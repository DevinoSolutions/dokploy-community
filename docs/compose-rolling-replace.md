# Rolling replace for compose services

Opt-in, per service. Off by default. Background and the options that were
weighed: [docs/design/compose-zero-downtime.md](design/compose-zero-downtime.md)
(issue #374, item 4).

## The problem

A plain `docker compose up -d` redeploy stops the old container, removes it,
and only then starts the new one. For a changed service there is a window with
no backend, as short as a few seconds or as long as the removal takes (135 s in
#374). Traefik drops the old container on its `die` event, so the router has
nothing to send traffic to until the new container is running and healthy.

## What rolling replace does

For each service you select, instead of stop-then-start:

1. Build or pull the new image first. Nothing running is touched.
2. Record the container ids of the service, then start a second replica from
   the new release (`up -d --no-deps --no-recreate --scale <svc>=2 <svc>`).
3. Wait until the new replica is healthy, up to the health timeout.
4. Wait the drain delay, then stop and remove the old container by id.

If the new replica never becomes healthy, it is removed and the old container,
which was never touched, keeps serving. Services you did not select are
deployed as before (`up -d --no-deps <others>`), and a final
`up -d --no-recreate --remove-orphans` over `docker compose config --services`
reconciles orphans and stopped services.

A service is skipped (left running, not replaced) only when both hold: its
`com.docker.compose.config-hash` label equals `docker compose config --hash
<svc>`, and its container's image id is one of the ids of the images the
service resolves to after the build or pull. A web-only change does not roll
the other selected services.

## Turning it on

Compose service, Advanced tab, **Rolling replace** card (next to Deploy
guardrails):

- **Enable**, then pick the services to roll. The list shows, per service,
  whether it is eligible and why not. Pick services explicitly: there is no
  "all". Databases and other stateful services never belong here.
- **Health timeout** (10 to 900 s, default 120): how long the new replica has
  to report healthy. If a selected service's healthcheck needs longer than
  that (`start_period + retries x (interval + timeout)`, a failing probe runs
  up to its `timeout` before the next one starts; the Compose defaults are 30 s
  each, so 180 s with only a `test`), the wait is raised to cover it at deploy
  time, up to the 900 s maximum.
- **Drain delay** (0 to 120 s, default 5): the wait between "new replica
  healthy" and "stop the old container". It does not make the old container
  unroutable (see "The stop window" below).

Only `docker-compose` type composes, without a custom command and not on a
fresh-volumes deploy. Compose previews never roll.

## Which services are eligible

A service is refused (on save, and again at every deploy) when any of these
hold:

| Condition | Why |
| --- | --- |
| `container_name` is set | Compose cannot scale it to two |
| a host port is published (`ports: "8080:80"`) | the second replica could not bind it. `expose:` and Traefik-only access are fine |
| `network_mode: host`, `service:x` or `container:x` | shared network namespace |
| `scale` or `deploy.replicas` is not 1 | `--scale` would conflict |
| static `ipv4_address`, `ipv6_address` or `mac_address` | the second replica cannot take it |
| another service uses `network_mode` / `pid` / `ipc: service:<svc>` or `volumes_from: <svc>` on it | replacing it breaks the dependent |
| no compose-level `healthcheck`, `healthcheck.disable: true` or `test: ["NONE"]` | no readiness signal. An image-level `HEALTHCHECK` is not visible to Dokploy, so put the healthcheck in the compose file |
| the image looks like a datastore (postgres, mysql, mariadb, mongo, redis, valkey, rabbitmq, kafka, ...) | stateful services keep the plain recreate. This is only a guard; the explicit selection is the real control |
| the healthcheck cannot settle within 900 s (`start_period + retries x (interval + timeout)`) | the replica would be judged before Docker has finished judging it |

Things Dokploy cannot see, so you decide before selecting a service:

- **Singleton workers** (queue consumers, cron runners): two copies run during
  the overlap.
- **Migrations at container start**: the new version migrates while the old one
  still serves, so migrations must be backward compatible.
- **Exclusive-lock volumes** (SQLite and other embedded stores): two containers
  mount the same volume briefly.
- **Exclusive devices and resource limits** (GPU, `devices:`) are doubled during
  the overlap.
- Container-to-container traffic by service name reaches both replicas for the
  length of the overlap (Docker DNS ignores health outside swarm).
- Exec, terminal and backup actions pick the first running container, which can
  be either replica for a few seconds.
- **Anything only visible after Compose renders the file.** Eligibility is read
  from the compose file as Dokploy sees it, without variable interpolation,
  `extends`, `include`, profiles or `.env` values. A `ports`,
  `container_name` or `scale` that only appears after those are applied is
  not detected. It fails safe: a second replica that cannot bind its port or
  take its name makes the `up` fail, the new replica is removed and the old
  container keeps serving.

## When the compose changes after you selected a service (drift)

At every deploy each selected service is checked again against the compose that
is about to run. A service that is no longer eligible, or no longer exists, is
recreated normally with a clear line in the deploy log naming the reason. The
deploy is never failed because of drift.

## Failure, partial failure, cancel

- **New replica not healthy in time:** it is removed, the old container keeps
  serving, the deployment is marked as an error and the usual failure
  notification is sent. When no service had been replaced yet, the regular
  restore of the previous release applies as before. That restore recreates
  every service of the compose, so services that are not rolled and were
  already updated by this deploy go back to the previous release with a normal
  stop-first recreate (a short downtime for them).
- **The old container cannot be removed** after the new replica is healthy: the
  service fails, the new replica keeps serving, the old container is left
  stopped, and no `docker compose up` runs for it (Compose would scale back to
  one container and keep the lowest-numbered, i.e. old, one). The next deploy
  reconciles it. If the leftover still cannot be removed then, the deploy fails
  again for that service before any `docker compose up` runs, so a stuck old
  container can never swap the service back to the old release; remove it by
  hand (`docker rm -f <id>`).
- **Several selected services:** services already replaced stay on the new
  release and the deployment reports an error. There is no revert-roll and no
  automatic restore once a service has been replaced.
- **Cancel mid-rollout** (`compose.killBuild` or `deployment.killProcess`):
  the new replica that was not promoted yet is removed at once with
  `docker rm -f`, and the old container keeps serving. Limits:
  - The deploy script runs on the serving host (the Dokploy host when the
    compose has no server), whether or not the compose uses a build server.
    When it contains a rolling replace it is started in its own session with a
    pid file there, and a cancel signals it on that host: SIGTERM, so the trap
    removes the replica, then SIGKILL after 20 s. With a build server the
    cancel first looks at the build server and signals the serving host when
    there is nothing to kill there. The log says the release step was
    stopped; services that were already replaced stay on the new release.
  - A compose without a build server that has a rolling replace is
    cancelled through its deployment row, whatever step it is in. While the
    rolling script is running it is signalled as above. In the steps before it
    (fetching the source, applying patches, the required-checks wait) there is
    no release step to signal, so the cancel marks the deployment cancelled and
    the deploy stops at the next step boundary: a step already in progress
    (for example a clone) is let finish, then nothing more is fetched, pulled
    or started and the previous release keeps serving. The deploy checks the
    cancel before each of its steps, the last time right before the plain `up`.
    A fresh-volumes deploy is checked right before its `down --volumes` and
    not again after it: once the stack is down the `up` runs, and a cancel
    that lands then is reported as arriving too late.
  - The required-checks wait polls the cancel flag at the same cadence as it
    polls GitHub. A cancel during it ends the wait at the next poll instead of
    holding the queue slot until the checks conclude or time out, restores the
    previous release's files like the cancel above, and reports no error and no
    failed-gate audit entry. The flag is only ever set for a compose that a
    cancel claims through its deployment row: one with a rolling replace, or one
    that builds on a build server. A plain compose (no rolling replace, no build
    server) keeps the generic stop and is not claimed by a UI cancel, so for it
    the poll finds nothing, unless rolling was switched on after the deploy
    started.
  - A deploy loads the compose when it starts, and a cancel reads it again when
    it is pressed, so rolling can have been switched on in between. The closing
    `done` of a compose deploy therefore never overwrites a deployment that was
    cancelled meanwhile, whichever of the two saw the rolling setting: the row
    stays cancelled and the log says the cancel arrived too late. A failure
    after a cancel still ends as an error.
  - The step that was let finish already replaced the compose file and `.env`
    on disk, and Start runs `up -d` from them. So a cancel before the release
    step puts the previous release's files back (the same restore a failed
    deploy does, which also confirms the previous release is still up). A
    first deploy has no previous release: the log says "No previous release to
    restore, leaving the stack as-is", the new files stay and nothing is
    running. A fresh-volumes deploy is not restored (its restore is not
    transactional). If the restore itself fails, the deployment ends as an
    error saying the files may still be the new ones.
  - A script without a rolling replace (a plain `up`) is not started through
    the launcher. With a build server it runs to completion, like a cancel
    that arrives too late. Without one it keeps the generic stop, described
    below.
  - The `up` of the services that are not rolled, and the final `up`, are
    never cut short: a cancel waits for the step that is running (up to the
    20 s grace), then the script stops before the next one. The job ends only
    after the script has cleaned up.
  - Once the script has finished its cleanup, helpers still running in its
    group (the `docker events` capture, the stall snapshot) are killed with
    SIGKILL a second later, so a helper that ignores SIGTERM does not outlive
    the cancel.
  - If the replica removal does not finish within 20 s of the cancel, the
    script is killed. The deployment log and the deployment's error message
    then say so: a replica it had not promoted may be left over (the next
    deploy reconciles it) and a `docker compose` step it had started may still
    be running on its own, because that step is not signalled.
  - A compose that does **not** roll keeps the generic stop. `compose.killBuild`
    runs `pkill -2 -f "docker compose"` on the serving host, which sends
    SIGINT to every process whose command line contains `docker compose`.
    `deployment.killProcess` on such a compose sends `kill -9` to the recorded
    pid. A rolling replace no longer uses either one, because they match by
    command line or pid and ignore the session shield around its `up` steps:
    a service that is mid-recreate could be interrupted, and `kill -9` cannot
    be caught, so it could leave two containers until the next deploy
    reconciles them.
- **Interrupted deploys can leave two containers.** The next deploy finds more
  than one container for a selected service and reconciles first: it keeps the
  newest healthy one, removes the rest, and goes on.

## The stop window: add a Traefik retry middleware yourself

Traefik removes the old backend only on the container's `die` event, so for the
whole stop grace period it still sends requests to an app that is shutting
down. The new replica being healthy does not cover that window, and neither
does the drain delay. Dokploy does **not** inject any Traefik middleware for
this. The mitigation is a retry middleware that you add once, manually:

1. Create a file in the Traefik dynamic configuration directory on the host
   (`/etc/dokploy/traefik/dynamic/rolling-retry.yml`):

   ```yaml
   http:
     middlewares:
       rolling-retry:
         retry:
           attempts: 3
           initialInterval: 100ms
   ```

2. In the service's **Domains** settings, add `rolling-retry@file` to the
   domain's custom middlewares.

A retry covers connection errors and short blips. It does not cover a long
outage and, by default, it does not retry non-idempotent methods. Check the
retry options for the Traefik version you run (this fork pins
`TRAEFIK_VERSION` in `packages/server/src/setup/traefik-setup.ts`) before
relying on more than `attempts` and `initialInterval`.

## Swarm stacks (`composeType: "stack"`)

Rolling replace does not apply to stacks, and Dokploy never injects
`update_config` into one. Swarm already has the mechanism: a stack is
healthcheck-gated and rolls back by itself when the compose says so:

```yaml
services:
  web:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 20s
    deploy:
      update_config:
        order: start-first
        failure_action: rollback
```

Both parts matter: without a healthcheck the new task counts as ready as soon
as it runs, and without `order: start-first` swarm stops the old task first. The
Rolling replace card shows a warning for a stack service that has no healthcheck,
no `start-first` update config, or a published port that binds a host address.

Moving an existing compose to stack type is not a no-op. Try it on a throwaway
copy first. What a trial run (a real compose copied to a stack) showed:

- **Volumes carry over.** Volume names are the same in both modes
  (`<appName>_<volume>`), so the data is still there. Volumes are node-local.
- **Things `docker stack deploy` rejects:** `depends_on` with conditions,
  `cpus`, build secrets that use `environment:`, and a top-level `name:`.
  `build:` and `restart:` are ignored, and so is `container_name`.
- **External networks.** An external bridge network (local scope) has to be
  recreated as an overlay network with `--attachable`.
- **Host-IP port bindings are dropped.** Swarm ingress ignores the address in
  `127.0.0.1:54005:5432` and listens on `0.0.0.0`. That is a security
  regression unless a firewall covers the port, which is why the card warns
  about it.
- **`start-first` needs a healthcheck whose `start_period` covers boot time.**
  In the trial, `start-first` without a healthcheck failed 53 of 117 requests
  during the update, `start-first` with a healthcheck failed none of 212, and
  `stop-first` failed 128 of 252.
- **Keep stateful services `stop-first`** (postgres, redis, ...).
  `start-first` briefly runs two tasks on one volume.
- **No transactional rollback.** A stack deploy skips the restore of the
  previous release and the pre-done health check that compose deploys have;
  swarm's own `failure_action: rollback` is the only safety net.

## Known limits

- The stop-grace window (above) is covered only by the manual retry middleware.
- A deploy that is `kill -9`ed leaves two containers until the next deploy
  reconciles them.
- Compose previews, stacks, custom commands, fresh-volumes deploys and stateful
  services are out of scope.
- The skip check compares against every image the service resolves to, which can
  include the images of services it `depends_on`. A false "changed" only costs a
  roll; a missed change is not possible unless a dependency's current image id
  equals the running service's stale image id.
