# Dokploy Community Edition

> **This is a community fork of [Dokploy](https://github.com/Dokploy/dokploy).** We are **not** affiliated with or competing against the Dokploy project. This fork exists to make new features available faster.

Based on **Dokploy v0.29.12** | Fork version **v0.29.12-community.5**

Everything in upstream Dokploy **v0.29.12**, plus **100+ community features and fixes** that haven't landed upstream yet — each one ported **1:1 with credit to its original author** — plus **fork-only security hardening**. When a fix exists as an open upstream PR or issue, we port it now instead of waiting for it to merge; when it merges upstream later, you lose nothing by switching back.

## Switching from official Dokploy

One command. Keeps every app, database, domain, and setting — the extra migrations are additive:

```bash
docker service update \
  --image ghcr.io/devinosolutions/dokploy-community:v0.29.12-community.5 \
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
export DOKPLOY_VERSION=v0.29.12-community.5
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Update an existing installation:

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh -s update
```

## Docker Image

```
ghcr.io/devinosolutions/dokploy-community:v0.29.12-community.5   # versioned (recommended)
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
