# Host boot ordering: containers on the Traefik network stay down after a reboot

Task T-2620. Investigated 2026-10-16 on `devino-first` (prod Dokploy host). Everything in
this document was gathered read-only. Nothing described under "Proposed fix" has been
installed on any host.

Secrets: none are quoted. Container ids are elided and stack names are generalised because
this repository is public.

---

## 1. Summary

After the host reboot at 07:22Z on 2026-10-16, every standalone container that is attached
to Dokploy's `dokploy-network` and has a restart policy was supposed to come back by
itself. 53 of them did not. They stayed `Exited (255)` until people started them by hand
between 08:22Z and 09:51Z (customer-facing sites were down for about 2 hours). The previous
reboot (2026-10-14) did the same to 40 containers.

It is not a missing network, a systemd ordering problem or a `depends_on` problem. Docker
deliberately postpones such containers until the swarm node is up, then tries to attach
all of them at once. Each attach has a hard 20 second budget. On this host the swarm
manager had been leader for about 9 seconds and was busy with 175 services, so the
attaches timed out. Docker logs the error and never retries a failed start.

Proposed fix: one oneshot systemd unit, `dokploy-boot-recover.service`, ordered after
`docker.service`. It starts exactly the containers Docker itself recorded as "wanted
running, failed to attach in this daemon run". It is idempotent, rate-limited, logged, and
ships in `dry-run` mode first.

---

## 2. Evidence

All times UTC, 2026-10-16, from `journalctl -b -u docker`, `docker inspect` and `systemctl`.

| Time | Event |
|---|---|
| 07:22:02 | Kernel boot (`uptime -s`). |
| 07:22:55 | `enp6s0` gets carrier. 07:23:03 DHCP lease, `network-online.target` reached. |
| 07:23:03 | `dockerd` starts (it is ordered after `network-online.target`). |
| 07:23:06 | Restore phase. Every container that was running before the reboot is marked `Exited (255)` with `FinishedAt` 07:23:06.57 to 07:23:06.65. |
| 07:23:13 to 07:24:10 | 437 `Removing stale sandbox` lines. `Loading containers: done` at 07:24:10 (about 66 s after it started). |
| 07:24:11 | Swarm node starts listening (`control.sock`). |
| 07:24:13 | Single-node raft: follower, candidate, **leader at term 43**, all within one second. |
| 07:24:12 to 07:24:20 | 101 `fatal task error: non-zero exit (255)` lines: the swarm replaces every service task that died with the reboot. 31 harmless `network dokploy-network remove failed: unknown network` lines. |
| 07:24:15 | The agent's first session to the node's advertised address fails with `no route to host`, then falls back to the local manager (see 6.3). |
| 07:24:21 | `dokploy-network` is instantiated locally (`docker network inspect` says `Created 07:24:21.17`). This is the first attach. |
| 07:24:42 to 07:25:33 | **53 x** `failed to start swarm container ... failed to set up container networking: attaching to network failed, make sure your network options are correct and check manager logs: context deadline exceeded`. The first one is 20 s after the network appears. |
| 07:25:44 | `docker.service` becomes `active` (`Type=notify`). It is not ready until the failures above are over. |
| 07:26 to 07:27:41 | `boot-traefik-fix.service` force-updates Traefik, which binds 443. |
| 08:22 to 09:51 | Manual starts. `StartedAt` of the recovered containers falls in this window. |

Facts that narrow the cause:

- All 53 failing containers are plain (non-swarm-task) containers with a restart policy.
  Of the 36 that still exist: `unless-stopped` 31, `on-failure` 4, `always` 1. Every one of
  them has `dokploy-network` in its networks (17 more were removed by redeploys since).
  Swarm service tasks and containers on stack-only bridge networks (databases, redis,
  typesense) restarted fine.
- 83 other standalone containers on `dokploy-network` have a `StartedAt` between 07:22 and
  07:30, so most likely they won the same race. It is a race, not a rule: some attaches
  finished inside the budget and some did not.
- Compose `isolatedDeployment=true` does not protect a stack: the web container still
  joins `dokploy-network` so Traefik can route to it.
- State left behind is machine-readable. A failed container keeps `State.ExitCode=255`,
  `State.FinishedAt` = restore time and `State.Error` =
  `failed to set up container networking: attaching to network failed ...`. Five such
  containers are still down on prod as of this writing.
- Same signature on the previous reboot: 40 failures between 18:05:17 and 18:05:49 on
  2026-10-14 (`dockerd` started 18:03:47).
- Scale: 16 cores, 217 GiB RAM, 175 swarm services, 638 containers (431 running). Userspace
  boot took 6 min 6 s.
- Docker 29.9.0, `live-restore` off, `/etc/docker/daemon.json` has no network settings,
  and no drop-ins exist for `docker.service`. Swarm: 1 node, manager, leader, `Ready`.

---

## 3. Root cause

1. When `dockerd` restores containers it **skips** any container that already has a swarm
   endpoint, because the cluster is not initialised yet. moby, `daemon/daemon.go`,
   `restore()`:

   > "Do not autostart containers which has endpoints in a swarm scope network yet since
   > the cluster is not initialized yet. We will start it after the cluster is initialized."

2. After the swarm node is up, `RestartSwarmContainers()` starts all of them in parallel.
   The error text in our logs is exactly its log line, `failed to start swarm container`.
   `dokploy-network` is a swarm overlay with `attachable=true`, so every attach goes through
   `Cluster.AttachNetwork` (`daemon/cluster/networks.go`). It sends a request to the manager
   and then waits for the manager to hand the network config back through the dispatcher.
   The whole thing is bounded by `swarmRequestTimeout` (20 s, `daemon/cluster/cluster.go`).

3. The message `attaching to network failed, make sure your network options are correct and
   check manager logs` is produced only in the branch where the request was **accepted**
   but the config never arrived in time. So the manager answered; it was too slow.
   (The why-slow part is inference: the manager had been leader for about 9 s and the
   orchestrator was replacing about 100 tasks and allocating 175 services at the same
   moment, while 50+ attaches queued behind that. The journal has no manager-side
   timing to prove it.)

4. A failed `containerStart` is only logged. Docker's restart manager engages only after
   a container has started successfully:

   > "A restart policy only takes effect after a container starts successfully."
   > (Docker docs, "Start containers automatically")

   So the container sits `Exited (255)` with the error in `State.Error`, forever.

5. `RestartSwarmContainers` runs before "Daemon has completed initialization" and before
   `notifyReady()` in `daemon/command/daemon.go`, and `docker.service` is `Type=notify`.
   That matches the log: the last failure is 07:25:33, the unit turns `active` at 07:25:44.
   Any unit ordered `After=docker.service` therefore sees the final, complete set of
   failures.

Upstream knows this class of bug: moby/moby
[#32607](https://github.com/moby/moby/issues/32607), "Containers on an attachable overlay
network fail to restart after dockerd restart", same error text, reported on 17.03, still
open, with reports up to 19.03. No upstream workaround is documented.

What was ruled out:

- systemd ordering. `docker.service` is already `After=network-online.target containerd.service`
  and the failure happens inside `dockerd` 80 seconds after both. No unit can create the
  overlay earlier: it only exists once swarm is up.
- `live-restore`. It covers standalone containers across a daemon restart, not a host
  reboot, and the docs say it "only pertains to standalone containers, and not to Swarm
  services".
- `depends_on`, healthchecks, volumes. The containers never started a process (logs end at
  the pre-reboot line).

---

## 4. Options

| Option | Verdict |
|---|---|
| **a1.** Order units so the network exists before containers start (drop-in on `docker.service`, earlier swarm). | Not viable. The overlay is created by `dockerd` after swarm init, inside the daemon. Docker already postpones those containers until then. The failure is the 20 s attach budget, not the order. |
| **a2.** Replace `dokploy-network` with a non-swarm bridge. | Not viable. Dokploy runs Traefik and all applications as swarm services (175 here), and swarm services can only join swarm-scope networks. A bridge cannot connect Traefik to them. Also a rewrite of Dokploy's network model. |
| **a3.** Make the manager faster or the herd smaller (fewer services, staggered start). | No Docker knob. `swarmRequestTimeout` is a compile-time constant, and `max-concurrent-*` settings only cover image transfers. Reducing the service count is not a fix we control. |
| **a4.** `live-restore: true`. | Does not apply to a host reboot, and does not cover swarm services. |
| **c.** Dokploy-side reconcile on startup (server code uses the compose status in the DB to start what should be running). | Knows user intent precisely, but needs a release and a deploy, only covers Dokploy-managed stacks, and depends on Dokploy itself being up, which is itself one of the things restarting at that moment. Worth revisiting later; not the first fix. |
| **b.** One host-level oneshot after `docker.service` that starts the containers Docker failed to attach. | **Chosen.** Smallest blast radius, no change to Docker or Dokploy, uses state Docker already records, trivially rolled back. |

---

## 5. Proposed fix

One mechanism: `dokploy-boot-recover.service` running `/usr/local/sbin/dokploy-boot-recover`.

### 5.1 Trigger

- `After=docker.service boot-traefik-fix.service`, `BindsTo=docker.service`,
  `WantedBy=docker.service`.
- Any start of `docker.service` pulls the unit in: boot, `systemctl restart docker`, and
  an auto-restart after a crash (`Restart=always`). `BindsTo` marks it inactive when docker
  stops, so the next docker start runs it again. `docker.service` itself is not edited
  (`systemctl enable` only adds a symlink under `docker.service.wants/`).
- `After=boot-traefik-fix.service` keeps the two boot jobs from fighting over the manager.
  It only matters at boot; the existing unit is not changed.

### 5.2 Which containers it starts

All of these must hold, evaluated from `docker inspect` data only:

| Condition | Why |
|---|---|
| `State.Status = exited` | It is down. |
| `HostConfig.RestartPolicy.Name` is `always`, `unless-stopped` or `on-failure` | Docker would have restarted it itself. `no` means the user never asked for that. |
| No `com.docker.swarm.task` label | Swarm service tasks are owned by the swarm orchestrator, which replaces them. |
| `State.Error` matches `attaching to network failed` or `failed to set up container networking` | Docker itself recorded that the start failed on networking. A container stopped by a user, by Dokploy, or that crashed has an empty `State.Error`. |
| `State.FinishedAt` is at or after the start of the running `dockerd` (minus 10 s) | The failure belongs to this daemon run. Old failures from an earlier run are left alone. |

"Failed at boot" versus "stopped by the user": `HasBeenManuallyStopped` is not exposed by
the Docker API, so the script does not rely on it. A clean user stop (`docker stop`,
Dokploy stop, `compose stop`) never writes the networking error, so it can never match.
A dry run of the selector on prod (read-only) returned exactly the 5 containers that are
down with that error and none of the cleanly stopped ones.

Selection uses no names, projects or labels other than the swarm-task label. The Lead Gen
System stacks get exactly the same treatment as every other stack. See 8 for what that
means today.

### 5.3 What it does

1. Wait (up to 300 s) for swarm `active`, `ControlAvailable`, and a node that is
   `Ready Leader`. Then settle 20 s.
2. Select candidates (5.2). In `dry-run` mode, log them and exit 0.
3. In `enforce` mode, `docker start` them in batches of 6 (the original failure was 53 at
   once), each with a 90 s timeout.
4. Up to 4 passes, 45 s apart. A pass also re-queues containers this run started that
   exited again (Docker's restart policy only takes over after 10 s of uptime, so an app
   that dies at second 3 because its database is still starting would otherwise be left
   dead). A container is started at most 4 times per run.
5. Log everything to the journal (`journalctl -t dokploy-boot-recover`), names only. The
   final line is `done: N running after recovery, M still failing`. Exit 3 (the unit shows
   as failed in `systemctl --failed`) if any attach failure is left.
6. Warn about "unclassified" containers: `exit 255`, restart policy set, restored in this
   daemon run, but no networking error. They are not touched. It is the early warning that
   Docker's wording changed or that a different failure mode appeared.

Safety properties: a lock (`flock`) prevents two runs overlapping. A second run finds
nothing, because a started container no longer has `State.Error`. It never creates,
removes, stops or restarts anything that is running, never edits Docker or Dokploy state,
and never prints environment or argv. A `docker start` on a container that Dokploy removed
meanwhile fails harmlessly with "No such container".

### 5.4 Files

`/etc/systemd/system/dokploy-boot-recover.service`

```ini
[Unit]
Description=Start restart-policy containers whose swarm network attach failed at dockerd startup
Documentation=https://github.com/DevinoSolutions/dokploy-community/blob/canary/docs/design/host-boot-network-ordering.md
After=docker.service boot-traefik-fix.service
BindsTo=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=-/etc/default/dokploy-boot-recover
ExecStart=/usr/local/sbin/dokploy-boot-recover
TimeoutStartSec=20min
Nice=10
SyslogIdentifier=dokploy-boot-recover

[Install]
WantedBy=docker.service
```

`/etc/default/dokploy-boot-recover` (ships as `dry-run`; flip to `enforce` after step 4 of
the rollout)

```sh
DOKPLOY_BOOT_RECOVER_MODE=dry-run
```

`/usr/local/sbin/dokploy-boot-recover` (mode 0755, root)

```bash
#!/usr/bin/env bash
# dokploy-boot-recover: after dockerd is up, start the restart-policy containers whose
# swarm-network attach failed during dockerd's own startup (moby RestartSwarmContainers,
# "attaching to network failed ... context deadline exceeded"), because the daemon does
# not retry a failed START. See docs/design/host-boot-network-ordering.md.
#
# Selection is by what Docker recorded, never by name or stack:
#   exited + restart policy != no + not a swarm task + State.Error is the attach failure
#   + the failure happened in the current dockerd run.
# A container a user stopped has an empty State.Error and is never selected.
set -u

LOG_TAG=dokploy-boot-recover
MODE=${DOKPLOY_BOOT_RECOVER_MODE:-dry-run}                # dry-run | enforce
READY_TIMEOUT=${DOKPLOY_BOOT_RECOVER_READY_TIMEOUT:-300} # s to wait for swarm leader
SETTLE=${DOKPLOY_BOOT_RECOVER_SETTLE:-20}                 # s pause once swarm is ready
MAX_PASSES=${DOKPLOY_BOOT_RECOVER_MAX_PASSES:-4}
PASS_PAUSE=${DOKPLOY_BOOT_RECOVER_PASS_PAUSE:-45}
BATCH=${DOKPLOY_BOOT_RECOVER_BATCH:-6}                    # parallel docker start
START_TIMEOUT=${DOKPLOY_BOOT_RECOVER_START_TIMEOUT:-90}   # s per docker start
MARKER='attaching to network failed|failed to set up container networking'

log() { logger -t "$LOG_TAG" -p "${2:-user.info}" -- "$1"; echo "$1"; }

LOCK=${DOKPLOY_BOOT_RECOVER_LOCK:-/run/dokploy-boot-recover.lock}
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock, exiting"; exit 0; }

swarm_ready() {
  [ "$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null)" = "active true" ] &&
    docker node ls --format '{{.Status}} {{.ManagerStatus}}' 2>/dev/null | grep -qx 'Ready Leader'
}

# Epoch seconds at which the running dockerd was started.
daemon_start_epoch() {
  local ts
  ts=$(systemctl show docker -p ExecMainStartTimestamp --value 2>/dev/null)
  [ -n "$ts" ] && date -d "$ts" +%s 2>/dev/null
}

# Print "id|name|finishedAt" for every container the daemon wanted running but failed to attach.
candidates() {
  docker ps -aq --no-trunc --filter status=exited 2>/dev/null | xargs -r docker inspect --format \
    '{{.Id}}|{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.FinishedAt}}|{{index .Config.Labels "com.docker.swarm.task"}}|{{.State.Error}}' 2>/dev/null |
    awk -F'|' -v m="$MARKER" '$3 != "no" && $3 != "" && $5 == "" && $6 ~ m { print $1 "|" substr($2, 2) "|" $4 }'
}

# Same, restricted to failures of the current dockerd run.
current_candidates() {
  local id name fin
  while IFS='|' read -r id name fin; do
    [ -n "$id" ] || continue
    if [ "$(date -d "$fin" +%s 2>/dev/null || echo 0)" -ge $((DSTART - 10)) ]; then
      echo "$id|$name"
    fi
  done < <(candidates)
}

# Containers that exited 255 at restore, with a restart policy, but not by the attach failure.
log_unclassified() {
  docker ps -aq --no-trunc --filter status=exited 2>/dev/null | xargs -r docker inspect --format \
    '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.ExitCode}}|{{.State.FinishedAt}}|{{index .Config.Labels "com.docker.swarm.task"}}|{{.State.Error}}' 2>/dev/null |
    awk -F'|' -v m="$MARKER" '$2 != "no" && $2 != "" && $3 == 255 && $5 == "" && $6 !~ m { print substr($1, 2) "|" $4 }' |
    while IFS='|' read -r name fin; do
      if [ "$(date -d "$fin" +%s 2>/dev/null || echo 0)" -ge $((DSTART - 10)) ]; then
        log "UNCLASSIFIED exit-255 restart-policy container (not touched): $name" user.warning
      fi
    done
}

start_one() { # id name
  local out
  if out=$(timeout "$START_TIMEOUT" docker start "$1" 2>&1); then
    log "started $2"
  else
    log "start failed $2: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)" user.warning
    return 1
  fi
}

waited=0
until swarm_ready; do
  [ "$waited" -ge "$READY_TIMEOUT" ] && { log "swarm not ready after ${READY_TIMEOUT}s, giving up" user.err; exit 2; }
  sleep 5; waited=$((waited + 5))
done
DSTART=$(daemon_start_epoch)
[ -n "$DSTART" ] || { log "cannot determine dockerd start time, giving up" user.err; exit 2; }
sleep "$SETTLE"
log "swarm ready, mode=$MODE, dockerd started $(date -u -d "@$DSTART" +%FT%TZ)"

declare -A attempts=() # id -> start attempts this run
declare -A names=()
recovered=0
pass=1
while [ "$pass" -le "$MAX_PASSES" ]; do
  # Attach failures, plus anything this run already started that exited again before the
  # daemon's restart policy could take over (it only engages after 10 s of uptime).
  todo=$(
    current_candidates
    for id in "${!attempts[@]}"; do
      case "$(docker inspect --format '{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}' "$id" 2>/dev/null)" in
        'exited|always' | 'exited|unless-stopped' | 'exited|on-failure') echo "$id|${names[$id]}" ;;
      esac
    done
  )
  todo=$(printf '%s\n' "$todo" | sed '/^$/d' | sort -u)
  count=$(printf '%s\n' "$todo" | sed '/^$/d' | wc -l)
  [ "$count" -gt 0 ] || { log "pass $pass: nothing to do"; break; }
  log "pass $pass: $count candidate(s)"

  if [ "$MODE" != "enforce" ]; then
    printf '%s\n' "$todo" | while IFS='|' read -r id name; do log "DRY-RUN would start $name"; done
    log_unclassified
    exit 0
  fi

  running=0
  while IFS='|' read -r id name; do
    [ -n "$id" ] || continue
    if [ "${attempts[$id]:-0}" -ge "$MAX_PASSES" ]; then continue; fi
    attempts[$id]=$(( ${attempts[$id]:-0} + 1 )); names[$id]=$name
    start_one "$id" "$name" &
    running=$((running + 1))
    if [ "$running" -ge "$BATCH" ]; then wait; running=0; fi
  done <<< "$todo"
  wait
  pass=$((pass + 1))
  [ "$pass" -le "$MAX_PASSES" ] && sleep "$PASS_PAUSE"
done

remaining=$(current_candidates | wc -l)
for id in "${!attempts[@]}"; do
  [ "$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null)" = running ] && recovered=$((recovered + 1))
done
log_unclassified
if [ "$remaining" -gt 0 ]; then
  log "done: $recovered running after recovery, $remaining still failing" user.err
  exit 3
fi
log "done: $recovered running after recovery, 0 still failing"
exit 0
```

---

## 6. Rollout, rollback, testing

### 6.1 Rollout

1. Review and merge this document. (Merging is separate from installing.)
2. Install the three files on `devino-first`. `systemctl daemon-reload` and
   `systemctl enable dokploy-boot-recover.service`. Do **not** start it yet. No restart of
   Docker or Dokploy is involved, and the deploy queue is not touched.
3. Prove the selector on the live host, no side effects: `systemctl start
   dokploy-boot-recover.service` in `dry-run`. Expected: `DRY-RUN would start` lines for
   exactly the containers currently down with the networking error (5 as of 2026-10-16),
   nothing started. Compare with `docker ps -a --filter status=exited`.
4. Leave it in `dry-run` through the next reboot or Docker restart. After it, compare
   its `DRY-RUN` list with the ground truth from the Docker log
   (`journalctl -b -u docker | grep "failed to start swarm container"`, same containers).
5. Set `DOKPLOY_BOOT_RECOVER_MODE=enforce` in `/etc/default/dokploy-boot-recover`.
   No reload needed, the file is read on each start.
6. At the next reboot confirm the success criteria in 6.5.

### 6.2 Rollback

`systemctl disable --now dokploy-boot-recover.service`, then remove the three files and
`systemctl daemon-reload`. Instant neutralisation without touching systemd: set the mode
back to `dry-run`. Rolling back returns the host to today's behaviour (manual recovery).
The unit changes no Docker or Dokploy configuration, so nothing else needs undoing.

### 6.3 Related finding, not part of this fix

The swarm node's advertised address is a LAN address (`.180`) that no longer exists on the
host: the current addresses are `.16` (wired) and `.93` (Wi-Fi), and neighbour lookup for
`.180` fails. At boot the agent's first session dials the stale address (`no route to
host`, 07:24:15) and falls back to the local manager. It is unlikely to be the main cause
(it cost less than a second), but it is a latent hazard: a DHCP-assigned advertise address
on a workstation host. Suggest a separate task to pin it to a stable address in a quiet
window.

### 6.4 Testing without rebooting prod

Done:

- **T1, selector on the live host (read-only).** The exact `docker inspect` + `awk` filter
  from `candidates()` was run against prod. It selected 5 containers, matching the 5 that
  are `Exited (255)` with the networking error, and none of the cleanly stopped or
  one-shot (exit 0) containers.
- **T2, script logic against a stub `docker` (local, no host touched).** 12 fixture
  containers. Dry run listed 6 and started none. Enforce started all 6 (one needed a
  third attempt because it failed twice, one needed a second start because it died
  immediately). It left alone: a container stopped before boot, one stopped after boot,
  an old failure from an earlier daemon run, a swarm task, a `no`-policy container, and an
  `exit 255` container without the networking error (logged as `UNCLASSIFIED`). A third run
  found nothing to do. Also run: `bash -n` on the script.

Not done (needs a host, and the brief said not to apply anything anywhere):

- **T3, real Docker.** On `devino-second`, inside a throwaway privileged docker-in-docker
  container with its own `dockerd` and swarm (so the host daemon is never touched):
  `swarm init`, an attachable overlay, about 30 `--restart unless-stopped` containers,
  then restart the inner daemon under load (many dummy services, low `--cpus`) until the
  20 s attach timeout reproduces. If it will not reproduce, stop the inner daemon, edit the
  containers' `config.v2.json` to the failed shape (`ExitCode 255`, the `State.Error`
  text, `HasBeenManuallyStopped: true` so Docker will not restart them itself), start the
  inner daemon and run the script in `enforce`. Remove the sandbox afterwards.
- **T4, first real event.** See 6.5.

### 6.5 Success criteria at the next reboot or Docker restart

- `journalctl -t dokploy-boot-recover -b` shows `done: N running after recovery, 0 still failing`.
- N matches the `failed to start swarm container` count in `journalctl -b -u docker`
  (minus containers removed since).
- `docker ps -a --filter status=exited` shows no restart-policy container with the
  networking error.
- Time from `docker.service` active to the last container running is under 5 minutes.
- Zero `UNCLASSIFIED` lines.

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Starts a container a user meant to keep stopped. | Very low. A clean stop never leaves the networking error. The remaining case is a user stopping a stack through Dokploy in the few minutes between the daemon's failure and this unit's first pass, since stopping an already-exited container does not clear its error. Dokploy is itself restarting then. | Runs about 20 s after Docker is ready. `dry-run` first. The pass logs every name it touches. |
| Start storm re-overloads the manager. | Low. | Batches of 6 versus 53 at once, passes 45 s apart, `Nice=10`, 4 attempts max per container. |
| Dependency order (an app starts before its DB). | Medium, harmless. | Re-queue of containers that died inside Docker's 10 s grace window. Databases on stack-only networks come back by themselves before this unit runs. |
| Docker changes the error wording on upgrade. Recovery silently stops. | Medium over time. | The pattern is two phrases. The `UNCLASSIFIED` warning fires when containers exit 255 at restore without it. Check after every Docker upgrade. |
| Unit fails at boot (swarm never ready). | Low. | Gives up after 300 s with exit 2, logs at `err`, blocks nothing. Nothing is `After=` it. |
| A start fails with a legitimate non-network error (bad mount, missing image). | Possible. | Logged by name with the Docker error and retried at most 4 times. |
| Applies to Lead Gen System containers like any other. | Certain, by design. | See 8. |
| Root cause remains: attaches still time out. | Certain. | This fix removes the outage, not the timeout. Long term options are in 4 (c) and 6.3. |

---

## 8. Decisions needed

- **Lead Gen System.** The mechanism has no per-stack logic, as required. Two Lead Gen
  containers are among the 5 down right now with the networking error. Enabling this unit
  means they would be started after a boot exactly as Docker's own restart policy would
  have started them. If the standing "never touch Lead Gen" rule should also forbid that,
  say so before moving from `dry-run` to `enforce`.
- Whether to move from `dry-run` to `enforce` after step 4, or straight after step 3.
- Whether to open a task for the stale swarm advertise address (6.3).
- Whether to report this upstream. The standing rule is not to post upstream, so the
  answer is no unless Amin says otherwise.

---

## 9. References

- moby `daemon/daemon.go`: comment in `restore()` and `RestartSwarmContainers()`
  (<https://github.com/moby/moby/blob/master/daemon/daemon.go>)
- moby `daemon/command/daemon.go`: `RestartSwarmContainers` is called before
  "Daemon has completed initialization" and `notifyReady()`
- moby `daemon/cluster/networks.go` `AttachNetwork`, and `daemon/cluster/cluster.go`
  `swarmRequestTimeout = 20 * time.Second` (read from `master` on 2026-10-16; the
  installed 29.9.0 behaves identically in the logs)
- Docker docs, "Start containers automatically":
  <https://docs.docker.com/engine/containers/start-containers-automatically/>
- Docker docs, "Live restore": <https://docs.docker.com/engine/daemon/live-restore/>
- moby/moby #32607: <https://github.com/moby/moby/issues/32607>
- Existing host unit for context: `/etc/systemd/system/boot-traefik-fix.service`
  (Traefik/Tailscale port 443 ordering on boot)

## Appendix: read-only commands used

`journalctl -b -u docker` (counts and first/last timestamps by normalised message),
`journalctl -b -u docker -u containerd`, `systemctl cat/show docker`,
`systemctl show docker -p ExecMainStartTimestamp`, `docker info --format` (swarm fields),
`docker node ls --format`, `docker network ls/inspect --format` (driver, scope, attachable,
created), `docker inspect --format` with State, HostConfig.RestartPolicy, network names and
one label (never `Config.Env` or `Config.Cmd`), `ip route get`, `ip neigh`, `ss -tlnH`,
`journalctl --list-boots`.
