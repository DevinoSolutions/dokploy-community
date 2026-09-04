# Remote MCP Server with OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dokploy serves MCP over Streamable HTTP at `POST /api/mcp`, protected by OAuth 2.1 (PKCE + dynamic client registration) with per-grant scope toggles, so Claude Code sessions connect over HTTPS with no local process and no API key.

**Architecture:** better-auth 1.6.23's in-core `mcp` plugin is the OAuth server (DCR, token, refresh). The fork owns discovery documents, a consent page with scope toggles (protected by an HMAC consent proof the plugin's authorize endpoint requires), a tool registry derived from `appRouter`, and a stateless MCP endpoint that executes tools through a tRPC caller with a synthesized member session. Three new tables (migration 0198), a `mcp` tRPC router, and a Settings → Profile card complete it.

**Tech Stack:** Next.js 16 pages router, tRPC v11, better-auth 1.6.23 (`mcp` plugin from `better-auth/plugins`), `@modelcontextprotocol/sdk` 1.x (low-level `Server` + `StreamableHTTPServerTransport`), zod 4 (`z.toJSONSchema`), drizzle-orm 0.45, vitest 4, node-schedule.

Spec: `docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md`. Branch: `feat/remote-mcp-oauth` (already exists, branched from `canary`).

---

## Conventions for every task

- Work on branch `feat/remote-mcp-oauth`. Use `git.exe` explicitly on this machine (a shell hook mangles plain `git` output).
- Commits are authored `AminDhouib <amin@devino.ca>` (repo default). No AI attribution, no `Co-Authored-By`.
- Tab indentation, double quotes, trailing commas (Biome). Format only the files you touched: `pnpm exec biome format --write <file...>` from `apps/dokploy` or `packages/server`. **Never run `biome check` on the whole repo** (it rewrites ~800 files).
- Tests: `cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts <path>`. Typecheck: `cd apps/dokploy && pnpm typecheck` and `cd packages/server && pnpm typecheck`.
- `__test__/setup.ts` globally mocks `@dokploy/server/db`: every `db.query.<table>.findFirst/findMany` is the **same** `vi.fn` (a Proxy returns one shared mock object for every table). When a code path issues several queries, use `mockResolvedValueOnce` in call order.
- Imports inside `packages/server` are relative (`../db`, `../db/schema`). Imports inside `apps/dokploy` use `@/…` and `@dokploy/server/…`.

## File map

| File | Responsibility |
| --- | --- |
| `docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md` | Spec (amend with 3 deviations in Task 1) |
| `packages/server/src/db/schema/mcp-oauth.ts` | Drizzle tables `oauthApplication`, `oauthAccessToken`, `oauthConsent` |
| `apps/dokploy/drizzle/0198_*.sql` + `meta/` | Guarded migration |
| `docs/UPSTREAM_SYNC.md` | Ledger rows for fork-owned tables |
| `packages/server/src/services/mcp-oauth.ts` | Env knobs, origin resolution, redirect-URI policy, default-org resolution, token lookup, consent proof, token hygiene, authorization listing/revoke, purge cron |
| `packages/server/src/lib/auth.ts` | `buildMemberSession`, `mcp` plugin registration, before/after hooks |
| `apps/dokploy/server/mcp/scopes.ts` | Scope catalogue + tool→scope rules |
| `apps/dokploy/server/mcp/registry.ts` | Tool registry derived from `appRouter` |
| `apps/dokploy/server/mcp/handler.ts` | Bearer auth, 401 payload, tool execution, per-request MCP `Server` |
| `apps/dokploy/server/mcp/discovery.ts` | Discovery metadata builders |
| `apps/dokploy/pages/api/mcp.ts` | MCP endpoint |
| `apps/dokploy/pages/api/mcp-oauth/authorization-server.ts`, `protected-resource.ts` | Discovery endpoints (targets of `.well-known` rewrites) |
| `apps/dokploy/next.config.mjs` | Rewrites |
| `apps/dokploy/lib/post-login-redirect.ts` + `pages/index.tsx` | Login return path |
| `apps/dokploy/pages/mcp/authorize.tsx` | Consent page with scope toggles |
| `apps/dokploy/server/api/routers/mcp.ts` + `root.ts` | `mcp` tRPC router |
| `apps/dokploy/components/dashboard/settings/mcp/mcp-server.tsx` + `pages/dashboard/settings/profile.tsx` | Settings card |
| `apps/dokploy/server/server.ts` | Purge cron registration |
| `apps/dokploy/__test__/mcp/*.test.ts` | All new tests |

---

### Task 1: Spec amendments and dependency install

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md`
- Modify: `apps/dokploy/package.json` (via pnpm)

- [ ] **Step 1: Append an "Amendments (implementation)" section to the spec**

Add at the end of the spec file:

```markdown
## Amendments (2026-09-04, implementation)

1. **Discovery documents are served by fork-owned Next API routes, not by the
   plugin.** The plugin's `/.well-known/*` endpoints require a global string
   `baseURL`, and setting one changes every better-auth redirect/callback URL
   (social sign-in, SSO) for installs whose users reach Dokploy on more than
   one host. Instead `/.well-known/oauth-authorization-server`,
   `/.well-known/openid-configuration` and
   `/.well-known/oauth-protected-resource(/…)` rewrite to
   `/api/mcp-oauth/authorization-server` and `/api/mcp-oauth/protected-resource`,
   which build the documents from the resolved MCP origin (`BETTER_AUTH_URL`,
   else `https://<webServerSettings.host>`, else in development `http://<Host header>`,
   else 503). The plugin's own discovery paths and `/oauth2/consent` are added to
   `disabledPaths`. No `baseURL` is set.
2. **Consent proof.** The plugin's `/api/auth/mcp/authorize` issues a code
   without consent, so a crafted link could grant scopes silently. A `before`
   hook on that path now (a) redirects unauthenticated requests to the fork's
   `/mcp/authorize` page (never letting the plugin set its login-resume cookie),
   and (b) requires a `consent` query parameter: an HMAC (better-auth secret)
   over `userId|client_id|redirect_uri|state|code_challenge|scope|exp`, valid
   5 minutes, minted by the `mcp.approveAuthorization` tRPC mutation that the
   consent page calls when the user clicks Authorize. Any mismatch → 400
   `consent_required`.
3. **Toggle pre-selection.** Toggles shown = requested Dokploy scopes (all of
   them when the client requests none); initially checked = shown ∩ default-on.
   A client that requests every scope therefore still starts with delete/admin
   off.
```

- [ ] **Step 2: Install the MCP SDK in the web app**

Run from repo root:

```bash
pnpm add @modelcontextprotocol/sdk@^1.30.0 --filter dokploy
```

Expected: `apps/dokploy/package.json` gains `"@modelcontextprotocol/sdk": "^1.30.0"` under `dependencies`; `pnpm-lock.yaml` updated.

- [ ] **Step 3: Confirm the SDK import paths exist**

Run:

```bash
ls apps/dokploy/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js apps/dokploy/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js apps/dokploy/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js
```

Expected: all three paths print. The imports used later are `@modelcontextprotocol/sdk/server/index.js`, `@modelcontextprotocol/sdk/server/streamableHttp.js`, `@modelcontextprotocol/sdk/types.js`. Also open `apps/dokploy/node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStatelessStreamableHttp.js` and confirm the per-request pattern (`new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `res.on("close", …)`, `server.connect(transport)`, `transport.handleRequest(req, res, body)`). If the signature differs, adapt Task 9 accordingly.

- [ ] **Step 4: Commit**

```bash
git.exe add docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md apps/dokploy/package.json pnpm-lock.yaml
git.exe commit -m "chore(mcp): add @modelcontextprotocol/sdk and record spec amendments"
```

---

### Task 2: OAuth tables and migration 0198

**Files:**
- Create: `packages/server/src/db/schema/mcp-oauth.ts`
- Modify: `packages/server/src/db/schema/index.ts`
- Create: `apps/dokploy/drizzle/0198_<generated>.sql` (+ `meta/0198_snapshot.json`, `meta/_journal.json`)
- Modify: `docs/UPSTREAM_SYNC.md`

- [ ] **Step 1: Write the schema**

`packages/server/src/db/schema/mcp-oauth.ts`:

```ts
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
```

- [ ] **Step 2: Export it from the schema barrel**

In `packages/server/src/db/schema/index.ts` add, keeping alphabetical order (after `./mariadb`):

```ts
export * from "./mcp-oauth";
```

- [ ] **Step 3: Generate the migration**

Run from `apps/dokploy`:

```bash
pnpm migration:generate
```

Expected: a new file `apps/dokploy/drizzle/0198_<adjective_name>.sql` containing three `CREATE TABLE`, three `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` groups (5 FKs total), and five `CREATE INDEX`; `drizzle/meta/_journal.json` gains `idx: 198` with a `when` greater than `1788193120296`; `drizzle/meta/0198_snapshot.json` created. If the generator also emits unrelated `ALTER`/`DROP` statements, stop: the schema TS has drifted from the snapshot — investigate before continuing.

- [ ] **Step 4: Hand-guard the SQL**

Replace the generated file's content with the idempotent form (keep the generated file name). Every statement is separated by `--> statement-breakpoint` exactly as drizzle emits. Use the constraint and index names drizzle generated (read them from the generated file before overwriting):

```sql
CREATE TABLE IF NOT EXISTS "oauth_application" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"icon" text,
	"metadata" text,
	"client_id" text NOT NULL,
	"client_secret" text,
	"redirect_urls" text NOT NULL,
	"type" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"user_id" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "oauth_application_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"access_token_expires_at" timestamp NOT NULL,
	"refresh_token_expires_at" timestamp,
	"client_id" text NOT NULL,
	"user_id" text,
	"scopes" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "oauth_access_token_access_token_unique" UNIQUE("access_token"),
	CONSTRAINT "oauth_access_token_refresh_token_unique" UNIQUE("refresh_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"consent_given" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_application" ADD CONSTRAINT "oauth_application_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_application_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_application"("client_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_application_user_id_idx" ON "oauth_application" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_client_id_idx" ON "oauth_access_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_user_id_idx" ON "oauth_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_client_id_idx" ON "oauth_consent" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_user_id_idx" ON "oauth_consent" USING btree ("user_id");
```

Verify the file uses LF line endings (`.gitattributes` enforces it on commit; `file apps/dokploy/drizzle/0198_*.sql` must not say CRLF).

- [ ] **Step 5: Record the tables in the sync ledger**

In `docs/UPSTREAM_SYNC.md`, after the "Fork columns on upstream-owned tables" table, add a new subsection:

```markdown
### Fork-owned tables (schema ledger)

Whole tables that exist only in the fork. On a sync, keep the schema file and
make sure the regenerated migration does not `DROP` them.

| Table | Schema file | Feature | Landed in |
|---|---|---|---|
| `oauth_application`, `oauth_access_token`, `oauth_consent` | `packages/server/src/db/schema/mcp-oauth.ts` | remote MCP server OAuth (better-auth `mcp` plugin storage) | `0198` |
```

- [ ] **Step 6: Typecheck the server package and commit**

```bash
cd packages/server && pnpm typecheck
```

Expected: no errors. Then:

```bash
git.exe add packages/server/src/db/schema/mcp-oauth.ts packages/server/src/db/schema/index.ts apps/dokploy/drizzle docs/UPSTREAM_SYNC.md
git.exe commit -m "feat(mcp): add OAuth application/token/consent tables (migration 0198)"
```

---

### Task 3: `mcp-oauth` service — env knobs, origin, redirect policy, default organization

**Files:**
- Create: `packages/server/src/services/mcp-oauth.ts`
- Modify: `packages/server/src/index.ts`
- Test: `apps/dokploy/__test__/mcp/mcp-oauth-service.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/dokploy/__test__/mcp/mcp-oauth-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(async () => webServerSettingsRow),
}));

let webServerSettingsRow: { host?: string | null } | undefined;

const { db } = await import("@dokploy/server/db");
const {
	getMcpAccessTokenSeconds,
	getMcpRefreshTokenSeconds,
	isAllowedRedirectUri,
	isMcpDisabled,
	resolveDefaultOrganizationId,
	resolveMcpOrigin,
} = await import("@dokploy/server/services/mcp-oauth");

const findFirst = vi.mocked(db.query.member.findFirst);

// The vitest config statically `define`s `process.env`, so tests pass an
// explicit env object instead of mutating process.env.
describe("mcp-oauth env knobs", () => {
	it("defaults to 24h access / 180d refresh", () => {
		expect(getMcpAccessTokenSeconds({})).toBe(24 * 3600);
		expect(getMcpRefreshTokenSeconds({})).toBe(180 * 86400);
	});

	it("honours positive integer overrides and ignores garbage", () => {
		expect(
			getMcpAccessTokenSeconds({ DOKPLOY_MCP_ACCESS_TOKEN_HOURS: "6" }),
		).toBe(6 * 3600);
		expect(
			getMcpRefreshTokenSeconds({ DOKPLOY_MCP_REFRESH_TOKEN_DAYS: "-3" }),
		).toBe(180 * 86400);
	});

	it("isMcpDisabled only for the literal string true", () => {
		expect(isMcpDisabled({ DOKPLOY_MCP_DISABLED: "true" })).toBe(true);
		expect(isMcpDisabled({ DOKPLOY_MCP_DISABLED: "1" })).toBe(false);
		expect(isMcpDisabled({})).toBe(false);
	});
});

describe("isAllowedRedirectUri", () => {
	it.each([
		"http://localhost/callback",
		"http://localhost:53421/callback",
		"http://127.0.0.1:8080/cb",
		"https://example.com/oauth/callback",
	])("allows %s", (uri) => {
		expect(isAllowedRedirectUri(uri)).toBe(true);
	});

	it.each([
		"http://example.com/callback",
		"http://localhost.evil.com/callback",
		"javascript:alert(1)",
		"custom-app://callback",
		"not a url",
		"",
	])("rejects %s", (uri) => {
		expect(isAllowedRedirectUri(uri)).toBe(false);
	});
});

describe("resolveMcpOrigin", () => {
	beforeEach(() => {
		webServerSettingsRow = undefined;
	});

	it("prefers BETTER_AUTH_URL (origin only)", async () => {
		webServerSettingsRow = { host: "other.example.com" };
		expect(
			await resolveMcpOrigin({}, { BETTER_AUTH_URL: "https://dok.example.com/api/auth" }),
		).toBe("https://dok.example.com");
	});

	it("falls back to https://<webServerSettings.host>", async () => {
		webServerSettingsRow = { host: "dok.example.com" };
		expect(await resolveMcpOrigin({}, {})).toBe("https://dok.example.com");
	});

	it("returns null when nothing is configured outside development", async () => {
		webServerSettingsRow = { host: null };
		expect(
			await resolveMcpOrigin({ host: "1.2.3.4:3000" }, { NODE_ENV: "production" }),
		).toBeNull();
	});

	it("uses the Host header in development only", async () => {
		webServerSettingsRow = { host: null };
		expect(
			await resolveMcpOrigin({ host: "localhost:3000" }, { NODE_ENV: "development" }),
		).toBe("http://localhost:3000");
	});
});

describe("resolveDefaultOrganizationId", () => {
	beforeEach(() => {
		findFirst.mockReset();
	});

	it("returns the organization of the first membership row (ordered is_default desc, created_at asc)", async () => {
		findFirst.mockResolvedValueOnce({ organizationId: "org-default" } as never);
		expect(await resolveDefaultOrganizationId("user-1")).toBe("org-default");
		const call = findFirst.mock.calls[0]?.[0] as { orderBy?: unknown[] };
		expect(call.orderBy).toHaveLength(2);
	});

	it("returns null without a membership", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await resolveDefaultOrganizationId("user-1")).toBeNull();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/mcp-oauth-service.test.ts
```

Expected: FAIL — cannot resolve `@dokploy/server/services/mcp-oauth`.

- [ ] **Step 3: Write the service (first half)**

`packages/server/src/services/mcp-oauth.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { and, asc, desc, eq, isNull, lt, or } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../db";
import {
	member,
	oauthAccessToken,
	oauthApplication,
	organization,
} from "../db/schema";
import { betterAuthSecret } from "../lib/auth-secret";
import { getWebServerSettings } from "./web-server-settings";

/** Path of the MCP endpoint relative to the origin. */
export const MCP_ENDPOINT_PATH = "/api/mcp";
/** Path of the fork's consent page relative to the origin. */
export const MCP_AUTHORIZE_PAGE_PATH = "/mcp/authorize";
/** Path of the plugin's authorize endpoint relative to the origin. */
export const MCP_PLUGIN_AUTHORIZE_PATH = "/api/auth/mcp/authorize";

/** Scope ids the MCP OAuth server accepts. The catalogue with labels lives in apps/dokploy/server/mcp/scopes.ts. */
export const DOKPLOY_MCP_SCOPE_IDS = [
	"dokploy:read",
	"dokploy:deploy",
	"dokploy:services:write",
	"dokploy:services:delete",
	"dokploy:projects:write",
	"dokploy:projects:delete",
	"dokploy:backups",
	"dokploy:admin",
] as const;
export type DokployMcpScope = (typeof DOKPLOY_MCP_SCOPE_IDS)[number];

const DEFAULT_ACCESS_TOKEN_HOURS = 24;
const DEFAULT_REFRESH_TOKEN_DAYS = 180;

/** Env reads take an explicit env object so tests never mutate process.env. */
type Env = Record<string, string | undefined>;

const positiveIntEnv = (env: Env, name: string, fallback: number) => {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Access-token lifetime in seconds (DOKPLOY_MCP_ACCESS_TOKEN_HOURS, default 24). */
export const getMcpAccessTokenSeconds = (env: Env = process.env) =>
	positiveIntEnv(env, "DOKPLOY_MCP_ACCESS_TOKEN_HOURS", DEFAULT_ACCESS_TOKEN_HOURS) *
	3600;

/** Refresh-token lifetime in seconds (DOKPLOY_MCP_REFRESH_TOKEN_DAYS, default 180). Slides on every refresh. */
export const getMcpRefreshTokenSeconds = (env: Env = process.env) =>
	positiveIntEnv(env, "DOKPLOY_MCP_REFRESH_TOKEN_DAYS", DEFAULT_REFRESH_TOKEN_DAYS) *
	86400;

/** Kill switch: DOKPLOY_MCP_DISABLED=true removes the endpoint and the purge job. */
export const isMcpDisabled = (env: Env = process.env) =>
	env.DOKPLOY_MCP_DISABLED === "true";

/**
 * Public origin used in discovery documents and the `WWW-Authenticate` header.
 * Deterministic on purpose (never trusts the Host header in production) so a
 * spoofed header cannot rewrite the issuer a client records.
 */
export const resolveMcpOrigin = async (
	headers: IncomingHttpHeaders,
	env: Env = process.env,
): Promise<string | null> => {
	const fromEnv = env.BETTER_AUTH_URL;
	if (fromEnv) {
		try {
			return new URL(fromEnv).origin;
		} catch {
			// fall through to the configured host
		}
	}
	const settings = await getWebServerSettings();
	if (settings?.host) {
		return `https://${settings.host}`;
	}
	if (env.NODE_ENV === "development" && headers.host) {
		return `http://${headers.host}`;
	}
	return null;
};

/**
 * Dynamic client registration is anonymous, so restrict where authorization
 * codes may be sent: loopback over http (Claude Code and other CLIs) or https.
 */
export const isAllowedRedirectUri = (uri: string): boolean => {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return false;
	}
	if (parsed.protocol === "https:") return true;
	if (parsed.protocol !== "http:") return false;
	return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
};

/**
 * Organization an MCP grant acts in: the member row flagged `is_default`,
 * else the user's earliest membership, else null (→ 401 at the endpoint).
 */
export const resolveDefaultOrganizationId = async (
	userId: string,
): Promise<string | null> => {
	const row = await db.query.member.findFirst({
		where: eq(member.userId, userId),
		orderBy: [desc(member.isDefault), asc(member.createdAt)],
		columns: { organizationId: true },
	});
	return row?.organizationId ?? null;
};

export const findOrganizationName = async (organizationId: string) => {
	const row = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { id: true, name: true },
	});
	return row ?? null;
};
```

(The rest of the file — token lookup, consent proof, hygiene, listing — is added in Task 4. The import block above already lists everything Task 4 needs (`createHmac`, `timingSafeEqual`, `isNull`, `lt`, `or`, `scheduleJob`, `oauthAccessToken`, `oauthApplication`, `betterAuthSecret`, `and`); unused imports are a Biome lint warning, not a tsc error — proceed.)

- [ ] **Step 4: Export from the barrel**

In `packages/server/src/index.ts`, add in alphabetical position among the `./services/*` exports:

```ts
export * from "./services/mcp-oauth";
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/mcp-oauth-service.test.ts
```

Expected: PASS (all describe blocks).

- [ ] **Step 6: Commit**

```bash
git.exe add packages/server/src/services/mcp-oauth.ts packages/server/src/index.ts apps/dokploy/__test__/mcp/mcp-oauth-service.test.ts
git.exe commit -m "feat(mcp): mcp-oauth service — env knobs, origin, redirect policy, default organization"
```

---

### Task 4: `mcp-oauth` service — token lookup, consent proof, hygiene, authorizations

**Files:**
- Modify: `packages/server/src/services/mcp-oauth.ts`
- Test: `apps/dokploy/__test__/mcp/mcp-oauth-tokens.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/dokploy/__test__/mcp/mcp-oauth-tokens.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const {
	createConsentProof,
	findMcpAccessToken,
	verifyConsentProof,
} = await import("@dokploy/server/services/mcp-oauth");

const findFirst = vi.mocked(db.query.oauthAccessToken.findFirst);

const basePayload = {
	userId: "user-1",
	clientId: "client-1",
	redirectUri: "http://localhost:1234/callback",
	state: "abc",
	codeChallenge: "chal",
	scope: "openid offline_access dokploy:read",
};

describe("consent proof", () => {
	it("round-trips and tolerates scope order", () => {
		const proof = createConsentProof(basePayload, "secret");
		expect(
			verifyConsentProof(
				proof,
				{ ...basePayload, scope: "dokploy:read openid offline_access" },
				"secret",
			),
		).toBe(true);
	});

	it("rejects a changed field, a bad signature, and an expired proof", () => {
		const proof = createConsentProof(basePayload, "secret");
		expect(
			verifyConsentProof(proof, { ...basePayload, userId: "user-2" }, "secret"),
		).toBe(false);
		expect(
			verifyConsentProof(
				proof,
				{ ...basePayload, scope: "openid offline_access dokploy:admin" },
				"secret",
			),
		).toBe(false);
		expect(verifyConsentProof(proof, basePayload, "other-secret")).toBe(false);
		const expired = createConsentProof(basePayload, "secret", Date.now() - 1000);
		expect(verifyConsentProof(expired, basePayload, "secret")).toBe(false);
		expect(verifyConsentProof("garbage", basePayload, "secret")).toBe(false);
	});
});

describe("findMcpAccessToken", () => {
	beforeEach(() => findFirst.mockReset());

	it("returns null for unknown or expired tokens", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		expect(await findMcpAccessToken("nope")).toBeNull();
		findFirst.mockResolvedValueOnce({
			accessToken: "t",
			accessTokenExpiresAt: new Date(Date.now() - 1),
			userId: "user-1",
			clientId: "c",
			scopes: "openid",
		} as never);
		expect(await findMcpAccessToken("t")).toBeNull();
	});

	it("returns userId, clientId and the scope list for a live token", async () => {
		findFirst.mockResolvedValueOnce({
			accessToken: "t",
			accessTokenExpiresAt: new Date(Date.now() + 60_000),
			userId: "user-1",
			clientId: "client-1",
			scopes: "openid offline_access dokploy:read dokploy:deploy",
		} as never);
		expect(await findMcpAccessToken("t")).toEqual({
			userId: "user-1",
			clientId: "client-1",
			scopes: ["openid", "offline_access", "dokploy:read", "dokploy:deploy"],
		});
	});

	it("returns null for an empty token without querying", async () => {
		expect(await findMcpAccessToken("")).toBeNull();
		expect(findFirst).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/mcp-oauth-tokens.test.ts
```

Expected: FAIL — `createConsentProof is not a function` (or similar).

- [ ] **Step 3: Append the second half of the service**

Append to `packages/server/src/services/mcp-oauth.ts`:

```ts
// ---------------------------------------------------------------------------
// Bearer tokens
// ---------------------------------------------------------------------------

export interface McpAccessToken {
	userId: string;
	clientId: string;
	scopes: string[];
}

/** Opaque access-token lookup. Null for missing, expired or user-less rows. */
export const findMcpAccessToken = async (
	accessToken: string,
): Promise<McpAccessToken | null> => {
	if (!accessToken) return null;
	const row = await db.query.oauthAccessToken.findFirst({
		where: eq(oauthAccessToken.accessToken, accessToken),
		columns: {
			userId: true,
			clientId: true,
			scopes: true,
			accessTokenExpiresAt: true,
		},
	});
	if (!row || !row.userId) return null;
	if (row.accessTokenExpiresAt.getTime() <= Date.now()) return null;
	return {
		userId: row.userId,
		clientId: row.clientId,
		scopes: row.scopes.split(" ").filter(Boolean),
	};
};

export const findOAuthApplicationByClientId = async (clientId: string) => {
	if (!clientId) return null;
	const row = await db.query.oauthApplication.findFirst({
		where: eq(oauthApplication.clientId, clientId),
		columns: {
			clientId: true,
			name: true,
			redirectUrls: true,
			disabled: true,
		},
	});
	if (!row) return null;
	return {
		clientId: row.clientId,
		name: row.name || "Unnamed client",
		redirectUrls: row.redirectUrls.split(",").filter(Boolean),
		disabled: row.disabled,
	};
};

// ---------------------------------------------------------------------------
// Consent proof — binds the plugin's authorize call to a consent-page approval
// ---------------------------------------------------------------------------

export interface ConsentProofPayload {
	userId: string;
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	/** Space-separated scope string; compared as a sorted set. */
	scope: string;
}

const CONSENT_PROOF_TTL_MS = 5 * 60 * 1000;

const canonicalScope = (scope: string) =>
	scope.split(" ").filter(Boolean).sort().join(" ");

const consentProofMessage = (payload: ConsentProofPayload, exp: number) =>
	[
		payload.userId,
		payload.clientId,
		payload.redirectUri,
		payload.state,
		payload.codeChallenge,
		canonicalScope(payload.scope),
		String(exp),
	].join("|");

const sign = (message: string, secret: string) =>
	createHmac("sha256", secret).update(message).digest("base64url");

/**
 * `<exp>.<signature>` — the signature covers every OAuth parameter the
 * plugin will act on plus the approving user, so the proof cannot be replayed
 * for another client, redirect, scope set, or user.
 */
export const createConsentProof = (
	payload: ConsentProofPayload,
	secret: string = betterAuthSecret,
	expiresAt: number = Date.now() + CONSENT_PROOF_TTL_MS,
): string => `${expiresAt}.${sign(consentProofMessage(payload, expiresAt), secret)}`;

export const verifyConsentProof = (
	proof: string,
	expected: ConsentProofPayload,
	secret: string = betterAuthSecret,
): boolean => {
	const dot = proof.indexOf(".");
	if (dot <= 0) return false;
	const exp = Number.parseInt(proof.slice(0, dot), 10);
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const given = Buffer.from(proof.slice(dot + 1));
	const wanted = Buffer.from(sign(consentProofMessage(expected, exp), secret));
	return given.length === wanted.length && timingSafeEqual(given, wanted);
};

// ---------------------------------------------------------------------------
// Token hygiene
// ---------------------------------------------------------------------------

/** Called after a successful refresh: the consumed refresh token must die. */
export const deleteConsumedRefreshToken = async (refreshToken: string) => {
	if (!refreshToken) return;
	await db
		.delete(oauthAccessToken)
		.where(eq(oauthAccessToken.refreshToken, refreshToken));
};

/**
 * Removes rows that can never be used again: refresh window closed, or no
 * refresh token and the access token expired.
 */
export const purgeExpiredMcpTokens = async () => {
	const now = new Date();
	await db
		.delete(oauthAccessToken)
		.where(
			or(
				lt(oauthAccessToken.refreshTokenExpiresAt, now),
				and(
					isNull(oauthAccessToken.refreshToken),
					lt(oauthAccessToken.accessTokenExpiresAt, now),
				),
			),
		);
};

/** Daily purge; registered from server.ts when MCP is enabled. */
export const initMcpTokenPurgeCronJob = () => {
	scheduleJob("mcp-token-purge", "23 4 * * *", async () => {
		try {
			await purgeExpiredMcpTokens();
		} catch (error) {
			console.error("[mcp] token purge failed", error);
		}
	});
};

// ---------------------------------------------------------------------------
// Authorizations (settings card)
// ---------------------------------------------------------------------------

export interface McpAuthorization {
	clientId: string;
	clientName: string;
	scopes: string[];
	authorizedAt: Date;
	lastRefreshedAt: Date;
	refreshExpiresAt: Date | null;
	tokenCount: number;
}

/** One row per client the user has authorized, newest token wins for scopes. */
export const listMcpAuthorizations = async (
	userId: string,
): Promise<McpAuthorization[]> => {
	const rows = await db.query.oauthAccessToken.findMany({
		where: eq(oauthAccessToken.userId, userId),
		orderBy: [asc(oauthAccessToken.createdAt)],
		with: { application: { columns: { name: true } } },
	});
	const byClient = new Map<string, McpAuthorization>();
	for (const row of rows) {
		const existing = byClient.get(row.clientId);
		const scopes = row.scopes
			.split(" ")
			.filter((scope) => scope.startsWith("dokploy:"));
		if (!existing) {
			byClient.set(row.clientId, {
				clientId: row.clientId,
				clientName: row.application?.name || "Unnamed client",
				scopes,
				authorizedAt: row.createdAt,
				lastRefreshedAt: row.createdAt,
				refreshExpiresAt: row.refreshTokenExpiresAt,
				tokenCount: 1,
			});
			continue;
		}
		existing.scopes = scopes;
		existing.lastRefreshedAt = row.createdAt;
		existing.refreshExpiresAt = row.refreshTokenExpiresAt;
		existing.tokenCount += 1;
	}
	return [...byClient.values()];
};

/** Deletes every token for client+user; the client's next call gets 401. */
export const revokeMcpAuthorization = async (
	userId: string,
	clientId: string,
) => {
	await db
		.delete(oauthAccessToken)
		.where(
			and(
				eq(oauthAccessToken.userId, userId),
				eq(oauthAccessToken.clientId, clientId),
			),
		);
};
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/
```

Expected: PASS for both files.

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/server && pnpm typecheck
```

Expected: clean. Then:

```bash
git.exe add packages/server/src/services/mcp-oauth.ts apps/dokploy/__test__/mcp/mcp-oauth-tokens.test.ts
git.exe commit -m "feat(mcp): token lookup, consent proof, token hygiene and authorization listing"
```

---

### Task 5: `buildMemberSession` extraction

**Files:**
- Modify: `packages/server/src/lib/auth.ts` (the `validateRequest` API-key branch, lines ~640–690)
- Test: `apps/dokploy/__test__/mcp/build-member-session.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/dokploy/__test__/mcp/build-member-session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = await import("@dokploy/server/db");
const { buildMemberSession } = await import("@dokploy/server/lib/auth");

const findFirst = vi.mocked(db.query.member.findFirst);

const userRow = {
	id: "user-1",
	firstName: "Ada",
	lastName: "L",
	email: "ada@example.com",
	emailVerified: true,
	image: null,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-02"),
	twoFactorEnabled: false,
	enableEnterpriseFeatures: false,
	isValidEnterpriseLicense: false,
};

describe("buildMemberSession", () => {
	beforeEach(() => findFirst.mockReset());

	it("maps the user row and member role into the tRPC session shape", async () => {
		findFirst.mockResolvedValueOnce({
			role: "admin",
			organization: { ownerId: "owner-9" },
		} as never);
		const result = await buildMemberSession(userRow as never, "org-1");
		expect(result.session).toEqual({
			userId: "user-1",
			activeOrganizationId: "org-1",
		});
		expect(result.user).toMatchObject({
			id: "user-1",
			name: "Ada",
			email: "ada@example.com",
			role: "admin",
			ownerId: "owner-9",
		});
	});

	it("falls back to member/self-owner when no member row exists", async () => {
		findFirst.mockResolvedValueOnce(undefined as never);
		const result = await buildMemberSession(userRow as never, "org-1");
		expect(result.user.role).toBe("member");
		expect(result.user.ownerId).toBe("user-1");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/build-member-session.test.ts
```

Expected: FAIL — `buildMemberSession` is not exported.

- [ ] **Step 3: Extract the function**

In `packages/server/src/lib/auth.ts`, directly above `export const validateRequest`, add:

```ts
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
```

Then in the API-key branch of `validateRequest`, replace everything from `const member = await db.query.member.findFirst({` down to `return mockSession;` (inclusive) with:

```ts
			return await buildMemberSession(apiKeyRecord.user, organizationId);
```

(The `userFromDb` cast and the `mockSession` literal are gone. Behaviour is identical: same queries, same shape.)

- [ ] **Step 4: Run the test and the existing suite that touches validateRequest**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/build-member-session.test.ts __test__/permissions
```

Expected: PASS.

- [ ] **Step 5: Typecheck both packages and commit**

```bash
cd packages/server && pnpm typecheck && cd ../../apps/dokploy && pnpm typecheck
git.exe add packages/server/src/lib/auth.ts apps/dokploy/__test__/mcp/build-member-session.test.ts
git.exe commit -m "refactor(auth): extract buildMemberSession from the API-key branch"
```

---

### Task 6: Register the better-auth `mcp` plugin with DCR, consent and rotation hooks

**Files:**
- Modify: `packages/server/src/lib/auth.ts`

- [ ] **Step 1: Add imports**

At the top of `packages/server/src/lib/auth.ts`:

```ts
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, mcp, organization, twoFactor } from "better-auth/plugins";
```

(These replace the existing `APIError, createAuthMiddleware` and `admin, organization, twoFactor` import lines.) Also add:

```ts
import {
	deleteConsumedRefreshToken,
	getMcpAccessTokenSeconds,
	getMcpRefreshTokenSeconds,
	isAllowedRedirectUri,
	MCP_AUTHORIZE_PAGE_PATH,
	MCP_ENDPOINT_PATH,
	verifyConsentProof,
} from "../services/mcp-oauth";
```

`DOKPLOY_MCP_SCOPE_IDS` was defined in `packages/server/src/services/mcp-oauth.ts` in Task 3 (`packages/server` must not import from `apps/dokploy`, so the id list lives server-side and the labelled catalogue in Task 7 imports it). Add it to the import list above.

- [ ] **Step 2: Add the plugin's discovery/consent paths to `disabledPaths`**

In `createBetterAuth`, extend the `disabledPaths` array:

```ts
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
```

- [ ] **Step 3: Extend the `before` hook and add an `after` hook**

Replace the existing `hooks: { before: … }` block with:

```ts
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
```

- [ ] **Step 4: Register the plugin**

In the `plugins: [...]` array, after `passkey(),` add:

```ts
			// Remote MCP endpoint OAuth server (see docs/superpowers/specs/2026-09-04-remote-mcp-oauth-design.md).
			// Discovery is served by the fork (apps/dokploy/pages/api/mcp-oauth/*), so no baseURL is set here.
			mcp({
				loginPage: MCP_AUTHORIZE_PAGE_PATH,
				resource: MCP_ENDPOINT_PATH,
				oidcConfig: {
					accessTokenExpiresIn: getMcpAccessTokenSeconds(),
					refreshTokenExpiresIn: getMcpRefreshTokenSeconds(),
					requirePKCE: true,
					defaultScope: ["openid", "offline_access", ...DOKPLOY_MCP_SCOPE_IDS].join(
						" ",
					),
					scopes: [...DOKPLOY_MCP_SCOPE_IDS],
				},
			}),
```

- [ ] **Step 5: Typecheck**

```bash
cd packages/server && pnpm typecheck
```

Expected: clean. If `ctx.redirect` is not on the middleware context type, use `throw new APIError("FOUND", { headers: { Location: url } })` — no, better-call exposes `ctx.redirect` on middleware contexts (the plugin's own after hook throws `ctx.redirect(...)` from a middleware); if tsc disagrees, cast: `throw (ctx as unknown as { redirect: (url: string) => Error }).redirect(url)` and leave a comment naming the plugin file that does the same.

If `getSessionFromCtx` is not exported from `better-auth/api`, import it from `better-auth/api` per `node_modules/better-auth/dist/api/index.d.mts` (it is listed there).

- [ ] **Step 6: Run the permissions suite to make sure auth still loads under the test db mock**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/permissions __test__/mcp
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git.exe add packages/server/src/lib/auth.ts packages/server/src/services/mcp-oauth.ts
git.exe commit -m "feat(mcp): register better-auth mcp plugin with DCR, consent-proof and refresh-rotation hooks"
```

---

### Task 7: Scope catalogue and tool→scope rules

**Files:**
- Create: `apps/dokploy/server/mcp/scopes.ts`
- Test: `apps/dokploy/__test__/mcp/scopes.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/dokploy/__test__/mcp/scopes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ON_SCOPES,
	DOKPLOY_SCOPES,
	isDokployScope,
	resolveToolScope,
} from "@/server/mcp/scopes";

const q = (routerName: string, procedureName: string) =>
	resolveToolScope({ routerName, procedureName, type: "query" });
const m = (routerName: string, procedureName: string) =>
	resolveToolScope({ routerName, procedureName, type: "mutation" });

describe("scope catalogue", () => {
	it("has 8 scopes with delete/admin off by default", () => {
		expect(DOKPLOY_SCOPES.map((s) => s.id)).toEqual([
			"dokploy:read",
			"dokploy:deploy",
			"dokploy:services:write",
			"dokploy:services:delete",
			"dokploy:projects:write",
			"dokploy:projects:delete",
			"dokploy:backups",
			"dokploy:admin",
		]);
		expect(DEFAULT_ON_SCOPES).not.toContain("dokploy:services:delete");
		expect(DEFAULT_ON_SCOPES).not.toContain("dokploy:projects:delete");
		expect(DEFAULT_ON_SCOPES).not.toContain("dokploy:admin");
		expect(isDokployScope("dokploy:read")).toBe(true);
		expect(isDokployScope("openid")).toBe(false);
	});
});

describe("resolveToolScope", () => {
	it("queries are always read, whatever the router", () => {
		expect(q("settings", "getDokployVersion")).toBe("dokploy:read");
		expect(q("application", "one")).toBe("dokploy:read");
		expect(q("user", "get")).toBe("dokploy:read");
	});

	it("service routers: deploy pattern, delete pattern, else write", () => {
		expect(m("application", "deploy")).toBe("dokploy:deploy");
		expect(m("compose", "redeploy")).toBe("dokploy:deploy");
		expect(m("postgres", "stop")).toBe("dokploy:deploy");
		expect(m("application", "killBuild")).toBe("dokploy:deploy");
		expect(m("rollback", "rollback")).toBe("dokploy:deploy");
		expect(m("previewDeployment", "redeploy")).toBe("dokploy:deploy");
		expect(m("docker", "restartContainer")).toBe("dokploy:deploy");
		expect(m("application", "delete")).toBe("dokploy:services:delete");
		expect(m("postgres", "remove")).toBe("dokploy:services:delete");
		expect(m("docker", "removeContainer")).toBe("dokploy:services:delete");
		expect(m("application", "update")).toBe("dokploy:services:write");
		expect(m("domain", "create")).toBe("dokploy:services:write");
		expect(m("application", "move")).toBe("dokploy:services:write");
	});

	it("explicit overrides beat the patterns", () => {
		expect(m("deployment", "removeDeployment")).toBe("dokploy:deploy");
		expect(m("deployment", "killProcess")).toBe("dokploy:deploy");
		expect(m("application", "clearDeployments")).toBe("dokploy:deploy");
		expect(m("application", "cleanQueues")).toBe("dokploy:deploy");
		expect(m("compose", "deployTemplate")).toBe("dokploy:services:write");
		expect(m("schedule", "runManually")).toBe("dokploy:deploy");
		expect(m("tag", "removeFromProject")).toBe("dokploy:services:write");
	});

	it("project routers split write/delete", () => {
		expect(m("project", "create")).toBe("dokploy:projects:write");
		expect(m("environment", "duplicate")).toBe("dokploy:projects:write");
		expect(m("project", "remove")).toBe("dokploy:projects:delete");
		expect(m("environment", "remove")).toBe("dokploy:projects:delete");
	});

	it("backup routers are one scope, admin routers and unknowns are admin", () => {
		expect(m("backup", "create")).toBe("dokploy:backups");
		expect(m("backup", "remove")).toBe("dokploy:backups");
		expect(m("volumeBackups", "runManually")).toBe("dokploy:backups");
		expect(m("destination", "update")).toBe("dokploy:backups");
		expect(m("settings", "cleanAll")).toBe("dokploy:admin");
		expect(m("server", "remove")).toBe("dokploy:admin");
		expect(m("user", "createApiKey")).toBe("dokploy:admin");
		expect(m("someFutureRouter", "doThing")).toBe("dokploy:admin");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/scopes.test.ts
```

Expected: FAIL — cannot resolve `@/server/mcp/scopes`.

- [ ] **Step 3: Write the module**

`apps/dokploy/server/mcp/scopes.ts`:

```ts
import {
	DOKPLOY_MCP_SCOPE_IDS,
	type DokployMcpScope,
} from "@dokploy/server/services/mcp-oauth";

export type { DokployMcpScope };

export interface ScopeDefinition {
	id: DokployMcpScope;
	label: string;
	description: string;
	defaultOn: boolean;
}

/** Order here is the order the consent page and settings card display. */
export const DOKPLOY_SCOPES: ScopeDefinition[] = [
	{
		id: "dokploy:read",
		label: "Read",
		description: "List and inspect projects, services, deployments, logs and settings.",
		defaultOn: true,
	},
	{
		id: "dokploy:deploy",
		label: "Deploy & lifecycle",
		description: "Deploy, redeploy, start, stop, restart, rebuild, roll back, cancel builds and clean deployment history.",
		defaultOn: true,
	},
	{
		id: "dokploy:services:write",
		label: "Edit services",
		description: "Create and update applications, compose stacks, databases, domains, ports, mounts, schedules, patches and tags.",
		defaultOn: true,
	},
	{
		id: "dokploy:services:delete",
		label: "Delete services",
		description: "Delete applications, compose stacks, databases, domains and other service resources.",
		defaultOn: false,
	},
	{
		id: "dokploy:projects:write",
		label: "Edit projects",
		description: "Create, update and duplicate projects and environments.",
		defaultOn: true,
	},
	{
		id: "dokploy:projects:delete",
		label: "Delete projects",
		description: "Delete projects and environments (and everything inside them).",
		defaultOn: false,
	},
	{
		id: "dokploy:backups",
		label: "Backups",
		description: "Manage backups, backup policies, volume backups and destinations, including manual runs and restores.",
		defaultOn: true,
	},
	{
		id: "dokploy:admin",
		label: "Administration",
		description: "Servers, cluster, Docker cleanup, SSH keys, registries, git providers, notifications, certificates, users, organization, roles and every other setting.",
		defaultOn: false,
	},
];

export const ALL_DOKPLOY_SCOPES: DokployMcpScope[] = [...DOKPLOY_MCP_SCOPE_IDS];
export const DEFAULT_ON_SCOPES: DokployMcpScope[] = DOKPLOY_SCOPES.filter(
	(scope) => scope.defaultOn,
).map((scope) => scope.id);

export const isDokployScope = (value: string): value is DokployMcpScope =>
	(DOKPLOY_MCP_SCOPE_IDS as readonly string[]).includes(value);

const SERVICE_ROUTERS = new Set([
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
	"domain",
	"port",
	"redirects",
	"security",
	"mounts",
	"previewDeployment",
	"schedule",
	"patch",
	"tag",
	"deployment",
	"rollback",
	"docker",
]);

const PROJECT_ROUTERS = new Set(["project", "environment"]);

const BACKUP_ROUTERS = new Set([
	"backup",
	"backupPolicy",
	"volumeBackups",
	"destination",
]);

/** `router.procedure` → scope, checked before every pattern. Keep small. */
const OVERRIDES: Record<string, DokployMcpScope> = {
	"deployment.removeDeployment": "dokploy:deploy",
	"deployment.killProcess": "dokploy:deploy",
	"application.clearDeployments": "dokploy:deploy",
	"application.cleanQueues": "dokploy:deploy",
	"application.dropDeployment": "dokploy:deploy",
	"compose.clearDeployments": "dokploy:deploy",
	"compose.cleanQueues": "dokploy:deploy",
	"compose.deployTemplate": "dokploy:services:write",
	"schedule.runManually": "dokploy:deploy",
	"tag.removeFromProject": "dokploy:services:write",
};

const DELETE_PATTERN = /^(delete|remove|drop|clear|clean)/i;
const DEPLOY_PATTERN =
	/^(deploy|redeploy|start|stop|restart|reload|rebuild|cancel|kill|rollback|changeStatus|markRunning)/i;

export interface ToolScopeInput {
	routerName: string;
	procedureName: string;
	type: "query" | "mutation";
}

/**
 * Rules, in order: override → query→read → router family (service/project/
 * backup) with delete/deploy patterns → everything else is admin (fail closed).
 */
export const resolveToolScope = ({
	routerName,
	procedureName,
	type,
}: ToolScopeInput): DokployMcpScope => {
	const override = OVERRIDES[`${routerName}.${procedureName}`];
	if (override) return override;
	if (type === "query") return "dokploy:read";
	if (SERVICE_ROUTERS.has(routerName)) {
		if (DELETE_PATTERN.test(procedureName)) return "dokploy:services:delete";
		if (DEPLOY_PATTERN.test(procedureName)) return "dokploy:deploy";
		return "dokploy:services:write";
	}
	if (PROJECT_ROUTERS.has(routerName)) {
		return DELETE_PATTERN.test(procedureName)
			? "dokploy:projects:delete"
			: "dokploy:projects:write";
	}
	if (BACKUP_ROUTERS.has(routerName)) return "dokploy:backups";
	return "dokploy:admin";
};

export const isDestructiveScope = (scope: DokployMcpScope) =>
	scope === "dokploy:services:delete" || scope === "dokploy:projects:delete";
```

- [ ] **Step 4: Run the test**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/scopes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git.exe add apps/dokploy/server/mcp/scopes.ts apps/dokploy/__test__/mcp/scopes.test.ts
git.exe commit -m "feat(mcp): scope catalogue and tool-to-scope rules"
```

---

### Task 8: Tool registry from `appRouter`

**Files:**
- Create: `apps/dokploy/server/mcp/registry.ts`
- Test: `apps/dokploy/__test__/mcp/registry.test.ts`
- Test: `apps/dokploy/__test__/mcp/scopes-snapshot.test.ts` (+ generated `__snapshots__/scopes-snapshot.test.ts.snap`)

- [ ] **Step 1: Write the failing registry test**

`apps/dokploy/__test__/mcp/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCallerFactory, createTRPCRouter, publicProcedure } from "@/server/api/trpc";
import { buildMcpToolRegistry, toolsForScopes } from "@/server/mcp/registry";

const sampleRouter = createTRPCRouter({
	application: createTRPCRouter({
		one: publicProcedure
			.input(z.object({ applicationId: z.string() }))
			.query(() => ({})),
		deploy: publicProcedure
			.meta({ openapi: { method: "POST", path: "/application.deploy", description: "Deploy an application" } })
			.input(z.object({ applicationId: z.string() }).optional())
			.mutation(() => ({})),
		delete: publicProcedure
			.input(z.object({ applicationId: z.string() }))
			.mutation(() => ({})),
		hidden: publicProcedure
			.meta({ openapi: { method: "POST", path: "/x", enabled: false } })
			.mutation(() => ({})),
		noInput: publicProcedure.query(() => ({})),
		scalarInput: publicProcedure.input(z.string()).query(() => ({})),
	}),
	mcp: createTRPCRouter({
		connectionInfo: publicProcedure.query(() => ({})),
	}),
});

// createCallerFactory is referenced so the import stays honest about the router type.
void createCallerFactory;

describe("buildMcpToolRegistry", () => {
	const tools = buildMcpToolRegistry(sampleRouter, { excludeRouters: ["mcp"] });
	const names = tools.map((tool) => tool.name);

	it("names tools router-procedure and skips excluded/hidden/non-object-input procedures", () => {
		expect(names).toEqual([
			"application-one",
			"application-deploy",
			"application-delete",
			"application-noInput",
		]);
	});

	it("uses the openapi description when present, else METHOD /router.procedure", () => {
		expect(tools.find((t) => t.name === "application-deploy")?.description).toBe(
			"Deploy an application",
		);
		expect(tools.find((t) => t.name === "application-one")?.description).toBe(
			"GET /application.one",
		);
		expect(tools.find((t) => t.name === "application-delete")?.description).toBe(
			"POST /application.delete",
		);
	});

	it("emits an object JSON schema with a single top-level 2020-12 $schema", () => {
		const deploy = tools.find((t) => t.name === "application-deploy");
		expect(deploy?.inputSchema.type).toBe("object");
		expect(deploy?.inputSchema.$schema).toBe(
			"https://json-schema.org/draft/2020-12/schema",
		);
		expect(JSON.stringify(deploy?.inputSchema.properties)).not.toContain("$schema");
		const noInput = tools.find((t) => t.name === "application-noInput");
		expect(noInput?.inputSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {},
		});
	});

	it("annotates queries as read-only and delete scopes as destructive", () => {
		const one = tools.find((t) => t.name === "application-one");
		expect(one?.annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
			destructiveHint: false,
			openWorldHint: true,
		});
		const del = tools.find((t) => t.name === "application-delete");
		expect(del?.scope).toBe("dokploy:services:delete");
		expect(del?.annotations.destructiveHint).toBe(true);
	});

	it("toolsForScopes filters by granted scopes", () => {
		expect(
			toolsForScopes(tools, new Set(["dokploy:read"])).map((t) => t.name),
		).toEqual(["application-one", "application-noInput"]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/registry.test.ts
```

Expected: FAIL — cannot resolve `@/server/mcp/registry`.

- [ ] **Step 3: Write the registry**

`apps/dokploy/server/mcp/registry.ts`:

```ts
import type { AnyRouter } from "@trpc/server";
import { z } from "zod";
import {
	type DokployMcpScope,
	isDestructiveScope,
	resolveToolScope,
} from "./scopes";

export interface McpToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface McpToolDefinition {
	/** `router-procedure`, identical to @dokploy/mcp. */
	name: string;
	/** `router.procedure` as registered in appRouter. */
	path: string;
	routerName: string;
	procedureName: string;
	type: "query" | "mutation";
	description: string;
	inputSchema: Record<string, unknown> & { type?: string; $schema?: string };
	scope: DokployMcpScope;
	annotations: McpToolAnnotations;
}

interface ProcedureDef {
	type: "query" | "mutation" | "subscription";
	meta?: { openapi?: { enabled?: boolean; description?: string; summary?: string } };
	inputs?: unknown[];
}

const JSON_SCHEMA_2020 = "https://json-schema.org/draft/2020-12/schema";
const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

/** Unwrap optional/nullable/default wrappers so the object schema is at the root. */
const unwrapZod = (schema: unknown): unknown => {
	let current = schema as { _zod?: { def?: { type?: string; innerType?: unknown } } };
	for (let i = 0; i < 5; i += 1) {
		const def = current?._zod?.def;
		if (!def) break;
		if (
			(def.type === "optional" || def.type === "nullable" || def.type === "default") &&
			def.innerType
		) {
			current = def.innerType as typeof current;
			continue;
		}
		break;
	}
	return current;
};

const stripNestedSchemaKeys = (node: unknown): void => {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) stripNestedSchemaKeys(item);
		return;
	}
	const record = node as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
		if (key === "$schema") {
			delete record[key];
			continue;
		}
		stripNestedSchemaKeys(value);
	}
};

/**
 * Zod input → JSON schema for MCP clients. Returns null when the input is not
 * an object schema (the tool is then skipped: MCP arguments are always an
 * object). Unrepresentable constructs (transforms, custom refinements) become
 * `{}` (any) rather than throwing.
 */
const toObjectJsonSchema = (
	inputs: unknown[] | undefined,
): McpToolDefinition["inputSchema"] | null => {
	if (!inputs || inputs.length === 0) {
		return { $schema: JSON_SCHEMA_2020, ...EMPTY_OBJECT_SCHEMA };
	}
	const converted: Record<string, unknown>[] = [];
	for (const raw of inputs) {
		const schema = unwrapZod(raw);
		if (!schema || typeof schema !== "object" || !("_zod" in schema)) return null;
		try {
			converted.push(
				z.toJSONSchema(schema as z.ZodType, {
					target: "draft-2020-12",
					unrepresentable: "any",
					io: "input",
				}) as Record<string, unknown>,
			);
		} catch {
			return null;
		}
	}
	const root =
		converted.length === 1
			? converted[0]!
			: { type: "object", allOf: converted };
	for (const part of converted) stripNestedSchemaKeys(part);
	if (root.type !== "object") return null;
	return { ...root, $schema: JSON_SCHEMA_2020 } as McpToolDefinition["inputSchema"];
};

export interface BuildRegistryOptions {
	/** Router names whose procedures are never exposed (the `mcp` router itself). */
	excludeRouters?: string[];
}

/**
 * Derives the tool list from a tRPC router. Pure: no caching, no I/O. The
 * production registry (`getMcpToolRegistry`) caches the result of calling this
 * on `appRouter` once per process.
 */
export const buildMcpToolRegistry = (
	router: AnyRouter,
	options: BuildRegistryOptions = {},
): McpToolDefinition[] => {
	const excluded = new Set(options.excludeRouters ?? []);
	const procedures = router._def.procedures as Record<string, { _def: ProcedureDef }>;
	const tools: McpToolDefinition[] = [];
	for (const [path, procedure] of Object.entries(procedures)) {
		const def = procedure._def;
		if (def.type === "subscription") continue;
		if (def.meta?.openapi?.enabled === false) continue;
		const segments = path.split(".");
		const routerName = segments[0] ?? "";
		const procedureName = segments.slice(1).join(".");
		if (!routerName || !procedureName || excluded.has(routerName)) continue;
		const inputSchema = toObjectJsonSchema(def.inputs);
		if (!inputSchema) {
			console.warn(`[mcp] skipping ${path}: input is not an object schema`);
			continue;
		}
		const type = def.type;
		const scope = resolveToolScope({ routerName, procedureName, type });
		const method = type === "query" ? "GET" : "POST";
		const name = segments.join("-");
		tools.push({
			name,
			path,
			routerName,
			procedureName,
			type,
			description:
				def.meta?.openapi?.description ??
				def.meta?.openapi?.summary ??
				`${method} /${path}`,
			inputSchema,
			scope,
			annotations: {
				title: name,
				readOnlyHint: type === "query",
				idempotentHint: type === "query",
				destructiveHint:
					isDestructiveScope(scope) ||
					(scope === "dokploy:admin" &&
						/^(clean|remove|delete)/i.test(procedureName)),
				openWorldHint: true,
			},
		});
	}
	return tools;
};

export const toolsForScopes = (
	tools: McpToolDefinition[],
	scopes: Set<string>,
) => tools.filter((tool) => scopes.has(tool.scope));

export const countToolsByScope = (tools: McpToolDefinition[]) => {
	const counts: Record<string, number> = {};
	for (const tool of tools) counts[tool.scope] = (counts[tool.scope] ?? 0) + 1;
	return counts;
};

let cached: McpToolDefinition[] | null = null;

/** Process-wide registry built from appRouter on first use. */
export const getMcpToolRegistry = async (): Promise<McpToolDefinition[]> => {
	if (cached) return cached;
	const { appRouter } = await import("@/server/api/root");
	cached = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });
	return cached;
};
```

Note the dynamic import in `getMcpToolRegistry`: `root.ts` will import the `mcp` router (Task 12), which imports this file for tool counts — the lazy import breaks that cycle.

- [ ] **Step 4: Run the registry test**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/registry.test.ts
```

Expected: PASS. If the `$schema` assertion fails because zod nests `$schema` inside `allOf` parts, the strip helper already runs on each part — check that `root` for the single-input case is the same object that was stripped (it is: `converted[0]`).

- [ ] **Step 5: Write the snapshot test against the real appRouter**

`apps/dokploy/__test__/mcp/scopes-snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { appRouter } from "@/server/api/root";
import { buildMcpToolRegistry } from "@/server/mcp/registry";

/**
 * Pins tool → scope for every exposed procedure. A change here is a
 * permission change and must be reviewed as one: update the snapshot on
 * purpose with `pnpm vitest run -u __test__/mcp/scopes-snapshot.test.ts`.
 */
describe("MCP tool scope table", () => {
	const tools = buildMcpToolRegistry(appRouter, { excludeRouters: ["mcp"] });

	it("exposes the expected well-known tools with @dokploy/mcp names", () => {
		const names = new Set(tools.map((tool) => tool.name));
		for (const expected of [
			"application-deploy",
			"application-one",
			"compose-one",
			"postgres-create",
			"project-all",
			"settings-getDokployVersion",
			"user-get",
			"backup-create",
		]) {
			expect(names.has(expected), expected).toBe(true);
		}
		expect(tools.length).toBeGreaterThan(400);
		for (const tool of tools) {
			expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		}
	});

	it("tool → scope snapshot", () => {
		const table = Object.fromEntries(
			tools
				.map((tool) => [tool.name, tool.scope] as const)
				.sort(([a], [b]) => a.localeCompare(b)),
		);
		expect(table).toMatchSnapshot();
	});
});
```

- [ ] **Step 6: Run it once to create the snapshot, then review the snapshot**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/scopes-snapshot.test.ts
```

Expected: PASS with "1 snapshot written". Open `apps/dokploy/__test__/mcp/__snapshots__/scopes-snapshot.test.ts.snap` and scan for surprises: anything under `dokploy:admin` that is clearly a service action, or a `:write` tool that deletes. Fix by adding an override in `scopes.ts` (Task 7) and re-running with `-u`. Also grep the test output for `[mcp] skipping` warnings; each skipped procedure must be one whose input is genuinely not an object (record it in the commit message).

- [ ] **Step 7: Commit**

```bash
git.exe add apps/dokploy/server/mcp/registry.ts apps/dokploy/__test__/mcp/registry.test.ts apps/dokploy/__test__/mcp/scopes-snapshot.test.ts apps/dokploy/__test__/mcp/__snapshots__/scopes-snapshot.test.ts.snap apps/dokploy/server/mcp/scopes.ts
git.exe commit -m "feat(mcp): tool registry derived from appRouter with pinned scope snapshot"
```

---

### Task 9: MCP endpoint — handler module and `pages/api/mcp.ts`

**Files:**
- Create: `apps/dokploy/server/mcp/handler.ts`
- Create: `apps/dokploy/pages/api/mcp.ts`
- Test: `apps/dokploy/__test__/mcp/handler.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/dokploy/__test__/mcp/handler.test.ts`:

```ts
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/mcp-oauth", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/mcp-oauth")>();
	return {
		...actual,
		findMcpAccessToken: vi.fn(async () => tokenRow),
		resolveDefaultOrganizationId: vi.fn(async () => organizationId),
	};
});

vi.mock("@dokploy/server/lib/auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dokploy/server/lib/auth")>();
	return {
		...actual,
		buildMemberSession: vi.fn(async (user: { id: string }, orgId: string) => ({
			session: { userId: user.id, activeOrganizationId: orgId },
			user: { id: user.id, email: "u@example.com", role: "owner", ownerId: user.id },
		})),
	};
});

let tokenRow: { userId: string; clientId: string; scopes: string[] } | null = null;
let organizationId: string | null = "org-1";

const { db } = await import("@dokploy/server/db");
const { authenticateMcpBearer, executeMcpTool, unauthorizedPayload } = await import(
	"@/server/mcp/handler"
);
const findFirst = vi.mocked(db.query.user.findFirst);

const readTool = {
	name: "application-one",
	path: "application.one",
	routerName: "application",
	procedureName: "one",
	type: "query" as const,
	description: "GET /application.one",
	inputSchema: { type: "object" },
	scope: "dokploy:read" as const,
	annotations: { title: "application-one", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

describe("unauthorizedPayload", () => {
	it("points at the protected-resource document on the resolved origin", () => {
		const payload = unauthorizedPayload("https://dok.example.com");
		expect(payload.headers["WWW-Authenticate"]).toBe(
			'Bearer resource_metadata="https://dok.example.com/.well-known/oauth-protected-resource"',
		);
		expect(payload.body).toEqual({
			jsonrpc: "2.0",
			error: { code: -32000, message: "Unauthorized: Authentication required" },
			id: null,
		});
	});
});

describe("authenticateMcpBearer", () => {
	beforeEach(() => {
		tokenRow = { userId: "user-1", clientId: "client-1", scopes: ["openid", "dokploy:read"] };
		organizationId = "org-1";
		findFirst.mockReset();
		findFirst.mockResolvedValue({ id: "user-1", firstName: "Ada" } as never);
	});

	it("returns null without a bearer header or with an unknown token", async () => {
		expect(await authenticateMcpBearer(undefined)).toBeNull();
		expect(await authenticateMcpBearer("Basic abc")).toBeNull();
		tokenRow = null;
		expect(await authenticateMcpBearer("Bearer nope")).toBeNull();
	});

	it("returns null when the user has no organization membership", async () => {
		organizationId = null;
		expect(await authenticateMcpBearer("Bearer tok")).toBeNull();
	});

	it("synthesizes the member session for the default organization", async () => {
		const auth = await authenticateMcpBearer("Bearer tok");
		expect(auth?.scopes).toEqual(new Set(["openid", "dokploy:read"]));
		expect(auth?.session).toEqual({ userId: "user-1", activeOrganizationId: "org-1" });
		expect(auth?.user.id).toBe("user-1");
	});
});

describe("executeMcpTool", () => {
	it("refuses a tool outside the granted scopes without calling the procedure", async () => {
		const call = vi.fn();
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:deploy"]),
			call,
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("dokploy:read");
		expect(call).not.toHaveBeenCalled();
	});

	it("returns the procedure result as text and structuredContent", async () => {
		const call = vi.fn(async () => ({ applicationId: "app-1" }));
		const result = await executeMcpTool({
			tool: readTool,
			args: { applicationId: "app-1" },
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(call).toHaveBeenCalledWith("application.one", { applicationId: "app-1" });
		expect(result.isError).toBeUndefined();
		expect((result.content[0] as { text: string }).text).toBe(
			JSON.stringify({ applicationId: "app-1" }),
		);
		expect(result.structuredContent).toEqual({ applicationId: "app-1" });
	});

	it("maps TRPCError to an error result with CODE: message", async () => {
		const call = vi.fn(async () => {
			throw new TRPCError({ code: "UNAUTHORIZED", message: "nope" });
		});
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toBe("UNAUTHORIZED: nope");
	});

	it("hides unexpected exception details", async () => {
		const call = vi.fn(async () => {
			throw new Error("postgres password is hunter2");
		});
		const result = await executeMcpTool({
			tool: readTool,
			args: {},
			scopes: new Set(["dokploy:read"]),
			call,
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).not.toContain("hunter2");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/handler.test.ts
```

Expected: FAIL — cannot resolve `@/server/mcp/handler`.

- [ ] **Step 3: Write the handler module**

`apps/dokploy/server/mcp/handler.ts`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { db } from "@dokploy/server/db";
import { user as userTable } from "@dokploy/server/db/schema";
import { buildMemberSession } from "@dokploy/server/lib/auth";
import {
	findMcpAccessToken,
	resolveDefaultOrganizationId,
} from "@dokploy/server/services/mcp-oauth";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import packageInfo from "../../package.json";
import { captureError } from "../sentry";
import { type McpToolDefinition, toolsForScopes } from "./registry";

export interface McpAuth {
	userId: string;
	clientId: string;
	scopes: Set<string>;
	session: Awaited<ReturnType<typeof buildMemberSession>>["session"];
	user: Awaited<ReturnType<typeof buildMemberSession>>["user"];
}

/** Bearer → token row → default organization → synthesized member session. */
export const authenticateMcpBearer = async (
	authorization: string | undefined,
): Promise<McpAuth | null> => {
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = await findMcpAccessToken(authorization.slice("Bearer ".length).trim());
	if (!token) return null;
	const organizationId = await resolveDefaultOrganizationId(token.userId);
	if (!organizationId) return null;
	const userRow = await db.query.user.findFirst({
		where: eq(userTable.id, token.userId),
	});
	if (!userRow) return null;
	const { session, user } = await buildMemberSession(userRow, organizationId);
	return {
		userId: token.userId,
		clientId: token.clientId,
		scopes: new Set(token.scopes),
		session,
		user,
	};
};

export const unauthorizedPayload = (origin: string) => {
	const wwwAuthenticate = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
	return {
		status: 401 as const,
		headers: {
			"WWW-Authenticate": wwwAuthenticate,
			"Access-Control-Expose-Headers": "WWW-Authenticate",
		},
		body: {
			jsonrpc: "2.0" as const,
			error: { code: -32000, message: "Unauthorized: Authentication required" },
			id: null,
		},
	};
};

export type ProcedureCall = (path: string, args: unknown) => Promise<unknown>;

export interface ToolCallResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: true;
}

const errorResult = (text: string): ToolCallResult => ({
	content: [{ type: "text", text }],
	isError: true,
});

/** Scope check, then execution through the injected tRPC caller. */
export const executeMcpTool = async ({
	tool,
	args,
	scopes,
	call,
}: {
	tool: McpToolDefinition;
	args: unknown;
	scopes: Set<string>;
	call: ProcedureCall;
}): Promise<ToolCallResult> => {
	if (!scopes.has(tool.scope)) {
		return errorResult(
			`Tool ${tool.name} requires scope ${tool.scope}, which this authorization does not include. Re-authorize with that scope enabled.`,
		);
	}
	try {
		const result = await call(tool.path, args ?? {});
		const text = result === undefined ? "null" : JSON.stringify(result);
		const structured =
			result && typeof result === "object" && !Array.isArray(result)
				? (result as Record<string, unknown>)
				: undefined;
		return {
			content: [{ type: "text", text }],
			...(structured ? { structuredContent: structured } : {}),
		};
	} catch (error) {
		if (error instanceof TRPCError) {
			return errorResult(`${error.code}: ${error.message}`);
		}
		captureError(error, { handler: "mcp", tool: tool.name });
		console.error(`[mcp] ${tool.name} failed`, error);
		return errorResult(`INTERNAL_SERVER_ERROR: ${tool.name} failed unexpectedly`);
	}
};

/** Builds a `call` bound to a tRPC caller: `caller[router][procedure](args)`. */
export const makeProcedureCall = (
	caller: Record<string, Record<string, (input: unknown) => Promise<unknown>>>,
): ProcedureCall => {
	return (path, args) => {
		const [routerName, ...rest] = path.split(".");
		const procedureName = rest.join(".");
		const procedure = caller[routerName ?? ""]?.[procedureName];
		if (!procedure) {
			throw new TRPCError({ code: "NOT_FOUND", message: `Unknown tool path ${path}` });
		}
		return procedure(args);
	};
};

/**
 * One MCP `Server` per HTTP request: tools/list filtered to the grant,
 * tools/call scope-checked then executed. Cheap: the registry is prebuilt.
 */
export const createMcpRequestServer = ({
	tools,
	scopes,
	call,
}: {
	tools: McpToolDefinition[];
	scopes: Set<string>;
	call: ProcedureCall;
}) => {
	const server = new Server(
		{ name: "dokploy", version: packageInfo.version },
		{ capabilities: { tools: {} } },
	);
	const allowed = toolsForScopes(tools, scopes);
	const byName = new Map(allowed.map((tool) => [tool.name, tool]));

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: allowed.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) {
			return errorResult(
				`Unknown tool ${request.params.name} (not granted or does not exist)`,
			);
		}
		return executeMcpTool({ tool, args: request.params.arguments, scopes, call });
	});

	return server;
};
```

If tsc complains that `inputSchema` must be typed `{ type: "object"; … }` for the SDK's `Tool` type, cast at the call site: `inputSchema: tool.inputSchema as { type: "object"; [key: string]: unknown }`.

- [ ] **Step 4: Run the handler test**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the endpoint**

`apps/dokploy/pages/api/mcp.ts`:

```ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	isMcpDisabled,
	OPENAPI_MAX_JSON_BODY_SIZE,
	resolveMcpOrigin,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import type { NextApiRequest, NextApiResponse } from "next";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";
import {
	authenticateMcpBearer,
	createMcpRequestServer,
	makeProcedureCall,
	unauthorizedPayload,
} from "@/server/mcp/handler";
import { getMcpToolRegistry } from "@/server/mcp/registry";

// The MCP transport reads the raw JSON-RPC body itself.
export const config = { api: { bodyParser: false } };

const createCaller = createCallerFactory(appRouter);

const jsonRpcError = (
	res: NextApiResponse,
	status: number,
	message: string,
	code = -32000,
) => res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (isMcpDisabled()) {
		return res.status(503).json({
			error: "mcp_disabled",
			message: "The MCP server is disabled on this instance (DOKPLOY_MCP_DISABLED=true).",
		});
	}
	const origin = await resolveMcpOrigin(req.headers);
	if (!origin) {
		return res.status(503).json({
			error: "mcp_unconfigured",
			message:
				"The MCP server needs a public origin. Set the server domain under Settings → Server, or set BETTER_AUTH_URL.",
		});
	}
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return jsonRpcError(res, 405, "Method not allowed. MCP over Streamable HTTP uses POST.");
	}
	const contentLength = Number(req.headers["content-length"]);
	if (Number.isFinite(contentLength) && contentLength > OPENAPI_MAX_JSON_BODY_SIZE) {
		return jsonRpcError(res, 413, "Payload too large");
	}

	const auth = await authenticateMcpBearer(req.headers.authorization);
	if (!auth) {
		const payload = unauthorizedPayload(origin);
		for (const [key, value] of Object.entries(payload.headers)) {
			res.setHeader(key, value);
		}
		return res.status(payload.status).json(payload.body);
	}

	const caller = createCaller({
		// @ts-ignore — same synthesized shape the REST handler builds via createTRPCContext
		session: auth.session,
		// @ts-ignore
		user: auth.user,
		db,
		req,
		res,
	});
	const server = createMcpRequestServer({
		tools: await getMcpToolRegistry(),
		scopes: auth.scopes,
		call: makeProcedureCall(caller as never),
	});
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res);
}
```

- [ ] **Step 6: Typecheck**

```bash
cd apps/dokploy && pnpm typecheck
```

Expected: clean. Known adjustments: if `transport.handleRequest` expects `IncomingMessage & { auth?: AuthInfo }`, pass `req as never`. If the SDK's `Server` generic complains about the `ListTools` return type, wrap `inputSchema` with the cast from Step 3.

- [ ] **Step 7: Commit**

```bash
git.exe add apps/dokploy/server/mcp/handler.ts apps/dokploy/pages/api/mcp.ts apps/dokploy/__test__/mcp/handler.test.ts
git.exe commit -m "feat(mcp): stateless Streamable HTTP endpoint at /api/mcp with scope-checked tool execution"
```

---

### Task 10: Discovery documents and `.well-known` rewrites

**Files:**
- Create: `apps/dokploy/server/mcp/discovery.ts`
- Create: `apps/dokploy/pages/api/mcp-oauth/authorization-server.ts`
- Create: `apps/dokploy/pages/api/mcp-oauth/protected-resource.ts`
- Modify: `apps/dokploy/next.config.mjs`
- Test: `apps/dokploy/__test__/mcp/discovery.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/dokploy/__test__/mcp/discovery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	buildAuthorizationServerMetadata,
	buildProtectedResourceMetadata,
} from "@/server/mcp/discovery";

describe("discovery metadata", () => {
	const origin = "https://dok.example.com";

	it("authorization server document points at the fork consent page and plugin endpoints", () => {
		const doc = buildAuthorizationServerMetadata(origin);
		expect(doc).toMatchObject({
			issuer: origin,
			authorization_endpoint: `${origin}/mcp/authorize`,
			token_endpoint: `${origin}/api/auth/mcp/token`,
			registration_endpoint: `${origin}/api/auth/mcp/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
		});
		expect(doc.scopes_supported).toEqual([
			"openid",
			"offline_access",
			"dokploy:read",
			"dokploy:deploy",
			"dokploy:services:write",
			"dokploy:services:delete",
			"dokploy:projects:write",
			"dokploy:projects:delete",
			"dokploy:backups",
			"dokploy:admin",
		]);
	});

	it("protected resource document names the endpoint and the origin as AS", () => {
		expect(buildProtectedResourceMetadata(origin)).toEqual({
			resource: `${origin}/api/mcp`,
			authorization_servers: [origin],
			scopes_supported: buildAuthorizationServerMetadata(origin).scopes_supported,
			bearer_methods_supported: ["header"],
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/discovery.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the builders**

`apps/dokploy/server/mcp/discovery.ts`:

```ts
import {
	DOKPLOY_MCP_SCOPE_IDS,
	MCP_AUTHORIZE_PAGE_PATH,
	MCP_ENDPOINT_PATH,
} from "@dokploy/server/services/mcp-oauth";

const SCOPES_SUPPORTED = ["openid", "offline_access", ...DOKPLOY_MCP_SCOPE_IDS];

/** RFC 8414 document. `issuer` must equal the origin the client fetched it from. */
export const buildAuthorizationServerMetadata = (origin: string) => ({
	issuer: origin,
	authorization_endpoint: `${origin}${MCP_AUTHORIZE_PAGE_PATH}`,
	token_endpoint: `${origin}/api/auth/mcp/token`,
	registration_endpoint: `${origin}/api/auth/mcp/register`,
	scopes_supported: SCOPES_SUPPORTED,
	response_types_supported: ["code"],
	response_modes_supported: ["query"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: [
		"none",
		"client_secret_basic",
		"client_secret_post",
	],
	subject_types_supported: ["public"],
});

/** RFC 9728 document for the MCP endpoint. */
export const buildProtectedResourceMetadata = (origin: string) => ({
	resource: `${origin}${MCP_ENDPOINT_PATH}`,
	authorization_servers: [origin],
	scopes_supported: SCOPES_SUPPORTED,
	bearer_methods_supported: ["header"],
});
```

- [ ] **Step 4: Write the two API routes**

`apps/dokploy/pages/api/mcp-oauth/authorization-server.ts`:

```ts
import { isMcpDisabled, resolveMcpOrigin } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { buildAuthorizationServerMetadata } from "@/server/mcp/discovery";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).end();
	}
	if (isMcpDisabled()) return res.status(404).end();
	const origin = await resolveMcpOrigin(req.headers);
	if (!origin) return res.status(503).json({ error: "mcp_unconfigured" });
	res.setHeader("Cache-Control", "public, max-age=300");
	return res.status(200).json(buildAuthorizationServerMetadata(origin));
}
```

`apps/dokploy/pages/api/mcp-oauth/protected-resource.ts`:

```ts
import { isMcpDisabled, resolveMcpOrigin } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { buildProtectedResourceMetadata } from "@/server/mcp/discovery";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		return res.status(405).end();
	}
	if (isMcpDisabled()) return res.status(404).end();
	const origin = await resolveMcpOrigin(req.headers);
	if (!origin) return res.status(503).json({ error: "mcp_unconfigured" });
	res.setHeader("Cache-Control", "public, max-age=300");
	return res.status(200).json(buildProtectedResourceMetadata(origin));
}
```

- [ ] **Step 5: Add the rewrites**

In `apps/dokploy/next.config.mjs`, inside `nextConfig` after `transpilePackages`, add:

```js
	// OAuth discovery for the remote MCP server: clients probe the origin
	// root (RFC 8414 / RFC 9728), the documents are built in pages/api/mcp-oauth/*.
	async rewrites() {
		return [
			{
				source: "/.well-known/oauth-protected-resource",
				destination: "/api/mcp-oauth/protected-resource",
			},
			{
				source: "/.well-known/oauth-protected-resource/:path*",
				destination: "/api/mcp-oauth/protected-resource",
			},
			{
				source: "/.well-known/oauth-authorization-server",
				destination: "/api/mcp-oauth/authorization-server",
			},
			{
				source: "/.well-known/openid-configuration",
				destination: "/api/mcp-oauth/authorization-server",
			},
		];
	},
```

- [ ] **Step 6: Run the test, typecheck, commit**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/discovery.test.ts && pnpm typecheck
git.exe add apps/dokploy/server/mcp/discovery.ts apps/dokploy/pages/api/mcp-oauth apps/dokploy/next.config.mjs apps/dokploy/__test__/mcp/discovery.test.ts
git.exe commit -m "feat(mcp): OAuth discovery documents served from /.well-known via rewrites"
```

---

### Task 11: Login page return path

**Files:**
- Create: `apps/dokploy/lib/post-login-redirect.ts`
- Modify: `apps/dokploy/pages/index.tsx`
- Test: `apps/dokploy/__test__/mcp/login-redirect.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/dokploy/__test__/mcp/login-redirect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	getPostLoginDestination,
	isSafeRelativePath,
} from "@/lib/post-login-redirect";

describe("isSafeRelativePath", () => {
	it.each(["/dashboard/home", "/mcp/authorize?client_id=a&state=b"])(
		"accepts %s",
		(path) => expect(isSafeRelativePath(path)).toBe(true),
	);
	it.each([
		"//evil.com",
		"/\\evil.com",
		"https://evil.com",
		"javascript:alert(1)",
		"dashboard",
		"",
	])("rejects %s", (path) => expect(isSafeRelativePath(path)).toBe(false));
});

describe("getPostLoginDestination", () => {
	it("defaults to the dashboard", () => {
		expect(getPostLoginDestination({})).toBe("/dashboard/home");
	});

	it("honours a safe redirect and ignores an unsafe one", () => {
		expect(getPostLoginDestination({ redirect: "/mcp/authorize?x=1" })).toBe(
			"/mcp/authorize?x=1",
		);
		expect(getPostLoginDestination({ redirect: "https://evil.com" })).toBe(
			"/dashboard/home",
		);
		expect(getPostLoginDestination({ redirect: ["/a", "/b"] })).toBe("/a");
	});

	it("rebuilds the consent URL when the plugin's login fallback shape is present", () => {
		expect(
			getPostLoginDestination({
				client_id: "c1",
				redirect_uri: "http://localhost:1/cb",
				response_type: "code",
				state: "s",
				consent: "should-be-dropped",
			}),
		).toBe(
			"/mcp/authorize?client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&response_type=code&state=s",
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/login-redirect.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

`apps/dokploy/lib/post-login-redirect.ts`:

```ts
type Query = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

/** Same-origin relative path: starts with a single `/`, never `//` or `/\`. */
export const isSafeRelativePath = (value: string | undefined): value is string =>
	typeof value === "string" && /^\/(?![\/\\])/.test(value);

const OAUTH_KEYS = [
	"client_id",
	"redirect_uri",
	"response_type",
	"state",
	"scope",
	"code_challenge",
	"code_challenge_method",
	"resource",
] as const;

/**
 * Where to send the user after a successful sign-in:
 * 1. a validated `redirect` query (set by pages that need the user back),
 * 2. the OAuth authorize parameters (better-auth's own login fallback shape) →
 *    the fork's consent page,
 * 3. the dashboard.
 */
export const getPostLoginDestination = (query: Query): string => {
	const redirect = first(query.redirect);
	if (isSafeRelativePath(redirect)) return redirect;
	const clientId = first(query.client_id);
	const redirectUri = first(query.redirect_uri);
	const responseType = first(query.response_type);
	if (clientId && redirectUri && responseType) {
		const params = new URLSearchParams();
		for (const key of OAUTH_KEYS) {
			const value = first(query[key]);
			if (value) params.set(key, value);
		}
		return `/mcp/authorize?${params.toString()}`;
	}
	return "/dashboard/home";
};
```

- [ ] **Step 4: Wire the login page**

In `apps/dokploy/pages/index.tsx`:

1. Add `import { getPostLoginDestination, isSafeRelativePath } from "@/lib/post-login-redirect";`.
2. Replace all four `router.push("/dashboard/home")` calls (email `onSubmit`, `onPasskeySignIn`, `onTwoFactorSubmit`, `onBackupCodeSubmit`) with `router.push(getPostLoginDestination(router.query))`. Keep the surrounding `await` where present.
3. In `getServerSideProps`, both places that redirect an already-signed-in user to `/dashboard/home` (the cloud branch and the self-hosted branch) become:

```ts
		const redirect = Array.isArray(context.query.redirect)
			? context.query.redirect[0]
			: context.query.redirect;
		return {
			redirect: {
				permanent: false,
				destination: isSafeRelativePath(redirect) ? redirect : "/dashboard/home",
			},
		};
```

- [ ] **Step 5: Run the test, typecheck, commit**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/login-redirect.test.ts && pnpm typecheck
git.exe add apps/dokploy/lib/post-login-redirect.ts apps/dokploy/pages/index.tsx apps/dokploy/__test__/mcp/login-redirect.test.ts
git.exe commit -m "feat(auth): honour a validated redirect after sign-in (MCP consent return path)"
```

---

### Task 12: `mcp` tRPC router (connection info, authorizations, revoke, approve)

**Files:**
- Create: `apps/dokploy/server/api/routers/mcp.ts`
- Modify: `apps/dokploy/server/api/root.ts`
- Test: `apps/dokploy/__test__/mcp/mcp-router.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/dokploy/__test__/mcp/mcp-router.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/mcp-oauth", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/services/mcp-oauth")>();
	return {
		...actual,
		resolveMcpOrigin: vi.fn(async () => "https://dok.example.com"),
		resolveDefaultOrganizationId: vi.fn(async () => "org-1"),
		findOrganizationName: vi.fn(async () => ({ id: "org-1", name: "Devino" })),
		findOAuthApplicationByClientId: vi.fn(async () => clientRow),
		listMcpAuthorizations: vi.fn(async () => []),
		revokeMcpAuthorization: vi.fn(async () => {}),
		recordMcpConsent: vi.fn(async () => {}),
		createConsentProof: vi.fn(() => "123.sig"),
	};
});

let clientRow: {
	clientId: string;
	name: string;
	redirectUrls: string[];
	disabled: boolean;
} | null = null;

const { appRouter } = await import("@/server/api/root");
const { createCallerFactory } = await import("@/server/api/trpc");
const { revokeMcpAuthorization } = await import("@dokploy/server/services/mcp-oauth");

const caller = createCallerFactory(appRouter)({
	user: { id: "user-1", email: "u@example.com", role: "member", ownerId: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: { headers: {} },
	res: {},
} as never);

const approveInput = {
	clientId: "client-1",
	redirectUri: "http://localhost:4321/callback",
	responseType: "code",
	state: "st",
	codeChallenge: "chal",
	codeChallengeMethod: "S256",
	scopes: ["dokploy:read", "dokploy:deploy"],
};

describe("mcp router", () => {
	beforeEach(() => {
		clientRow = {
			clientId: "client-1",
			name: "Claude Code",
			redirectUrls: ["http://localhost:4321/callback"],
			disabled: false,
		};
	});

	it("connectionInfo reports endpoint, add command, organization and scope catalogue", async () => {
		const info = await caller.mcp.connectionInfo();
		expect(info.enabled).toBe(true);
		expect(info.endpoint).toBe("https://dok.example.com/api/mcp");
		expect(info.addCommand).toBe(
			"claude mcp add --transport http --scope user dokploy https://dok.example.com/api/mcp",
		);
		expect(info.organization).toEqual({ id: "org-1", name: "Devino" });
		expect(info.scopes.map((s) => s.id)).toContain("dokploy:read");
		expect(info.scopes.every((s) => typeof s.toolCount === "number")).toBe(true);
	});

	it("revokeAuthorization is scoped to the caller", async () => {
		await caller.mcp.revokeAuthorization({ clientId: "client-1" });
		expect(revokeMcpAuthorization).toHaveBeenCalledWith("user-1", "client-1");
	});

	it("approveAuthorization records the grant and returns the plugin URL with openid/offline_access, sorted scopes and the consent proof", async () => {
		const { recordMcpConsent } = await import("@dokploy/server/services/mcp-oauth");
		const { url } = await caller.mcp.approveAuthorization(approveInput);
		expect(recordMcpConsent).toHaveBeenCalledWith("user-1", "client-1", [
			"dokploy:deploy",
			"dokploy:read",
		]);
		const parsed = new URL(url, "https://dok.example.com");
		expect(parsed.pathname).toBe("/api/auth/mcp/authorize");
		expect(parsed.searchParams.get("scope")).toBe(
			"openid offline_access dokploy:deploy dokploy:read",
		);
		expect(parsed.searchParams.get("consent")).toBe("123.sig");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe("st");
	});

	it("approveAuthorization rejects unknown clients, unregistered redirects, bad PKCE and unknown scopes", async () => {
		await expect(
			caller.mcp.approveAuthorization({ ...approveInput, redirectUri: "http://localhost:9/other" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.mcp.approveAuthorization({ ...approveInput, codeChallengeMethod: "plain" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			caller.mcp.approveAuthorization({ ...approveInput, scopes: ["dokploy:root"] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		clientRow = null;
		await expect(caller.mcp.approveAuthorization(approveInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/mcp-router.test.ts
```

Expected: FAIL — `caller.mcp` is undefined.

- [ ] **Step 3: Write the router**

`apps/dokploy/server/api/routers/mcp.ts`:

```ts
import {
	createConsentProof,
	findOAuthApplicationByClientId,
	findOrganizationName,
	getMcpRefreshTokenSeconds,
	isMcpDisabled,
	listMcpAuthorizations,
	MCP_ENDPOINT_PATH,
	MCP_PLUGIN_AUTHORIZE_PATH,
	recordMcpConsent,
	resolveDefaultOrganizationId,
	resolveMcpOrigin,
	revokeMcpAuthorization,
} from "@dokploy/server/services/mcp-oauth";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { countToolsByScope, getMcpToolRegistry } from "@/server/mcp/registry";
import { DOKPLOY_SCOPES, isDokployScope } from "@/server/mcp/scopes";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/** Never exposed over REST or MCP: these manage the MCP grant itself. */
const hidden = (name: string) => ({
	openapi: { enabled: false, method: "POST" as const, path: `/mcp.${name}` },
});

export const mcpRouter = createTRPCRouter({
	connectionInfo: protectedProcedure
		.meta(hidden("connectionInfo"))
		.query(async ({ ctx }) => {
			const disabled = isMcpDisabled();
			const origin = disabled ? null : await resolveMcpOrigin(ctx.req.headers);
			const organizationId = await resolveDefaultOrganizationId(ctx.user.id);
			const organization = organizationId
				? await findOrganizationName(organizationId)
				: null;
			const counts = countToolsByScope(await getMcpToolRegistry());
			const endpoint = origin ? `${origin}${MCP_ENDPOINT_PATH}` : null;
			return {
				enabled: !disabled && !!origin,
				reason: disabled ? ("disabled" as const) : origin ? null : ("unconfigured" as const),
				origin,
				endpoint,
				addCommand: endpoint
					? `claude mcp add --transport http --scope user dokploy ${endpoint}`
					: null,
				organization,
				refreshTokenDays: Math.round(getMcpRefreshTokenSeconds() / 86400),
				scopes: DOKPLOY_SCOPES.map((scope) => ({
					...scope,
					toolCount: counts[scope.id] ?? 0,
				})),
			};
		}),

	listAuthorizations: protectedProcedure
		.meta(hidden("listAuthorizations"))
		.query(({ ctx }) => listMcpAuthorizations(ctx.user.id)),

	revokeAuthorization: protectedProcedure
		.meta(hidden("revokeAuthorization"))
		.input(z.object({ clientId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await revokeMcpAuthorization(ctx.user.id, input.clientId);
			return { success: true };
		}),

	/**
	 * Consent page → plugin handoff. Validates the client and every OAuth
	 * parameter, then mints the consent proof the plugin's authorize hook
	 * requires (see packages/server/src/lib/auth.ts).
	 */
	approveAuthorization: protectedProcedure
		.meta(hidden("approveAuthorization"))
		.input(
			z.object({
				clientId: z.string().min(1),
				redirectUri: z.string().min(1),
				responseType: z.string(),
				state: z.string().optional(),
				codeChallenge: z.string().min(1),
				codeChallengeMethod: z.string(),
				resource: z.string().optional(),
				scopes: z.array(z.string()),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const client = await findOAuthApplicationByClientId(input.clientId);
			if (!client || client.disabled) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Unknown OAuth client" });
			}
			if (!client.redirectUrls.includes(input.redirectUri)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "redirect_uri is not registered for this client",
				});
			}
			if (input.responseType !== "code") {
				throw new TRPCError({ code: "BAD_REQUEST", message: "response_type must be code" });
			}
			if (input.codeChallengeMethod !== "S256") {
				throw new TRPCError({ code: "BAD_REQUEST", message: "PKCE S256 is required" });
			}
			if (!input.scopes.every(isDokployScope)) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown scope requested" });
			}
			const selectedScopes = [...new Set(input.scopes)].sort();
			const scope = ["openid", "offline_access", ...selectedScopes].join(" ");
			// Grant record: gives the settings card a stable "authorized at" and a
			// scope history that survives refresh-token rotation.
			await recordMcpConsent(ctx.user.id, input.clientId, selectedScopes);
			const state = input.state ?? "";
			const consent = createConsentProof({
				userId: ctx.user.id,
				clientId: input.clientId,
				redirectUri: input.redirectUri,
				state,
				codeChallenge: input.codeChallenge,
				scope,
			});
			const params = new URLSearchParams({
				client_id: input.clientId,
				redirect_uri: input.redirectUri,
				response_type: "code",
				code_challenge: input.codeChallenge,
				code_challenge_method: "S256",
				scope,
				consent,
			});
			if (state) params.set("state", state);
			if (input.resource) params.set("resource", input.resource);
			return { url: `${MCP_PLUGIN_AUTHORIZE_PATH}?${params.toString()}` };
		}),
});
```

If `.meta(hidden)` fails the `OpenApiMeta` type because `enabled: false` still requires `method`/`path`, the object above already carries both; if it complains about `path` format, use `"/mcp.internal"`.

- [ ] **Step 4: Register the router**

In `apps/dokploy/server/api/root.ts` add `import { mcpRouter } from "./routers/mcp";` (alphabetical, after `mariadb`) and inside `createTRPCRouter({ … })` add `mcp: mcpRouter,` after `mariadb: mariadbRouter,`.

- [ ] **Step 5: Run the router test plus the snapshot test (the registry must still exclude `mcp`)**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts __test__/mcp/mcp-router.test.ts __test__/mcp/scopes-snapshot.test.ts
```

Expected: PASS, snapshot unchanged (no `mcp-*` tools).

- [ ] **Step 6: Typecheck and commit**

```bash
cd apps/dokploy && pnpm typecheck
git.exe add apps/dokploy/server/api/routers/mcp.ts apps/dokploy/server/api/root.ts apps/dokploy/__test__/mcp/mcp-router.test.ts
git.exe commit -m "feat(mcp): mcp router — connection info, authorizations, revoke, consent approval"
```

---

### Task 13: Consent page `/mcp/authorize`

**Files:**
- Create: `apps/dokploy/pages/mcp/authorize.tsx`

- [ ] **Step 1: Write the page**

`apps/dokploy/pages/mcp/authorize.tsx`:

```tsx
import {
	findOAuthApplicationByClientId,
	findOrganizationName,
	isMcpDisabled,
	resolveDefaultOrganizationId,
	validateRequest,
} from "@dokploy/server";
import { ShieldCheck } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { OnboardingLayout } from "@/components/layouts/onboarding-layout";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { countToolsByScope, getMcpToolRegistry } from "@/server/mcp/registry";
import {
	DEFAULT_ON_SCOPES,
	DOKPLOY_SCOPES,
	type DokployMcpScope,
	isDokployScope,
} from "@/server/mcp/scopes";
import { api } from "@/utils/api";

interface ScopeRow {
	id: DokployMcpScope;
	label: string;
	description: string;
	toolCount: number;
	checked: boolean;
}

interface OAuthParams {
	clientId: string;
	redirectUri: string;
	responseType: string;
	state: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	resource: string;
}

interface Props {
	error: string | null;
	clientName: string;
	redirectHost: string;
	organizationName: string | null;
	scopes: ScopeRow[];
	params: OAuthParams | null;
	cancelUrl: string | null;
}

const one = (value: string | string[] | undefined) =>
	(Array.isArray(value) ? value[0] : value) ?? "";

export default function McpAuthorizePage({
	error,
	clientName,
	redirectHost,
	organizationName,
	scopes,
	params,
	cancelUrl,
}: Props) {
	const [selected, setSelected] = useState<Set<DokployMcpScope>>(
		new Set(scopes.filter((s) => s.checked).map((s) => s.id)),
	);
	const approve = api.mcp.approveAuthorization.useMutation();

	const onAuthorize = async () => {
		if (!params) return;
		try {
			const { url } = await approve.mutateAsync({
				clientId: params.clientId,
				redirectUri: params.redirectUri,
				responseType: params.responseType,
				state: params.state || undefined,
				codeChallenge: params.codeChallenge,
				codeChallengeMethod: params.codeChallengeMethod,
				resource: params.resource || undefined,
				scopes: [...selected],
			});
			window.location.assign(url);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Authorization failed");
		}
	};

	return (
		<>
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight flex items-center justify-center gap-2">
					<ShieldCheck className="size-8" />
					Authorize {clientName}
				</h1>
				<p className="text-sm text-muted-foreground">
					{clientName} wants to use the Dokploy MCP server on your behalf.
				</p>
			</div>
			<CardContent className="p-0 space-y-4">
				{error ? (
					<AlertBlock type="error">{error}</AlertBlock>
				) : (
					<>
						<div className="rounded-lg border p-3 text-sm space-y-1">
							<div>
								<span className="text-muted-foreground">Acting in organization: </span>
								<span className="font-medium">{organizationName ?? "none"}</span>
							</div>
							<div>
								<span className="text-muted-foreground">Code will be sent to: </span>
								<span className="font-mono">{redirectHost}</span>
							</div>
						</div>
						{!organizationName && (
							<AlertBlock type="error">
								You are not a member of any organization, so nothing can be authorized.
							</AlertBlock>
						)}
						<div className="flex flex-col gap-3">
							{scopes.map((scope) => (
								<div
									key={scope.id}
									className="flex items-start justify-between gap-4 rounded-lg border p-3"
								>
									<div className="space-y-1">
										<Label htmlFor={scope.id} className="font-medium">
											{scope.label}{" "}
											<span className="text-xs text-muted-foreground font-mono">
												{scope.id} · {scope.toolCount} tools
											</span>
										</Label>
										<p className="text-sm text-muted-foreground">{scope.description}</p>
									</div>
									<Switch
										id={scope.id}
										checked={selected.has(scope.id)}
										onCheckedChange={(checked) => {
											setSelected((prev) => {
												const next = new Set(prev);
												if (checked) next.add(scope.id);
												else next.delete(scope.id);
												return next;
											});
										}}
									/>
								</div>
							))}
						</div>
						<p className="text-xs text-muted-foreground">
							Scopes only restrict what this client may do. Your role permissions still
							apply. You can revoke this authorization any time under Settings → Profile →
							MCP Server.
						</p>
						<div className="grid grid-cols-2 gap-4">
							<Button
								variant="outline"
								type="button"
								onClick={() => cancelUrl && window.location.assign(cancelUrl)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								onClick={onAuthorize}
								isLoading={approve.isPending}
								disabled={!organizationName || selected.size === 0}
							>
								Authorize
							</Button>
						</div>
					</>
				)}
			</CardContent>
		</>
	);
}

McpAuthorizePage.getLayout = (page: ReactElement) => (
	<OnboardingLayout>{page}</OnboardingLayout>
);

export async function getServerSideProps(context: GetServerSidePropsContext) {
	const { user } = await validateRequest(context.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: `/?redirect=${encodeURIComponent(context.resolvedUrl)}`,
			},
		};
	}

	const empty: Props = {
		error: null,
		clientName: "Unknown client",
		redirectHost: "",
		organizationName: null,
		scopes: [],
		params: null,
		cancelUrl: null,
	};

	if (isMcpDisabled()) {
		return { props: { ...empty, error: "The MCP server is disabled on this instance." } };
	}

	const q = context.query;
	const params: OAuthParams = {
		clientId: one(q.client_id),
		redirectUri: one(q.redirect_uri),
		responseType: one(q.response_type),
		state: one(q.state),
		codeChallenge: one(q.code_challenge),
		codeChallengeMethod: one(q.code_challenge_method),
		resource: one(q.resource),
	};

	const client = await findOAuthApplicationByClientId(params.clientId);
	if (!client || client.disabled) {
		return { props: { ...empty, error: "Unknown or disabled OAuth client." } };
	}
	if (!client.redirectUrls.includes(params.redirectUri)) {
		return {
			props: {
				...empty,
				clientName: client.name,
				error: "The redirect URI is not registered for this client.",
			},
		};
	}
	if (params.responseType !== "code" || !params.codeChallenge || params.codeChallengeMethod !== "S256") {
		return {
			props: {
				...empty,
				clientName: client.name,
				error: "This authorization request is missing PKCE (S256) or uses an unsupported response type.",
			},
		};
	}

	const organizationId = await resolveDefaultOrganizationId(user.id);
	const organization = organizationId ? await findOrganizationName(organizationId) : null;

	const requested = one(q.scope).split(" ").filter(isDokployScope);
	const shown = requested.length > 0 ? requested : DOKPLOY_SCOPES.map((s) => s.id);
	const counts = countToolsByScope(await getMcpToolRegistry());
	const scopes: ScopeRow[] = DOKPLOY_SCOPES.filter((s) => shown.includes(s.id)).map(
		(s) => ({
			id: s.id,
			label: s.label,
			description: s.description,
			toolCount: counts[s.id] ?? 0,
			checked: DEFAULT_ON_SCOPES.includes(s.id),
		}),
	);

	const cancel = new URL(params.redirectUri);
	cancel.searchParams.set("error", "access_denied");
	if (params.state) cancel.searchParams.set("state", params.state);

	return {
		props: {
			error: null,
			clientName: client.name,
			redirectHost: new URL(params.redirectUri).host,
			organizationName: organization?.name ?? null,
			scopes,
			params,
			cancelUrl: cancel.toString(),
		} satisfies Props,
	};
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/dokploy && pnpm typecheck
```

Expected: clean. If `validateRequest`, `findOAuthApplicationByClientId` etc. are not visible from `@dokploy/server`, the barrel export from Task 3 Step 4 is missing — fix that rather than importing from a deep path.

- [ ] **Step 3: Commit**

```bash
git.exe add apps/dokploy/pages/mcp/authorize.tsx
git.exe commit -m "feat(mcp): consent page with per-grant scope toggles"
```

---

### Task 14: Settings card on Profile

**Files:**
- Create: `apps/dokploy/components/dashboard/settings/mcp/mcp-server.tsx`
- Modify: `apps/dokploy/pages/dashboard/settings/profile.tsx`

- [ ] **Step 1: Write the card**

`apps/dokploy/components/dashboard/settings/mcp/mcp-server.tsx`:

```tsx
import copy from "copy-to-clipboard";
import { formatDistanceToNow } from "date-fns";
import { Copy, Plug, Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

export const McpServer = () => {
	const { data: info } = api.mcp.connectionInfo.useQuery();
	const { data: authorizations, refetch } = api.mcp.listAuthorizations.useQuery();
	const { mutateAsync: revoke, isPending: isRevoking } =
		api.mcp.revokeAuthorization.useMutation();

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<Plug className="size-6 text-muted-foreground self-center" />
								MCP Server
							</CardTitle>
							<CardDescription>
								Connect Claude Code (or any MCP client) to this Dokploy over HTTPS with
								OAuth. No API key, no local process.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-6 py-6 border-t">
						{info && !info.enabled && (
							<AlertBlock type="warning">
								{info.reason === "disabled"
									? "The MCP server is disabled on this instance (DOKPLOY_MCP_DISABLED=true)."
									: "The MCP server needs a public origin. Set a domain under Settings → Server (Web Domain), or set BETTER_AUTH_URL."}
							</AlertBlock>
						)}
						{info?.enabled && info.endpoint && info.addCommand && (
							<div className="space-y-3">
								<div className="text-sm">
									<span className="text-muted-foreground">Endpoint: </span>
									<span className="font-mono">{info.endpoint}</span>
								</div>
								<div className="flex items-center gap-2">
									<code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs overflow-x-auto">
										{info.addCommand}
									</code>
									<Button
										variant="outline"
										size="icon"
										type="button"
										onClick={() => {
											copy(info.addCommand ?? "");
											toast.success("Copied");
										}}
									>
										<Copy className="size-4" />
									</Button>
								</div>
								<p className="text-sm text-muted-foreground">
									Then run <code>/mcp</code> in Claude Code and choose Authenticate. The
									browser opens this Dokploy, you pick the scopes, and the token is shared
									by every session on that machine. Tokens refresh silently; you only sign
									in again if the client stays unused for {info.refreshTokenDays} days or
									you revoke it here.
								</p>
								<div className="text-sm">
									<span className="text-muted-foreground">MCP acts in organization: </span>
									<span className="font-medium">{info.organization?.name ?? "none"}</span>
									<span className="text-muted-foreground">
										{" "}
										(your default organization —{" "}
										<Link href="/dashboard/settings/organization" className="underline">
											change it
										</Link>
										).
									</span>
								</div>
							</div>
						)}

						<div className="space-y-2">
							<h3 className="text-sm font-medium">Authorized clients</h3>
							{authorizations && authorizations.length > 0 ? (
								authorizations.map((auth) => (
									<div
										key={auth.clientId}
										className="flex flex-col gap-2 p-4 border rounded-lg"
									>
										<div className="flex justify-between items-start gap-4">
											<div className="flex flex-col gap-1">
												<span className="font-medium">{auth.clientName}</span>
												<div className="flex flex-wrap gap-1">
													{auth.scopes.map((scope) => (
														<Badge key={scope} variant="secondary">
															{scope}
														</Badge>
													))}
												</div>
												<div className="text-xs text-muted-foreground">
													Authorized {formatDistanceToNow(new Date(auth.authorizedAt))} ago ·
													last refreshed {formatDistanceToNow(new Date(auth.lastRefreshedAt))}{" "}
													ago
													{auth.refreshExpiresAt &&
														` · expires ${formatDistanceToNow(new Date(auth.refreshExpiresAt), { addSuffix: true })} if unused`}
												</div>
											</div>
											<DialogAction
												title="Revoke MCP authorization"
												description="The client will lose access immediately and must authenticate again."
												type="destructive"
												onClick={async () => {
													try {
														await revoke({ clientId: auth.clientId });
														await refetch();
														toast.success("Authorization revoked");
													} catch (error) {
														toast.error(
															error instanceof Error ? error.message : "Error revoking",
														);
													}
												}}
											>
												<Button variant="ghost" size="icon" isLoading={isRevoking}>
													<Trash2 className="size-4" />
												</Button>
											</DialogAction>
										</div>
									</div>
								))
							) : (
								<p className="text-sm text-muted-foreground">
									No MCP client has been authorized yet.
								</p>
							)}
						</div>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
```

- [ ] **Step 2: Mount it on the profile page**

In `apps/dokploy/pages/dashboard/settings/profile.tsx` add `import { McpServer } from "@/components/dashboard/settings/mcp/mcp-server";` and render `<McpServer />` after `{permissions?.api.read && <ShowApiKeys />}` (the card is per-user; it needs no permission gate because every member may authorize a client that only carries their own permissions).

- [ ] **Step 3: Typecheck, format, commit**

```bash
cd apps/dokploy && pnpm typecheck && pnpm exec biome format --write components/dashboard/settings/mcp/mcp-server.tsx pages/mcp/authorize.tsx server/mcp server/api/routers/mcp.ts pages/api/mcp.ts pages/api/mcp-oauth lib/post-login-redirect.ts __test__/mcp
git.exe add apps/dokploy/components/dashboard/settings/mcp/mcp-server.tsx apps/dokploy/pages/dashboard/settings/profile.tsx apps/dokploy/server/api/routers/mcp.ts
git.exe commit -m "feat(mcp): MCP Server card on Settings → Profile"
```

---

### Task 15: Purge cron registration

**Files:**
- Modify: `apps/dokploy/server/server.ts`

- [ ] **Step 1: Register the job**

In `apps/dokploy/server/server.ts` add `initMcpTokenPurgeCronJob` and `isMcpDisabled` to the `@dokploy/server` import list, and after `await initEnterpriseBackupCronJobs();` add:

```ts
			if (!isMcpDisabled()) {
				initMcpTokenPurgeCronJob();
			}
```

- [ ] **Step 2: Typecheck and build the server bundle**

```bash
cd apps/dokploy && pnpm typecheck && pnpm build-server
```

Expected: `dist/server.mjs` produced without errors.

- [ ] **Step 3: Commit**

```bash
git.exe add apps/dokploy/server/server.ts
git.exe commit -m "feat(mcp): daily purge of expired OAuth token rows"
```

---

### Task 16: Full verification and PR

- [ ] **Step 1: Run the whole test suite and both typechecks**

```bash
cd apps/dokploy && pnpm vitest run --config __test__/vitest.config.ts && pnpm typecheck && cd ../../packages/server && pnpm typecheck
```

Expected: all green.

- [ ] **Step 2: Production build of the web app (catches SDK bundling issues)**

```bash
cd apps/dokploy && SKIP_ENV_VALIDATION=1 pnpm build-next
```

Expected: build completes. If webpack fails inside `@modelcontextprotocol/sdk` (e.g. on an optional dependency), add to `next.config.mjs`:

```js
	serverExternalPackages: ["@modelcontextprotocol/sdk"],
```

and rebuild; commit that as its own change.

- [ ] **Step 3: Format check on touched files only**

```bash
cd apps/dokploy && pnpm exec biome format --write pages/index.tsx pages/dashboard/settings/profile.tsx server/server.ts server/api/root.ts next.config.mjs
cd ../../packages/server && pnpm exec biome format --write src/lib/auth.ts src/services/mcp-oauth.ts src/db/schema/mcp-oauth.ts src/db/schema/index.ts src/index.ts
git.exe status --short
```

Commit any formatting deltas: `git.exe commit -am "style(mcp): biome format"`.

- [ ] **Step 4: Push and open the PR**

```bash
git.exe push origin feat/remote-mcp-oauth
gh pr create --repo DevinoSolutions/dokploy-community --base canary --head feat/remote-mcp-oauth --title "feat(mcp): remote MCP server with OAuth 2.1 and scoped grants" --body-file docs/superpowers/plans/pr-body-remote-mcp.md
```

Write `docs/superpowers/plans/pr-body-remote-mcp.md` first (do not commit it): summary of the feature, link to the spec, the migration (0198, three new tables, guarded), env knobs (`DOKPLOY_MCP_ACCESS_TOKEN_HOURS`, `DOKPLOY_MCP_REFRESH_TOKEN_DAYS`, `DOKPLOY_MCP_DISABLED`, `BETTER_AUTH_URL`), security notes (consent proof, DCR redirect policy, refresh rotation, scopes narrow only), and the manual verification checklist from the spec's Testing section. Delete the file after the PR is created.

- [ ] **Step 5: Verify CI**

```bash
gh api repos/DevinoSolutions/dokploy-community/commits/$(git.exe rev-parse HEAD)/check-runs --jq '.check_runs[] | {name, status, conclusion}'
```

Expected: typecheck, build, test all `success`. Known flakes (node-pty gyp, `application.real.test.ts` timeout): `gh run rerun <id> --repo DevinoSolutions/dokploy-community`.

---

## Self-review notes

- Spec coverage: OAuth server (T6), storage (T2), session synthesis (T5), registry (T8), scopes + snapshot (T7/T8), endpoint + 401 shape + 405 + body cap (T9), discovery + rewrites (T10), consent page (T13), login return path (T11), settings card + mcp router (T12/T14), token hygiene rotation + purge + revoke (T4/T6/T15), kill switch (T3/T9/T10/T14/T15), DCR redirect policy (T3/T6), error handling table (T9/T13), tests listed in spec (T3/T4/T5/T7/T8/T9/T10/T11/T12). Rollout (release, prod deploy, `claude mcp add`) is out of the implementation plan and stays user-gated.
- Deviations from the spec are recorded in the spec's Amendments section (T1): fork-served discovery, consent proof, toggle pre-selection.
- Type consistency: `DOKPLOY_MCP_SCOPE_IDS`/`DokployMcpScope` originate in `packages/server/src/services/mcp-oauth.ts` (T6 step 1) and are consumed by `scopes.ts` (T7) and `discovery.ts` (T10); `McpToolDefinition` (T8) is what `handler.ts` (T9) and the router (T12) consume; `buildMemberSession(userRow, organizationId)` (T5) is what `authenticateMcpBearer` (T9) calls; `createConsentProof/verifyConsentProof` payload keys match between T4, T6 and T12.
