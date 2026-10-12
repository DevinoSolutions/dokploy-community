# Dokploy Community Edition

> **This is a community fork of [Dokploy](https://github.com/Dokploy/dokploy).** We are **not** affiliated with or competing against the Dokploy project. This fork exists to make new features available faster.

Based on **Dokploy v0.30.8** | Fork version **v0.30.8-community.24**

Everything in upstream Dokploy **v0.30.8**, plus features that upstream does not have and fixes ported from open upstream PRs, each ported **1:1 with credit to its original author**. When a port merges upstream later, you lose nothing by switching back.

## Guides

- **[Integrations guide](https://dokploy-community.devino.ca/integrations/)** — set up Uptimely, Snapvisor, DoDomain, Sendly and Notifly
- **[FAQ](https://dokploy-community.devino.ca/faq/)** — install, migrate from Dokploy, MCP server for Claude Code, large deploy webhooks, DoDomain, uptime monitoring, telemetry

## Switching from official Dokploy

One command. Keeps every app, database, domain, and setting — the extra migrations are additive:

```bash
docker service update \
  --image ghcr.io/devinosolutions/dokploy-community:v0.30.8-community.24 \
  --with-registry-auth \
  dokploy
```

Going back to official is just as easy (our extra tables/columns are simply ignored):

```bash
docker service update --image dokploy/dokploy:v0.30.8 --with-registry-auth dokploy
```

The image is public — no registry login required.

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
- **Required checks, coalescing and rollback by digest** — a deploy can wait for named commit checks, rapid pushes collapse into a single deploy, and a rollback re-deploys exactly the image that was running
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
- Container resource breakdown and swap usage in the monitoring tab

### Backups

- **Backup Center** with policies, coverage across services, backup file verification, browsing and restore, and an activity feed
- **Encryption at rest** via rclone crypt, and **SFTP, FTP and generic rclone** destinations beyond S3

### Security hardening (fork only)

- **Secrets stay secret** — notification provider secrets are write-only, URL-embedded credentials and token prefixes are redacted from logs and notifications, and S3 credentials are redacted in backup logs
- **Organization scoping and permission gates** — service, server, certificate, registry and destination access is checked against the active organization, and GitLab MR previews authorize the MR *author*, not the webhook actor
- **Shell-injection fixes** in backup, rclone and build commands

### Also

- **Docker Compose auto-rollback**, native AWS ECR registries, pre/post-deploy command hooks, and `DOKPLOY_*` environment variables plus the git commit hash and message as build args
- **Project icons and export**, bulk invitations, and 30-day login sessions (configurable with `DOKPLOY_SESSION_DAYS`)

> Concurrent deployments and Docker network management started as fork features and now ship in official Dokploy, so this fork uses the official implementations.

## What's new in v0.30.8-community.24

- Preview deployments created before community.23 now find their build log on the owner's build server, the serving server or the Dokploy host ([#367](https://github.com/DevinoSolutions/dokploy-community/pull/367)).
- Cancelled schedule runs no longer show "Command failed" or get stuck as `running` ([#368](https://github.com/DevinoSolutions/dokploy-community/pull/368)).
- Three more upstream fixes ported ([#369](https://github.com/DevinoSolutions/dokploy-community/pull/369), [#370](https://github.com/DevinoSolutions/dokploy-community/pull/370), [#371](https://github.com/DevinoSolutions/dokploy-community/pull/371)). No database migrations.

Older notes are in the **[changelog](https://github.com/DevinoSolutions/dokploy-community/blob/canary/CHANGELOG.md)** and on **[GitHub Releases](https://github.com/DevinoSolutions/dokploy-community/releases)**.

## Fresh install

On a clean Linux server with root access (same requirements as Dokploy):

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Install a specific version:

```bash
export DOKPLOY_VERSION=v0.30.8-community.24
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Update an existing installation:

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh -s update
```

## Docker Image

```
ghcr.io/devinosolutions/dokploy-community:v0.30.8-community.24      # versioned (recommended)
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

## Versioning

Tags follow `v<upstream-version>-community.<n>`: the upstream Dokploy release the fork is based on, then a counter that restarts at 1 for each new upstream version. For example, `v0.30.8-community.24` is the 24th fork release on top of Dokploy v0.30.8.

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
