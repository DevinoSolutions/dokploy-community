# Compose redeploys without downtime: options

Design note for GetItDone T-1993, item 4 of
[#374](https://github.com/DevinoSolutions/dokploy-community/issues/374)
("Compose deployment: delayed container removal caused a 135s web outage").
Investigation only: no product code changes with this note.

Items 1 to 3 of #374 shipped as opt-in observability (phase timestamps, docker
events, pre-done health check, stall snapshots). None of them removes the gap;
they only show it. This note covers what it would take to remove it.

## 1. Why a plain `docker compose up -d` redeploy has a gap

What Dokploy runs for a `docker-compose` type compose:

```
docker compose -p <appName> [--project-directory ..] [--env-file ..] -f <file> up -d [--pull always] --build --remove-orphans
```

(`packages/server/src/utils/builders/compose.ts:705`; with a build server it is
`--no-build` instead of `--build`, line 701.) A custom command replaces it
entirely (line 687). The deploy is marked done when that command returns; the
only later step is the opt-in health check (lines 541 to 547, 577).

Compose replaces a changed service in this order (maintainer analysis in the
#374 comments): create the new container under a temporary name, stop the old
one, remove the old one, rename the new one. It starts nothing until every
changed service has been replaced, and `depends_on` serialises services that
depend on each other. So there is no moment where both versions serve.

Tied to the #374 timeline:

- 21:32:31 old web is force-stopped after the 10 s SIGTERM grace period. From
  here the old web no longer serves. Traefik's docker provider runs with
  `watch: true` (`packages/server/src/setup/traefik-setup.ts:299-312`), so it
  drops the server on the container's stop/die event and the router has no
  backend.
- 21:32:31 to 21:34:41 the old container sits in `removing`/`Dead`. The new
  one stays `Created` because Compose does not start it before the removal and
  rename finish. This is the 135 s. The slow removal is Docker/host behaviour
  (not established, see the issue); the structural problem is that it sits
  between "old stopped" and "new started".
- Even without a slow removal the gap is stop grace + remove + rename + start
  + whatever the app needs to become ready, typically seconds.
- Traefik adds a container as soon as it is `running`. Per the Traefik docker
  provider docs, a container with a Docker healthcheck is only added once it
  is healthy (`allowEmptyServices` exists to override that), so a service
  without a healthcheck gets traffic while the app is still booting.

The property to aim for: the old container keeps serving until a new one is
healthy and routable, and the slow, failure-prone steps (stop, remove) happen
off the serving path.

What exists today for comparison:

- Dokploy Applications (non-compose) are swarm services. When the user sets
  no update config, the generated spec uses `Order: "start-first"`,
  `Parallelism: 1`, `FailureAction: "rollback"` and a matching rollback config
  (`packages/server/src/utils/docker/utils.ts:802-820`). They already roll.
- `composeType: "stack"` deploys with `docker stack deploy -c <file> <app>
  --prune --with-registry-auth` (`builders/compose.ts:706-712`). Dokploy
  injects no update config for stacks; start-first only happens if the
  compose file says so.
- Upstream discusses this in Dokploy/dokploy#2497 (open, no implementation).
  The maintainer position there and in the older #617 is that plain compose
  has no zero-downtime path and swarm (stack type) is the answer. Users in
  #2497 report that stack type plus `deploy.update_config.order: start-first`
  plus a healthcheck works, with a custom command to resolve `.env` first.

## 2. Options for plain docker compose stacks

### a. Scale up, then remove the old container (docker-rollout pattern)

How it works, per selected service `svc`:

1. Build or pull the new image first (`docker compose build svc`, or the
   existing pull step on a build server). Nothing running is touched.
2. Record the ids of the service's containers (label filter
   `com.docker.compose.project` and `com.docker.compose.service`, all states),
   then run `docker compose ... up -d --no-deps --no-recreate --scale svc=2 svc`.
   `--no-recreate` keeps the old container as is; the second replica is
   created from the new config and image. The new replica is the id that is not
   in the recorded set.
3. Wait until the new replica is healthy (Docker healthcheck status), up to a
   timeout.
4. Stop and remove the old ids explicitly (graceful stop, its own grace
   period), then `up -d --no-deps --no-recreate --scale svc=1 svc`.

Old and new must be told apart by id, never by Compose's scale-down: scaling
from 2 to 1 removes the highest-numbered container, which is the new one. After
step 4 the survivor keeps its number (`-2`, `-3`, ...), which is cosmetic. If no
old container is running (first deploy, service stopped or exited), that
service uses the normal `up` instead of a rollout.

What Dokploy would generate: a shell block replacing the single `up` line at
`builders/compose.ts:496-498` for the selected services. The rest of the
compose (non-selected services) goes through `up -d --no-deps <others>` first.
That step is emitted only when the non-selected set is non-empty, and services
are always named explicitly on every `up` line: with no service arguments
(for example when every service is selected) `up` would bring up the whole
project as a plain recreate, selected services included. Old and new container
ids are found with the
same labels Dokploy already uses elsewhere
(`com.docker.compose.project`, `com.docker.compose.service`,
`utils/backups/utils.ts:348`, `utils/docker/utils.ts:1052-1053`). A service
is skipped only if both hold: its `com.docker.compose.config-hash` label equals
`docker compose config --hash svc`, and the container's image id
(`docker inspect -f '{{.Image}}'`) equals the id of the service's image after
the build/pull step. Otherwise it is rolled. The hash alone is not enough: it
covers only the service config, so a source change behind a `build:` service,
or a floating tag with `--pull always`, leaves it unchanged while Compose
itself would recreate the container (it also compares the image id, label
`com.docker.compose.image`). With both checks, a web-only change still does
not roll mastra or iii.

Traefik:

- Domain labels live on the service (`utils/docker/domain.ts:398-415`), so the
  second replica carries identical labels. Traefik merges both containers into
  one load balancer with the same router/service names, so no label change is
  needed.
- Healthcheck-aware routing is what makes step 3 safe: the new replica only
  joins the pool when `healthy`. Traefik also leaves out a container whose
  health is `starting`, not only `unhealthy`, so a long `start_period` delays
  routing. Therefore a Docker healthcheck on the service is a hard requirement,
  and the health timeout must exceed `start_period` plus `interval` times
  `retries`; the setting is validated against the service's healthcheck.
- Traefik removes the old backend only on the `die` event, so for the whole
  stop grace period it still receives new requests while the app shuts down.
  The new replica being healthy does not cover this window. The drain delay in
  the first PR is a wait between "new replica healthy" and "stop old". It does
  not make the old container unroutable, and the Traefik retry middleware
  (option e) is the only mitigation for this window.
- Docker DNS ignores health for non-swarm containers, so container-to-container
  traffic by service name reaches the not-yet-healthy replica too; this path is
  not gated during the overlap. It resolves to both replicas for the length of
  the overlap.

Constraints:

- `container_name` set: Compose refuses to scale. Blocker.
- Published host ports (`ports: "8080:80"`): the second replica cannot bind.
  Blocker. `expose:` and Traefik-only access are fine.
- `network_mode: host` or `service:x`: blocker.
- `scale:` or `deploy.replicas` greater than 1: `--scale svc=2` would shrink
  or conflict with it. Blocker (or use 2xN; the first PR refuses).
- Static `ipv4_address`, `ipv6_address` or `mac_address`: the second replica
  cannot take it. Blocker.
- Any other service that points at the rolled one with `network_mode:
  service:<svc>`, `pid: service:<svc>`, `ipc: service:<svc>` or
  `volumes_from: <svc>`: replacing the service breaks the dependent. Blocker.
- Exclusive devices (`devices:`, GPU reservations) and resource limits are
  doubled during the overlap. Not reliably detectable; listed as a soft risk.
- Singleton workers (queue consumers, cron runners, anything that must run
  once): two copies run during the overlap. Not detectable from the file.
- DB migrations at container start: the new version migrates while the old
  version still serves, so migrations must be backward compatible
  (expand/contract). Not detectable.
- Volumes: two containers briefly mount the same named volume or bind path.
  Safe for read-mostly data, unsafe for stores that take an exclusive lock
  (SQLite, embedded DBs). Not reliably detectable.
- `getComposeContainer` takes the first running container
  (`utils/docker/utils.ts:1038-1073`, `limit: 1`) and the backup lookup uses
  `head -n 1` (`utils/backups/utils.ts:348`), so exec/terminal/backup actions
  can pick either replica during the overlap (seconds).

Stateful services (postgres, mysql, redis, mongo, anything with a data volume
that is the source of truth): never. They keep the plain recreate path.

Failure and rollback: this is the main gain. If the new replica is not healthy
in time, Dokploy removes it and the old container, which was never touched,
keeps serving. The current failure path instead re-runs the previous release
with `up`, which is itself a recreate
(`getRestoreCommands`, `builders/compose.ts:227-315`). With several selected
services, services already rolled stay on the new release when a later one
fails; that is a mixed state and must be logged as such. Because the
transactional restore would recreate the already-rolled services, it should
not run for rolled services (see decision 3).

Interrupted deploys (cancel, host reboot) can leave two replicas. The next
deploy must detect more than one container for a selected service and
reconcile (keep the newest healthy one). The deploy queue already serialises
deploys of one compose (per-service group lock,
`apps/dokploy/server/queues/in-memory-queue.ts:408-418`), so two rollouts of
the same compose cannot overlap.

Effort: moderate. One new builder module plus config, UI list of services,
tests. No new moving parts on the host beyond the docker CLI Dokploy already
uses.

### b. Blue-green with two compose project names and a Traefik switch

How it works: deploy the new release as project `<app>-green` next to
`<app>-blue`, wait healthy, move Traefik to the new project, tear down the old
project.

Problems specific to this codebase:

- Compose-defined named volumes are project-prefixed by default, so the second
  project gets empty volumes unless every volume is declared external or given
  a fixed name. Stateful services cannot be duplicated, so the stack has to be
  split into a stateless front and a shared stateful back. That is a different
  product, not a flag.
- Host ports and `container_name` conflict as in (a), for every service rather
  than only the selected ones.
- The switch: if both projects carry the same router names Traefik simply
  merges them (this collapses into (a) across projects). A real cut-over needs
  distinct router names plus a file-provider route in
  `/etc/dokploy/traefik/dynamic` pointing at the active project, or a label
  flip that requires recreating a container.
- Service-name collision handling exists for isolated deployments and
  randomize (`utils/docker/collision.ts`, `utils/docker/compose/service.ts`),
  which could be reused for colour suffixes, but domains, backups, schedules
  and the Dokploy UI all key on `appName`.
- Double the resources for the whole stack during the cut-over.

Effort: high, large blast radius. Not recommended as a first step; only worth
revisiting if (a) proves too weak.

### c. Convert to swarm: `composeType: "stack"` with `start-first`

Already supported: a compose of type `stack` runs `docker stack deploy`
(`builders/compose.ts:706-712`), Dokploy puts Traefik labels under
`deploy.labels` and uses the `traefik.swarm.network` label
(`utils/docker/domain.ts:405-421`). With this in the compose file:

```yaml
services:
  web:
    healthcheck: { ... }
    deploy:
      update_config:
        order: start-first
        failure_action: rollback
```

swarm starts the new task, waits for it to be healthy, then stops the old one,
and rolls back automatically on failure. That is the cleanest zero-downtime
mechanism available and needs no new Dokploy engine.

What users gain: healthcheck-gated rolling update, automatic rollback,
replicas, no custom scripting.

What users lose or must change:

- `build:` is ignored by `stack deploy`; images must come from a registry. The
  fork's build server path already pushes images and uses an override file for
  stacks (`builders/compose.ts:706-711`), which covers this when a build
  server is configured.
- `container_name`, `depends_on` ordering, and `restart:` do not apply the
  same way; `deploy.restart_policy` replaces `restart:`.
- Bind mounts and named volumes are node-local; placement must be pinned.
- Published ports use ingress/host mode semantics.
- Environment interpolation differs (the fork stages a stack env file for this,
  `builders/compose.ts:856-866`).
- The opt-in health check is skipped on stacks because `stack deploy` returns
  before tasks run (`compose-guardrails.ts:467-469`,
  `builders/compose.ts:543-547`); an `update_config` healthcheck gate replaces
  it, but Dokploy would not see the outcome (upstream #3987 describes swarm
  rollbacks not reflected in the UI as a deploy result).
- Switching an existing compose between types is not a no-op. Whether the
  named volumes carry over (both are named `<name>_<volume>`, but ownership
  labels differ) is untested and must be tried on a throwaway compose before
  anything is promised.

Recommended handling in Dokploy: documentation plus a small preflight, not a
new engine. For stack type, warn in the UI when a service has no healthcheck
or no `update_config.order: start-first`, since those are the two things that
silently make it stop-first.

Effort: low (docs and a warning); the migration is the user's.

### d. Healthcheck-gated recreate only

`docker compose up -d --wait --wait-timeout N` makes the command wait for
healthy before returning, and `depends_on: condition: service_healthy` orders
startup. Together with pre-pulling or pre-building (the build already happens
before containers are touched) and a tuned `stop_grace_period`, this shortens
the gap and makes "deploy done" mean "healthy".

It does not remove the gap, because the old container is still stopped before
the new one starts. It also does not touch the #374 cause (the removal sits
between stop and start). It overlaps with the shipped pre-done HTTP health
check (`compose-guardrails.ts:483`), which checks externally and does not
change what compose does. Cheap and low risk, but it only improves
diagnostics.

Effort: small. A possible add-on to (a) rather than an answer by itself.

### e. Smaller mitigations

- Traefik retry middleware on the domain's router (`retry.attempts`,
  `initialinterval`, `timeout`, and a `status` list in recent Traefik; the pin
  is `TRAEFIK_VERSION` 3.6.25 in `traefik-setup.ts:24`, so confirm the
  `status` option exists in that version before relying on it). It covers
  connection errors and sub-second to a few-second blips. It cannot cover a
  135 s gap, and it does not retry non-idempotent methods by default. Useful
  next to (a) for the stop race, not alone.
- Move the one service that matters (usually the web front) out of the
  compose and into a Dokploy Application, which already gets start-first
  (`utils/docker/utils.ts:811-820`). Zero engineering, but it splits the
  stack and loses compose-internal networking and `depends_on`.
- A static maintenance response when no backend exists (a low-priority router
  that returns 503 instead of Traefik's default no-route reply). Does not
  prevent downtime; makes it legible.
- Reduce what is replaced: narrower build contexts and `.dockerignore`, or
  shared pre-built images, so a web-only change does not recreate mastra and
  iii (already suggested on #374).

## 3. Services that must be refused or skipped, and how to detect it

Two layers. Hard blockers are detectable from the rendered compose spec and
must be refused. Soft risks are not detectable, so the safety comes from the
user choosing services explicitly (opt-in per service, never "all").

Hard blockers (checked on the spec that `renderComposeWithDomains` produces,
`utils/docker/domain.ts:192`, so names after `randomize`/isolated deployment
match what Compose will see):

| Condition | Reason |
| --- | --- |
| `container_name` set | scale to 2 impossible |
| any `ports:` entry with a published host port | second replica cannot bind |
| `network_mode: host` or `service:`/`container:` | shared netns |
| `scale:` or `deploy.replicas` > 1 | `--scale svc=2` would conflict |
| static `ipv4_address`, `ipv6_address` or `mac_address` | second replica cannot take it |
| another service uses `network_mode`/`pid`/`ipc: service:<svc>` or `volumes_from: <svc>` on this one | replacing it breaks the dependent |
| no `healthcheck` on the service, or `healthcheck: { disable: true }` / `test: ["NONE"]` | no readiness signal; Traefik would route to a booting container (an image-level `HEALTHCHECK` is not visible in the spec; v1 requires it in the compose, or checks `docker image inspect` on the host) |
| compose has a custom `command` (`builders/compose.ts:687`) | Dokploy does not control what runs |
| `composeType: "stack"` | use (c) |
| fresh-volumes deploy (`freshVolumes`, `builders/compose.ts:432`) | destructive by design |
| image name matches a known datastore (postgres, mysql, mariadb, mongo, redis, valkey, etcd, rabbitmq, kafka, ...) | stateful heuristic; only a guard, the explicit opt-in is the real control |

Soft risks, documented in the UI next to the service picker, not detected:
singleton workers, migrations at start, exclusive-lock volumes, services that
register themselves externally on boot, exclusive devices and resource limits
(doubled during the overlap).

Detection runs at two points:

1. On save (compose parsed with `loadServices`-style loading,
   `services/compose.ts:472`): refuse to enable rolling replace for a service
   that has a hard blocker, with the reason.
2. At deploy time against the rendered spec: if a previously selected service
   now has a blocker (compose edited since), do not roll it. Fall back to the
   standard recreate for that service and print a clear log line saying why.
   Failing the whole deploy over drift would be worse than the status quo.

## 4. Recommendation and first step

Recommendation: implement (a) as an opt-in, per-service rolling replace for
`docker-compose` type; document (c) as the supported route for users who want
swarm semantics, with a preflight warning; treat (d) and the retry middleware
(e) as optional add-ons; do not pursue (b).

Why (a): it is the only option that removes the gap for plain compose, it
fixes the #374 failure mode (the slow removal then happens after the new
container already serves), a failed deploy leaves the old release serving
untouched, and it needs nothing beyond the docker CLI the deploy script
already calls.

### Scoped first PR

Behaviour:

- Off by default; a compose with no setting gets a byte-identical deploy
  script (same guarantee the guardrails keep with their golden test,
  `apps/dokploy/__test__/compose/deploy-guardrails-golden.test.ts`).
- Per compose setting: a list of service names to roll, a health timeout, and
  a drain delay (a wait between "new replica healthy" and "stop old"; it does
  not make the old container unroutable, see the Traefik notes in option a).
  Only `docker-compose` type, no custom command, no fresh-volumes.
- Deploy script order: build/pull as today; `up -d --no-deps <others>` for the
  non-selected services, emitted only when that set is non-empty; for each
  selected, changed (hash and image id, see option a), eligible service the
  sequence from option (a); then a final `up -d --no-recreate
  --remove-orphans` with an explicit service list (the output of
  `docker compose config --services`, which respects active profiles) to
  reconcile orphans without starting services of inactive profiles. It does
  start a stopped non-selected container, as a plain `up` does; that is
  intended. `persistLastGood` (`builders/compose.ts:577`) and the
  isolated-deployment `docker network connect` (`builders/compose.ts:576`) still
  run on the rolling path. Phase timestamps and docker events from the existing
  guardrails wrap it when enabled.
  The Traefik retry middleware (option e) is the only mitigation of the
  stop-grace window in this PR. It is not injected; the first PR documents it
  as a manual step (decision 5).
- Timeout or unhealthy new replica: remove the new replica, keep the old
  container, mark the deployment as an error with the reason, fire the
  existing failure notification. No transactional restore for rolled services.
- On entry, reconcile leftovers (more than one container for a selected
  service) before starting.

Where:

- New `packages/server/src/utils/builders/compose-rolling.ts` next to
  `compose-guardrails.ts`, producing the shell block, and a pure
  `getRollingEligibility(spec, serviceName)` returning blockers.
- Hook at the single place the `up` line is composed
  (`builders/compose.ts:496-498`, `550-552`), only when enabled.
- Setting storage: a separate column with a migration and the idempotency gate
  (decision 1). `deployGuardrails` stays guardrails-only, so no key is added
  to it.
- UI: a section next to the existing Deploy guardrails card
  (`apps/dokploy/components/dashboard/compose/advanced/deploy-guardrails.tsx`)
  with the service picker and the soft-risk warning text.

Tests (no real docker in CI):

- Eligibility matrix: one case per hard blocker (including `scale`/`replicas`
  > 1, static addresses, a dependent service pointing at the rolled one, and
  a disabled healthcheck), plus a clean service, plus the
  randomize/isolated-deployment renames.
- All services selected: no `up -d --no-deps <others>` line is emitted and no
  `up` line lacks explicit service names.
- No running old container: that service falls back to a plain `up`.
- Old and new containers are told apart by recorded ids: the old id is the one
  stopped and removed, never the highest-numbered container.
- Health timeout validation against `start_period`, `interval` and `retries`.
- Schema: bounds and defaults for the new setting, and that malformed stored
  data resolves to "off".
- Golden: feature off produces the same script as before; the existing
  golden cases do not change.
- Script generation: expected command sequence for one and several services;
  hostile service names and paths are quoted (same style as
  `compose-command-injection.test.ts`); build-server variant uses
  `--no-build`.
- Behaviour with a stub `docker` first on `PATH`, as
  `deploy-guardrails-stall-snapshot.test.ts` does: healthy path, unhealthy
  timeout (new replica removed, old untouched, non-zero exit), leftover
  replica reconciliation, skip when hash and image id both match, and roll
  when the hash is unchanged but the image id changed.
- Service level: the setting is read, and the fall-back-with-warning path when
  a selected service became ineligible.
- Manual, before release: a throwaway compose on a non-customer docker host
  with a probe loop against the public URL during a deploy, confirming zero
  failed requests and measuring the stop race.

Not in the first PR: stack-type changes, blue-green, stateful services, auto-detecting singletons. The Traefik retry middleware is documented as a manual step, not injected (decision 5). Preview deployments are not rolled (decision 8).

## Decisions

The open questions were answered as follows; the first PR follows them.

1. Storage: a new column with a migration. `deployGuardrails` stays for
   guardrails only.
2. Deploy-time drift: fall back to a normal recreate with a clear warning. Drift
   never fails the deploy.
3. Partial failure with several services: earlier services stay on the new
   release and the deploy reports an error. A revert-roll is a later PR.
4. Healthcheck requirement: services without a compose-level healthcheck are
   refused. There is no fixed "wait N seconds" readiness.
5. Traefik retry middleware: not injected in the first PR. The manual step
   (adding a retry middleware to the rolled service's router) is documented.
6. Stack type: a documentation page plus the stack preflight warning. Dokploy
   does not inject `update_config` for stack composes.
7. Before pointing the #374 reporter at (c), stack type is tried on a copy of
   the uNotes compose, off production, to check whether its named volumes carry
   over.
8. Preview deployments: no rolling in the first PR.
9. Cancel or kill mid-rollout: the cancel path also removes the extra replica.
   Reconcile-on-next-deploy stays as the safety net.
