import type { IncomingMessage } from "node:http";
import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
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
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { admin, organization, twoFactor } from "better-auth/plugins";
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
	canonicalizeMcpResourceParam,
	DOKPLOY_MCP_SCOPE_IDS,
	ensureMcpResource,
	evaluateMcpAuthorizeGate,
	evaluateMcpRegisterBody,
	getMcpAccessTokenSeconds,
	getMcpRefreshGraceSeconds,
	getMcpRefreshTokenSeconds,
	isMcpAuthorizeMethodAllowed,
	isStaleRotatedRefreshToken,
	MCP_AUTHORIZE_PAGE_PATH,
	mcpResourceAliasHosts,
	normalizeMcpRegisterBody,
	resolveMcpOrigin,
} from "../services/mcp-oauth";
import { removeOrganizationNotifications } from "../services/notification-channels";
import { scimOptions } from "../services/proprietary/scim";
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

/** Token requests are form-encoded; normalize either body shape to a record. */
const readFormOrJsonBody = (rawBody: unknown): Record<string, unknown> => {
	if (rawBody instanceof FormData) {
		return Object.fromEntries(rawBody.entries()) as Record<string, unknown>;
	}
	if (rawBody instanceof URLSearchParams) {
		return Object.fromEntries(rawBody.entries());
	}
	return rawBody && typeof rawBody === "object"
		? (rawBody as Record<string, unknown>)
		: {};
};

/**
 * Prepares a `resource` parameter before the provider validates it: makes
 * sure the MCP endpoint of this instance is a known RFC 8707 resource, and
 * maps the variants clients send for it (trailing slash, another host name of
 * this instance, http) to the advertised identifier. Returns the value to use.
 * A failure is logged and the value is left to the provider, which then
 * answers `invalid_target`.
 */
const prepareMcpResourceParam = async (
	headers: Headers | undefined,
	value: unknown,
): Promise<unknown> => {
	try {
		const incoming = Object.fromEntries(headers?.entries() ?? []);
		const origin = await resolveMcpOrigin(incoming);
		if (!origin) return value;
		await ensureMcpResource(origin);
		return canonicalizeMcpResourceParam(
			value,
			origin,
			await mcpResourceAliasHosts(),
		);
	} catch (error) {
		console.error("[mcp] failed to register the MCP resource", error);
		return value;
	}
};

const sameParam = (left: unknown, right: unknown) =>
	JSON.stringify(left) === JSON.stringify(right);

/**
 * Client secrets of confidential OAuth clients. Opaque access tokens (see
 * `disableJwtPlugin` below) make the provider sign confidential clients' ID
 * tokens with their secret, so secrets are stored encrypted, not hashed.
 * Clients migrated from better-auth 1.6, which stored secrets in plaintext,
 * carry the legacy prefix (migration 0211) and keep verifying.
 */
export const LEGACY_PLAINTEXT_CLIENT_SECRET_PREFIX = "dokploy-legacy-plain:";
const oauthClientSecretStorage = {
	encrypt: (clientSecret: string) =>
		symmetricEncrypt({ key: betterAuthSecret, data: clientSecret }),
	decrypt: async (storedSecret: string) =>
		storedSecret.startsWith(LEGACY_PLAINTEXT_CLIENT_SECRET_PREFIX)
			? storedSecret.slice(LEGACY_PLAINTEXT_CLIENT_SECRET_PREFIX.length)
			: symmetricDecrypt({ key: betterAuthSecret, data: storedSecret }),
};

const createBetterAuth = () =>
	betterAuth({
		database: drizzleAdapter(db, {
			provider: "pg",
			schema: schema,
			// The 1.7 SCIM plugin refuses to start without native interactive
			// transactions. Core runs database `after` hooks once the
			// transaction commits (see `session.create.after` below).
			transaction: true,
		}),
		disabledPaths: [
			"/sso/register",
			"/organization/create",
			"/organization/update",
			"/organization/delete",
			// The fork serves OAuth discovery from /api/mcp-oauth/* (see
			// services/mcp-oauth.ts), pointing at its own consent page.
			"/.well-known/oauth-authorization-server",
			"/.well-known/openid-configuration",
			"/.well-known/oauth-protected-resource",
			// MCP clients are approved only on the fork's consent page, which
			// records the consent row the provider's authorize endpoint checks.
			// The provider's own consent/continue flow, client CRUD, consent
			// CRUD, resource admin and OIDC session endpoints are not part of
			// that flow and stay closed.
			"/oauth2/consent",
			"/oauth2/continue",
			"/oauth2/create-client",
			"/oauth2/get-client",
			"/oauth2/get-clients",
			"/oauth2/public-client",
			"/oauth2/public-client-prelogin",
			"/oauth2/update-client",
			"/oauth2/delete-client",
			"/oauth2/client/rotate-secret",
			"/oauth2/get-consent",
			"/oauth2/get-consents",
			"/oauth2/update-consent",
			"/oauth2/delete-consent",
			"/oauth2/end-session",
			"/oauth2/end-session/confirm",
			"/oauth2/userinfo",
			// Not advertised in discovery. The provider's revoke answers a
			// rotated refresh token by deleting every token of the (client,
			// user) pair, which would log out all sessions sharing the grant
			// (#214); Settings revokes through `revokeMcpAuthorization`.
			// Introspection is not used: the MCP endpoint looks tokens up itself.
			"/oauth2/revoke",
			"/oauth2/introspect",
			"/admin/oauth2/create-client",
			"/admin/oauth2/update-client",
			"/admin/oauth2/resources",
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

				const isBlockedAuthPath =
					ctx.path.startsWith("/sign-in/email") ||
					ctx.path.startsWith("/sign-in/social") ||
					// Linking a social account would add a login method that
					// bypasses SSO as soon as enforcement is turned off.
					ctx.path.startsWith("/link-social") ||
					ctx.path.startsWith("/sign-in/passkey") ||
					ctx.path.startsWith("/sign-up/email") ||
					ctx.path.startsWith("/passkey/verify-authentication") ||
					ctx.path.startsWith("/passkey/generate-authenticate-options");

				if (!IS_CLOUD && isBlockedAuthPath) {
					const settings = await getWebServerSettings();
					if (settings?.enforceSSO) {
						throw new APIError("FORBIDDEN", {
							message:
								"SSO is enforced. Direct password, social, and passkey sign-in are disabled.",
						});
					}
				}

				// OAuth resource administration is not part of the MCP flow.
				// `disabledPaths` matches exact paths only, so the parameterized
				// admin routes are closed here.
				if (ctx.path.startsWith("/admin/oauth2/")) {
					throw new APIError("NOT_FOUND");
				}

				// Dynamic client registration is anonymous: only loopback-http or
				// https redirect targets may receive authorization codes.
				if (ctx.path === "/oauth2/register") {
					const decision = evaluateMcpRegisterBody(ctx.body);
					if (!decision.ok) {
						throw new APIError("BAD_REQUEST", {
							error: decision.error,
							error_description: decision.error_description,
						});
					}
					const normalized = normalizeMcpRegisterBody(ctx.body);
					if (normalized) {
						return { context: { body: normalized } };
					}
				}

				// The fork's consent page is the only way to approve a client.
				// Require the proof it mints, and never let an anonymous request
				// reach the provider (it would start its own login flow, which
				// bypasses the consent page after sign-in).
				if (ctx.path === "/oauth2/authorize") {
					// A POST would make the provider read its parameters from the
					// body, which the proof (checked on the query) never covered.
					if (
						!isMcpAuthorizeMethodAllowed(
							ctx.request?.method ?? (ctx.body ? "POST" : "GET"),
						)
					) {
						throw new APIError("METHOD_NOT_ALLOWED", {
							error: "invalid_request",
							error_description: "authorization requests must use GET",
						});
					}
					const query = (ctx.query ?? {}) as Record<string, unknown>;
					const session = await getSessionFromCtx(ctx);
					const decision = evaluateMcpAuthorizeGate({
						query,
						userId: session?.user.id ?? null,
					});
					if (decision.action === "redirect") {
						throw ctx.redirect(decision.location);
					}
					if (decision.action === "reject") {
						throw new APIError("BAD_REQUEST", {
							error: decision.error,
							error_description: decision.error_description,
						});
					}
					if (query.resource !== undefined) {
						const resource = await prepareMcpResourceParam(
							ctx.headers,
							query.resource,
						);
						if (!sameParam(resource, query.resource)) {
							return { context: { query: { ...query, resource } } };
						}
					}
				}

				if (ctx.path === "/oauth2/token") {
					const body = readFormOrJsonBody(ctx.body);
					if (
						body.grant_type === "refresh_token" &&
						typeof body.refresh_token === "string" &&
						(await isStaleRotatedRefreshToken(body.refresh_token))
					) {
						throw new APIError("BAD_REQUEST", {
							error: "invalid_grant",
							error_description: "invalid refresh token",
						});
					}
					if (body.resource !== undefined) {
						const resource = await prepareMcpResourceParam(
							ctx.headers,
							body.resource,
						);
						if (!sameParam(resource, body.resource)) {
							return { context: { body: { ...body, resource } } };
						}
					}
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

						// SCIM-provisioned users join their organization through the
						// SCIM projection (services/proprietary/scim.ts), never through
						// the first-admin or SSO paths below.
						if (isSCIMRequest) {
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
						let orgId = (
							session as typeof session & { activeOrganizationId?: string }
						).activeOrganizationId;
						if (!orgId) {
							// With adapter transactions, a sign-up creates the session
							// inside the transaction while `user.create.after` (which
							// creates the first organization and membership) only runs
							// after it commits, so `create.before` found no membership.
							// This hook is queued after that one; finish the job here.
							const defaultMember = await db.query.member.findFirst({
								where: eq(schema.member.userId, session.userId),
								orderBy: [
									desc(schema.member.isDefault),
									desc(schema.member.createdAt),
								],
								columns: { organizationId: true },
							});
							if (!defaultMember) return;
							orgId = defaultMember.organizationId;
							await db
								.update(schema.session)
								.set({ activeOrganizationId: orgId })
								.where(eq(schema.session.id, session.id));
						}
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
				// `ownerId` is not a user column: validateRequest derives it per
				// request from the active organization. It cannot be declared
				// here, since 1.7 rejects declared fields that have no column in
				// the Drizzle schema.
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
			// IdP-initiated SAML stays off (the 1.7 default): every SAML login
			// must answer a request this instance issued.
			sso({ trustEmailVerified: true }),
			// Organization-scoped SCIM connections (services/proprietary/scim.ts).
			scim(scimOptions()),
			twoFactor(),
			passkey(),
			// Remote MCP endpoint OAuth server (see docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md).
			// `@better-auth/mcp`'s `mcp()` preset is not used: it needs one static
			// HTTPS resource URL at boot, while Dokploy learns its public origin
			// per request and also runs on plain-http installs. The preset is a
			// thin wrapper over this provider; the fork serves discovery itself
			// (apps/dokploy/pages/api/mcp-oauth/*) and registers the MCP resource
			// on demand (`ensureMcpResource`).
			oauthProvider({
				loginPage: MCP_AUTHORIZE_PAGE_PATH,
				consentPage: MCP_AUTHORIZE_PAGE_PATH,
				scopes: ["openid", "offline_access", ...DOKPLOY_MCP_SCOPE_IDS],
				grantTypes: ["authorization_code", "refresh_token"],
				accessTokenExpiresIn: getMcpAccessTokenSeconds(),
				refreshTokenExpiresIn: getMcpRefreshTokenSeconds(),
				refreshTokenReuseInterval: getMcpRefreshGraceSeconds(),
				// Opaque, database-backed access tokens: the MCP endpoint looks
				// them up itself, and revoking a grant in Settings takes effect on
				// the next request instead of when a JWT expires.
				disableJwtPlugin: true,
				storeTokens: "hashed",
				storeClientSecret: oauthClientSecretStorage,
				// Claude Code and other MCP clients register themselves. The
				// register gate in `hooks.before` restricts redirect targets.
				allowDynamicClientRegistration: true,
				allowUnauthenticatedClientRegistration: true,
				// The single MCP resource is implicitly available to every client.
				enforcePerClientResources: false,
				// A fleet of MCP sessions on one machine shares an IP and can
				// refresh at the same moment; the provider defaults (20 token
				// requests a minute) would answer some of them 429.
				rateLimit: {
					token: { window: 60, max: 600 },
					authorize: { window: 60, max: 120 },
					register: { window: 60, max: 30 },
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
				organizationHooks: {
					// The plugin's own delete endpoint: once the notification rows
					// cascade away with the organization, nothing points at their
					// provider rows (API keys, webhooks) any more.
					beforeDeleteOrganization: async ({ organization: deleted }) => {
						await removeOrganizationNotifications(deleted.id);
					},
				},
				// Dokploy creates organizations itself (the plugin's create
				// endpoint is disabled) and stores their owner. Declaring the
				// column satisfies the 1.7 schema check, which rejects NOT NULL
				// columns the plugin does not know about.
				// `member.isDefault` is declared so SCIM provisioning, which writes
				// through the adapter inside its transaction, can set it (see
				// services/proprietary/scim.ts).
				schema: {
					organization: {
						additionalFields: {
							ownerId: { type: "string", required: false, input: false },
						},
					},
					member: {
						additionalFields: {
							isDefault: {
								type: "boolean",
								required: false,
								input: false,
								defaultValue: false,
							},
						},
					},
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
	get createSCIMManagedConnection() {
		return getAuthInstance().api.createSCIMManagedConnection;
	},
	get listSCIMManagedConnections() {
		return getAuthInstance().api.listSCIMManagedConnections;
	},
	get getSCIMManagedConnection() {
		return getAuthInstance().api.getSCIMManagedConnection;
	},
	get rotateSCIMManagedCredential() {
		return getAuthInstance().api.rotateSCIMManagedCredential;
	},
	get decommissionSCIMManagedConnection() {
		return getAuthInstance().api.decommissionSCIMManagedConnection;
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

/**
 * Outcome of checking a Dokploy API key. A key that is over its per-key rate
 * limit is still a good key, so it is reported apart from an invalid one:
 * callers that answer 401 for invalid keys should answer 429 for throttled
 * ones, or clients will treat a busy key as a lost login.
 */
export type ApiKeyVerification =
	| {
			status: "valid";
			member: Awaited<ReturnType<typeof buildMemberSession>>;
	  }
	| { status: "invalid" }
	| { status: "rate_limited"; retryAfterSeconds: number };

/** Seconds until a throttled key may retry, from better-auth's `tryAgainIn` (ms). */
const retryAfterSecondsFrom = (error: unknown) => {
	const source = error as {
		details?: { tryAgainIn?: unknown };
		tryAgainIn?: unknown;
	};
	const tryAgainIn = Number(source.details?.tryAgainIn ?? source.tryAgainIn);
	if (!Number.isFinite(tryAgainIn) || tryAgainIn <= 0) return 1;
	return Math.max(1, Math.ceil(tryAgainIn / 1000));
};

/**
 * Resolves a Dokploy API key to the member session of its owner inside the
 * organization the key was created for, telling a throttled key apart from
 * an unknown, expired, disabled or organization-less one.
 */
export const verifyApiKeyDetailed = async (
	apiKey: string,
): Promise<ApiKeyVerification> => {
	const api = getApi();
	try {
		const { valid, key, error } = await api.verifyApiKey({
			body: {
				key: apiKey,
			},
		});

		if (error) {
			if ((error as { code?: unknown }).code === "RATE_LIMITED") {
				return {
					status: "rate_limited",
					retryAfterSeconds: retryAfterSecondsFrom(error),
				};
			}
			throw new Error(error.message?.toString() || "Error verifying API key");
		}
		if (!valid || !key) {
			return { status: "invalid" };
		}

		const apiKeyRecord = await db.query.apikey.findFirst({
			where: eq(schema.apikey.id, key.id),
			with: {
				user: true,
			},
		});

		if (!apiKeyRecord) {
			return { status: "invalid" };
		}

		const organizationId = (
			JSON.parse(apiKeyRecord.metadata || "{}") as {
				organizationId?: string;
			}
		).organizationId;

		if (!organizationId) {
			return { status: "invalid" };
		}

		return {
			status: "valid",
			member: await buildMemberSession(apiKeyRecord.user, organizationId),
		};
	} catch (error) {
		console.error("Error verifying API key", error);
		return { status: "invalid" };
	}
};

/**
 * Resolves a Dokploy API key to the member session of its owner inside the
 * organization the key was created for. Null for unknown, expired, disabled,
 * throttled or organization-less keys. Used by the REST/tRPC `x-api-key` path;
 * the MCP endpoint uses {@link verifyApiKeyDetailed} to answer 429 on throttling.
 */
export const validateApiKey = async (apiKey: string) => {
	const verification = await verifyApiKeyDetailed(apiKey);
	return verification.status === "valid" ? verification.member : null;
};

export const validateRequest = async (request: IncomingMessage) => {
	const api = getApi();
	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		return (
			(await validateApiKey(apiKey)) ?? {
				session: null,
				user: null,
			}
		);
	}

	// If no API key, proceed with normal session validation
	const betterAuthSession = await api.getSession({
		headers: new Headers({
			cookie: request.headers.cookie || "",
		}),
	});
	// `ownerId` is not a user column: it is derived below from the active
	// organization, so it is added to the type here rather than declared as a
	// better-auth additional field.
	const session = betterAuthSession as
		| (NonNullable<typeof betterAuthSession> & {
				user: NonNullable<typeof betterAuthSession>["user"] & {
					ownerId: string;
				};
		  })
		| null;

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
