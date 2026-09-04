import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { user } from "./user";

/**
 * Fork-owned tables backing better-auth's in-core `mcp` plugin (OAuth 2.1
 * server for the remote MCP endpoint). The drizzle export keys MUST be
 * `oauthApplication` / `oauthAccessToken` / `oauthConsent` and the field keys
 * MUST match the plugin's field names exactly — the better-auth drizzle
 * adapter resolves `schema[modelName][fieldName]`. Column names follow the
 * snake_case convention of the other better-auth tables (see account.ts).
 */
export const oauthApplication = pgTable(
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

export const oauthAccessToken = pgTable(
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
			.references(() => oauthApplication.clientId, { onDelete: "cascade" }),
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

export const oauthConsent = pgTable(
	"oauth_consent",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clientId: text("client_id")
			.notNull()
			.references(() => oauthApplication.clientId, { onDelete: "cascade" }),
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

export const oauthApplicationRelations = relations(
	oauthApplication,
	({ many }) => ({
		accessTokens: many(oauthAccessToken),
	}),
);

export const oauthAccessTokenRelations = relations(
	oauthAccessToken,
	({ one }) => ({
		application: one(oauthApplication, {
			fields: [oauthAccessToken.clientId],
			references: [oauthApplication.clientId],
		}),
		user: one(user, {
			fields: [oauthAccessToken.userId],
			references: [user.id],
		}),
	}),
);
