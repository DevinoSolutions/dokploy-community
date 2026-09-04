import type { IncomingMessage } from "node:http";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import * as bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
	APIError,
	createAuthMiddleware,
	getSessionFromCtx,
} from "better-auth/api";
import { admin, mcp, organization, twoFactor } from "better-auth/plugins";
import { and, desc, eq } from "drizzle-orm";
import { IS_CLOUD } from "../constants";
import { db } from "../db";
import * as schema from "../db/schema";
import {
	getTrustedOrigins,
	getTrustedProviders,
	getUserByToken,
} from "../services/admin";
import {
	deleteConsumedRefreshToken,
	DOKPLOY_MCP_SCOPE_IDS,
	getMcpAccessTokenSeconds,
	getMcpRefreshTokenSeconds,
	isAllowedRedirectUri,
	MCP_AUTHORIZE_PAGE_PATH,
	MCP_ENDPOINT_PATH,
	verifyConsentProof,
} from "../services/mcp-oauth";
import { createAuditLog } from "../services/proprietary/audit-log";
import { resolveOrganizationDefaultRole } from "../services/proprietary/license-key";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "../services/web-server-settings";
import { getHubSpotUTK, submitToHubSpot } from "../utils/tracking/hubspot";
import {
	sendEmail,
	sendVerificationEmail,
} from "../verification/send-verification-email";
import { getPublicIpWithFallback } from "../wss/utils";
import { ac, adminRole, memberRole, ownerRole } from "./access-control";
import { betterAuthSecret } from "./auth-secret";

// Number of days a login session stays valid (sliding window). Reads
// DOKPLOY_SESSION_DAYS, falling back to 30. Invalid or non-positive values
// fall back to the default so a bad env var can never lock everyone out.
const DEFAULT_SESSION_DAYS = 30;
const getSessionDays = () => {
	const raw = process.env.DOKPLOY_SESSION_DAYS;
	if (!raw) return DEFAULT_SESSION_DAYS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_DAYS;
};

const resolveTrustedOrigins = async () => {
	try {
		if (IS_CLOUD) {
			return await getTrustedOrigins();
		}
		const [trustedOrigins, settings] = await Promise.all([
			getTrustedOrigins(),
			getWebServerSettings(),
		]);

		if (!settings) return [];

		const devOrigins =
			process.env.NODE_ENV === "development"
				? [
						"http://localhost:3000",
						"https://absolutely-handy-falcon.ngrok-free.app",
					]
				: [];
		return [
			...(settings?.serverIp ? [`http://${settings?.serverIp}:3000`] : []),
			...(settings?.host ? [`https://${settings?.host}`] : []),
			...devOrigins,
			...trustedOrigins,
		];
	} catch (error) {
		console.error("Failed to resolve trusted origins:", error);
		return [];
	}
};

const createBetterAuth = () =>
	betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: schema,
		}),
		disabledPaths: [
			"/sso/register",
			"/organization/create",
			"/organization/update",
			"/organization/delete",
			// The fork serves OAuth discovery from /api/mcp-oauth/* (see
			// services/mcp-oauth.ts); the plugin's copies need a global baseURL.
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-protected-resource",
			"/oauth2/consent",
			...(!IS_CLOUD ? ["/verify-email"] : []),
		],
		secret: betterAuthSecret,
		onAPIError: {
			errorURL: "/",
		},
		...(!IS_CLOUD
			? {
					advanced: {
						useSecureCookies: false,
						defaultCookieAttributes: {
							sameSite: "lax",
							secure: false,
							httpOnly: true,
							path: "/",
						},
					},
				}
			: {}),

		account: {
			accountLinking: {
				enabled: true,
				async trustedProviders() {
					const fromDb = await getTrustedProviders();
					return ["github", "google", ...fromDb];
				},
				allowDifferentEmails: true,
			},
		},
		appName: "Dokploy",
		socialProviders: {
			github: {
				clientId: process.env.GITHUB_CLIENT_ID as string,
				clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
			},
			google: {
				clientId: process.env.GOOGLE_CLIENT_ID as string,
				clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
			},
		},
		logger: {
			disabled: process.env.NODE_ENV === "production",
		},
		trustedOrigins: resolveTrustedOrigins,
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				ctx.context.trustedOrigins = [
					...(ctx.context.baseURL ? [new URL(ctx.context.baseURL).origin] : []),
					...(await resolveTrustedOrigins()),
				].filter(Boolean);

				// Dynamic client registration is anonymous: only loopback-http or
				// https redirect targets may receive authorization codes.
				if (ctx.path === "/mcp/register") {
					const uris = (ctx.body as { redirect_uris?: unknown } | undefined)
						?.redirect_uris;
					const valid =
						Array.isArray(uris) &&
						uris.length > 0 &&
						uris.every(
							(uri) => typeof uri === "string" && isAllowedRedirectUri(uri),
						);
					if (!valid) {
						throw new APIError("BAD_REQUEST", {
							error: "invalid_redirect_uri",
							error_description:
								"redirect_uris must use http://localhost, http://127.0.0.1 or https://",
						});
					}
				}

				// The plugin issues a code without consent. Require the proof the
				// fork's consent page mints, and never let an anonymous request reach
				// the plugin (it would set a login-resume cookie that bypasses the
				// consent page after sign-in).
				if (ctx.path === "/mcp/authorize") {
					const query = (ctx.query ?? {}) as Record<string, string | undefined>;
					const session = await getSessionFromCtx(ctx);
					if (!session) {
						const origin = new URL(ctx.context.baseURL).origin;
						const params = new URLSearchParams();
						for (const [key, value] of Object.entries(query)) {
							if (key !== "consent" && typeof value === "string") {
								params.set(key, value);
							}
						}
						throw ctx.redirect(
							`${origin}${MCP_AUTHORIZE_PAGE_PATH}?${params.toString()}`,
						);
					}
					const ok = verifyConsentProof(query.consent ?? "", {
						userId: session.user.id,
						clientId: query.client_id ?? "",
						redirectUri: query.redirect_uri ?? "",
						state: query.state ?? "",
						codeChallenge: query.code_challenge ?? "",
						scope: query.scope ?? "",
					});
					if (!ok) {
						throw new APIError("BAD_REQUEST", {
							error: "consent_required",
							error_description: `Authorization must start from ${MCP_AUTHORIZE_PAGE_PATH}`,
						});
					}
				}
			}),
			after: createAuthMiddleware(async (ctx) => {
				// Refresh rotation: the plugin inserts a new row and leaves the
				// consumed refresh token alive. Delete it so it cannot be replayed.
				if (ctx.path !== "/mcp/token") return;
				const rawBody = ctx.body as unknown;
				const body =
					rawBody instanceof FormData
						? (Object.fromEntries(rawBody.entries()) as Record<string, unknown>)
						: ((rawBody ?? {}) as Record<string, unknown>);
				if (body.grant_type !== "refresh_token") return;
				const returned = ctx.context.returned as unknown;
				const succeeded =
					!!returned &&
					typeof returned === "object" &&
					"access_token" in returned;
				if (!succeeded) return;
				const consumed = body.refresh_token;
				if (typeof consumed === "string" && consumed) {
					await deleteConsumedRefreshToken(consumed);
				}
			}),
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			sendOnSignIn: true,
			sendVerificationEmail: async ({ user, url }) => {
				if (IS_CLOUD) {
					await sendVerificationEmail({
						userName: user.name || "User",
						email: user.email,
						verificationUrl: url,
					});
				}
			},
		},
		emailAndPassword: {
			enabled: true,
			autoSignIn: !IS_CLOUD,
			requireEmailVerification:
				IS_CLOUD && process.env.NODE_ENV === "production",
			password: {
				async hash(password) {
					return bcrypt.hashSync(password, 10);
				},
				async verify({ hash, password }) {
					return bcrypt.compareSync(password, hash);
				},
			},
			sendResetPassword: async ({ user, url }) => {
				await sendEmail({
					email: user.email,
					subject: "Reset your password",
					text: `
				<p>Click the link to reset your password: <a href="${url}">Reset Password</a></p>
				`,
				});
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async (_user, context) => {
						if (context?.path?.includes("/scim")) {
							return { data: { emailVerified: true } };
						}
						if (!IS_CLOUD) {
							const xDokployToken =
								context?.request?.headers?.get("x-dokploy-token");
							if (xDokployToken) {
								let invitation: Awaited<ReturnType<typeof getUserByToken>>;
								try {
									invitation = await getUserByToken(xDokployToken);
								} catch {
									throw new APIError("BAD_REQUEST", {
										message: "Invalid invitation token",
									});
								}
								if (invitation.isExpired) {
									throw new APIError("BAD_REQUEST", {
										message: "Invitation has expired",
									});
								}
								if (invitation.status !== "pending") {
									throw new APIError("BAD_REQUEST", {
										message: "Invitation has already been used",
									});
								}
								if (
									_user.email.toLowerCase().trim() !==
									invitation.email.toLowerCase().trim()
								) {
									throw new APIError("BAD_REQUEST", {
										message: "Email does not match invitation",
									});
								}
							} else {
								const isSSORequest = context?.path?.includes("/sso");
								if (isSSORequest) {
									return;
								}
								const isAdminPresent = await db.query.member.findFirst({
									where: eq(schema.member.role, "owner"),
								});
								if (isAdminPresent) {
									throw new APIError("BAD_REQUEST", {
										message: "Admin is already created",
									});
								}
							}
						}
					},
					after: async (user, context) => {
						const isSSORequest = context?.path?.includes("/sso");
						const isSCIMRequest = context?.path?.includes("/scim");
						const isAdminPresent = await db.query.member.findFirst({
							where: eq(schema.member.role, "owner"),
						});

						if (!IS_CLOUD && !isAdminPresent) {
							await updateWebServerSettings({
								serverIp: await getPublicIpWithFallback(),
							});
						}

						if (IS_CLOUD) {
							try {
								const hutk = getHubSpotUTK(
									context?.request?.headers?.get("cookie") || undefined,
								);
								// Cast to include additional fields
								const userWithFields = user as typeof user & {
									lastName?: string;
								};
								const hubspotSuccess = await submitToHubSpot(
									{
										email: user.email,
										firstName: user.name || "", // name is mapped to firstName column
										lastName: userWithFields.lastName || "",
									},
									hutk,
								);
								if (!hubspotSuccess) {
									console.error("Failed to submit to HubSpot");
								}
							} catch (error) {
								console.error("Error submitting to HubSpot", error);
							}
						}

						if (isSCIMRequest) {
							const membership = await db.query.member.findFirst({
								where: eq(schema.member.userId, user.id),
							});
							if (membership) {
								const defaultRole = await resolveOrganizationDefaultRole(
									membership.organizationId,
								);
								if (defaultRole !== membership.role) {
									await db
										.update(schema.member)
										.set({ role: defaultRole })
										.where(eq(schema.member.id, membership.id));
								}
							}
							return;
						}

						if (IS_CLOUD || !isAdminPresent) {
							await db.transaction(async (tx) => {
								const organization = await tx
									.insert(schema.organization)
									.values({
										name: "My Organization",
										ownerId: user.id,
										createdAt: new Date(),
									})
									.returning()
									.then((res) => res[0]);

								await tx.insert(schema.member).values({
									userId: user.id,
									organizationId: organization?.id || "",
									role: "owner",
									createdAt: new Date(),
									isDefault: true, // Mark first organization as default
								});
							});
						} else if (isSSORequest) {
							const providerId = context?.params?.providerId;
							if (!providerId) {
								throw new APIError("BAD_REQUEST", {
									message: "Provider ID is required",
								});
							}
							const provider = await db.query.ssoProvider.findFirst({
								where: eq(schema.ssoProvider.providerId, providerId),
							});

							if (!provider) {
								throw new APIError("BAD_REQUEST", {
									message: "Provider not found",
								});
							}
							const defaultRole = provider.organizationId
								? await resolveOrganizationDefaultRole(provider.organizationId)
								: "member";
							await db.insert(schema.member).values({
								userId: user.id,
								organizationId: provider?.organizationId || "",
								role: defaultRole,
								createdAt: new Date(),
								isDefault: true,
							});
						}
					},
				},
			},
			session: {
				create: {
					before: async (session) => {
						// Find the default organization for this user
						// Priority: 1) isDefault=true, 2) most recently created
						const member = await db.query.member.findFirst({
							where: eq(schema.member.userId, session.userId),
							orderBy: [
								desc(schema.member.isDefault),
								desc(schema.member.createdAt),
							],
							with: {
								organization: true,
							},
						});

						return {
							data: {
								...session,
								activeOrganizationId: member?.organization?.id,
							},
						};
					},
					after: async (session) => {
						const orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) return;
						const memberRecord = await db.query.member.findFirst({
							where: and(
								eq(schema.member.userId, session.userId),
								eq(schema.member.organizationId, orgId),
							),
							with: { user: true },
						});
						if (!memberRecord) return;
						await createAuditLog({
							organizationId: orgId,
							userId: session.userId,
							userEmail: memberRecord.user.email,
							userRole: memberRecord.role,
							action: "login",
							resourceType: "session",
						});
					},
				},
				delete: {
					after: async (session) => {
						const orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) return;
						const memberRecord = await db.query.member.findFirst({
							where: and(
								eq(schema.member.userId, session.userId),
								eq(schema.member.organizationId, orgId),
							),
							with: { user: true },
						});
						if (!memberRecord) return;
						await createAuditLog({
							organizationId: orgId,
							userId: session.userId,
							userEmail: memberRecord.user.email,
							userRole: memberRecord.role,
							action: "logout",
							resourceType: "session",
						});
					},
				},
			},
		},
		session: {
			// Sliding session lifetime, in days. Defaults to 30 (upstream ships 3,
			// which logs infrequent users out too aggressively for a dashboard).
			// Override per-install with DOKPLOY_SESSION_DAYS.
			expiresIn: 60 * 60 * 24 * getSessionDays(),
			// Refresh the sliding expiry at most once a day of use.
			updateAge: 60 * 60 * 24,
		},
		user: {
			modelName: "user",
			fields: {
				name: "firstName", // Map better-auth's default 'name' field to 'firstName' column
			},
			additionalFields: {
				role: {
					type: "string",
					// required: true,
					input: false,
				},
				ownerId: {
					type: "string",
					// required: true,
					input: false,
				},
				allowImpersonation: {
					fieldName: "allowImpersonation",
					type: "boolean",
					defaultValue: false,
				},
				lastName: {
					type: "string",
					required: false,
					input: true,
					defaultValue: "",
				},
				enableEnterpriseFeatures: {
					type: "boolean",
					required: false,
					input: false,
				},
				isValidEnterpriseLicense: {
					type: "boolean",
					required: false,
					input: false,
				},
			},
		},
		plugins: [
			apiKey({
				enableMetadata: true,
				references: "user",
			}),
			sso({ trustEmailVerified: true }),
			scim({
				beforeSCIMTokenGenerated: async ({ user }) => {
					const dbUser = await db.query.user.findFirst({
						where: eq(schema.user.id, user.id),
						columns: { enableEnterpriseFeatures: true },
					});

					if (!dbUser?.enableEnterpriseFeatures) {
						throw new APIError("FORBIDDEN", {
							message: "SCIM provisioning requires an enterprise license",
						});
					}
				},
			}),
			twoFactor(),
			passkey(),
			// Remote MCP endpoint OAuth server (see docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md).
			// Discovery is served by the fork (apps/dokploy/pages/api/mcp-oauth/*), so no baseURL is set here.
			mcp({
				loginPage: MCP_AUTHORIZE_PAGE_PATH,
				resource: MCP_ENDPOINT_PATH,
				oidcConfig: {
					// OIDCOptions requires loginPage; the plugin overwrites it with the
					// top-level one, so both must name the fork's consent page.
					loginPage: MCP_AUTHORIZE_PAGE_PATH,
					accessTokenExpiresIn: getMcpAccessTokenSeconds(),
					refreshTokenExpiresIn: getMcpRefreshTokenSeconds(),
					requirePKCE: true,
					defaultScope: [
						"openid",
						"offline_access",
						...DOKPLOY_MCP_SCOPE_IDS,
					].join(" "),
					scopes: [...DOKPLOY_MCP_SCOPE_IDS],
				},
			}),
			organization({
				ac,
				roles: {
					owner: ownerRole,
					admin: adminRole,
					member: memberRole,
				},
				dynamicAccessControl: {
					enabled: true,
					maximumRolesPerOrganization: 10,
				},
			}),
			// Self-hosted needs the admin plugin too: SCIM deactivation (active: false)
			// maps to the admin plugin's `banned` field and is rejected without it.
			// adminRoles: [] keeps every /admin/* endpoint locked on self-hosted.
			admin(
				IS_CLOUD
					? {
							adminUserIds: [process.env.USER_ADMIN_ID as string].filter(
								Boolean,
							),
						}
					: { adminRoles: [] },
			),
		],
	});

// Una sola instancia de better-auth por proceso aunque el módulo esté
// duplicado en varios bundles.
type AuthInstance = ReturnType<typeof createBetterAuth>;

const globalForAuth = globalThis as unknown as {
	betterAuthInstance?: AuthInstance;
};

// Lazily initialize better-auth on first use instead of at module import
// time, so importing this module (or anything that re-exports it) no longer
// requires a reachable database.
function getAuthInstance(): AuthInstance {
	if (globalForAuth.betterAuthInstance) {
		return globalForAuth.betterAuthInstance;
	}

	try {
		globalForAuth.betterAuthInstance = createBetterAuth();
		return globalForAuth.betterAuthInstance;
	} catch (error) {
		console.error("Failed to initialize auth instance:", error);
		throw error;
	}
}

// Export properly typed lazy-loaded auth: each property defers to the
// singleton created on first access.
const _auth = {
	get handler() {
		return getAuthInstance().handler;
	},
	get createApiKey() {
		return getAuthInstance().api.createApiKey;
	},
	get registerSSOProvider() {
		return getAuthInstance().api.registerSSOProvider;
	},
	get updateSSOProvider() {
		return getAuthInstance().api.updateSSOProvider;
	},
	get generateSCIMToken() {
		return getAuthInstance().api.generateSCIMToken;
	},
	get listSCIMProviderConnections() {
		return getAuthInstance().api.listSCIMProviderConnections;
	},
	get deleteSCIMProviderConnection() {
		return getAuthInstance().api.deleteSCIMProviderConnection;
	},
};

export type AuthType = typeof _auth;
export const auth: AuthType = _auth;

// Access the underlying better-auth api lazily (used by validateRequest).
function getApi() {
	return getAuthInstance().api;
}

/**
 * Diagnostic for the "logged out early" reports: when a request carries a
 * session_token cookie but better-auth resolves no session, classify why by
 * looking the token up directly. Requests without a session cookie are normal
 * anonymous traffic and are not logged. Only a token prefix is logged — the
 * full token would allow session hijacking from log output.
 */
async function logRejectedSessionCookie(cookieHeader: string) {
	if (!cookieHeader) return;
	try {
		const sessionCookie = cookieHeader
			.split(";")
			.map((part) => part.trim())
			.find((part) => {
				const name = part.slice(0, part.indexOf("="));
				return (
					name.endsWith(".session_token") || name.endsWith("-session_token")
				);
			});
		if (!sessionCookie) return;
		const rawValue = decodeURIComponent(
			sessionCookie.slice(sessionCookie.indexOf("=") + 1),
		);
		const token = rawValue.split(".")[0] || "";
		if (!token) return;
		const row = await db.query.session.findFirst({
			where: eq(schema.session.token, token),
			columns: { token: true, expiresAt: true, userId: true },
		});
		const reason = !row
			? "token_not_in_db"
			: row.expiresAt <= new Date()
				? `expired_at=${row.expiresAt.toISOString()}`
				: "row_valid_but_rejected(signature_or_secret)";
		console.warn(
			`[session-diag] session cookie rejected: reason=${reason} tokenPrefix=${token.slice(0, 8)}`,
		);
	} catch (error) {
		console.warn("[session-diag] classification failed", error);
	}
}

type UserRow = typeof schema.user.$inferSelect;

/**
 * Synthesizes the `{ session, user }` shape tRPC's context expects for a
 * user acting inside one organization without a browser session. Shared by
 * the API-key branch of `validateRequest` and the MCP endpoint.
 */
export const buildMemberSession = async (
	userFromDb: UserRow,
	organizationId: string,
) => {
	const member = await db.query.member.findFirst({
		where: and(
			eq(schema.member.userId, userFromDb.id),
			eq(schema.member.organizationId, organizationId),
		),
		with: {
			organization: true,
		},
	});

	return {
		session: {
			userId: userFromDb.id,
			activeOrganizationId: organizationId,
		},
		user: {
			id: userFromDb.id,
			name: userFromDb.firstName, // Map firstName back to name for better-auth
			email: userFromDb.email,
			emailVerified: userFromDb.emailVerified,
			image: userFromDb.image,
			createdAt: userFromDb.createdAt,
			updatedAt: userFromDb.updatedAt,
			twoFactorEnabled: userFromDb.twoFactorEnabled,
			role: member?.role || "member",
			ownerId: member?.organization.ownerId || userFromDb.id,
			enableEnterpriseFeatures: userFromDb.enableEnterpriseFeatures,
			isValidEnterpriseLicense: userFromDb.isValidEnterpriseLicense,
		},
	};
};

export const validateRequest = async (request: IncomingMessage) => {
	const api = getApi();
	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		try {
			const { valid, key, error } = await api.verifyApiKey({
				body: {
					key: apiKey,
				},
			});

			if (error) {
				throw new Error(error.message?.toString() || "Error verifying API key");
			}
			if (!valid || !key) {
				return {
					session: null,
					user: null,
				};
			}

			const apiKeyRecord = await db.query.apikey.findFirst({
				where: eq(schema.apikey.id, key.id),
				with: {
					user: true,
				},
			});

			if (!apiKeyRecord) {
				return {
					session: null,
					user: null,
				};
			}

			const organizationId = (
				JSON.parse(apiKeyRecord.metadata || "{}") as {
					organizationId?: string;
				}
			).organizationId;

			if (!organizationId) {
				return {
					session: null,
					user: null,
				};
			}

			return await buildMemberSession(apiKeyRecord.user, organizationId);
		} catch (error) {
			console.error("Error verifying API key", error);
			return {
				session: null,
				user: null,
			};
		}
	}

	// If no API key, proceed with normal session validation
	const session = await api.getSession({
		headers: new Headers({
			cookie: request.headers.cookie || "",
		}),
	});

	if (!session?.session || !session.user) {
		await logRejectedSessionCookie(request.headers.cookie || "");
		return {
			session: null,
			user: null,
		};
	}

	if (session?.user) {
		const member = await db.query.member.findFirst({
			where: and(
				eq(schema.member.userId, session.user.id),
				...(session.session.activeOrganizationId
					? [
							eq(
								schema.member.organizationId,
								session.session.activeOrganizationId || "",
							),
						]
					: []),
			),
			orderBy: [desc(schema.member.isDefault), desc(schema.member.createdAt)],
			with: {
				organization: true,
				user: true,
			},
		});

		session.user.role = member?.role || "member";
		session.user.enableEnterpriseFeatures =
			member?.user.enableEnterpriseFeatures || false;
		session.user.isValidEnterpriseLicense =
			member?.user.isValidEnterpriseLicense || false;
		session.session.activeOrganizationId = member?.organization.id || "";
		if (member) {
			session.user.ownerId = member.organization.ownerId;
		} else {
			session.user.ownerId = session.user.id;
		}
	}

	return session;
};
