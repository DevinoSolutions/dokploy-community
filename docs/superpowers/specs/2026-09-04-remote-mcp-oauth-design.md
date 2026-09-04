# Remote MCP server with OAuth (in-app) — design

Date: 2026-09-04
Status: approved design, pending implementation plan

## Problem

Today every Claude Code session that uses Dokploy spawns its own `@dokploy/mcp`
stdio process. That process eagerly materializes 524 Zod schemas plus 524 JSON
schemas, authenticates with a long-lived API key stored in plain text in the
client config, and forwards every call over REST. With 50+ concurrent sessions
that is 50+ node processes for one server, and one leaked API key equals full
access with no expiry and no scoping.

## Goals

1. Dokploy itself serves MCP over Streamable HTTP at `POST /api/mcp`. Clients
   hold no process and no secret file; Claude Code's built-in HTTP transport
   connects directly.
2. Authentication is OAuth 2.1 (PKCE, dynamic client registration) with Dokploy
   as the authorization server. `/mcp → Authenticate` in Claude Code opens the
   browser, the user signs in once, and the token is shared by every session on
   that machine.
3. Re-authentication is rare: access tokens refresh silently; the refresh token
   window slides on every use.
4. Every grant is **scoped**. At authorization time the user toggles what the
   client may do (read, deploy, edit services, delete services, edit projects,
   delete projects, backups, admin). Scopes only restrict; the user's role
   permissions still apply underneath.
5. Tool names are identical to `@dokploy/mcp` (`application-deploy`,
   `compose-one`, …) so existing prompts, skills and habits keep working.

## Non-goals (v1)

- JWT / DPoP / CIMD tokens (needs better-auth 1.7; revisit when upstream bumps).
- Choosing an organization at authorization time (v1 uses the user's default
  organization; see below).
- Redacting secrets from tool outputs (parity with REST; separate follow-up).
- MCP resources, prompts, server-initiated notifications, or SSE streaming.
- Any change to the existing API-key path. It keeps working unchanged.

## Decisions taken (with the user, 2026-09-04)

| Decision | Choice |
| --- | --- |
| Approach | In-app MCP endpoint on better-auth 1.6's in-core `mcp` plugin (no dependency bump) |
| Organization binding | User's default organization (`member.is_default`), fallback earliest membership |
| Token lifetimes | Access 24 h, refresh 180 d sliding; both env-tunable |
| Tool surface | All procedures, same names as `@dokploy/mcp`, filtered per grant by scopes |
| Scoping | Per-grant scope toggles on a Dokploy-owned authorization page |

## Architecture

```
Claude Code ──(1) POST /api/mcp (no token)──────────────▶ Dokploy
            ◀── 401 + WWW-Authenticate: Bearer resource_metadata=…
            ──(2) GET /.well-known/oauth-protected-resource ─▶  (rewrite → /api/auth/…)
            ──(3) GET /.well-known/oauth-authorization-server ▶ (rewrite → /api/auth/…)
            ──(4) POST /api/auth/mcp/register (DCR) ─────────▶
            ──(5) browser: GET /mcp/authorize?client_id…&scope… ▶ Dokploy consent page
                     │ not signed in → / (login) ?redirect=/mcp/authorize?… → back
                     │ user toggles scopes, clicks Authorize
                     ▼
                  GET /api/auth/mcp/authorize?…&scope=<granted>  (better-auth plugin)
            ◀── 302 http://localhost:<port>/callback?code=…&state=…
            ──(6) POST /api/auth/mcp/token (code + PKCE verifier) ▶
            ◀── { access_token, refresh_token, scope }
            ──(7) POST /api/mcp  Authorization: Bearer … ────────▶ tools/list, tools/call
```

Components (all fork-owned unless noted):

| Component | Location | Responsibility |
| --- | --- | --- |
| better-auth `mcp` plugin config | `packages/server/src/lib/auth.ts` (upstream-owned file, additive change) | OAuth server: DCR, authorize, token, refresh, discovery documents |
| `mcp-oauth` schema + migration 0198 | `packages/server/src/db/schema/mcp-oauth.ts`, `apps/dokploy/drizzle/0198_*.sql` | `oauthApplication`, `oauthAccessToken`, `oauthConsent` tables |
| Session synthesis | `packages/server/src/lib/auth.ts` → new `buildMemberSession(userId, organizationId)` | One function used by the API-key branch of `validateRequest` **and** the MCP endpoint |
| Tool registry | `apps/dokploy/server/mcp/registry.ts` | Derives tools from `appRouter` once; caches |
| Scope model | `apps/dokploy/server/mcp/scopes.ts` | Scope catalogue + tool→scope mapping |
| MCP endpoint | `apps/dokploy/pages/api/mcp.ts` | Bearer check, per-request `McpServer`, tool execution via tRPC caller |
| Discovery rewrites | `apps/dokploy/next.config.mjs` (upstream-owned, additive) | Root `.well-known` paths → plugin endpoints |
| Authorization page | `apps/dokploy/pages/mcp/authorize.tsx` | Scope toggles, client identity, Authorize / Cancel |
| Login return path | `apps/dokploy/pages/index.tsx` (upstream-owned, additive) | Honor a validated `redirect` query after sign-in |
| Settings card | `apps/dokploy/components/dashboard/settings/mcp/mcp-server.tsx` on Settings → Profile | Endpoint, `claude mcp add` command, authorizations list, Revoke |
| `mcp` tRPC router | `apps/dokploy/server/api/routers/mcp.ts` | `connectionInfo`, `listAuthorizations`, `revokeAuthorization` |
| Token hygiene | `apps/dokploy/server/mcp/token-hygiene.ts` + hook in auth config | Delete consumed refresh tokens on rotation; daily purge of expired rows |

## OAuth server (better-auth 1.6.23 in-core `mcp` plugin)

Verified from the installed plugin source (`plugins/mcp/index.mjs`,
`plugins/mcp/authorize.mjs`, `plugins/oidc-provider/schema.mjs`):

- Endpoints under `/api/auth`: `/mcp/authorize`, `/mcp/token`, `/mcp/register`,
  `/mcp/get-session`, `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`.
- Discovery requires `baseURL` to be a **string** (the issuer). Dokploy does not
  set one today. The fork sets `baseURL` from `BETTER_AUTH_URL` when present,
  otherwise `https://<webServerSettings.host>` when a host is configured. If
  neither exists the MCP feature is disabled at runtime (endpoint returns 503
  with a clear message, settings card explains what to set).
- Authorization codes carry the requested `scope` list; the token row stores
  `scopes`. The plugin validates requested scopes against
  `["openid","profile","email","offline_access", ...oidcConfig.scopes]`.
- `defaultScope` applies when the client sends no `scope`. The fork sets it to
  `openid offline_access` plus all Dokploy scopes so a client that requests
  nothing still receives a refresh token and still lands on the consent page
  with everything toggled on.
- Refresh grant: a **new** token row is created with
  `refreshTokenExpiresAt = now + refreshTokenExpiresIn` — the window slides on
  every refresh. The consumed row is not deleted by the plugin; the fork does
  that (see Token hygiene).
- Consent is skipped by the plugin unless the client sends `prompt=consent`.
  Claude Code does not. Therefore the fork **overrides
  `authorization_endpoint`** in the discovery metadata to point at its own
  page (`/mcp/authorize`), which collects scope choices and then forwards to
  the plugin's authorize endpoint. `loginPage` is set to `/` as the plugin's
  own fallback.
- DCR is anonymous. The fork adds a `before` hook on `/mcp/register` that
  rejects any `redirect_uris` entry that is not `http://localhost[:port]/…`,
  `http://127.0.0.1[:port]/…`, or `https://…`.

Plugin options as configured:

```ts
mcp({
  loginPage: "/",
  resource: `${origin}/api/mcp`,
  oidcConfig: {
    accessTokenExpiresIn: hours(env DOKPLOY_MCP_ACCESS_TOKEN_HOURS, default 24),
    refreshTokenExpiresIn: days(env DOKPLOY_MCP_REFRESH_TOKEN_DAYS, default 180),
    requirePKCE: true,
    defaultScope: "openid offline_access " + ALL_DOKPLOY_SCOPES.join(" "),
    scopes: ALL_DOKPLOY_SCOPES,
    metadata: {
      authorization_endpoint: `${origin}/mcp/authorize`,
      scopes_supported: ["openid", "offline_access", ...ALL_DOKPLOY_SCOPES],
    },
  },
})
```

`DOKPLOY_MCP_DISABLED=true` removes the endpoint (503) and hides the settings
card; the plugin stays registered so existing tokens simply stop working.

## Discovery routing

`next.config.mjs` gains rewrites (Claude Code and the MCP spec probe the origin
root, not `/api/auth`):

| Public path | Target |
| --- | --- |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/:path*` | `/api/auth/.well-known/oauth-protected-resource` |
| `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` | `/api/auth/.well-known/oauth-authorization-server` |

The protected-resource document reports `resource = ${origin}/api/mcp` and
`authorization_servers = [origin]`.

## Identity → request context

`buildMemberSession(userId, organizationId)` is extracted from the API-key
branch of `validateRequest` and returns the exact `{ session, user }` shape
that tRPC context expects (user row mapped to better-auth fields, `role` from
the member row, `ownerId`, enterprise flags). The API-key branch calls it; MCP
calls it with the organization resolved as:

1. the `member` row for the user with `is_default = true`, else
2. the user's earliest membership by `created_at`, else
3. no membership → 401.

Switching organization is a dashboard action (Settings → Organization →
set default); it takes effect on the next MCP request. This is documented in
the settings card.

## Scopes

Catalogue (`apps/dokploy/server/mcp/scopes.ts`):

| Scope | Grants | Default on |
| --- | --- | --- |
| `dokploy:read` | every `query` procedure | yes |
| `dokploy:deploy` | deploy / redeploy / start / stop / restart / reload / rebuild / cancel / kill-build / rollback / deployment cleanup / preview redeploy | yes |
| `dokploy:services:write` | create and update of applications, compose, databases, domains, ports, redirects, security, mounts, previews, schedules, patches, tags, service transfer | yes |
| `dokploy:services:delete` | delete / remove / drop of the above | no |
| `dokploy:projects:write` | project and environment create / update / duplicate | yes |
| `dokploy:projects:delete` | project and environment remove | no |
| `dokploy:backups` | backup, backup policy, volume backup, destination mutations incl. manual runs and restores | yes |
| `dokploy:admin` | everything else: settings, servers, cluster/swarm, docker cleanup, SSH keys, registries, git providers, notifications, certificates, DNS/Cloudflare, vault, AI, users, organization, roles, SSO/SCIM, license, forward-auth, whitelabeling | no |

Mapping rules, applied in order, produce one scope per tool:

1. explicit per-procedure overrides (small table, e.g. `deployment.killProcess → deploy`, `compose.deployTemplate → services:write`);
2. `type === "query"` → `dokploy:read`;
3. router membership table (service routers, project routers, backup routers, admin routers);
4. inside service/project routers, procedure name matching `/^(delete|remove|drop|clear|clean)/i` → the `:delete` variant;
5. inside service routers, name matching the deploy pattern → `dokploy:deploy`;
6. unmapped → `dokploy:admin` (fail closed).

A snapshot test pins the full `tool → scope` table so any drift shows up as a
reviewable diff.

Enforcement, defense in depth:

- `tools/list` returns only tools whose scope is in the token's `scopes`.
- `tools/call` re-checks the scope before executing; a missing scope returns an
  MCP error result (`isError: true`, message names the scope needed) and never
  reaches the procedure.
- The procedure itself still runs the user's role/permission checks; scopes
  can only narrow, never widen.

`openid` and `offline_access` are always granted (needed for the refresh
token); they are not shown as toggles.

## Authorization page (`/mcp/authorize`)

- Server-side: `validateRequest`; if not signed in, redirect to
  `/?redirect=<this url>`. Loads the client (`oauthApplication` by
  `client_id`); unknown client or `redirect_uri` not in its registered list →
  error page, never a redirect.
- Shows: client name (from DCR, e.g. "Claude Code"), the redirect host it will
  send the code to, the organization the grant will act in, and one toggle per
  Dokploy scope with a one-line description and tool count. Requested scopes
  (query `scope` ∩ catalogue) pre-check the toggles; when absent, defaults from
  the table above apply.
- Authorize → browser navigates to `/api/auth/mcp/authorize?<original query>`
  with `scope` replaced by `openid offline_access <selected>`; all other
  parameters (`client_id`, `redirect_uri`, `response_type`, `state`,
  `code_challenge`, `code_challenge_method`, `resource`) pass through
  untouched.
- Cancel → `redirect_uri?error=access_denied&state=<state>`.
- Layout: the existing auth layout (same shell as the login page), not the
  dashboard chrome.

## Login page return path

`pages/index.tsx` reads `router.query.redirect`. After any successful sign-in
path (email, passkey, 2FA, backup code) it navigates there instead of
`/dashboard/home` when the value is a same-origin relative path (`/…`, not
`//…`, no scheme). Because the plugin's own fallback redirects unauthenticated
users to `/?client_id=…`, the login page also treats the presence of
`client_id` + `redirect_uri` + `response_type` as "return to
`/mcp/authorize?<query>`".

## Tool registry

Built lazily once per process from `appRouter._def.procedures`:

- Path `router.procedure` → tool name `router-procedure` (matches
  `@dokploy/mcp`; all Dokploy routers are one level deep).
- Skip: subscriptions; procedures with `meta.openapi.enabled === false`
  (mirrors what REST hides); the `mcp` router itself; procedures whose input
  is not a Zod object (none expected; logged if found).
- `inputSchema` = the procedure's own Zod input (`_def.inputs[0]`), or an empty
  object when there is none. The JSON schema handed to clients is generated
  with `target: "jsonSchema2019-09"` semantics and a single top-level
  `$schema` of draft 2020-12, the same fix `@dokploy/mcp` applies for
  Anthropic's validator (their issue #32).
- `description` = `meta.openapi.description` or `meta.openapi.summary` when
  present, else `"<GET|POST> /<router>.<procedure>"` (parity).
- Annotations: `readOnlyHint` + `idempotentHint` for queries;
  `destructiveHint` for `:delete` scopes and admin cleanup procedures;
  `openWorldHint` true.

Per request the endpoint creates a `McpServer`, registers the tools allowed by
the token's scopes from the cached registry, connects a stateless
`StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`), handles the
request, then closes both. `GET` and `DELETE` on `/api/mcp` return 405 with a
JSON-RPC error body.

Tool execution: `createCallerFactory(appRouter)(ctx)` with the synthesized
context; call `caller[router][procedure](input)`. Success → `content` text of
`JSON.stringify(result)` plus `structuredContent` when the result is an
object. `TRPCError` → `isError: true` with `code: message`. Body size is capped
with the existing `OPENAPI_MAX_JSON_BODY_SIZE`.

## Storage

Drizzle tables in `packages/server/src/db/schema/mcp-oauth.ts` using the
snake_case column convention of the other better-auth-managed tables
(`account.ts`), with field names matching the plugin schema exactly:

- `oauth_application`: `id`, `client_id` (unique), `client_secret`, `name`,
  `icon`, `metadata`, `type`, `disabled`, `redirect_urls`, `user_id` (FK user,
  cascade, index), `created_at`, `updated_at`.
- `oauth_access_token`: `id`, `access_token` (unique), `refresh_token`
  (unique), `access_token_expires_at`, `refresh_token_expires_at`,
  `client_id` (FK application.client_id, cascade, index), `user_id` (FK user,
  cascade, index), `scopes`, `created_at`, `updated_at`.
- `oauth_consent`: `id`, `client_id`, `user_id`, `scopes`, `consent_given`,
  `created_at`, `updated_at`.

Migration `0198` is generated with `migration:generate`, then hand-guarded
(`CREATE TABLE IF NOT EXISTS`, `DO $$ … duplicate_object` for FKs) and logged
in `docs/UPSTREAM_SYNC.md` as fork-owned tables. The implementer verifies the
drizzle adapter maps plugin field names to these drizzle keys (as it does for
`account`).

## Token hygiene

- Rotation: an `after` hook on `/mcp/token` with `grant_type=refresh_token`
  deletes the row whose `refresh_token` was just consumed, so an old refresh
  token cannot be replayed. If the hook cannot observe the consumed token
  reliably, fall back to deleting rows for the same `client_id + user_id`
  whose `refresh_token_expires_at` is older than the newest row's.
- Purge: a daily job (registered next to the other non-cloud cron jobs)
  deletes rows whose `refresh_token_expires_at < now()` and rows with no
  refresh token whose access token has expired.
- Revoke (settings card / `mcp.revokeAuthorization`): deletes every token row
  for `client_id + user_id`; the client's next request gets 401 and Claude
  Code re-prompts for authentication.

## Settings UI

Card "MCP Server" under Settings → Profile, next to API Keys, following the
`wildcard-domain.tsx` card pattern:

- Endpoint URL and a copyable
  `claude mcp add --transport http --scope user dokploy <origin>/api/mcp`.
- The organization MCP will act in, with a link to where to change the
  default.
- Table of the caller's authorizations grouped by client: name, granted
  scopes as badges, created, last refreshed, refresh expiry, Revoke button
  (confirm dialog).
- When MCP is disabled (no base URL or `DOKPLOY_MCP_DISABLED`), the card says
  why and what to set.

## Error handling

| Situation | Behaviour |
| --- | --- |
| No / expired / unknown bearer | 401, `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`, JSON-RPC error body |
| Token valid, user has no membership | 401 (same shape) |
| Tool not in granted scopes | MCP result `isError: true`, "requires scope dokploy:…" |
| Procedure throws `TRPCError` | MCP result `isError: true`, `<CODE>: <message>` |
| Unexpected exception | MCP result `isError: true`, generic message; error captured by Sentry with the tool name |
| MCP disabled / no base URL | 503 with explanatory JSON |
| DCR with disallowed redirect URI | 400 `invalid_redirect_uri` |
| Consent page: unknown client / unregistered redirect | Rendered error, no redirect |

## Testing

- `registry.test.ts`: tool name set equals the expected list (fixture generated
  from the current `@dokploy/mcp` build minus fork-excluded procedures);
  excluded procedures absent; every tool has an object input schema; JSON
  schema carries a single 2020-12 `$schema`.
- `scopes.test.ts`: snapshot of `tool → scope`; unmapped procedure resolves to
  `dokploy:admin`; delete/deploy pattern rules.
- `mcp-endpoint.test.ts` (router-test pattern, mocked db): 401 header shape;
  `tools/list` filtered by scopes; `tools/call` outside scope is refused and
  the procedure mock is never invoked; in-scope call reaches the caller with
  the synthesized context; default-organization resolution (is_default, then
  earliest, then none → 401).
- `dcr-redirect-uri.test.ts`: allowed vs rejected redirect URIs.
- `login-redirect.test.ts`: relative-path validation of the `redirect` query.
- Existing `routers-org-scope-*` tests keep guarding cross-organization access
  for everything the caller executes.
- Manual, on prod after release: `claude mcp add … --scope user`, `/mcp →
  Authenticate`, browser flow with scope toggles, a read tool, a deploy tool,
  a delete tool with the scope off (refused), revoke from the settings card,
  re-authenticate.

## Rollout

1. PR into `canary` (fork-original, authored by AminDhouib), CI green,
   security review of the endpoint and hooks.
2. Release as the next `v0.30.3-community.N`; prod deploy runs migration 0198.
3. User migrates: `claude mcp remove dokploy-mcp` (user scope), add the HTTP
   server, authenticate once. The API key stays valid for anything else that
   still uses it.

## Open follow-ups (not in this spec)

- better-auth 1.7 upgrade for JWT/JWKS + DPoP once upstream moves.
- Organization picker at authorization time.
- Output redaction of secrets in tool results.
- Per-server scoping (`dokploy:server:<id>`).
