import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { db } from "../db";
import * as schema from "../db/schema";
import { ac, adminRole, memberRole, ownerRole } from "./access-control";

// CLI-only config for `npx auth generate` — must mirror the plugin set
// in auth.ts. Never import this from runtime code.
export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema,
		transaction: true,
	}),
	user: {
		modelName: "user",
		fields: {
			name: "firstName",
		},
		additionalFields: {
			role: { type: "string", input: false },
			allowImpersonation: { type: "boolean", defaultValue: false },
			lastName: { type: "string", required: false, defaultValue: "" },
			enableEnterpriseFeatures: { type: "boolean", required: false },
			isValidEnterpriseLicense: { type: "boolean", required: false },
		},
	},
	plugins: [
		apiKey({ enableMetadata: true, references: "user" }),
		sso({
			trustEmailVerified: true,
			domainVerification: {
				enabled: true,
			},
		}),
		twoFactor(),
		passkey(),
		organization({
			ac,
			roles: { owner: ownerRole, admin: adminRole, member: memberRole },
			dynamicAccessControl: {
				enabled: true,
				maximumRolesPerOrganization: 10,
			},
			schema: {
				organization: {
					additionalFields: {
						ownerId: { type: "string", required: false, input: false },
					},
				},
			},
		}),
		scim({
			connections: [],
			managedConnections: {
				credentialHashSecret: "cli-only-placeholder-secret-0123456789abcdef",
			},
			projection: { reconcileUser: () => {} },
		}),
		oauthProvider({
			loginPage: "/mcp/authorize",
			consentPage: "/mcp/authorize",
			disableJwtPlugin: true,
			storeClientSecret: {
				encrypt: (value) => value,
				decrypt: (value) => value,
			},
		}),
		admin(),
	],
});
