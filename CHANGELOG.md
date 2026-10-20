# Changelog

Release notes for Dokploy Community Edition, newest first. The same notes, with the full credited change lists, are on [GitHub Releases](https://github.com/DevinoSolutions/dokploy-community/releases).

### Unreleased

**Schedule run script follow-ups** (T-4688, after [#431](https://github.com/DevinoSolutions/dokploy-community/pull/431)). Application and compose schedules now run their command from an unlinked file descriptor, so `$0` and `BASH_SOURCE` are `/dev/fd/3` and shell errors read `/dev/fd/3: line N` instead of naming a script path. The first line of that file closes fd 3, so line numbers in errors are one higher than the line in the schedule's command. When the container cannot stage the file (for example a read-only root filesystem without a tmpfs), the run log now says so on one line; the command then runs as a `-c` argument and is visible in the container's process list.

### New in v0.30.8-community.30

**Opt-in rolling replace for Compose services** ([#399](https://github.com/DevinoSolutions/dokploy-community/pull/399), issue [#374](https://github.com/DevinoSolutions/dokploy-community/issues/374) item 4). Off by default. A plain `docker compose up -d` stops the old container before the new one exists, which leaves a window with no backend. With rolling replace enabled for a service, the new image is built or pulled first, a second replica is started next to the old container, and the old container is stopped and removed only after the new replica reports healthy and a drain delay has passed. A replica that never becomes healthy is removed and the old container keeps serving.
- Enable it per service on the Compose Advanced tab, in the Rolling replace card. The card lists each service with its eligibility and the reasons it is refused.
- Health timeout 10-900 s (default 120) and drain delay 0-120 s (default 5). The health wait is raised automatically to cover the service's healthcheck (`start_period + retries x (interval + timeout)`, capped at 900 s), so a healthcheck that only sets `test` is no longer refused; only one that cannot settle within 900 s is ([#400](https://github.com/DevinoSolutions/dokploy-community/pull/400)).
- Refused on save and again at every deploy for services with `container_name`, a published host port, host or shared network modes, `scale` or `deploy.replicas` other than 1, static addresses, no usable healthcheck, or datastore images such as databases and queues. Only `docker-compose` type composes qualify; stacks, custom commands, fresh-volume deploys and previews never roll.
- Adds the nullable `compose.rollingReplace` column (migration 0217). With it unset or disabled, deploy scripts are byte-identical to the previous release.
- Design and decisions: `docs/design/compose-zero-downtime.md` ([#396](https://github.com/DevinoSolutions/dokploy-community/pull/396), [#398](https://github.com/DevinoSolutions/dokploy-community/pull/398)). Usage: `docs/compose-rolling-replace.md`.

**Security: Traefik file access is confined to the Traefik directory** ([#397](https://github.com/DevinoSolutions/dokploy-community/pull/397), port of upstream Dokploy [#5070](https://github.com/Dokploy/dokploy/pull/5070), with credit to its authors). A member with the `traefikFiles` write permission could previously read or overwrite any file on the host by passing an absolute path or `../` segments to the Traefik file endpoints. Paths are now resolved against the Traefik configuration directory and anything outside it is rejected with a bad request. Remote servers are resolved with POSIX semantics.

**Stack environments no longer go through the shell command line** ([#394](https://github.com/DevinoSolutions/dokploy-community/pull/394)). Compose stacks (`docker stack deploy`) embedded their environment in the deploy script, up to three times, so a large environment could fail with "Argument list too long" and the values were visible in `ps`. The environment is now staged once in a 0600 file next to the compose file and sourced by the docker command, then removed after the deploy, including on failure and cancel.

Tests:
- Guardrail shell-timing tests no longer flake ([#395](https://github.com/DevinoSolutions/dokploy-community/pull/395)).

> One database migration in this release (0217, guarded). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.29

**Embedded deploy content no longer goes through the shell command line** ([#392](https://github.com/DevinoSolutions/dokploy-community/pull/392)). File mounts, patches, raw Compose sources and the Compose `.env` were embedded in the deploy shell command, so a large one could fail with "Argument list too long" on build-server and serving-host deploys. They are now written to a staging file over SFTP or the local filesystem and copied into place, as Compose files already were in community.28.

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.28

**Large Compose files deploy again** ([#390](https://github.com/DevinoSolutions/dokploy-community/pull/390)). Since the YAML merge-key fix, an expanded Compose file over about 96 KB (more than 128 KB once base64-encoded, the Linux per-argument limit) failed on build-server and serving-host deploys with "Argument list too long". The file is now written to a staging file over SFTP or the local filesystem and copied into place.

**Opt-in browser session replay** ([#389](https://github.com/DevinoSolutions/dokploy-community/pull/389)). Off by default. It is enabled only with `DOKPLOY_SESSION_REPLAY=true` at runtime, with optional `DOKPLOY_POSTHOG_KEY` and `DOKPLOY_POSTHOG_HOST`, sample-rate variables and a `DOKPLOY_SESSION_REPLAY_SENTRY_DSN` override. All text and inputs are masked, media is blocked, URLs are stripped of query strings, credential pages are never recorded, and the log, terminal and editor views are blocked. Details are in the README section **Browser session replay**.

Fixes and ports:
- A remote server with no SSH key now reports a precondition error instead of a 500 ([#386](https://github.com/DevinoSolutions/dokploy-community/pull/386)).
- The Railpack versions list serves the last cached list when GitHub fails, instead of a 500 ([#385](https://github.com/DevinoSolutions/dokploy-community/pull/385)).
- Members can list servers in the server pickers; without `server.read` they see only name and IP ([#388](https://github.com/DevinoSolutions/dokploy-community/pull/388), port of upstream #5613).
- Template tags are capped so the Create button stays visible ([#387](https://github.com/DevinoSolutions/dokploy-community/pull/387), port of upstream #5661).

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.27

**Stall snapshots for slow Compose deploys** ([#383](https://github.com/DevinoSolutions/dokploy-community/pull/383), issue [#374](https://github.com/DevinoSolutions/dokploy-community/issues/374)). A fourth opt-in deploy guardrail. While `docker compose up` is still running after a set delay, the deploy log gets a snapshot of the project's container states (name, state, status, created) at a fixed interval, up to a set number of snapshots. For swarm stacks the snapshot uses `docker stack ps`.
- Settings: start after 15-1800 s (default 60), repeat every 10-600 s (default 30), 1-20 snapshots (default 5).
- It only observes: it never stops, kills or times out the deploy.
- Each snapshot is capped at 200 lines, and a state command that does not return within 20 s is stopped.
- For stacks, `docker stack deploy` usually returns before tasks converge, so snapshots rarely fire there.

It is off by default. Enable it in the compose service under **Advanced** > **Deploy guardrails** (**Stall snapshots**), or through `compose.update` (`deployGuardrails.stallSnapshot`).

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.26

**Log of removed-server previews** ([#380](https://github.com/DevinoSolutions/dokploy-community/pull/380)). Preview deployments created before community.23 whose log is no longer on any connected server (for example because their build server was removed) now show "This deployment's log is no longer available on any connected server" instead of an empty or wrong log. Log-host probes that time out now close their SSH connection.

**Cancelling schedule runs on servers** ([#381](https://github.com/DevinoSolutions/dokploy-community/pull/381)). Cancelling a schedule run on a server (or the Dokploy host) whose script never reported a process ID no longer answers "still starting" forever.
- Runs are tagged and cancelled by tag.
- A cancel during startup stops the command before it runs.
- Runs stranded by a Dokploy restart can be cancelled.
- Container runs are unchanged.

**Clearer errors**
- A compose domain pointing at a service that no longer exists returns a clear error (bad request) instead of a server error in the compose preview. Deploys still fail with the same message ([#377](https://github.com/DevinoSolutions/dokploy-community/pull/377)).
- Restart, start, stop, kill and remove of a container that no longer exists return "not found" instead of a server error ([#378](https://github.com/DevinoSolutions/dokploy-community/pull/378)).
- "This node is not a swarm manager" at startup is logged as a warning, with the `docker swarm init` hint, instead of being reported as an error ([#379](https://github.com/DevinoSolutions/dokploy-community/pull/379)).

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.25

**Opt-in Compose deploy guardrails** ([#375](https://github.com/DevinoSolutions/dokploy-community/pull/375), issue [#374](https://github.com/DevinoSolutions/dokploy-community/issues/374)). A compose deploy was marked done as soon as `docker compose up` returned, with no readiness check and little in the log to show where the time went (in #374, web was down for about 135 s while the old container was being removed). Three guardrails, configured per compose, are now available. All are off by default, so existing composes deploy exactly as before.
- **Phase timestamps.** Each deploy phase is logged with a UTC timestamp and the seconds elapsed since the previous one.
- **Docker events capture.** While `docker compose up` runs, container lifecycle events (create, start, die, health status) for the project are written to the deploy log. The capture is size-capped and cleaned up by a watchdog if the deploy shell goes away.
- **Health check.** An optional HTTP(S) URL is polled before the deploy is marked done. If it does not return a success status before the timeout, the deploy is marked `error` and the failure notification fires.

To enable them, open the compose service, go to **Advanced** and use the **Deploy guardrails** card. The same settings are available through `compose.update` (`deployGuardrails`).

Limits to know about:
- The events capture covers only `compose up`, not the image pull.
- The health check does not run for swarm stacks, and cannot be saved for one.
- There is no automatic rollback: when the health check fails, the new release is left running so you can inspect it.
- The timeout is wall-clock time for the whole health check, not per request.
- Preview deployments are never guarded, duplicating a compose does not copy its guardrails, and project exports leave out the health check URL unless secrets are included.

> One database migration in this release (`0216_compose_deploy_guardrails`, a nullable `jsonb` column). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.24

**Logs of older previews** ([#367](https://github.com/DevinoSolutions/dokploy-community/pull/367)). Preview deployments created before community.23 did not record the build server that holds their log. The log drawer and the `deployment.readLogs` API now look for such a log on the preview owner's build server, its serving server and the Dokploy host, and read it from the first one that has it. Each check gives up after 5 seconds, so a server that is down cannot stall the drawer. Every remote log read now also checks that the server belongs to your organization. Logs on a build server that has since been removed still can't be found.

**Cleaner cancelled schedule runs** ([#368](https://github.com/DevinoSolutions/dokploy-community/pull/368)).
- Cancelled runs on remote servers and server schedules no longer show "Command failed" above the cancel line.
- A cancel that lands just as the run ends no longer leaves the run stuck as `running`.
- Application and compose runs can be cancelled before their process id is recorded. A cancel that lands before the command starts stops it from starting, instead of reporting success while the command runs.
- Server schedules that have not reported a process id yet answer "The run is still starting, try again in a moment".
- A database error while a failed run is ending no longer loses its failure notification.

**Ported upstream fixes.** Each is ported 1:1 with credit to its original author:
- [#369](https://github.com/DevinoSolutions/dokploy-community/pull/369): [Dokploy/dokploy#5656](https://github.com/Dokploy/dokploy/pull/5656) by @Totopo27 (long service card descriptions wrap and are clamped on the environment page)
- [#370](https://github.com/DevinoSolutions/dokploy-community/pull/370): [Dokploy/dokploy#5657](https://github.com/Dokploy/dokploy/pull/5657) by @Totopo27 (the Projects card on the home dashboard links to the projects page)
- [#371](https://github.com/DevinoSolutions/dokploy-community/pull/371): [Dokploy/dokploy#5614](https://github.com/Dokploy/dokploy/pull/5614) by @tomron (optional zone on the OVH DNS provider, enforced on record operations)

> No database migrations in this release (the count stays at 219). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.23

**Cancelled schedule runs end as cancelled** ([#364](https://github.com/DevinoSolutions/dokploy-community/pull/364)). Using **Kill Process** on a scheduled run (application, compose, server or Dokploy server schedules) now ends it with the status `cancelled` and a "Run cancelled by user" line in its log, and no longer sends a schedule failure notification. A run that really fails still notifies as before, and cancelling a server schedule whose process already exited no longer returns an error.

**Logs of previews built on a build server** ([#365](https://github.com/DevinoSolutions/dokploy-community/pull/365)). Preview deployments built on a build server now record that server, so the log drawer and the `deployment.readLogs` API read their log from it. Cleanup of old deployments, and deleting a deployment, now remove each log on the host that holds it (the build server, the serving server or the Dokploy host), so build-server logs no longer pile up, and an unreachable host no longer makes a new deployment fail.

> No database migrations in this release (the count stays at 219). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.22

**Scheduled commands in apps and composes can be cancelled** ([#362](https://github.com/DevinoSolutions/dokploy-community/pull/362)). Application and compose schedules now record the process id of their run inside the container, so **Kill Process** works for them on remote servers and on the Dokploy host. Cancelling stops only the processes of that run, including any child processes, and never touches other processes in the container.

**Deployment logs from build servers** ([#361](https://github.com/DevinoSolutions/dokploy-community/pull/361)). The `deployment.readLogs` API reads the log of an application built on a build server from that build server, as the log drawer already did, instead of returning an empty log.

> No database migrations in this release (the count stays at 219). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.21

**Deployment cancel targets the right host** ([#359](https://github.com/DevinoSolutions/dokploy-community/pull/359)). Cancelling a deployment that runs a recorded process now stops it on the server that runs it, resolved the same way as the deployment log, instead of on the Dokploy host. Only running deployments with a valid process id can be stopped, and Dokploy Cloud never runs the kill on its own host.

**Ported upstream fixes.** Each is ported 1:1 with credit to its original author:
- [#357](https://github.com/DevinoSolutions/dokploy-community/pull/357): [Dokploy/dokploy#5655](https://github.com/Dokploy/dokploy/pull/5655) by @ahmedisam99 (concurrent GitLab token refreshes share one request)
- [#358](https://github.com/DevinoSolutions/dokploy-community/pull/358): [Dokploy/dokploy#5654](https://github.com/Dokploy/dokploy/pull/5654) by @olivier-drieux (restore dialog keeps the service name when the database type changes)

> No database migrations in this release (the count stays at 219). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.20

**Security hardening.** Backup, volume-backup and restore commands now shell-quote user-supplied prefixes, service names, S3 paths and restore file names, and restore paths are checked for traversal ([#336](https://github.com/DevinoSolutions/dokploy-community/pull/336)). Schedules no longer accept a client-supplied app name ([#349](https://github.com/DevinoSolutions/dokploy-community/pull/349)), and schedule targets and organization are validated on create and update ([#352](https://github.com/DevinoSolutions/dokploy-community/pull/352), [#353](https://github.com/DevinoSolutions/dokploy-community/pull/353)). Deployment log, cancel and remove routes authorize every deployment kind ([#355](https://github.com/DevinoSolutions/dokploy-community/pull/355)). Git provider tokens are kept out of clone URLs and `.git/config` and sent as a host-scoped auth header instead ([#335](https://github.com/DevinoSolutions/dokploy-community/pull/335), port of [Dokploy/dokploy#5619](https://github.com/Dokploy/dokploy/pull/5619) by @Souvik-Cyclic). Dependency updates clear the two remaining Dependabot advisories ([#334](https://github.com/DevinoSolutions/dokploy-community/pull/334)).

**Registry reliability** ([#354](https://github.com/DevinoSolutions/dokploy-community/pull/354)). Image pushes are retried with backoff on transient registry or storage errors (5xx responses and dropped connections).

**Ported upstream fixes.** Each is ported 1:1 with credit to its original author:
- [#337](https://github.com/DevinoSolutions/dokploy-community/pull/337): [Dokploy/dokploy#5626](https://github.com/Dokploy/dokploy/pull/5626) by @olivier-drieux
- [#338](https://github.com/DevinoSolutions/dokploy-community/pull/338): [Dokploy/dokploy#5631](https://github.com/Dokploy/dokploy/pull/5631) by @moataz-hjaiji
- [#339](https://github.com/DevinoSolutions/dokploy-community/pull/339): [Dokploy/dokploy#5632](https://github.com/Dokploy/dokploy/pull/5632) by @Totopo27
- [#340](https://github.com/DevinoSolutions/dokploy-community/pull/340): [Dokploy/dokploy#5633](https://github.com/Dokploy/dokploy/pull/5633) by @Totopo27
- [#341](https://github.com/DevinoSolutions/dokploy-community/pull/341): [Dokploy/dokploy#5583](https://github.com/Dokploy/dokploy/pull/5583) by @cevheri
- [#342](https://github.com/DevinoSolutions/dokploy-community/pull/342): [Dokploy/dokploy#5553](https://github.com/Dokploy/dokploy/pull/5553) by @Souvik-Cyclic
- [#343](https://github.com/DevinoSolutions/dokploy-community/pull/343): [Dokploy/dokploy#5593](https://github.com/Dokploy/dokploy/pull/5593) by @tarikyalcinkaya
- [#344](https://github.com/DevinoSolutions/dokploy-community/pull/344): [Dokploy/dokploy#5623](https://github.com/Dokploy/dokploy/pull/5623) by @lucasdu4rte
- [#345](https://github.com/DevinoSolutions/dokploy-community/pull/345): [Dokploy/dokploy#5627](https://github.com/Dokploy/dokploy/pull/5627) by @olivier-drieux
- [#346](https://github.com/DevinoSolutions/dokploy-community/pull/346): [Dokploy/dokploy#5566](https://github.com/Dokploy/dokploy/pull/5566) by @jhthompson
- [#347](https://github.com/DevinoSolutions/dokploy-community/pull/347): [Dokploy/dokploy#5559](https://github.com/Dokploy/dokploy/pull/5559) by @Tyagiquamar and [Dokploy/dokploy#5570](https://github.com/Dokploy/dokploy/pull/5570) by @boysandri8-jpg
- [#348](https://github.com/DevinoSolutions/dokploy-community/pull/348): [Dokploy/dokploy#5587](https://github.com/Dokploy/dokploy/pull/5587) by @ahmedisam99

**Fixes.** Trailing-slash trimming runs in linear time everywhere ([#350](https://github.com/DevinoSolutions/dokploy-community/pull/350)). Snapvisor builds are picked by build number, and email render errors are contained ([#351](https://github.com/DevinoSolutions/dokploy-community/pull/351)).

> No database migrations in this release (the count stays at 219). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.19

**DoDomain polling** ([#331](https://github.com/DevinoSolutions/dokploy-community/pull/331)). Verification status is pulled from DoDomain by background jobs every 2 and 30 minutes, so it works without inbound webhooks on private or Tailscale panels. Check now syncs immediately, webhooks are optional, and the DNS Providers page has a new DoDomain explainer card. Migration 0214.

**Snapvisor build checks** ([#332](https://github.com/DevinoSolutions/dokploy-community/pull/332)). Build badges appear on branch and production deployments in the deployments list, and the project picker is now on the Deployments tab. A new notification event, Snapvisor Visual Changes, works on all 14 providers and is detected by server-side polling. Migration 0215.

> Two database migrations in this release (0214 and 0215), applied automatically on startup. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.18

**Notification follow-ups** ([#329](https://github.com/DevinoSolutions/dokploy-community/pull/329)). The Mattermost channel and username can now be cleared. Stored notification URLs (Gotify and ntfy `serverUrl`, Sendly, Notifly and Uptimely `baseUrl`) come back with userinfo, query values and fragment redacted, and echoing the redacted URL back keeps the stored one. URL fields are capped at 2048 characters, the URL helpers run in linear time, and the create passthrough test covers all 15 routes.

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.17

**Write-only provider secrets** ([#322](https://github.com/DevinoSolutions/dokploy-community/pull/322)). The remaining notification provider secrets are write-only: they are masked in `notification.one` and `notification.all`, and the edit form keeps the stored value when a field is left blank.

**Follow-ups and invitation scoping** ([#323](https://github.com/DevinoSolutions/dokploy-community/pull/323)). Review follow-ups, plus `sendInvitation` is now scoped to the active organization.

**Safe sender-error logging** ([#324](https://github.com/DevinoSolutions/dokploy-community/pull/324), [#325](https://github.com/DevinoSolutions/dokploy-community/pull/325)). Failed notification sends and failed invitation emails log only safe details, and a failed Lark or Telegram Test now throws instead of reporting success.

**Review follow-ups** ([#326](https://github.com/DevinoSolutions/dokploy-community/pull/326)). Telegram omits an empty `reply_markup`. A Test that borrows a stored secret needs `notification:update`. Update routes no longer leak raw errors, and `maskApiKey` shows the tail only for keys of 12 or more characters.

**Error hardening** ([#327](https://github.com/DevinoSolutions/dokploy-community/pull/327)). Notification errors no longer carry a `cause`, and `receiveNotification` returns a generic error for every failure.

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.16

**Uptimely deploy heartbeat and notification channel** ([#318](https://github.com/DevinoSolutions/dokploy-community/pull/318)). An optional per-service deploy heartbeat pings Uptimely on every successful deploy, fire-and-forget. Paste the heartbeat key from the monitor's Settings page, because Uptimely doesn't return it yet. A new Uptimely notification channel declares an incident when a deploy fails and resolves it on the next success. Keys are masked on read, and changing the URL requires re-entering the key. Migration 0212.

**Integration key hardening** ([#319](https://github.com/DevinoSolutions/dokploy-community/pull/319)). Notifly and Sendly API keys are masked and kept when the field is left blank. Sendly, Notifly and DoDomain require the key again when the base URL changes. `getEmailProviders` no longer returns secrets, and deleting an organization now removes its notification channel rows and keys. No migration.

**Snapvisor visual testing for compose preview deployments** ([#320](https://github.com/DevinoSolutions/dokploy-community/pull/320)). Compose services get a Snapvisor project picker, and compose previews show the Snapvisor build status, a review link and refresh. Builds are looked up by head SHA. The Snapvisor token gets the same re-enter-on-URL-change rule. Migration 0213.

> Migrations 0212 and 0213 are idempotent and additive (new tables and columns, an enum value). The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.15

**postgres.js 3.4.9** ([#315](https://github.com/DevinoSolutions/dokploy-community/pull/315)). Updates postgres.js from 3.4.4 to 3.4.9, which fixes a `TimeoutNegativeWarning` logged at boot: the driver's reconnect delay went negative when a pooled connection slot was reused after the backoff. Upstream fixed it in 3.4.8. A regression test was added.

**Deleting a registry cleans up its docker login** ([#316](https://github.com/DevinoSolutions/dokploy-community/pull/316)). Deleting a registry now also removes its per-registry docker login directory (`docker-config/<registryId>`, from #303) on the Dokploy host and on every server of the organization. It is best effort, and a failed `docker logout` no longer makes the delete fail.

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.14

**One better-auth instance across workspaces** ([#312](https://github.com/DevinoSolutions/dokploy-community/pull/312)). The lockfile held two copies of better-auth 1.7.7 because of an `@better-auth/utils` 0.4.2/0.5.0 split and better-auth's optional vitest peer. `apps/dokploy` now pins `@better-auth/utils` 0.4.2 and a root `.pnpmfile.cjs` drops the unused vitest peer, so a single instance resolves everywhere.

**Contributor tooling** ([#313](https://github.com/DevinoSolutions/dokploy-community/pull/313), refs [#235](https://github.com/DevinoSolutions/dokploy-community/issues/235)). Adds `AGENTS.md` (agent and contributor gates, pull request requirements) and `scripts/dev-instance.sh` (a throwaway local Dokploy per worktree).

> No database migrations in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.13

**Upgrade notes:** [better-auth 1.7 upgrade notes](https://github.com/DevinoSolutions/dokploy-community/blob/canary/docs/better-auth-1.7-upgrade.md). Read them before updating if you use SCIM, SAML or the remote MCP server.

**better-auth 1.6.33 to 1.7.7** ([#309](https://github.com/DevinoSolutions/dokploy-community/pull/309)). The MCP OAuth provider moves to `@better-auth/oauth-provider`, with endpoints at `/api/auth/oauth2/*`; the old `/api/auth/mcp/*` URLs keep working. Migrations `0210` (new tables) and `0211` (copies existing MCP clients, tokens and consents) mean existing grants keep working without re-authorization. Concurrent refreshes of one token are serialized. SCIM is rewritten for the 1.7 plugin, so adopters using SCIM must re-create their connections and re-push their directory. The SAML ACS URL changes to `/sso/saml2/sp/acs/:providerId` (the old callback URL is kept as an alias), and IdP-initiated SAML is off. The provider's revoke and introspect endpoints are closed. Fixes the Dependabot high alerts for `@better-auth/scim` (GHSA-j8v8-g9cx-5qf4).

**MCP OAuth hardening** ([#310](https://github.com/DevinoSolutions/dokploy-community/pull/310)). Resource alias hosts now come from configuration only, and the refresh-lock pool wait is bounded.

> Includes database migrations 0210 and 0211, applied on startup. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.12

**Preview deployments for pull requests from forks** ([#289](https://github.com/DevinoSolutions/dokploy-community/pull/289), closes [#278](https://github.com/DevinoSolutions/dokploy-community/issues/278), by [@decryptedchaos](https://github.com/decryptedchaos)). Previews now check out `refs/pull/N/head` (GitHub and Gitea) or `refs/merge-requests/IID/head` (GitLab) from the base repository and fall back to the branch. The manual preview path verifies the pull request author with the provider. With "require collaborator permissions" turned off, fork pull requests now actually build.

**Preview deployments for Docker-image applications** ([#306](https://github.com/DevinoSolutions/dokploy-community/pull/306), closes [#257](https://github.com/DevinoSolutions/dokploy-community/issues/257)). A preview image template whose tag carries <code>${&#123;preview.prNumber}}</code>, a manual trigger by pull request number or tag, and a redeploy that pulls the image again. Adds the `application.previewDockerImage` column (migration `0209`, idempotent).

**Security update** ([#307](https://github.com/DevinoSolutions/dokploy-community/pull/307)). next 16.3.6 to 16.3.8, for Dependabot security advisories.

> Includes database migration 0209, applied on startup. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.11

**Registry passwords never appear in a process command line** ([#300](https://github.com/DevinoSolutions/dokploy-community/pull/300)). Registry logins now send the password on the login process's stdin, locally and over SSH, instead of embedding it in a `printf ... | docker login` command. Application deploys, build-policy pushes, docker-source pulls, rollbacks, ECR and the registry test calls all use it, so `ps` on a host no longer shows a registry password. A refused login now fails the deploy with the command's own error. Other secrets in build scripts (git clone tokens, the base64 `.env`) are not covered yet.

**A failed compose registry login is logged** ([#301](https://github.com/DevinoSolutions/dokploy-community/pull/301)). A failed registry login on the build server or the serving host writes `Registry login failed for <url>: ...` to the deployment log before the deploy fails. SSH commands no longer write an empty stdin.

**Registries on one URL keep their own login** ([#303](https://github.com/DevinoSolutions/dokploy-community/pull/303)). Each registry row gets its own docker config directory per host (`/etc/dokploy/docker-config/<registryId>`, mode 700), used with `docker --config` for build and rollback registry pushes, build-policy pushes, compose build-server pushes and docker-source pulls. Two registry rows with the same URL and different accounts no longer replace each other's login. The deploy registry and the compose serving host stay on the default config. A cancel during a compose build-server login ends as a cancel. Deleting a registry row does not yet remove its config directory.

**Docs and tests.** A registry password rotation record ([#299](https://github.com/DevinoSolutions/dokploy-community/pull/299)), a registry garbage collection runbook ([#302](https://github.com/DevinoSolutions/dokploy-community/pull/302)) with the bucket versioning check ([#304](https://github.com/DevinoSolutions/dokploy-community/pull/304)), and the env-file tests skip on Windows ([#298](https://github.com/DevinoSolutions/dokploy-community/pull/298)).

> No database migration in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.10

**Compose rollback and restore never build on the serving host** ([#293](https://github.com/DevinoSolutions/dokploy-community/pull/293)). Restoring a previous release of a compose service uses `--no-build`. If the restore fails, Dokploy prints a neutral warning telling you to redeploy instead of building on the host that serves traffic.

**Old build-server image tags are cleaned up** ([#294](https://github.com/DevinoSolutions/dokploy-community/pull/294)). After a build-server compose deploy, the `dpl-` image tags in the build registry are pruned. It keeps `latest`, every non-`dpl-` tag, every tag referenced by an override file, and the 5 newest `dpl-` tags. A digest is deleted only when no kept tag resolves to it, with at most 50 deletions per run. ECR registries are skipped. Set `DOKPLOY_DISABLE_BUILD_REGISTRY_RETENTION=true` to turn it off. Blob garbage collection is not included.

**Cancelling stops a build running on a build server** ([#295](https://github.com/DevinoSolutions/dokploy-community/pull/295)). Remote builds run under `setsid` with a pid file, and cancel sends TERM and then KILL to the process group.

**A compose rebuild on a build server reuses the existing clone** ([#296](https://github.com/DevinoSolutions/dokploy-community/pull/296)). The clone is reused only when a completion marker (`.git/dokploy-clone-ok`) exists and the directory is a top-level repo. Otherwise it clones again. A real failure after a cancel now logs neutral wording.

> No database migration in this release. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.9

**Compose services can build on a build server** ([#290](https://github.com/DevinoSolutions/dokploy-community/pull/290)). Set a build server and a registry on a compose service's Advanced tab. Its images are then built on that server, pushed to the registry, and pulled on the server that runs the stack, which never builds. Each built service is pushed with a per-deployment tag and run through a generated override file with `--no-build`. Services that share one image are pushed and pulled once. A failed build or pull restores the previous release. Works for `docker compose` and `docker stack` deployments. Composes without a build server behave exactly as before.

**Deploys that pull a large image are no longer marked failed too early** ([#291](https://github.com/DevinoSolutions/dokploy-community/pull/291)). When an application is built on a build server, the serving host has to pull the image before the new container can start. The post-deploy check now waits up to 10 minutes while the image is still being pulled, then watches the container for 30 seconds once it is running.

> Database migration 0208 adds `buildServerId` and `buildRegistryId` to compose services. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.8

**Restarting Dokploy no longer loses queued deployments** ([#288](https://github.com/DevinoSolutions/dokploy-community/pull/288)). Every queued deployment is now also saved in the database. When Dokploy restarts, for example during an update, waiting deployments are queued again in their original order. A deployment that was running at the moment of the restart is marked "Interrupted by a Dokploy restart; re-queued" and runs again. A deployment that keeps crashing Dokploy is dropped after 3 attempts. On shutdown, Dokploy stops starting new jobs and gives the running ones a few seconds to finish.

**better-auth 1.6.33** ([#287](https://github.com/DevinoSolutions/dokploy-community/pull/287)) fixes the SSO advisory GHSA-8c5h-wx78-2cfg. Signing in with GitHub or Google no longer adds you to an SSO provider's organization just because your email domain matches. That now needs a verified domain.

**Smaller fixes:** live log and status streams now return a clear "server unreachable" error instead of a 500 ([#286](https://github.com/DevinoSolutions/dokploy-community/pull/286)), and screen readers no longer read the DoDomain webhook address twice ([#285](https://github.com/DevinoSolutions/dokploy-community/pull/285)).

> Database migration 0207 adds the `deployment_queue_job` table. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.7

**A remote server that is offline now gets a clear error, not a 500** ([#283](https://github.com/DevinoSolutions/dokploy-community/pull/283)). When a request needs a server that can't be reached over SSH, Dokploy answers "Couldn't reach the server at host:port. Check that it is online and reachable over SSH." with HTTP 503.

**Offline servers no longer cause unhandled errors in background work** ([#284](https://github.com/DevinoSolutions/dokploy-community/pull/284)). Scheduled cleanups, websocket log and terminal sessions, and other background jobs now handle an unreachable server and log it. Creating a certificate or redirect on an offline server now fails with an error instead of reporting success.

> No database migration. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.6

**DoDomain: expired connect links no longer leave a domain "Awaiting domain owner"** ([#282](https://github.com/DevinoSolutions/dokploy-community/pull/282)). When a connect link expires before the owner finishes, and no webhook arrives (for example on a panel inside a private network), the domain now goes back to unverified so you can send a new link.

**Clear error when starting or stopping a compose that was never deployed** ([#281](https://github.com/DevinoSolutions/dokploy-community/pull/281)). It used to fail with `spawn /bin/sh ENOENT`; it now says to deploy the compose first.

> No database migration. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.5

**Security dependency sweep** ([#280](https://github.com/DevinoSolutions/dokploy-community/pull/280)): patched releases of next, nodemailer, hono, undici, the MCP SDK and about 40 transitive packages, plus gofiber in the monitoring agent. SCIM token generation now refuses providers that aren't bound to an organization (GHSA-j8v8-g9cx-5qf4).

> No database migration. The image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.4

**DoDomain webhook status is honest** ([#279](https://github.com/DevinoSolutions/dokploy-community/pull/279)): the Webhook row on the DoDomain card shows a green check only when the endpoint is registered and DoDomain can reach your panel. A panel on a private address (for example a Tailscale `*.ts.net` name) now shows a warning icon next to the existing explanation.

> No database migration. Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.3

**Integrations: logos, Learn more and fixes from a full end-to-end test** ([#273](https://github.com/DevinoSolutions/dokploy-community/pull/273), [#277](https://github.com/DevinoSolutions/dokploy-community/pull/277)):

- Uptimely, Snapvisor, DoDomain, Sendly and Notifly show their own logos, with a Learn more link. Uptimely's goes to the new [Dokploy × Uptimely page](https://getuptimely.com/integrations/dokploy).
- Monitor with Uptimely is disabled, with the reason, when a service has nothing to monitor. The Uptimely card shows the project name.
- Snapvisor errors stay in the dialog instead of a toast that disappears.
- DoDomain warns when your panel URL is private (for example a Tailscale `*.ts.net` name), because webhooks can't reach it. Re-verify DNS still works.
- Notifly errors are short and readable.

**Fixes for errors reported by other instances** ([#271](https://github.com/DevinoSolutions/dokploy-community/pull/271), [#272](https://github.com/DevinoSolutions/dokploy-community/pull/272)):

- The Traefik settings no longer error when Traefik has no published dashboard port or isn't on the host.
- The preview wildcard domain is validated when you save it.
- An expired GitLab token tells you to reconnect the provider.
- Volume backup failures include the real cause.
- The Requests page reads large access logs without running out of memory (port of [Dokploy/dokploy#4991](https://github.com/Dokploy/dokploy/pull/4991) by @Adriel2503).

**Upstream fixes ported ahead of their release**, each 1:1 with credit to its author:

- libsql validates the app name like the other databases ([#274](https://github.com/DevinoSolutions/dokploy-community/pull/274), [Dokploy/dokploy#5584](https://github.com/Dokploy/dokploy/pull/5584) by @cevheri).
- The terminal no longer collapses on zoom ([#275](https://github.com/DevinoSolutions/dokploy-community/pull/275), [Dokploy/dokploy#5582](https://github.com/Dokploy/dokploy/pull/5582) by @imrja8).
- Tooltips no longer stick over open dialogs on the remote servers page ([#276](https://github.com/DevinoSolutions/dokploy-community/pull/276), [Dokploy/dokploy#5575](https://github.com/Dokploy/dokploy/pull/5575) by @imrja8).

> No database migration. Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.2

**Clearer DoDomain setup and Deployments tab** ([#268](https://github.com/DevinoSolutions/dokploy-community/pull/268)):

- The DoDomain form checks each field when you leave it and shows the Base URL and secret key errors together. It links to your DoDomain dashboard and says that the App ID is filled in by Test connection.
- The Deployments tab shows short commit SHAs that you can click to copy, shows the error line on failed deployments, and explains how to deploy when there are none yet. The webhook buttons have labels.
- New FAQ answers cover large GitHub pushes and webhooks (up to 25 MB), connecting Claude Code over MCP, service status after saving provider settings, and DoDomain setup.

> No database migration. Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.8-community.1

**Upstream v0.30.8 sync** ([#259](https://github.com/DevinoSolutions/dokploy-community/pull/259)): upstream's only change is the Dokploy Cloud chat widget, so nothing changes for self-hosted installs.

**Upstream fixes ported ahead of their release**, each 1:1 with credit to its author:

- Session cookies are marked `Secure` when the dashboard is served over HTTPS ([#260](https://github.com/DevinoSolutions/dokploy-community/pull/260), from [Dokploy#5022](https://github.com/Dokploy/dokploy/pull/5022) by @Souvik-Cyclic)
- S3 credentials stay redacted in backup logs even when they contain quote characters ([#261](https://github.com/DevinoSolutions/dokploy-community/pull/261), from [Dokploy#5527](https://github.com/Dokploy/dokploy/pull/5527) by @Souvik-Cyclic)
- The deployment log tail is stopped when the browser disconnects early ([#262](https://github.com/DevinoSolutions/dokploy-community/pull/262), from [Dokploy#5529](https://github.com/Dokploy/dokploy/pull/5529) by @Souvik-Cyclic)
- Deploy webhooks accept payloads up to 25 MB ([#263](https://github.com/DevinoSolutions/dokploy-community/pull/263), from [Dokploy#5543](https://github.com/Dokploy/dokploy/pull/5543) by @Souvik-Cyclic)
- Saving a compose service's provider settings keeps its status ([#264](https://github.com/DevinoSolutions/dokploy-community/pull/264), from [Dokploy#5544](https://github.com/Dokploy/dokploy/pull/5544) by @roshanasingh4)
- Saving an application's provider settings keeps its status ([#265](https://github.com/DevinoSolutions/dokploy-community/pull/265), from [Dokploy#5455](https://github.com/Dokploy/dokploy/pull/5455) by @roshanasingh4)
- Host Block I/O stats count physical disks only ([#266](https://github.com/DevinoSolutions/dokploy-community/pull/266), from [Dokploy#5540](https://github.com/Dokploy/dokploy/pull/5540) by @Souvik-Cyclic)
- The add-invitation form keeps its input after a failed submit ([#267](https://github.com/DevinoSolutions/dokploy-community/pull/267), from [Dokploy#5498](https://github.com/Dokploy/dokploy/pull/5498) by @imrja8)

**DoDomain**: the base URL must use https; plain http is allowed only for localhost ([#258](https://github.com/DevinoSolutions/dokploy-community/pull/258)).

> No database migration. Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.11

**Sendly test emails arrive every time** ([#256](https://github.com/DevinoSolutions/dokploy-community/pull/256))

- Sendly accepts an email identical to one it already sent to the same recipient but never delivers it, so only the first **Test Notification** of a Sendly channel ever reached the inbox. Each test email now carries its send time, for example `Test Email (2026-10-03 19:06:09 UTC)`.

> Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.10

**Uptimely monitors check the right URL** ([#254](https://github.com/DevinoSolutions/dokploy-community/pull/254))

- Before creating monitors, the Uptimely panel checks each URL and shows what it returns. When one returns an error (for example a 404 at `/`), it warns that Uptimely will report it Offline.
- A new optional **Path to check** (for example `/health`) is added to every domain's monitor.
- The 30-day timeline now has per-day tooltips, a legend and a 30-day uptime percentage, and days without data look different from healthy days. Offline monitors show since when, with a hint on how to fix them.

**Clearer integrations and log viewer** ([#252](https://github.com/DevinoSolutions/dokploy-community/pull/252), [#251](https://github.com/DevinoSolutions/dokploy-community/pull/251))

- Integration dialogs keep Test connection and Save visible on small screens, and the Integrations page points to Notifications for Sendly and Notifly.
- The log viewer's input says that it writes to the container's standard input.
- A wrong Uptimely API key now shows "Uptimely rejected the API key" instead of "Uptimely JSON-RPC error undefined".

> Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.9

**Uptimely integration works with Uptimely's Code Mode MCP** ([#250](https://github.com/DevinoSolutions/dokploy-community/pull/250))

- Uptimely's MCP endpoint now exposes only `search_tools` and `execute_typescript`, so every call from Dokploy (test connection, status pages, monitor create and lookup, probes) failed with "Tool ... not found". Dokploy now runs each Uptimely tool through `execute_typescript`, and Uptimely's error codes (project access, invalid input, AI write operations off) come back as readable messages with a link to the right settings page.

**Snapvisor defaults to its API host** ([#249](https://github.com/DevinoSolutions/dokploy-community/pull/249))

- The Snapvisor Base URL now defaults to `https://api.snapvisor.io`. The old default, `https://app.snapvisor.io`, served the web app, so Test connection failed with "Snapvisor returned a non-JSON response". Saved integrations that still use the old value are treated as the API host, and build review links keep pointing at the web app.

**Container log input survives a container restart** ([#248](https://github.com/DevinoSolutions/dokploy-community/pull/248))

- Typing into the log viewer of a container that had exited and restarted went nowhere until the log viewer was reopened. The input session is now reopened on the next keystroke, including for TTY containers.

> Merged on green CI; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.8

**Deploy hook output reaches the build server's log over one connection** ([#245](https://github.com/DevinoSolutions/dokploy-community/pull/245), fixes [#243](https://github.com/DevinoSolutions/dokploy-community/pull/243))

- When builds run on a separate server, pre- and post-deploy hook output is now relayed to the deployment log over a single SSH session per hook. It used to open a new SSH connection for every chunk, which added up to hundreds per chatty hook.
- Relayed output is capped at 8 MiB. A dropped connection is restarted once, with a marker in the log, and a failed relay never fails the deploy.
- Remote command output no longer garbles multi-byte characters split across SSH packets, and a hook that runs on the Dokploy server with the log on a build server no longer dies after 64 MiB of output.

> Merged on green tests, typecheck and independent review run on a clean clone; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.7

**Viewing logs no longer restarts containers** ([#244](https://github.com/DevinoSolutions/dokploy-community/pull/244), from [#219](https://github.com/DevinoSolutions/dokploy-community/pull/219) by @ajnart)

- Opening or closing a container's log viewer no longer sends SIGHUP to the container. Services that exit on SIGHUP (PocketBase, for one) used to restart whenever someone looked at their logs.
- The viewer attaches to the container only when you send it a command, and never forwards signals. A new test checks this against a real container.

> Merged on green tests, typecheck and independent review run on a clean clone; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.6

**Deploy hooks work with a separate build server** ([#240](https://github.com/DevinoSolutions/dokploy-community/pull/240), from [#222](https://github.com/DevinoSolutions/dokploy-community/pull/222) by @rossreicks)

- Pre/post deploy hooks no longer fail when an application builds on a build server and deploys to another server. Hook output is relayed into the deployment log on the build server, capped at 8 MiB.

**API docs load again** ([#239](https://github.com/DevinoSolutions/dokploy-community/pull/239), from [#218](https://github.com/DevinoSolutions/dokploy-community/pull/218) by @rossreicks)

- `/swagger` and `settings.getOpenApiDocument` failed on "Subscriptions are not supported by OpenAPI v3". Fork subscriptions are now excluded from the document, and a test builds it from the whole router.

**Link GitHub or Google on self-hosted** ([#223](https://github.com/DevinoSolutions/dokploy-community/pull/223) by @rossreicks, [#241](https://github.com/DevinoSolutions/dokploy-community/pull/241))

- The profile page offers account linking whenever GitHub or Google OAuth is configured, not only on cloud.
- With **Enforce SSO** on, linking is hidden and blocked, so no login method can bypass the SSO provider.

**Auth hardening on PostgreSQL** ([#238](https://github.com/DevinoSolutions/dokploy-community/pull/238))

- API-key rate limits and other guarded auth updates now hold when many requests arrive at once. This fixes MCP keys whose request count could climb past their limit.
- The change patches the better-auth Drizzle adapter until an upstream fix ships.

> Merged on green tests, typecheck and independent review run on a clean clone; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.5

**MCP API-key rate limits count every tool call** ([#237](https://github.com/DevinoSolutions/dokploy-community/pull/237)) — follow-up to community.4.

- Tool calls that arrived together after a key sat idle shared one check and skipped the per-call count; each one is now counted against the key's rate limit
- Requests admitted on another request's check are flagged explicitly instead of compared by timestamp, which also closes a same-millisecond gap

> Merged on green tests, typecheck and independent review run on a clean clone; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.4

**MCP over API key survives fleets of clients** — fixes "needs authentication" prompts in every new Claude Code session on machines that open many sessions at once ([#236](https://github.com/DevinoSolutions/dokploy-community/pull/236)).

- A Dokploy API key that is over its per-key rate limit is answered with **429 + `Retry-After`**, never 401, so MCP clients back off instead of dropping their login and marking the server as needing re-authentication
- Session handshakes (`initialize`, `notifications/initialized`, `tools/list`) are admitted on a verification of the same key from the last 60 s, and concurrent checks share one lookup, so N clients starting together cost about one verification instead of 3N; `tools/call` is still verified and counted every time, and revoked keys stop doing work immediately
- Unauthenticated callers are rejected before the request body is read
- New diagnostic line: `[mcp-diag] request throttled: reason=api_key_rate_limited retryAfter=<s>s`

> Merged on green tests, typecheck and independent review run on a clean clone; the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.3

**Native integrations for the Devino product lineup** — new **Settings → Integrations** page, four migrations (`0203`–`0206`, all idempotent), upgrades in place.

- **Uptimely** — per-service uptime, SSL and domain monitors from the Monitoring tab of every application, compose stack and database, talking to Uptimely over its MCP endpoint with a project API key; status pill, 30-day timeline, run-probe, status-page badge. Monitor creation is opt-in per service and needs the project's "AI write operations" toggle ON in Uptimely. Also a per-service deploy heartbeat (Incoming Request monitor, pinged after each successful deploy) and an Uptimely notification channel (deploy failure declares an incident, the next success resolves it) ([#229](https://github.com/DevinoSolutions/dokploy-community/pull/229))
- **Sendly, Notifly and Uptimely notification channels** — the Uptimely channel declares an incident when a deploy fails and resolves it on the next success; email through Sendly (`POST /api/emails`) and workflow triggers through Notifly (`POST /v1/events/trigger`), wired into every notification event alongside Slack, Discord, Telegram, Email and Resend ([#231](https://github.com/DevinoSolutions/dokploy-community/pull/231))
- **DoDomain custom-domain connect** — "Check DNS" and "Send connect link" on domains; end users link their own domain through DoDomain's hosted flow, a signed webhook (`/api/webhooks/dodomain`, HMAC-verified, deduplicated) marks the domain verified and re-applies it through the normal Traefik path; failures fan out to notification channels ([#232](https://github.com/DevinoSolutions/dokploy-community/pull/232))
- **Snapvisor visual testing on preview deployments** — pick a Snapvisor project per application; each preview shows the visual-diff status of the build for the deployed commit with a "Review in Snapvisor" link ([#233](https://github.com/DevinoSolutions/dokploy-community/pull/233))
- **Migrations 0203/0204 hardened** so every fork-delta migration replays idempotently on installs switching from official Dokploy ([#234](https://github.com/DevinoSolutions/dokploy-community/pull/234))

> Every PR was merged on local green (typecheck, feature and migration test suites, independent review); the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.2

**API-key authentication for the MCP endpoint** — no migrations, upgrades in place.

- **MCP endpoint accepts a Dokploy API key** — `POST /api/mcp` now also authenticates with a Dokploy API key sent in the `x-api-key` header, resolved through the same path the REST API uses, with every MCP scope. Clients that keep one OAuth grant per machine (Claude Code shares a single grant across every session and a stale session can wipe it) can instead be configured with `claude mcp add --transport http --scope user dokploy https://<host>/api/mcp --header "x-api-key: <key>"` and never depend on that grant ([#226](https://github.com/DevinoSolutions/dokploy-community/pull/226))
- **Rejected MCP requests are logged** — the endpoint logs `[mcp-diag] request rejected: reason=…` (`api_key_invalid`, `not_bearer`, `empty_bearer`, `bearer_rejected` with an 8-character token prefix) so a "keeps asking me to log in" report can be answered from the server log. Credential-less discovery probes are not logged ([#226](https://github.com/DevinoSolutions/dokploy-community/pull/226))

> Merged on local green (typecheck + MCP test suite); the image is multi-arch (`linux/amd64` and `linux/arm64`), built by CI from the release commit.

### New in v0.30.7-community.1

**Upstream v0.30.7 sync + the MCP OAuth refresh fix** — no migrations, upgrades in place.

- **Upstream v0.30.7** — trial-expiration emails and a reworked billing/onboarding plan step (cloud-only; no effect on self-hosted). The extended static Railpack version list is superseded by the fork's dynamic list fetched from GitHub releases ([#224](https://github.com/DevinoSolutions/dokploy-community/pull/224))
- **MCP clients stay connected** — every refresh-token grant failed with `ERR_INVALID_ARG_TYPE` because the rotation clamp handed a JavaScript `Date` to the database driver as a raw SQL parameter, turning a successful refresh into a 500; clients dropped their grant and looped back to the browser authorization page. The deadline is now serialised the way the timestamp column expects, and a hygiene failure can no longer fail the token response ([#225](https://github.com/DevinoSolutions/dokploy-community/pull/225))
- **Dynamically registered MCP clients survive a slow approval** — the daily purge deleted any registration older than one day with no token, so a client that registered and was authorized a few days later hit `Unknown or disabled OAuth client`. Registrations now get 30 days, and that error explains how to recover (remove and re-add the MCP server) ([#225](https://github.com/DevinoSolutions/dokploy-community/pull/225))

### New in v0.30.6-community.2

**Self-healing fork schema for upstream switchers, a Settings → Build policy fix, and quieter scheduled-backup failures** — one guarded catch-up migration, upgrades in place.

- **Switching from upstream Dokploy v0.30.6 no longer loses fork tables** — the drizzle migrator orders migrations by timestamp, so an upstream v0.30.6 database that switched to the fork silently skipped the fork's wildcard-domain, MCP OAuth and earlier catch-up migrations (`column wildcard_domain does not exist`, `relation oauth_access_token does not exist`). A new catch-up migration re-issues them, and the boot sequence now applies any fork catch-up whose hash is missing from the migrations table, independent of timestamps ([#220](https://github.com/DevinoSolutions/dokploy-community/pull/220))
- **Settings → Build policy loads again** — the exclusions and audit listings selected the full `application` row inside a relational query, which exceeds Postgres's 100-argument limit; they now select only the columns the page shows ([#220](https://github.com/DevinoSolutions/dokploy-community/pull/220))
- **Scheduled backup failures no longer surface as context-free crashes** — a failing scheduled database or volume backup is logged with its backup and server ids instead of escaping as an unhandled rejection, and command errors reported to the error tracker now carry the scrubbed command, exit code and output tail ([#220](https://github.com/DevinoSolutions/dokploy-community/pull/220))
- **Migration failures are reported** — the migration step reports a failed batch to the error tracker instead of only logging it, so a half-migrated install is diagnosable ([#220](https://github.com/DevinoSolutions/dokploy-community/pull/220))

### New in v0.30.6-community.1

**Upstream v0.30.6 sync + a fork-original build policy + longer-lived MCP sessions + critical dependency patches** — one guarded migration (three enum values, one column, one default), upgrades in place.

- **Upstream v0.30.6** — Infomaniak and OVHcloud DNS providers, an AWS Parameter Store vault provider, Infisical secret references expanded with folder paths, organization logo drag-and-drop with smarter name truncation, dynamic Open Graph metadata for whitelabeled instances, SSO enforcement extended to server-side sign-in, passkeys and email signup, DNS upserts that match on record content instead of overwriting existing records, domain validation that accepts a server's own interface addresses, and custom Docker address-pool detection in server health ([#215](https://github.com/DevinoSolutions/dokploy-community/pull/215))
- **The v0.30.5 Docker build-context change is reverted upstream** — the default build context is the Dockerfile's own directory again. An application that needed *Docker Context Path* set as a workaround on `v0.30.5-community.1` keeps working either way, so no action is required ([#215](https://github.com/DevinoSolutions/dokploy-community/pull/215))
- **Build once, deploy by digest (fork original)** — enforced remote builds on the organization build server, a registry push per commit, swarm updates by image digest, audited break-glass local builds, required commit checks, deploy coalescing, and rollback to a stored digest; off by default ([#209](https://github.com/DevinoSolutions/dokploy-community/pull/209))
- **MCP sessions stop re-authorizing daily** — access tokens now last 30 days and refresh tokens 365 days sliding, and a 5-minute rotation grace window keeps a dropped refresh response from stranding a client; every lifetime is env-tunable ([#214](https://github.com/DevinoSolutions/dokploy-community/pull/214))
- **Critical dependency patches** — `next` 16.3.3 closes two unauthenticated remote-code-execution advisories (one affecting Windows-hosted servers, one in the image optimizer), alongside `sharp` and `js-yaml` fixes ([#213](https://github.com/DevinoSolutions/dokploy-community/pull/213))

### New in v0.30.5-community.1

**Upstream v0.30.5 sync + the three most-requested open upstream PRs + credential redaction** — one guarded migration (two enum values, one nullable column with a backfill), upgrades in place.

- **Upstream v0.30.4 + v0.30.5** — Phase.dev vault provider, Porkbun DNS provider, reworked DNS records management for every record type, bulk secret import from vault providers, "Deploy with Fresh Volumes" for compose, swarm convergence check before a database deploy is marked done, remote Traefik config written over SFTP, git-provider secrets stripped from compose responses, password reset by email, responsive application logs, and an onboarding wizard for brand-new instances ([#205](https://github.com/DevinoSolutions/dokploy-community/pull/205))
- **⚠ Docker build context now defaults to the repository root** (upstream [#5231](https://github.com/Dokploy/dokploy/pull/5231)) — it used to be the Dockerfile's directory. A Dockerfile app whose Dockerfile lives in a subdirectory and copies paths relative to it needs *Docker Context Path* set to that directory, otherwise its next build fails with a file-not-found ([#205](https://github.com/DevinoSolutions/dokploy-community/pull/205))
- **Compose deployments roll back automatically** — a failed `docker compose up` restores the last good compose file and `.env` and re-runs the previous release, so a bad push no longer takes a running stack down; disabled for fresh-volume deploys, previews included, plus Live / Deploying / Deploy failed badges in the compose header ([#207](https://github.com/DevinoSolutions/dokploy-community/pull/207), from upstream [#5182](https://github.com/Dokploy/dokploy/pull/5182) by [@EngAbo3lia](https://github.com/EngAbo3lia))
- **Gitea / Forgejo preview deployments** — pull-request webhooks for applications and compose stacks, PR comments with the preview URL, a *Build Pull Request* dialog, and the same author-collaborator gate GitHub and GitLab previews use ([#208](https://github.com/DevinoSolutions/dokploy-community/pull/208), from upstream [#5149](https://github.com/Dokploy/dokploy/pull/5149) by [@ankit8697](https://github.com/ankit8697))
- **Deploy hooks run on the right server** — with a build server configured, pre/post-deploy hooks tried to `docker exec` on the build host where the container never exists; they now run on the app server and the post-deploy hook targets the exact container the rolling update brought up ([#206](https://github.com/DevinoSolutions/dokploy-community/pull/206), from upstream [#4240](https://github.com/Dokploy/dokploy/pull/4240) review fixes by [@Alfredao](https://github.com/Alfredao))
- **Security: credentials in URLs are redacted** — GitHub App installation tokens, GitLab/Gitea OAuth tokens and registry passwords embedded in clone or login URLs (including the shell-escaped form git clone uses), plus bare `ghs_`/`ghp_`/`glpat-` style tokens, no longer reach deployment logs or crash reports ([#204](https://github.com/DevinoSolutions/dokploy-community/pull/204))

### New in v0.30.3-community.4

**Remote MCP server with OAuth** — one guarded migration (three additive tables), upgrades in place.

- **MCP server hosted inside Dokploy** — `POST /api/mcp` serves all 664 API procedures as MCP tools (same names as `@dokploy/mcp`) over Streamable HTTP, so 50 Claude Code sessions share one HTTPS endpoint instead of spawning 50 local processes; `claude mcp add --transport http --scope user dokploy https://<host>/api/mcp` and `/mcp → Authenticate` is the whole setup ([#203](https://github.com/DevinoSolutions/dokploy-community/pull/203))
- **OAuth 2.1 instead of API keys** — PKCE, dynamic client registration and RFC 9728 discovery via better-auth's in-core `mcp` plugin, hardened with a consent-proof gate on the authorize endpoint, a loopback/https-only redirect-URI policy, refresh-token rotation cleanup, and a bounded request body ([#203](https://github.com/DevinoSolutions/dokploy-community/pull/203))
- **Scoped grants** — the consent page lets you check off exactly what a client may do: `dokploy:read`, `deploy`, `services:write`, `services:delete`, `projects:write`, `projects:delete`, `backups`, `admin` (delete + admin off by default); credential-store queries and raw file reads require `admin`; every tool still runs the caller's role checks ([#203](https://github.com/DevinoSolutions/dokploy-community/pull/203))
- **Minimal re-authentication** — 30-day access tokens with a 365-day sliding refresh and a 5-minute grace window on rotated refresh tokens (`DOKPLOY_MCP_ACCESS_TOKEN_HOURS` / `DOKPLOY_MCP_REFRESH_TOKEN_DAYS` / `DOKPLOY_MCP_REFRESH_GRACE_SECONDS`), daily purge of expired rows, `DOKPLOY_MCP_DISABLED=true` kill switch, and a Settings → Profile card listing authorized clients with one-click revoke ([#203](https://github.com/DevinoSolutions/dokploy-community/pull/203))

### New in v0.30.3-community.3

**Wildcard domains for generated domains** — one guarded migration (three additive columns), upgrades in place.

- **Wildcard domain base for generated domains** — set a base domain at the organization level (Settings → Server) and/or per project, and the Generate Domain button and preview-deployment defaults produce `<app>.your-base.com` instead of `sslip.io` addresses; precedence is project → server default domain → organization (with a per-project inherit toggle) → `DEFAULT_DOMAIN` env → sslip.io, and existing HTTP-01 certificate issuance keeps working unchanged ([#201](https://github.com/DevinoSolutions/dokploy-community/pull/201), the top-requested unmet feature upstream — prior art by [@amirhmoradi](https://github.com/amirhmoradi), [@LukasParke](https://github.com/LukasParke), [@semihanadolu](https://github.com/semihanadolu), [@TuroYT](https://github.com/TuroYT))
- **Domain edits now enforce the domain allow-list** — updating an existing domain could bypass a restriction that creating one enforced; fixed with regression tests (bundled in [#201](https://github.com/DevinoSolutions/dokploy-community/pull/201))
- **Deployment history restored for previews, backups and volume backups** — the community.1 authorization hardening 401'd the "View Deployments" modal for non-service resource types; ids now resolve to their owning service before the same permission check, and host-level schedules gained the authorization gate they were missing ([#202](https://github.com/DevinoSolutions/dokploy-community/pull/202) by [@lmichelin](https://github.com/lmichelin))

### New in v0.30.3-community.2

**Manual preview builds + security hardening wave 5** — no migrations.

- **Build a preview deployment from any open PR/MR with one click** — a "Build Pull Request" button on applications and compose services lists open pull/merge requests (GitHub and GitLab) and builds a preview on demand, converging with webhook-triggered previews on the same deployment; the collaborator-permission requirement is enforced on the manual path too, so untrusted fork PRs can't be built onto your host ([#199](https://github.com/DevinoSolutions/dokploy-community/pull/199) by [@ajnart](https://github.com/ajnart))
- **Unhardened legacy permission helpers removed** — the package root exported pre-hardening duplicates of the access-check helpers (unused by shipped code, but a silent-downgrade trap for future imports); all deleted, the hardened implementations are now the only ones exported, and member allow-list writes verify organization ownership before persisting ([#200](https://github.com/DevinoSolutions/dokploy-community/pull/200))

### New in v0.30.3-community.1

**Upstream v0.30.3 sync + security hardening waves 3 & 4** — one guarded migration (`network.dockerId` + `server.terminal` role backfill), upgrades in place.

- **All ~37 fixes from upstream [v0.30.3](https://github.com/Dokploy/dokploy/releases/tag/v0.30.3)** ([#198](https://github.com/DevinoSolutions/dokploy-community/pull/198)): new `server.terminal` permission decoupling terminal access from root SSH, network sync that detects delete/recreate by Docker ID, volume backups restart services after a failed backup, `.env` `${VAR}` interpolation preserved, multi-IP domain validation, monitoring chart label/unit fixes, tini as PID 1, Railpack remote installs with sudo, and more
- **Cross-organization authorization hardening, waves 3 & 4** ([#196](https://github.com/DevinoSolutions/dokploy-community/pull/196), [#197](https://github.com/DevinoSolutions/dokploy-community/pull/197)) — service-level permission checks now verify organization ownership for **every** role across ~200 procedures (deploy/start/stop/logs/env for all eight service types) and all six project/service/environment access helpers; the AI provider router no longer leaks API keys across organizations; metrics endpoints are derived server-side from the organization-scoped server row instead of trusting a caller-supplied URL and token

### New in v0.30.2-community.2

**Security hardening, swarm-deploy stability, and quieter, tougher backups** — no migrations.

- **Cross-organization authorization hardening** — a sweep found tRPC procedures that accepted a `serverId` (or registry id) from another organization and ran SSH/docker commands against it; 22 procedures across the settings, certificate, registry, destination and patch routers are now organization-scoped, and user-supplied rclone `additionalFlags` are shell-quoted at the command builder so legacy rows can't smuggle shell syntax into backup commands ([#191](https://github.com/DevinoSolutions/dokploy-community/pull/191), [#192](https://github.com/DevinoSolutions/dokploy-community/pull/192))
- **Scheduled backups of stopped databases now skip quietly** — a "backup everything" policy no longer produces an error storm for databases that are intentionally stopped; manual runs still report real failures, and an unreachable server never masks an outage ([#193](https://github.com/DevinoSolutions/dokploy-community/pull/193))
- **MariaDB/MySQL dumps and restores survive the binary rename** — newer MariaDB images renamed `mysqldump`/`mysql` to `mariadb-dump`/`mariadb`; both backup and restore now pick whichever binary exists in the container ([#193](https://github.com/DevinoSolutions/dokploy-community/pull/193))
- **Backup failures finally say why** — volume-backup and remote command errors now include the tail of the command's output (secrets redacted) instead of an empty message ([#193](https://github.com/DevinoSolutions/dokploy-community/pull/193))
- **Rolling updates are robust to daemon clock skew** — the deploy stability check now anchors task timestamps to the remote docker daemon's clock and ignores tasks from previous deployments ([#188](https://github.com/DevinoSolutions/dokploy-community/pull/188) by [@lmichelin](https://github.com/lmichelin))
- **Disk Usage works on remote servers** — the dashboard's Disk Usage tab now passes the selected server instead of always querying the Dokploy host ([#187](https://github.com/DevinoSolutions/dokploy-community/pull/187) by [@lmichelin](https://github.com/lmichelin))

### New in v0.30.2-community.1

**Upstream v0.30.2 sync + a self-healing migration for anyone switching from official Dokploy.**

- **Switching from official Dokploy now works on any existing database** — the migration runner used to silently skip this fork's older migrations when upgrading a database that had already run newer official migrations, which broke fork features (backup destinations, Cloudflare integration, project icons, …) with `column does not exist` errors. A new fully idempotent catch-up migration recreates every fork table and column regardless of upgrade path ([#189](https://github.com/DevinoSolutions/dokploy-community/pull/189)) — found and fixed within hours thanks to the fork's opt-out error reporting catching a real install's crash.
- **All fixes from upstream [v0.30.1](https://github.com/Dokploy/dokploy/releases/tag/v0.30.1) and [v0.30.2](https://github.com/Dokploy/dokploy/releases/tag/v0.30.2)** ([#190](https://github.com/DevinoSolutions/dokploy-community/pull/190)): stack deploys keep env-var quotes literal, preview redeploys are no longer blocked by the preview limit, project pages no longer over-fetch for members with limited permissions, terminal resize desync fixed, tags apply on project create, switch thumb alignment

### New in v0.30.0-community.2

**Two community-contributed fixes** — no migrations.

- **GitLab merge-request previews now work for applications** — the preview pipeline only knew how to clone GitHub repos, so GitLab application previews died at deploy time; the GitHub-only gates are now provider-aware (GitHub or GitLab), the MR branch is cloned with refreshed credentials, and early failures land in the deployment logs ([#185](https://github.com/DevinoSolutions/dokploy-community/pull/185) by [@Knyntsje](https://github.com/Knyntsje) — first-time contributor!)
- **Rolling updates no longer report false deployment failures** — the post-deploy stability check could catch the outgoing container winding down and report "Container did not stay running"; task counts now only consider tasks Swarm intends to keep alive, while crash-loop detection still sees the full task history ([#184](https://github.com/DevinoSolutions/dokploy-community/pull/184) by [@lmichelin](https://github.com/lmichelin))

### New in v0.30.0-community.1

**Upstream v0.30.0 sync.** Full merge of upstream [Dokploy v0.30.0](https://github.com/Dokploy/dokploy/releases/tag/v0.30.0) ([#186](https://github.com/DevinoSolutions/dokploy-community/pull/186)) — one guarded migration, upgrades in place.

- **Overview dashboard** — new org-wide Overview page with Services, Backups, Domains and Deployments tabs
- **Secrets (vault providers)** — store secrets in HashiCorp Vault, Infisical, AWS Secrets Manager, Doppler, Azure Key Vault, or Scaleway and reference them from service environments
- **DNS providers** — Cloudflare and AWS Route53 integration for managing DNS records from Dokploy
- **Session management** — owners can view and revoke sessions across the organization (supersedes this fork's earlier self-scoped sessions page)
- **Docker dashboard expansion** — Health diagnostics, Docker events (sortable, paginated), Images and Disk Usage tabs
- **Organization improvements** — default role for newly joining members, larger searchable organization selector
- **Traefik 3.6.25**, monitoring deployed as a swarm service, SCIM/SSO user linking fix, GitLab OAuth token fix, and TypeScript 7 across the codebase
- **Fork fixes on top**: mysql/mariadb restores strip `USE`-statements (closes a restore bug found in our backup audit), ECR rollbacks use vault-resolved credentials, and compose `.env` files are no longer double-escaped
- All fork features preserved: Backup Center (incl. destination encryption — upstream's new backup internals were adapted around it), Cloudflare Tunnel & Access, project icons, Sentry opt-out error reporting, 30-day sessions, preview deployments

### New in v0.29.14-community.3

**Member project-access fix.** One community-contributed fix — no migrations.

- **Members with service-level permissions can now open their projects** — the project and environment endpoints required explicit project-level access, so members granted access to individual services were redirected back to the dashboard; access is now granted through project, environment, or service permissions, with responses still filtered to only the services each member can see ([#183](https://github.com/DevinoSolutions/dokploy-community/pull/183) by [@m41denx](https://github.com/m41denx)).

### New in v0.29.14-community.2

**Build-server deployment status fix.** One community-contributed fix — no migrations.

- **Deployments no longer marked failed when using a separate build server** — the post-deploy stability check polled the build server for a service that only runs on the app's runtime server, reporting successful deployments as failed ([#181](https://github.com/DevinoSolutions/dokploy-community/pull/181) by [@lmichelin](https://github.com/lmichelin)).

### New in v0.29.14-community.1

**Upstream v0.29.14 sync.** Full merge of upstream [Dokploy v0.29.14](https://github.com/Dokploy/dokploy/releases/tag/v0.29.14) ([#182](https://github.com/DevinoSolutions/dokploy-community/pull/182)) — one guarded migration, upgrades in place.

- **Network management** — upstream's network management landed and replaces this fork's earlier implementation: create/inspect/recreate Docker networks with driver, IPv4/IPv6, IPAM and MTU options, attach services to networks, and detach the default dokploy network per service. The fork adds role-permission gates on top.
- **Passkey sign-in** — register passkeys and sign in with them.
- **GitHub Enterprise support** — GitHub providers accept a custom base URL.
- **Service icon management** — pick icons for compose services.
- **Misc fixes from upstream** — single-label hostnames, real error-page status codes, dropdowns staying open on window blur, rollback env resolution, preview-deployment cleanup on app delete, and more.
- Upstream's new hotfix automation workflows are not enabled in this fork (releases here are manual).

### New in v0.29.13-community.3

**Security fix & six upstream ports.** Six 1:1 ports of upstream PRs — no new migrations. **Upgrading is recommended** for the command-injection fix.

- **Security: command injection via compose service names** — a crafted compose service name could reach a `docker` error message that was interpolated unquoted into an `echo` inside the generated build script, allowing shell command injection during builds. The error text is now shell-quoted before embedding ([#178](https://github.com/DevinoSolutions/dokploy-community/pull/178), upstream [#4872](https://github.com/Dokploy/dokploy/pull/4872) by @Siumauricio).
- **Preview deployments work with GitHub apps again** — creating a preview deployment passed a redacted GitHub private key to authentication, so previews always failed with `NOT_FOUND`; the provider credentials are now re-fetched unredacted ([#179](https://github.com/DevinoSolutions/dokploy-community/pull/179), upstream [#4933](https://github.com/Dokploy/dokploy/pull/4933) by @CyrilBIENNE).
- **Postgres 100-argument limit fix for schedules & volume backups** — installs with many applications no longer crash schedule/volume-backup queries that hydrate app relations ([#175](https://github.com/DevinoSolutions/dokploy-community/pull/175), upstream [#4931](https://github.com/Dokploy/dokploy/pull/4931) by @Siumauricio).
- **GitHub provider trigger type persists** — the selected deploy trigger (push/tag) is saved correctly when editing a GitHub-provider application ([#176](https://github.com/DevinoSolutions/dokploy-community/pull/176), upstream [#4937](https://github.com/Dokploy/dokploy/pull/4937) by @narcisonunez).
- **DNS check tooltip no longer flags CDNs as errors** — domains behind a CDN/proxy show an informational message instead of a false-negative error ([#177](https://github.com/DevinoSolutions/dokploy-community/pull/177), upstream [#4911](https://github.com/Dokploy/dokploy/pull/4911) by @AbiRaditya).
- **Template dialog keeps its state on tab switch** — the create-from-template dialog no longer closes when switching browser tabs ([#180](https://github.com/DevinoSolutions/dokploy-community/pull/180), upstream [#4906](https://github.com/Dokploy/dokploy/pull/4906) by @zenojunior).

### New in v0.29.13-community.2

**Migration reliability for official-Dokploy switchers, credential scrubbing & backup cleanup.** A patch release on the v0.29.13 base — five fixes, no new migrations. **Upgrading is recommended**, especially if you switched to the fork from official Dokploy v0.29.13 or use S3 backups.

- **Migration failures fixed for installs switching from official Dokploy v0.29.13** — installs that moved from official Dokploy v0.29.13 to the fork previously re-ran migration 0174 (the fork re-timestamps it), hit a `duplicate_column` error, and rolled back the **entire** pending migration batch (0174–0192) — leaving every fork table and column silently missing. Migration 0174 now uses `ADD COLUMN IF NOT EXISTS`, a fork-wide migration-idempotency audit plus a static lint test guards against recurrence, and migration failures now log loudly and report to Sentry instead of failing quietly ([#172](https://github.com/DevinoSolutions/dokploy-community/pull/172)).
- **Credentials scrubbed from error reports** — a failed backup command could previously embed live S3 credentials (e.g. rclone `--s3-access-key-id` / `--s3-secret-access-key`) in an error message that then flowed into error reports. Credentials are now scrubbed from `ExecError` messages and from all error reports (a Sentry `beforeSend` scrubber) before anything leaves the process ([#173](https://github.com/DevinoSolutions/dokploy-community/pull/173)).
- **Partial backup uploads are cleaned up on failure** — when a backup fails mid-upload, the truncated partial object is now deleted from the destination, so it can't pollute buckets or evict good backups from retention. Failure diagnostics now distinguish **"Backup failed"** (a dump error, with the dump's stderr) from **"Upload failed"** (a destination error) ([#174](https://github.com/DevinoSolutions/dokploy-community/pull/174), inspired by upstream [#4896](https://github.com/Dokploy/dokploy/pull/4896)).
- **Cursor pointer on buttons** — buttons now show a pointer cursor on hover ([#170](https://github.com/DevinoSolutions/dokploy-community/pull/170), upstream [#4890](https://github.com/Dokploy/dokploy/pull/4890) by @SteadEXE).
- **Security-audit robustness** — the server security audit no longer breaks when sshd/ufw config contains duplicate directives; the grep pipelines take the first match and strip carriage returns so the audit JSON stays valid ([#171](https://github.com/DevinoSolutions/dokploy-community/pull/171), upstream [#4889](https://github.com/Dokploy/dokploy/pull/4889) by @reikjarloekl).

### New in v0.29.13-community.1

**Upstream v0.29.13 rebase + SMTP-without-auth, UI fixes & session diagnostics.** The fork is now based on upstream Dokploy v0.29.13 — a large security-hardening release (shell-escaping of all user-influenced commands, WebSocket handler authorization, git/registry command-injection fixes, secret redaction in API responses, org-scoped custom AI provider presets, email verification for SSO). All fork features were re-verified on top, and the fork's backup-command credential redaction was widened to cover the new escaping format. One additive migration (0192).

- **SMTP without authentication** — email notifications now work with auth-less SMTP relays: username/password are optional and the auth block is omitted when blank ([#165](https://github.com/DevinoSolutions/dokploy-community/pull/165), upstream [#4844](https://github.com/Dokploy/dokploy/pull/4844) by @hbilal9; migration 0192).
- **Org menu width fix** — the organization dropdown is no longer clipped when the sidebar is collapsed ([#166](https://github.com/DevinoSolutions/dokploy-community/pull/166), upstream [#4845](https://github.com/Dokploy/dokploy/pull/4845) by @hbilal9; also landed upstream in v0.29.13).
- **Compose "Reload" renamed to "Rebuild"** — the button label now says what the action does ([#167](https://github.com/DevinoSolutions/dokploy-community/pull/167), upstream [#4847](https://github.com/Dokploy/dokploy/pull/4847) by @ANSUJKMEHER; also landed upstream in v0.29.13).
- **Session-rejection diagnostics** (fork original) — when a browser presents a session cookie that the server rejects, the server now logs a classified reason (token unknown / expired / signature mismatch) with only an 8-char token prefix, to make unexplained logouts diagnosable ([#168](https://github.com/DevinoSolutions/dokploy-community/pull/168)).

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
