import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { session } from "./session";
import { user } from "./user";

/**
 * Tables backing `@better-auth/oauth-provider` (better-auth 1.7), the OAuth 2.1
 * server behind the remote MCP endpoint. The drizzle export keys MUST equal the
 * plugin's model names (`oauthClient`, `oauthRefreshToken`, `oauthAccessToken`,
 * `oauthConsent`, ...) and the property keys MUST equal its field names: the
 * better-auth drizzle adapter resolves `schema[modelName][fieldName]`, and its
 * startup schema check compares these keys with the plugin schema.
 *
 * The 1.6 in-core `mcp` plugin owned `oauth_access_token` and `oauth_consent`
 * with a different layout, so the 1.7 token and consent tables use new
 * physical names. The 1.6 tables are kept (see the `legacy*` exports below) so
 * a rollback of the 1.7 upgrade finds its grants where it left them; migration
 * 0211 copies their live rows into these tables.
 *
 * Tokens are stored as `base64url(SHA-256(value))`, the plugin's `"hashed"`
 * storage format. Client secrets are encrypted with the auth secret (see
 * `oauthClientSecretStorage` in lib/auth.ts).
 */
export const oauthClient = pgTable(
	"oauth_client",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clientId: text("client_id").notNull().unique(),
		clientSecret: text("client_secret"),
		clientDiscoveryId: text("client_discovery_id"),
		disabled: boolean("disabled").default(false),
		skipConsent: boolean("skip_consent"),
		enableEndSession: boolean("enable_end_session"),
		subjectType: text("subject_type"),
		scopes: text("scopes").array(),
		clientCredentialsScopes: text("client_credentials_scopes")
			.array()
			.default([]),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at"),
		updatedAt: timestamp("updated_at"),
		name: text("name"),
		uri: text("uri"),
		icon: text("icon"),
		contacts: text("contacts").array(),
		tos: text("tos"),
		policy: text("policy"),
		softwareId: text("software_id"),
		softwareVersion: text("software_version"),
		softwareStatement: text("software_statement"),
		redirectUris: text("redirect_uris").array().notNull(),
		postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
		backchannelLogoutUri: text("backchannel_logout_uri"),
		backchannelLogoutSessionRequired: boolean(
			"backchannel_logout_session_required",
		),
		tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
		applicationType: text("application_type"),
		jwks: text("jwks"),
		jwksUri: text("jwks_uri"),
		grantTypes: text("grant_types").array(),
		responseTypes: text("response_types").array(),
		requirePKCE: boolean("require_pkce"),
		dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
		referenceId: text("reference_id"),
		metadata: jsonb("metadata"),
	},
	(table) => [index("oauth_client_user_id_idx").on(table.userId)],
);

export const oauthResource = pgTable("oauth_resource", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => nanoid()),
	identifier: text("identifier").notNull().unique(),
	name: text("name").notNull(),
	accessTokenTtl: integer("access_token_ttl"),
	refreshTokenTtl: integer("refresh_token_ttl"),
	signingAlgorithm: text("signing_algorithm"),
	signingKeyId: text("signing_key_id"),
	allowedScopes: text("allowed_scopes").array(),
	customClaims: jsonb("custom_claims"),
	dpopBoundAccessTokensRequired: boolean(
		"dpop_bound_access_tokens_required",
	).default(false),
	disabled: boolean("disabled").default(false),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
	policyVersion: integer("policy_version").default(1),
	metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
	"oauth_client_resource",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		resourceId: text("resource_id")
			.notNull()
			.references(() => oauthResource.identifier, { onDelete: "cascade" }),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at"),
	},
	(table) => [
		index("oauth_client_resource_client_id_idx").on(table.clientId),
		index("oauth_client_resource_resource_id_idx").on(table.resourceId),
		uniqueIndex("oauth_client_resource_client_id_resource_id_uidx").on(
			table.clientId,
			table.resourceId,
		),
	],
);

export const oauthRefreshToken = pgTable(
	"oauth_refresh_token",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		token: text("token").notNull().unique(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		sessionId: text("session_id").references(() => session.id, {
			onDelete: "set null",
		}),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		authorizationCodeId: text("authorization_code_id"),
		resources: text("resources").array(),
		requestedUserInfoClaims: text("requested_user_info_claims").array(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").notNull(),
		revoked: timestamp("revoked"),
		rotatedAt: timestamp("rotated_at"),
		rotationReplayResponse: text("rotation_replay_response"),
		rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
		authTime: timestamp("auth_time"),
		confirmation: jsonb("confirmation"),
		scopes: text("scopes").array().notNull(),
	},
	(table) => [
		index("oauth_refresh_token_client_id_idx").on(table.clientId),
		index("oauth_refresh_token_session_id_idx").on(table.sessionId),
		index("oauth_refresh_token_user_id_idx").on(table.userId),
		index("oauth_refresh_token_authorization_code_id_idx").on(
			table.authorizationCodeId,
		),
	],
);

export const oauthAccessToken = pgTable(
	"oauth_provider_access_token",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		token: text("token").notNull().unique(),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		sessionId: text("session_id").references(() => session.id, {
			onDelete: "set null",
		}),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		authorizationCodeId: text("authorization_code_id"),
		resources: text("resources").array(),
		requestedUserInfoClaims: text("requested_user_info_claims").array(),
		refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
			onDelete: "cascade",
		}),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").notNull(),
		revoked: timestamp("revoked"),
		confirmation: jsonb("confirmation"),
		scopes: text("scopes").array().notNull(),
	},
	(table) => [
		index("oauth_provider_access_token_client_id_idx").on(table.clientId),
		index("oauth_provider_access_token_session_id_idx").on(table.sessionId),
		index("oauth_provider_access_token_user_id_idx").on(table.userId),
		index("oauth_provider_access_token_authorization_code_id_idx").on(
			table.authorizationCodeId,
		),
		index("oauth_provider_access_token_refresh_id_idx").on(table.refreshId),
	],
);

/**
 * Written by the fork's consent page (`recordMcpConsent`) and read by the
 * plugin's authorize endpoint, which issues a code only when a consent row
 * covers the requested scopes and resources.
 */
export const oauthConsent = pgTable(
	"oauth_provider_consent",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthClient.clientId, { onDelete: "cascade" }),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		referenceId: text("reference_id"),
		resources: text("resources").array(),
		requestedUserInfoClaims: text("requested_user_info_claims").array(),
		scopes: text("scopes").array().notNull(),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [
		index("oauth_provider_consent_client_id_idx").on(table.clientId),
		index("oauth_provider_consent_user_id_idx").on(table.userId),
	],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
	id: text("id").primaryKey(),
	expiresAt: timestamp("expires_at").notNull(),
});

export const oauthClientRelations = relations(oauthClient, ({ many }) => ({
	accessTokens: many(oauthAccessToken),
	refreshTokens: many(oauthRefreshToken),
}));

export const oauthRefreshTokenRelations = relations(
	oauthRefreshToken,
	({ one }) => ({
		client: one(oauthClient, {
			fields: [oauthRefreshToken.clientId],
			references: [oauthClient.clientId],
		}),
		user: one(user, {
			fields: [oauthRefreshToken.userId],
			references: [user.id],
		}),
	}),
);

export const oauthAccessTokenRelations = relations(
	oauthAccessToken,
	({ one }) => ({
		client: one(oauthClient, {
			fields: [oauthAccessToken.clientId],
			references: [oauthClient.clientId],
		}),
		user: one(user, {
			fields: [oauthAccessToken.userId],
			references: [user.id],
		}),
	}),
);

// ---------------------------------------------------------------------------
// better-auth 1.6 `mcp` plugin tables, kept read-only for rollback
// ---------------------------------------------------------------------------

/**
 * 1.6 client registrations. Nothing writes here after the 1.7 upgrade; the
 * table stays so reverting the upgrade finds the grants it issued. Migration
 * 0211 copied every row into `oauth_client`.
 */
export const legacyOauthApplication = pgTable(
	"oauth_application",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name"),
		icon: text("icon"),
		metadata: text("metadata"),
		clientId: text("client_id").notNull().unique(),
		clientSecret: text("client_secret"),
		redirectUrls: text("redirect_urls").notNull(),
		type: text("type").notNull(),
		disabled: boolean("disabled").notNull().default(false),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [index("oauth_application_user_id_idx").on(table.userId)],
);

/**
 * 1.6 token rows (plaintext tokens). Kept for rollback; see above. Rows go
 * only once both tokens expired or when the user revokes the client
 * (`purgeExpiredMcpTokens`, `revokeMcpAuthorization`).
 */
export const legacyOauthAccessToken = pgTable(
	"oauth_access_token",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		accessToken: text("access_token").notNull().unique(),
		refreshToken: text("refresh_token").unique(),
		accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
		clientId: text("client_id")
			.notNull()
			.references(() => legacyOauthApplication.clientId, {
				onDelete: "cascade",
			}),
		userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
		scopes: text("scopes").notNull(),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [
		index("oauth_access_token_client_id_idx").on(table.clientId),
		index("oauth_access_token_user_id_idx").on(table.userId),
	],
);

/** 1.6 consent rows written by the fork's consent page. Kept for rollback only. */
export const legacyOauthConsent = pgTable(
	"oauth_consent",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clientId: text("client_id")
			.notNull()
			.references(() => legacyOauthApplication.clientId, {
				onDelete: "cascade",
			}),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		scopes: text("scopes").notNull(),
		consentGiven: boolean("consent_given").notNull().default(false),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [
		index("oauth_consent_client_id_idx").on(table.clientId),
		index("oauth_consent_user_id_idx").on(table.userId),
	],
);
