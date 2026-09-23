# Devino product integrations for dokploy-community — plan

Date: 2026-09-22. Status: proposal, awaiting owner decisions listed at the end.

## Goal

Ship first-class integrations of Devino products into the fork so that every
service in Dokploy can be monitored (Uptimely) and every custom domain can be
connected by an end user without touching DNS by hand (DoDomain), with each
integration visibly branded "powered by Uptimely / DoDomain" so the fork also
advertises the products.

## What already exists (surveyed 2026-09-22)

Fork side:

- Cloudflare is already integrated end to end: tunnels (`cloudflareTunnelMode`,
  `cloudflareTunnelId`, `cloudflare_tunnel_runtime`), Access applications, DNS
  record publishing, and a DNS-provider abstraction covering cloudflare,
  route53, porkbun, infomaniak and ovh (`packages/server/src/db/schema/{cloudflare,cloudflare-access,dns-provider}.ts`,
  services `cloudflare*.ts`, `dns-provider.ts`, settings pages
  `pages/dashboard/settings/{cloudflare,dns}.tsx`). "Cloudflare connection" and
  "tunneling" from the request are therefore already covered; DoDomain must add
  something Cloudflare-by-token does not.
- Monitoring is built in (container/server metrics, free and paid tiers) and the
  service detail pages already have a `monitoring` tab
  (`pages/dashboard/project/[projectId]/environment/[environmentId]/services/application/[applicationId].tsx`,
  TabsTrigger at line 279). No third-party monitoring hook exists.
- Notification providers: 12 types, one table each, fanned out per event from
  `packages/server/src/utils/notifications/{build-success,build-error,database-backup,volume-backup,docker-cleanup,dokploy-backup,dokploy-restart,schedule-failure,server-threshold}.ts`.
  Adding a provider is a known recipe (schema table + `notificationType` enum
  value + service + router + settings card + icon).
- Provider-settings recipe (Cloudflare and DNS providers follow it): schema
  table → `services/<name>.ts` → `server/api/routers/<name>.ts` registered in
  `root.ts` → `components/dashboard/settings/<name>/{show,handle}-<name>.tsx` →
  `pages/dashboard/settings/<name>.tsx` → nav entry in `components/layouts/side.tsx`.
- Domain validation is pattern based; there is no live DNS lookup anywhere in
  the server package.
- No generic outbound webhook subscriptions; the `custom` notification provider
  is the only arbitrary POST.

Uptimely (`getuptimely.com`, repo `INTERNAL/uptimely`):

- No public REST API by design (roadmap item NF-038). The only programmatic
  surface is the MCP server at `https://app.getuptimely.com/api/mcp` (19 tools)
  with two auth modes: OAuth 2.1 bearer, or a project API key (bare UUID) sent
  as `Authorization: Bearer <key>`, project-locked, all scopes.
- Write tools (`uptimely_monitor_create`, `uptimely_incident_declare`,
  `uptimely_alert_state_change`, `uptimely_run_monitor_probe`, …) are gated by a
  per-project `enableAiWriteOperations` toggle, default OFF.
- Public SVG status badge: `GET /status/<slug>/badge`, no auth, 5-minute cache.
- Heartbeat monitors: `POST|GET https://app.getuptimely.com/heartbeat/<secretKey>`.
- Outgoing alert webhooks exist (`packages/domain/src/public-api-webhook-*.ts`),
  signed, retried with frozen payloads.
- Monitor types: Website, API, Ping, IP, Port, DNS, SSL Certificate, Domain,
  Manual, Incoming Request.

DoDomain (`dodomain.io`, repo `INTERNAL/dodomain`):

- Custom-domain connect for SaaS: the integrator creates a connect session, the
  end user is walked through Cloudflare OAuth, Domain Connect (one-consent apply
  at the registrar) or a guided manual flow with per-provider deep links; records
  are verified against the authoritative nameservers and a signed webhook
  (`connection.verified|failed|disconnected`, `session.completed|abandoned`)
  reports back. Not a registrar.
- REST API at `https://app.dodomain.io/api/v1`: `POST /domains/check`,
  `POST /sessions` (returns `connectUrl` + composed DNS records),
  `GET|DELETE /connections`, `POST /connections/:id/reverify`,
  `/webhook-endpoints/*`. Auth: `dd_sk_…` secret key as bearer, or OAuth 2.1 with
  scopes. Typed client `@dodomain/node`; embeddable `@dodomain/connect` (iframe
  modal) and `@dodomain/react`.
- Plans: Free 50 connections/month, 1 app, 60 req/min, attribution badge
  required; Pro $29 (500, 3 apps, 300 req/min, white-label); Scale $99 (2500,
  unlimited apps, 1200 req/min). 10 webhook endpoints per app on every plan.
- Uptimely already consumes DoDomain webhooks for status-page custom domains
  (`uptimely/src/app/api/webhooks/dodomain/route.ts`): a working reference
  consumer in the same codebase family.

## Fit assessment of the full lineup (17 RevenueCat projects, 2026-09-22)

Owner decision 2026-09-22 (final): build native integrations for Uptimely,
Snapvisor, Sendly, Notifly and DoDomain. upAPI and GetItDone were weighed and
dropped from the build lineup; their sections stay below as optional later
work. Everything else is skipped.

| Product | Dokploy surface | Verdict |
|---|---|---|
| Uptimely | Per-service uptime/SSL/domain monitors, status badge, deploy heartbeat | **Build 1** |
| DoDomain | End-user custom-domain connect + real DNS verification for hosted apps | **Build 2** |
| Snapvisor (visual testing) | Register preview deployments, show visual-diff status on the preview card | **Build 3** |
| Notifly (push/workflows) | Notification provider triggering a workflow on deploy events | **Build 4** |
| Sendly (email) | Notification provider like `resend` | **Build 4** |
| upAPI (marketplace API gateway) | "Publish as marketplace API" action on a service | Later, optional (dropped from lineup) |
| GetItDone (AI task management) | Notification provider creating ops tasks on failures | Later, optional (dropped from lineup) |
| VoiceLabs, Shorty | Compose templates in the external templates repo only | Later, no in-product hook |
| Marka, Postify, SuperBooks, BioFlow, SafeMeet, Demofy, Caly, uNotes | No PaaS-shaped surface | Skip |
| Sapphis | Not in RevenueCat, no local repo, no MCP | Cannot assess |

## Integration 1 — Uptimely

### Scope (v1)

1. **Settings → Monitoring → Uptimely card** (reuses the existing Monitoring
   settings page rather than a new page, per the "enrich existing surfaces"
   rule): stores one Uptimely connection per organization: project API key
   (encrypted at rest like the Cloudflare `apiToken`), project id, base URL
   (default `https://app.getuptimely.com`, overridable for self-hosted
   Uptimely). "Test connection" button calls `uptimely_project_list`.
2. **Per-service "Uptime" panel inside the existing monitoring tab** of
   application, compose and database pages. States:
   - not linked → "Monitor this service with Uptimely" button. It creates one
     `Website` monitor per HTTPS domain (or `Port`/`Ping` for databases with an
     exposed port), interval 5 min, named `<project>/<service>`, and stores the
     monitor ids.
   - linked → current status pill, last 24h/7d/30d timeline from
     `uptimely_monitor_status_history`, open incidents, "Run probe now"
     (`uptimely_run_monitor_probe`), "Open in Uptimely" deep link, and the public
     badge if the org has a status page. Footer "Powered by Uptimely" with the
     product link.
3. **Deploy heartbeat**: optional per-service `Incoming Request` monitor; the
   fork pings `/heartbeat/<key>` from `build-success.ts`, so a service that
   stops deploying on schedule raises an Uptimely alert.
4. **Domain hygiene monitors**: when a domain is added with HTTPS, offer
   `SSL Certificate` + `Domain` monitors alongside the Website one.
5. **Uptimely as a notification channel** (13th `notificationType`): deploy
   failures declare an Uptimely incident (`uptimely_incident_declare`) and
   successes resolve it (`uptimely_incident_state_change`). Optional in v1;
   cheap once the client exists.

### Transport decision

Uptimely has no REST API, so the fork talks MCP over Streamable HTTP with the
project API key as bearer. Implement a tiny JSON-RPC client in
`packages/server/src/utils/uptimely/client.ts` (`initialize` → `tools/call`),
not the full MCP SDK client, to keep the dependency surface small. Requires the
Uptimely project to have `enableAiWriteOperations` ON for monitor creation; the
settings card must surface that requirement with a link to the toggle.
Recommendation for the Uptimely repo in parallel: ship the roadmap REST API
(NF-038) or at least exempt API-key callers from the AI-write gate, since a PaaS
creating monitors is not an "AI write".

### Data

New table `uptimely_integration` (organizationId, apiKey encrypted, projectId,
baseUrl, statusPageSlug nullable) and `uptimely_monitor_link` (serviceType,
serviceId, monitorId, kind: website|port|ssl|domain|heartbeat, heartbeatKey
encrypted). One fork migration in the next slot, plus a fork_schema_catchup
entry per the sync rule.

### Effort

Settings card + client: 1 day. Per-service panel across three service types:
2 days. Heartbeat + notification channel: 1 day. Tests: MCP client mocked;
vitest for link/unlink and event fan-out.

## Integration 2 — DoDomain

### Why it is not redundant with the existing Cloudflare integration

The existing integration serves the **operator**: their Cloudflare account, their
tunnels, their zones. DoDomain serves the **operator's end users**: a Dokploy app
that is itself a SaaS wants its customers to bring `app.customer.com`. Today the
operator has to explain CNAME records; DoDomain gives them a hosted connect flow
across registrars. It also fixes a real gap: the fork never verifies DNS.

### Scope (v1)

1. **Settings → Domains/DNS page → DoDomain card**: secret key (encrypted),
   app id, base URL (default `https://app.dodomain.io`). Registers one webhook
   endpoint on save (`POST /webhook-endpoints`) pointing at
   `<dokploy-url>/api/webhooks/dodomain`, storing the signing secret.
2. **Domain verification on the existing Add Domain dialog**: when a host is
   entered, call `POST /domains/check` to show provider, tier and the exact
   records expected, and a "Send connect link" action that creates a session
   (`POST /sessions`) and shows/copies the `connectUrl`. Domain rows gain a
   `dodomainConnectionId` and a `verificationStatus`
   (unverified|pending|verified|failed) badge next to the existing Cloudflare
   badges.
3. **Webhook receiver** `apps/dokploy/pages/api/webhooks/dodomain.ts`, HMAC
   verify with `x-dodomain-signature`, dedupe by delivery id, map
   `connection.verified` → status verified and trigger the existing Traefik
   domain apply / certificate request; `connection.failed|disconnected` → mark
   and notify through the notification fan-out. Model on Uptimely's consumer.
4. **"Powered by DoDomain"** attribution on the connect UI (required by the Free
   plan anyway).

Out of scope for v1: tunnels (already Cloudflare), embedding `@dodomain/connect`
inside Dokploy (the connect link is for the end user, who is not a Dokploy
user), bulk reverify.

### Data

`dodomain_integration` (organizationId, secretKey encrypted, appId, baseUrl,
webhookEndpointId, webhookSecret encrypted) and three nullable columns on
`domains` (`dodomainConnectionId`, `dodomainSessionId`, `dnsVerificationStatus`).
`domains` is upstream-owned, so the columns go in the sync ledger like the
wildcard columns did.

### Effort

Settings card + client (`@dodomain/node` or a 6-call fetch wrapper): 1 day.
Add Domain dialog changes + status badges: 1.5 days. Webhook receiver + Traefik
trigger + tests: 1 day.

## Integration 3 — Snapvisor on preview deployments

Snapvisor (Argos fork, `INTERNAL/snapvisor`) already has a deployments API
(`POST /v2/deployments`, handler `apps/backend/src/api/handlers/projectDeployments.ts`)
and MCP tools `listProjectDeployments`, `listBuilds`, `listBuildDiffs`,
`createReview`; the deployments product is built but unprovisioned, so this is
its launch use case.

Scope (v1):

1. **Settings → Snapvisor card**: access token (encrypted), account slug, base
   URL (default `https://app.snapvisor.io`).
2. **Per-application "Visual testing" toggle** in the preview-deployments
   settings: pick the Snapvisor project. On preview-deployment success the fork
   registers a deployment (preview URL, PR number, commit SHA, branch) with
   Snapvisor.
3. **Preview-deployment card** gains a Snapvisor build badge: pending / diffs
   detected (n changes) / approved / rejected, with a deep link to the build
   review. Polled through the existing preview refresh, no webhook receiver in
   v1.
4. Attribution "Visual testing by Snapvisor".

Out of scope for v1: taking screenshots inside Dokploy. Capture stays in the
user's CI via the Snapvisor CLI; the fork only ties builds to deployments and
surfaces the result. v2 can add an optional Playwright capture job run as a
Dokploy schedule against the preview URL.

Data: `snapvisor_integration` (organizationId, token encrypted, accountSlug,
baseUrl) + nullable `snapvisorProjectId` on `application` and
`snapvisorDeploymentId`/`snapvisorBuildStatus` on `previewDeployments`
(upstream-owned table → sync ledger).

Effort: settings card + client 0.5 day, deployment registration hook 0.5 day,
preview card badge 1 day.

## Integration 4 — Notifly and Sendly notification providers

Same shape as the existing `resend` provider: one table each (api key, workflow
id / from address), one `notificationType` enum value, one send function in
`utils/notifications/utils.ts`, one settings card, one icon. Half a day each.
Every deploy/backup/schedule/threshold event already fans out to all providers,
so both light up everywhere at once.

## Later, optional — upAPI "Publish as marketplace API" (not in the build lineup)

upAPI (`INTERNAL/upAPI`, upapi.io) runs one source-of-truth API definition
(manifest, input schema, output schema, execute function) and exposes it on
upapi.io, RapidAPI and Apify. A Dokploy service already has a stable URL,
domain and health; upAPI adds keys, metering, billing and listings. This is the
"serverless function becomes a sellable API" path.

Scope (v1):

1. **Settings → upAPI card**: account API key (encrypted), base URL.
2. **"Publish as marketplace API" action** in the application domain tab:
   form for name, description, input/output JSON schema (prefilled from an
   OpenAPI URL if the service exposes one), pricing tier; the fork creates the
   upAPI definition whose execute function proxies to the service domain with a
   per-definition shared secret header that Traefik middleware enforces, so the
   origin only answers upAPI.
3. Domain row badge "Listed on upAPI" with call counts pulled from upAPI.

Needs a survey of the upAPI management API before implementation (not done
today). Effort estimate 3 days including the Traefik header middleware.

## Later, optional — GetItDone ops-task provider (not in the build lineup)

GetItDone (`INTERNAL/GetItDone`, app.nowgetitdone.com) is an AI-native task
manager with an MCP where agents are first-class users. Fit is operations, not
end users: a notification provider that creates a task on `build-error`,
`database-backup`/`volume-backup` failure, `schedule-failure` and
`server-threshold`, with the log tail, deployment link and server attached, and
optionally completes it on the next `build-success` for the same service.
GetItDone agents can then triage. Half a day via the provider recipe; build
last.

## Order and release plan

1. PR A: Settings → Integrations page + Uptimely card + MCP client +
   per-service Uptime panel for applications, compose and every database
   type (fork PR #229). Release as v0.30.7-community.3 after a stealth-Chrome
   pass against prod (the Devino Team project already has 50 monitors to link).
2. PR E: Notifly + Sendly providers (built in parallel with PR A; whichever
   merges second regenerates its migration into the next slot).
3. PR C: DoDomain card + Add Domain verification + webhook receiver (needs the
   Integrations page from PR A).
4. PR D: Snapvisor card + preview-deployment registration + badge (needs the
   Integrations page from PR A).
5. PR B (follow-up): Uptimely heartbeat on deploy + Uptimely notification
   channel.
6. README "Integrations" section listing the five with product links.

upAPI and GetItDone are not scheduled.

## Decisions needed from the owner

Decided 2026-09-22 (final): lineup = Uptimely, Snapvisor, Sendly, Notifly,
DoDomain. upAPI and GetItDone dropped.

Still open:

1. Uptimely side: turn on `enableAiWriteOperations` for the Devino Team
   project, or ship a REST API / API-key exemption so the fork can create
   monitors without the AI-write gate.
2. Whether the Uptimely per-service panel sits above the existing monitoring
   metrics (recommended) or replaces them.
3. Whether monitors are created automatically for every new HTTPS domain
   (opt-in default recommended).
4. Snapvisor: provision the deployments product on app.snapvisor.io before PR D.
5. Sapphis: what is it, and does it have an API or MCP? Not present locally.
