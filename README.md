# Dokploy Community Edition

> **This is a community fork of [Dokploy](https://github.com/Dokploy/dokploy).** We are **not** affiliated with or competing against the Dokploy project. This fork exists to make new features available faster.

Based on **Dokploy v0.29.12** | Fork version **v0.29.12-community.15**

Everything in upstream Dokploy **v0.29.12**, plus **100+ community features and fixes** that haven't landed upstream yet — each one ported **1:1 with credit to its original author** — plus **fork-only security hardening**. When a fix exists as an open upstream PR or issue, we port it now instead of waiting for it to merge; when it merges upstream later, you lose nothing by switching back.

## Switching from official Dokploy

One command. Keeps every app, database, domain, and setting — the extra migrations are additive:

```bash
docker service update \
  --image ghcr.io/devinosolutions/dokploy-community:v0.29.12-community.15 \
  --with-registry-auth \
  dokploy
```

Going back to official is just as easy (our extra tables/columns are simply ignored):

```bash
docker service update --image dokploy/dokploy:v0.29.12 --with-registry-auth dokploy
```

The image is public — no registry login required.

## What's different

### Docker Network Management (fork original)

- New **Networks** page in the sidebar
- Create, delete, and manage Docker overlay networks
- Attach networks to any application or database service
- Per-resource network picker in the Advanced tab

https://github.com/user-attachments/assets/94134095-5601-4279-be2f-219734c8e199

### Cloudflare integration

- Manage **Cloudflare credentials** directly in Dokploy
- Publish apps through **Cloudflare Tunnels** — no exposed ports required
- Gate services behind **Cloudflare Access** for zero-trust authentication

### Domains & networking

- **Wildcard domain support** (`*.example.com`), with an optional wildcard-restriction setting to control who can use it
- **Per-server default domain** for auto-generated app domains — each server can hand out its own base domain
- Global **response-compression** toggle (Traefik compress middleware)
- Cross-service env references via `${{service.<name>.fqdn}}`
- Configurable **MTU** for isolated networks, explicit `HostIp` on Traefik port bindings, and public-IP handling for `traefik.me` domains behind private IPs
- Custom certificate provider display and more reliable Traefik file-provider discovery

### Preview deployments, supercharged

- **Docker Compose preview deployments** — the most-requested unbuilt feature in upstream Dokploy ([#2028](https://github.com/Dokploy/dokploy/issues/2028)): a PR or MR spins up an **isolated copy of your entire compose stack** (own volumes, networks, and per-service preview domains), redeploys on update, and fully tears down on close
- **GitLab merge-request previews** via webhook (in addition to GitHub) — for both applications and compose stacks
- **API-triggered previews** — spin up a preview deployment programmatically
- **Deterministic per-PR domains** using a `${prNumber}` template variable
- **Custom preview templates** so previews match your production topology
- **Duplicate-prevention** for concurrent webhook events and labeled PRs (with a one-time cleanup of existing duplicates)
- **Re-clone on rebuild** so new pushes to a PR actually propagate
- Build previews on a dedicated `buildServerId`, and don't block updates to existing previews when at the limit

### Backups & destinations

- **S3 encryption at rest** via rclone crypt — encrypt backups with obscured passwords before they ever leave the box
- **SFTP, FTP, and generic rclone** backup destinations, plus user-defined **S3 prefixes**
- Safer restores: 3-section sequential `pg_restore` to avoid OID race conditions, MongoDB **all-databases** backup, restore-button gating when the target service is down, and unlimited volume-backup retention
- Fixes for double-dumps, MongoDB gzip filename mismatches, replica-set preservation, and post-failure container restart

### Registries & deployments

- **AWS ECR** registry support and pulling images with **stored registry credentials**
- **Pre-deploy and post-deploy command hooks** for applications
- Deploy a **specific Docker image/tag** on demand, and **pull latest images** on Compose deploy
- Injected **`DOKPLOY_*` environment variables** and **git commit hash/message as build args** at deploy time
- "Deploy with Fresh Volumes" for Compose, dynamic railpack version fetching, and smarter build-cache invalidation on env changes

### Monitoring

- **Container resource breakdown** and **swap usage** in monitoring
- **Remote-server stats** via a server selector
- **Container healthcheck status** surfaced in the UI
- **Attach to a running container** to send input interactively

### Security hardening (fork only)

Beyond the ported features, this fork carries **7 direct security commits** and **13 ported hardening fixes**, including:

- **Command-injection** fixes for `customGitUrl`, mount-permission inputs, and shell-less rclone `obscure`
- **Secret redaction** — private keys kept out of build-failure notifications and logged command errors; webhook URLs masked by default
- **Permission gates** — service-permission checks on template loading, org-scoped assigned-server access, custom-role listing behind `member:read`, and validated admin invites
- **Webhook author authorization** — GitLab MR previews authorize the MR *author*, not the webhook actor, closing a preview-deployment bypass

### Also included

- **Notifications** — container crash-loop alerts, scheduled-job failure alerts, and real server names in threshold alerts
- **Git providers & auth** — GitHub/Google social login on self-hosted, self-hosted password reset, Codeberg preset, Gitea `write:repository` scope, and several OAuth/redirect fixes
- **Organizations & teams** — editable descriptions, bulk invitations, drag-and-drop logo upload, and **project export** to a portable JSON file
- **Per-project icons** — paste a URL or drag-and-drop an image onto any project; projects without one automatically show the **favicon of their first working domain**
- **Reliability** — clean exit on fatal startup errors instead of crash-looping, Podman idle-exec support, custom `template.toml` in git repos, and Docker/Ubuntu install-failure fixes
- **Longer login sessions** — sessions last 30 days (sliding) instead of upstream's 3, configurable via `DOKPLOY_SESSION_DAYS`
- **15+ UI/UX fixes** — deployments filtering and tab behavior, env-form edit stability, log-counter layout shift, responsive log pages, dark-theme icons, and new translations

Every item above is ported 1:1 and credited to its original upstream author. See the **[full release notes](https://github.com/DevinoSolutions/dokploy-community/releases/tag/v0.29.12-community.2)** for the complete, per-PR credited list, migration details, and known caveats.

> Concurrent deployments — previously a fork-only feature — shipped natively in upstream Dokploy v0.29.11, so this fork now uses the official implementation.

### New in v0.29.12-community.15

**Session management, log-stream hygiene & metrics dedupe fix.** Three 1:1 ports of open upstream PRs — no migrations.

- **Session management page** — Settings → Sessions lists your active and expired sessions (device, IP, created/expires) with one-click revoke to force logout on another device; strictly self-scoped and session tokens never leave the server ([#164](https://github.com/DevinoSolutions/dokploy-community/pull/164), upstream [#4841](https://github.com/Dokploy/dokploy/pull/4841)).
- **Container log streams terminate on disconnect** — closing a logs view now reliably kills the underlying `docker logs --follow` process (SIGTERM with SIGKILL escalation, local and SSH), and log commands are spawned argument-by-argument with in-process search filtering instead of concatenated shell strings ([#163](https://github.com/DevinoSolutions/dokploy-community/pull/163), upstream [#4836](https://github.com/Dokploy/dokploy/pull/4836)).
- **Monitoring metrics dedupe fix** — container metrics are deduplicated by swarm task suffix instead of name prefix, so distinct services sharing a name prefix (e.g. `app-x-mysql` and `app-x-redis`) no longer lose metrics to each other ([#162](https://github.com/DevinoSolutions/dokploy-community/pull/162), upstream [#4843](https://github.com/Dokploy/dokploy/pull/4843)).

### New in v0.29.12-community.14

**Backup scale-safety, image restorability & navigation.** Three changes — no migrations.

- **Scheduled backup concurrency limit** — scheduled database, compose, and volume backups now run through a per-server FIFO queue (`DOKPLOY_BACKUP_CONCURRENCY`, default 4), so a policy firing many backups on one cron drains gradually instead of spawning them all at once; manual runs stay immediate ([#160](https://github.com/DevinoSolutions/dokploy-community/pull/160)).
- **Image-restorability view on the Registry page** — Settings → Registry now shows, for every application and compose service, whether its image is **Re-pullable** from a registry, **In registry** (source-built but pushed), or **⚠ Rebuild-only** (exists only on the local daemon), with per-registry push counts ([#161](https://github.com/DevinoSolutions/dokploy-community/pull/161)).
- **Coverage deep-links + tab order** — coverage rows link straight to each service's backups tab, and Coverage is now the Backup Center's first tab ([#159](https://github.com/DevinoSolutions/dokploy-community/pull/159)).

### New in v0.29.12-community.13

**Backup Center polish.** Two refinements — no migrations.

- **Instance tab manages web-server backups in place** — the Instance tab now embeds the full Web Server Backups card (schedules, run/edit/delete, Restore Backup) instead of a read-only summary linking out ([#158](https://github.com/DevinoSolutions/dokploy-community/pull/158)).
- **Destinations show the storage prefix** — coverage rows list each destination as "name · /prefix" so you can see where each backup lands at a glance ([#158](https://github.com/DevinoSolutions/dokploy-community/pull/158)).

### New in v0.29.12-community.12

**Backup Center tabs, search & activity feed.** Community-requested UX pass — no migrations.

- **Tabbed layout** — the Backup Center is now organized like the Swarm page: **Policies / Instance / Coverage / Activity** tabs with `?tab=` deep links, plus a "Viewing server" selector scoping Coverage and Activity ([#157](https://github.com/DevinoSolutions/dokploy-community/pull/157)).
- **Coverage search** — filter the coverage tree by project, environment, or service name, composing with the global facets ([#157](https://github.com/DevinoSolutions/dokploy-community/pull/157)).
- **Activity feed** — recent backup and volume-backup runs org-wide with status, destination, policy-vs-manual source, timestamps, and the uploaded artifact path parsed from the run log (confirming the file landed in the bucket), with the full run log one click away; derived from existing run records, so it works retroactively ([#157](https://github.com/DevinoSolutions/dokploy-community/pull/157)).

### New in v0.29.12-community.11

**Backup verification, browsing & restore in the Backup Center.** Coverage no longer just assumes — it can prove backups exist. No migrations.

- **Browse the real bucket contents** — every covered database/compose service gets a Browse-backups button; the dialog lazily lists the actual files under each backup's prefix (name, size, timestamp) with an "N in bucket" badge, and warns when a backup is configured but the bucket is empty ([#156](https://github.com/DevinoSolutions/dokploy-community/pull/156)).
- **Restore from the Backup Center** — each listed file has a Restore action behind a double confirmation (destructive-action confirm, then type the database name), streaming live logs via the existing restore pipeline; hidden without the restore permission and enforced server-side ([#156](https://github.com/DevinoSolutions/dokploy-community/pull/156)).

### New in v0.29.12-community.10

**Global coverage filters.** The Backup Center coverage filter is now three global facets instead of a per-project list — no migrations.

- **Environments** — multi-select over distinct environment names org-wide ("only production, everywhere" in one click); **Service types** — Databases group (with individual DB kinds), Applications, Compose; **"Not covered only"** toggle to jump straight to gaps. Facets AND together; the production-focused default view applies until any explicit facet replaces it ([#155](https://github.com/DevinoSolutions/dokploy-community/pull/155)).

### New in v0.29.12-community.9

**Backup Center coverage tree.** UX overhaul of the Backup Center's coverage view — no migrations in this release.

- **Coverage tree with rollup badges** — the flat coverage table is now an expandable **Project → Environment → Service** tree; collapsed nodes show an orange "⚠ N not covered" count (green check when fully covered), and project rows reuse the project icons/favicons ([#154](https://github.com/DevinoSolutions/dokploy-community/pull/154)).
- **Environment filter with production-focused defaults** — a /deployments-style filter shows production environments in full while non-production environments only surface databases and volume-bearing services by default; every environment can be toggled fully on or off, with "(N hidden)" hints ([#154](https://github.com/DevinoSolutions/dokploy-community/pull/154)).
- **Compose stacks expand into their containers** — a Compose service now lazily expands to the containers parsed from its compose file, with database-image detection (Postgres/MySQL/MariaDB/Mongo/Redis-family) and per-volume coverage badges, so "a compose with a database inside" is obvious at a glance ([#154](https://github.com/DevinoSolutions/dokploy-community/pull/154)).

### New in v0.29.12-community.8

**Move services between servers, and organization-wide backup policies.** Two headline features plus one additive migration (0191).

- **Move a service to another server** — move an Application, Compose, or database service to a different server in multi-server mode. The move runs a two-phase **scan → execute** flow with a downtime-safe, **copy-based cutover**: the source is stopped, its data is copied to the destination, and the service's `serverId` switches **only after a fully successful copy** — on any failure the source is restarted and left untouched. No migration ([#148](https://github.com/DevinoSolutions/dokploy-community/pull/148), upstream [#3713](https://github.com/Dokploy/dokploy/pull/3713)).
- **Backup policies + Backup Center** — manage backups organization-wide instead of service by service. Define **policies** scoped to the whole org, specific projects, or specific environments (with a one-click "production environments" preset), covering **database dumps and/or volume backups**, each targeting **one destination** with its own cron schedule and retention. Services added later that match a policy's scope are **auto-covered**. A new **Backup Center** page lists every policy, shows an org-wide **coverage table** (what's backed up vs. not) and the instance backup, and **coexists** with any manual backups you already set up. Redis/applications/Compose are covered via volume backups. Adds additive **migration 0191** ([#153](https://github.com/DevinoSolutions/dokploy-community/pull/153)).

### New in v0.29.12-community.7

**Four upstream fixes — safe auth-secret migration, domain clearing, and two editor/UI papercuts.** No migrations in this release.

- **Auth-secret migration no longer loses encrypted data** — installs moving off the deprecated hardcoded `BETTER_AUTH_SECRET` used to lose access to everything previously encrypted with the old key. The legacy-derived key is now kept as a **decrypt-only fallback**, so existing secrets stay readable while every new write uses your real secret ([#151](https://github.com/DevinoSolutions/dokploy-community/pull/151), upstream [#4834](https://github.com/Dokploy/dokploy/pull/4834)).
- **Server domain can be cleared** — clearing the panel's server domain now reverts to IP-only access instead of being rejected. The backend already removed the Traefik router on an empty host; the client-side schema was the only thing blocking it ([#152](https://github.com/DevinoSolutions/dokploy-community/pull/152), upstream [#4825](https://github.com/Dokploy/dokploy/pull/4825)).
- **Clickable icons in badges work again** — interactive icons nested inside badges are once more clickable, rather than swallowing pointer events ([#149](https://github.com/DevinoSolutions/dokploy-community/pull/149), upstream [#4827](https://github.com/Dokploy/dokploy/pull/4827)).
- **YAML auto-indentation on Enter** — the code editor now indents correctly when you press Enter inside YAML ([#150](https://github.com/DevinoSolutions/dokploy-community/pull/150), upstream [#4828](https://github.com/Dokploy/dokploy/pull/4828)).

### New in v0.29.12-community.6

**Project favicons, for real — and hardened.** Project icons now resolve the actual favicon of a project's first working domain, and the resolver is locked down against SSRF and stored XSS.

- **Real favicon resolution** — projects without an explicit icon show their first working domain's favicon, including apps that declare it via a custom `<link rel="icon">` path instead of the default `/favicon.ico`; icons now also render in the project switcher, not just cards and headers ([#145](https://github.com/DevinoSolutions/dokploy-community/pull/145)).
- **SSRF hardening** — every URL the resolver fetches, and every redirect hop, is re-validated as same-origin against the originally-requested org-managed host, pinning scheme + host **+ port** so the fetch can't be pivoted to an internal service or another port on the same IP ([#146](https://github.com/DevinoSolutions/dokploy-community/pull/146), [#147](https://github.com/DevinoSolutions/dokploy-community/pull/147)).
- **Stored-XSS hardening** — `image/svg+xml` favicons are rejected (an SVG served with its real content-type can execute inline script), and the icon response carries a locked-down `default-src 'none'; sandbox` CSP plus `nosniff` ([#147](https://github.com/DevinoSolutions/dokploy-community/pull/147)).
- **Private caching** — the auth-gated icon response is now `private`, so a shared cache can't serve one user's favicon to another.

### New in v0.29.12-community.5

**Project icons & longer sessions.** Projects can now carry an icon — upload an image or paste a URL, and projects without one automatically fall back to the favicon of their first working domain. Login sessions last **30 days** (sliding) instead of 3, tunable via `DOKPLOY_SESSION_DAYS`. Also fixes a scheduled-task bug (caught by the new error reporting on day one) where schedules targeting a stopped container ran `docker exec` with an empty ID on every tick instead of failing with a clear message.

### New in v0.29.12-community.4

**Backend error reporting (opt-out).** The fork now reports unhandled backend errors — crashes and internal server errors, i.e. the stack trace, message, and fork version — to a Devino-hosted Sentry instance, so we catch regressions across installs without waiting on bug reports. No environment variables, secrets, deployment logs, request data, or personal information are ever sent, and the reporting server's hostname is stripped before the event leaves your machine. Opt out with `DOKPLOY_DISABLE_SENTRY=true` (or `DO_NOT_TRACK=1`) — see [Error reporting & privacy](#error-reporting--privacy).

### New in v0.29.12-community.3

**Preview Deployments for Docker Compose** — upstream Dokploy's most-requested unbuilt feature, now live for GitHub PRs and GitLab MRs. Isolated per-PR stack copies with per-service domains, automatic redeploy on update, and full teardown (volumes included) on close. One additive migration (0189) applies automatically on startup.

The previous release, [v0.29.12-community.2](https://github.com/DevinoSolutions/dokploy-community/releases/tag/v0.29.12-community.2), rolled up the full port train: 100+ upstream fixes and features ported 1:1 (native **Cloudflare integration**, **AWS ECR**, **S3 backup encryption at rest**, **per-server default domains**, **remote-server monitoring stats**, and more), plus the fork-side security hardening above.

## Fresh install

On a clean Linux server with root access (same requirements as Dokploy):

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Install a specific version:

```bash
export DOKPLOY_VERSION=v0.29.12-community.15
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Update an existing installation:

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh -s update
```

## Docker Image

```
ghcr.io/devinosolutions/dokploy-community:v0.29.12-community.15   # versioned (recommended)
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

We follow the scheme `v<upstream-version>-community.<release>`:

| Upstream | Fork release | Tag |
|---|---|---|
| v0.29.11 | 1st release | `v0.29.11-community.1` |
| v0.29.12 | 1st release | `v0.29.12-community.1` |
| v0.29.12 | 2nd release | `v0.29.12-community.2` |
| v0.29.12 | 3rd release | `v0.29.12-community.3` |
| v0.29.12 | 4th release | `v0.29.12-community.4` |
| v0.29.12 | 5th release | `v0.29.12-community.5` |
| v0.29.12 | 6th release | `v0.29.12-community.6` |
| v0.29.12 | 7th release | `v0.29.12-community.7` |
| v0.29.12 | 8th release | `v0.29.12-community.8` |
| v0.29.12 | 9th release | `v0.29.12-community.9` |
| v0.29.12 | 10th release | `v0.29.12-community.10` |
| v0.29.12 | 11th release | `v0.29.12-community.11` |
| v0.29.12 | 12th release | `v0.29.12-community.12` |
| v0.29.12 | 13th release | `v0.29.12-community.13` |
| v0.29.12 | 14th release | `v0.29.12-community.14` |
| v0.29.12 | 15th release | `v0.29.12-community.15` |

## Contributing

This fork tracks upstream Dokploy's `canary` branch. To contribute:

1. Fork this repo
2. Create a feature branch from `canary`
3. Open a PR targeting `canary`

For features that should go upstream, please also open a PR on the [official Dokploy repo](https://github.com/Dokploy/dokploy).

## Credits

- [Dokploy](https://dokploy.com) — the original project by [@siumauricio](https://github.com/siumauricio)
- Every ported change credits its original upstream author — their work, ported and re-verified against the fork's networking and branding layer
- Community-maintained fork, stewarded by [Devino Solutions](https://devino.ca)

## License

Same as upstream — [Apache 2.0](LICENSE)
