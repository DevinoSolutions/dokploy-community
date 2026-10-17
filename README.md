# Dokploy Community Edition

> **This is a community fork of [Dokploy](https://github.com/Dokploy/dokploy).** We are **not** affiliated with or competing against the Dokploy project. This fork exists to make new features available faster.

Based on **Dokploy v0.30.8** | Fork version **v0.30.8-community.30**

Everything in upstream Dokploy **v0.30.8**, plus features that upstream does not have and fixes ported from open upstream PRs, each ported **1:1 with credit to its original author**. When a port merges upstream later, you lose nothing by switching back.

## Guides

- **[Integrations guide](https://dokploy-community.devino.ca/integrations/)** — set up Uptimely, Snapvisor, DoDomain, Sendly and Notifly
- **[FAQ](https://dokploy-community.devino.ca/faq/)** — install, migrate from Dokploy, MCP server for Claude Code, large deploy webhooks, DoDomain, uptime monitoring, telemetry

## Switching from official Dokploy

One command. Keeps every app, database, domain, and setting — the extra migrations are additive:

```bash
docker service update \
  --image ghcr.io/devinosolutions/dokploy-community:v0.30.8-community.30 \
  --with-registry-auth \
  dokploy
```

Going back to official is just as easy (our extra tables/columns are simply ignored):

```bash
docker service update --image dokploy/dokploy:v0.30.8 --with-registry-auth dokploy
```

The image is public — no registry login required.

## Running in production

Devino runs its own products on Dokploy Community, built and deployed through the fork and monitored by [Uptimely](https://getuptimely.com). Each badge below is live and links to that product's public status page.

| Product | What it is | Status |
| --- | --- | --- |
| [Uptimely](https://getuptimely.com) | Uptime monitoring, on-call, status pages | [![Uptimely status](https://app.getuptimely.com/status/uptimely-status/badge)](https://app.getuptimely.com/status/uptimely-status) |
| [Snapvisor](https://snapvisor.io) | Visual regression testing for pull requests | [![Snapvisor status](https://app.getuptimely.com/status/snapvisor-io/badge)](https://app.getuptimely.com/status/snapvisor-io) |
| [DoDomain](https://dodomain.io) | Custom domains for SaaS | [![DoDomain status](https://app.getuptimely.com/status/dodomain-status/badge)](https://app.getuptimely.com/status/dodomain-status) |
| [Notifly](https://notifly.io) | Notification infrastructure API | [![Notifly status](https://app.getuptimely.com/status/notifly-status/badge)](https://app.getuptimely.com/status/notifly-status) |
| [GetItDone](https://nowgetitdone.com) | AI daily planner and to-do list | [![GetItDone status](https://app.getuptimely.com/status/getitdone-status/badge)](https://app.getuptimely.com/status/getitdone-status) |
| [SuperBooks](https://superbooks.io) | AI bookkeeping and accounting software | [![SuperBooks status](https://app.getuptimely.com/status/superbooks-status/badge)](https://app.getuptimely.com/status/superbooks-status) |
| [VoiceLabs](https://voicelabs.now) | AI text to speech, voice cloning | [![VoiceLabs status](https://app.getuptimely.com/status/voicelabs-status/badge)](https://app.getuptimely.com/status/voicelabs-status) |
| [Shorty](https://aishorty.com) | AI video and article summarizer | [![Shorty status](https://app.getuptimely.com/status/shorty/badge)](https://app.getuptimely.com/status/shorty) |
| [Demofy](https://demofy.io) | Automated product demo videos | [![Demofy status](https://app.getuptimely.com/status/demofy-status/badge)](https://app.getuptimely.com/status/demofy-status) |
| [Syncara](https://syncara.ca) | Personal health record app | [![Syncara status](https://app.getuptimely.com/status/syncara-status/badge)](https://app.getuptimely.com/status/syncara-status) |
| [Caramel](https://grabcaramel.com) | Free open-source coupon extension | [![Caramel status](https://app.getuptimely.com/status/caramel-status/badge)](https://app.getuptimely.com/status/caramel-status) |
| [Marka](https://joinmarka.com) | 0% fee buy and sell marketplace | [![Marka status](https://app.getuptimely.com/status/marka-status/badge)](https://app.getuptimely.com/status/marka-status) |
| [SafeMeet](https://safemeet.now) | Anonymous moderated 1:1 chat | [![SafeMeet status](https://app.getuptimely.com/status/safemeet-status/badge)](https://app.getuptimely.com/status/safemeet-status) |
| [Caly](https://trycaly.com) | Free scheduling app | [![Caly status](https://app.getuptimely.com/status/caly-status/badge)](https://app.getuptimely.com/status/caly-status) |
| [BioFlow](https://getbioflow.com) | AI link in bio builder | [![BioFlow status](https://app.getuptimely.com/status/bioflow-status/badge)](https://app.getuptimely.com/status/bioflow-status) |
| [uNotes](https://unotes.net) | Free university notes, past exams | [![uNotes status](https://app.getuptimely.com/status/unotes-status/badge)](https://app.getuptimely.com/status/unotes-status) |

The fork's own integrations guide shows how to wire Uptimely monitors, the deploy heartbeat and the incident channel into your apps: [Integrations guide](https://dokploy-community.devino.ca/integrations/).

## Key features

Only what upstream Dokploy does not ship. The **[changelog](https://github.com/DevinoSolutions/dokploy-community/blob/canary/CHANGELOG.md)** and the **[full release notes](https://github.com/DevinoSolutions/dokploy-community/releases/latest)** have the complete, per-PR credited list.

### Remote MCP server with OAuth (fork original)

- Dokploy hosts its own **MCP server** at `POST /api/mcp` (Streamable HTTP). Claude Code, Cursor or any MCP client connects over HTTPS with **no local process and no API key**
- **OAuth 2.1** with PKCE and dynamic client registration: `claude mcp add --transport http --scope user dokploy https://<host>/api/mcp`, then `/mcp → Authenticate` opens the browser and you sign in once
- **API-key alternative for automation fleets** — `POST /api/mcp` also accepts a Dokploy API key in the `x-api-key` header (`claude mcp add --transport http --scope user dokploy https://<host>/api/mcp --header "x-api-key: <key>"`), so unattended agent sessions never depend on one shared OAuth grant
- **Per-grant scopes** — a consent page with toggles for read, deploy, edit/delete services, edit/delete projects, backups and admin (delete and admin are off by default); role permissions still apply underneath. Revoke any client from Settings → Profile

### Build once, deploy by digest (fork original)

- **One builder for the whole organization** — with enforcement on, every GitHub-sourced application builds on the organization build server, pushes `<repository>:<sha>` to the organization registry, and updates the swarm service **by digest**, so CI can wait for that image instead of building a second copy of it
- **Escape hatches that leave a record** — per-application and per-compose exclusions, plus a one-shot "build locally once" grant written to an audit trail with actor, reason and timestamp
- **Required checks, coalescing and rollback by digest** — a deploy can wait for named commit checks, rapid pushes collapse into one waiting deploy that keeps its place in the queue and builds the newest commit, and a rollback re-deploys exactly the image that was running
- **Off by default** — with no policy configured for an organization, every code path is stock upstream behaviour

### Preview deployments for Compose, GitLab and Gitea

- **Docker Compose preview deployments** — the most-requested unbuilt feature in upstream Dokploy ([#2028](https://github.com/Dokploy/dokploy/issues/2028)): a PR or MR spins up an **isolated copy of your entire compose stack** (own volumes, networks, and per-service preview domains), redeploys on update, and fully tears down on close
- **GitLab merge-request and Gitea/Forgejo pull-request previews** via webhook, for both applications and compose stacks (upstream previews are GitHub-only)
- **API-triggered previews** and **deterministic per-PR domains** with a `${prNumber}` template variable

### Cloudflare Tunnels and Access

- Publish apps through **Cloudflare Tunnels** with no exposed ports, using Cloudflare credentials managed in Dokploy
- Gate services behind **Cloudflare Access** for zero-trust authentication

### Domains

- **Wildcard domains** (`*.example.com`) with an optional restriction setting, and a **per-server default domain** for auto-generated app domains
- **DoDomain custom-domain connect** — end users link their own domain through a hosted flow (Cloudflare OAuth, Domain Connect, or guided manual) and Dokploy verifies DNS and applies it, powered by [DoDomain](https://dodomain.io)
- Cross-service env references via <code>${&#123;service.&lt;name&gt;.fqdn}}</code>, and a global response-compression toggle

### Integrations and monitoring

- **[Uptimely](https://getuptimely.com)** — per-service uptime, SSL and domain monitors from the Monitoring tab, an optional deploy heartbeat, and a notification channel that declares an incident when a deploy fails and resolves it on the next success
- **[Snapvisor](https://snapvisor.io)** — visual-diff review status (pending, changes detected, approved, rejected) on preview deployments
- **[Sendly](https://sendly.now) and [Notifly](https://notifly.io)** notification channels, plus container crash-loop and scheduled-job failure alerts
- Container resource breakdown, swap usage and remote-server stats (with a server selector) in the monitoring tab

### Backups

- **Backup Center** with policies, coverage across services, backup file verification, browsing and restore, and an activity feed
- **Encryption at rest** via rclone crypt, and **SFTP, FTP and generic rclone** destinations beyond S3

### Security hardening (fork only)

- **Secrets stay secret** — notification provider secrets are write-only, URL-embedded credentials and token prefixes are redacted from logs and notifications, and S3 credentials are redacted in backup logs
- **Organization scoping and permission gates** — service, server, certificate, registry and destination access is checked against the active organization, and GitLab MR previews authorize the MR *author*, not the webhook actor
- **Shell-injection fixes** in backup, rclone and build commands

### Also

- **Opt-in rolling replace for Compose services** (off by default): the new replica must pass its healthcheck before the old container is stopped, so a redeploy of a selected service does not leave a window with no backend
- **Docker Compose auto-rollback**, native AWS ECR registries, pre/post-deploy command hooks, and `DOKPLOY_*` environment variables plus the git commit hash and message as build args
- **Project icons and export**, bulk invitations, and 30-day login sessions (configurable with `DOKPLOY_SESSION_DAYS`)

> Concurrent deployments and Docker network management started as fork features and now ship in official Dokploy, so this fork uses the official implementations.

## What's new in v0.30.8-community.30

- Opt-in rolling replace for Compose services: the new replica starts and must report healthy before the old container is stopped. Off by default; the health wait is raised automatically to fit the service's healthcheck ([#399](https://github.com/DevinoSolutions/dokploy-community/pull/399), [#400](https://github.com/DevinoSolutions/dokploy-community/pull/400)).
- Security: Traefik file read and write are confined to the Traefik configuration directory, a port of upstream Dokploy #5070 ([#397](https://github.com/DevinoSolutions/dokploy-community/pull/397)).
- Stack environments are staged in a 0600 file instead of the deploy command line ([#394](https://github.com/DevinoSolutions/dokploy-community/pull/394)).
- One database migration (0217). Full notes are in the **[changelog](https://github.com/DevinoSolutions/dokploy-community/blob/canary/CHANGELOG.md)**.

Older notes are in the **[changelog](https://github.com/DevinoSolutions/dokploy-community/blob/canary/CHANGELOG.md)** and on **[GitHub Releases](https://github.com/DevinoSolutions/dokploy-community/releases)**.

## Fresh install

On a clean Linux server with root access (same requirements as Dokploy):

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Install a specific version:

```bash
export DOKPLOY_VERSION=v0.30.8-community.30
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Update an existing installation:

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh -s update
```

## Docker Image

```
ghcr.io/devinosolutions/dokploy-community:v0.30.8-community.30      # versioned (recommended)
ghcr.io/devinosolutions/dokploy-community:latest                  # latest release
ghcr.io/devinosolutions/dokploy-community:canary                  # latest build
```

## Error reporting & privacy

The fork reports **unhandled backend errors** — crashes and internal server errors, i.e. the stack trace, error message, and fork version — to a Devino-hosted Sentry instance so we can catch regressions across installs without waiting on bug reports. No environment variables, secrets, deployment logs, request data, or personal information are ever sent, and the reporting server's hostname is stripped before the event leaves your machine.

Opting out is one environment variable on the `dokploy` service:

```bash
docker service update --env-add DOKPLOY_DISABLE_SENTRY=true dokploy
```

The standard [`DO_NOT_TRACK=1`](https://consoledonottrack.com) convention is also respected.

### Browser session replay (opt-in, off by default)

The dashboard never records your browser sessions unless the instance operator turns it on. With nothing set, no replay or product-analytics code is downloaded, and nothing is sent. It only runs in production builds, and `DOKPLOY_DISABLE_SENTRY=true` or `DO_NOT_TRACK=1` force it off even when enabled.

**Where the data goes.** When you enable it, by default session replays and browser errors are sent to the fork maintainers' Sentry (the built-in DSN), and, if you configure one, to the PostHog host you set. To keep the data on infrastructure you control, set `DOKPLOY_SESSION_REPLAY_SENTRY_DSN` to your own Sentry project's DSN; an invalid value disables the Sentry part instead of falling back to the built-in DSN. Do not enable it on an instance whose dashboard sessions you are not entitled to send to those servers.

Set these on the `dokploy` service (they are read at runtime, so the same image works everywhere):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOKPLOY_SESSION_REPLAY` | unset (off) | Master switch. Only the exact value `true` turns replay on. |
| `DOKPLOY_SESSION_REPLAY_SAMPLE_RATE` | `0.1` | Share of sessions recorded from the start, clamped to 0 to 1. |
| `DOKPLOY_SESSION_REPLAY_ON_ERROR_SAMPLE_RATE` | `1.0` | Share of sessions that hit an error whose replay is kept, clamped to 0 to 1. |
| `DOKPLOY_SESSION_REPLAY_SENTRY_DSN` | built-in DSN | Optional `https://<key>@<host>/<project-id>` DSN of your own Sentry project. |
| `DOKPLOY_POSTHOG_KEY`, `DOKPLOY_POSTHOG_HOST` | unset | Also record sessions and page views in a PostHog project (for example `https://posthog.example.com`). Used only when the switch is on and both are set. The browser loads PostHog's recorder script from `<host>/static`, so that host must serve it. |

```bash
docker service update --env-add DOKPLOY_SESSION_REPLAY=true dokploy
```

What is recorded: the page structure and interactions (clicks, scrolling, navigation), plus page views and browser errors. What is masked or left out: all text and all form inputs are replaced with placeholders, images, video and other media are blocked, console output is dropped, network request and response bodies and headers are not captured, and query strings and hashes are removed from every URL that is sent. Log viewers, terminals and code and environment editors are excluded from the recording entirely. Pages that carry credentials (password reset, invitations, registration, the MCP authorization screen, and any URL with a token, code or state parameter) are never recorded. Browser errors are scrubbed of secrets before they are sent. PostHog autocapture is off and users are never identified. The page URL recorded inside a Sentry replay can still include query strings (Sentry 10.72 has no hook for that event), which is why credential pages are never recorded.

Replays are stored by the servers you point it at. Roughly 10% session sampling keeps the volume low; lower `DOKPLOY_SESSION_REPLAY_SAMPLE_RATE` to reduce it further. Add the class `ph-no-capture` to an element to exclude it from the recording entirely.

## Versioning

Tags follow `v<upstream-version>-community.<n>`: the upstream Dokploy release the fork is based on, then a counter that restarts at 1 for each new upstream version. For example, `v0.30.8-community.30` is the 30th fork release on top of Dokploy v0.30.8.

## Contributing

This fork tracks upstream Dokploy's `canary` branch. To contribute:

1. Fork this repo
2. Create a feature branch from `canary`
3. Open a PR targeting `canary`

For features that should go upstream, please also open a PR on the [official Dokploy repo](https://github.com/Dokploy/dokploy).

## Contributors

This fork carries the work of **100+ contributors** — upstream Dokploy's authors plus the fork's own community. GitHub hides the contributors panel on fork homepages, but the full list is here:

[![Contributors](https://contrib.rocks/image?repo=DevinoSolutions/dokploy-community&max=48)](https://github.com/DevinoSolutions/dokploy-community/graphs/contributors)

*[See all contributors →](https://github.com/DevinoSolutions/dokploy-community/graphs/contributors)*

## Credits

- [Dokploy](https://dokploy.com) — the original project by [@siumauricio](https://github.com/siumauricio)
- Every ported change credits its original upstream author — their work, ported and re-verified against the fork's networking and branding layer
- Community-maintained fork, stewarded by [Devino Solutions](https://devino.ca)

## License

Same as upstream — [Apache 2.0](https://github.com/DevinoSolutions/dokploy-community/blob/canary/LICENSE.MD)
