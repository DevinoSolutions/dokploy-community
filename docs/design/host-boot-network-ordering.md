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
ships in `dry-run` mode first. Lead Gen stacks are excluded by default (5.7), and it checks
that a recovered container is still reachable by its service name and logs it when it is
not (5.8). Repairing a lost alias is a separate switch, off by default.

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
  `failed to set up container networking: attaching to network failed ...`. Most of the 53
  were started by hand before 10:30Z; at the last manual dry-run (6.4, about 11:40Z) three
  were still down: one ordinary stack and two Lead Gen stacks.
- **A plain start can lose the DNS aliases.** One recovered database container (a compose
  `root_db` service) was started with a plain compose start at about 10:29Z. It was `Up` and
  healthy, but its `dokploy-network` endpoint had no aliases (the service name `root_db`
  was not resolvable), so the application crash-looped on `getaddrinfo EAI_AGAIN root_db`
  until someone ran `docker network disconnect` and `connect --alias <service> --alias
  <container name>`. Read-only checks afterwards (aliases and DNSNames only):
  the repaired container now lists `Aliases=[<service> <container name>]` and
  `DNSNames=[<container name> <service> <short id>]`; the containers that are still down
  keep their stored aliases (`Aliases=[<container name> <service>]`), so the aliases are
  lost during the start, not before it. It is not universal: another recovered container
  on the same overlay, started by hand at 10:28, kept both aliases. So it has to be checked
  per container, not assumed. The daemon journal has one line at 10:29:29 for the repaired
  container, `error detaching from network ... could not find network attachment for
  container <id> to network dokploy-network`, which looks like a swarm attachment
  bookkeeping mismatch. The cause is **not proven**: it was not reproduced, and the moby
  code read (`allocateNetwork`, `connectToNetwork`, `buildEndpointDNSNames`) rebuilds
  `DNSNames` from the endpoint's `Aliases` on every start, so any loss happens on the
  swarm attach path (`findAndAttachNetwork`) or in the manager's answer, which we cannot see.
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

Open question, not part of the root cause above: why a start can come back without the
endpoint aliases (see Evidence). The fix does not depend on the answer; it verifies the
result of every start (5.8).

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
| **a3.** Lower the burst: make Docker attach fewer containers at a time (or stagger them), so each attach finishes inside the 20 s budget. | Not available. `RestartSwarmContainers` limits its parallelism with `adjustParallelLimit(len(containers), 128*runtime.NumCPU())` (moby `daemon/daemon.go`). That is 128 x 16 cores = 2048 on this host, so all 53 run at once, and there is no `daemon.json` key or flag for it (the only `max-concurrent-*` keys are image downloads and uploads). `swarmRequestTimeout` is also a constant. The source comment says the multiplier was benchmarked and should not be changed, so a patched or self-built `dockerd` is not something to take on. Even if a knob existed, it would only make the race less likely, not remove it: any attach that still exceeds 20 s would be lost the same way. Our recovery handles every failure, whatever the cause. Reducing the number of services on the host is not a fix we control. |
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
- `After=boot-traefik-fix.service` keeps the two boot jobs from loading the swarm manager at
  the same time (about two minutes of delay at boot). It is ordering only, not a dependency,
  and the existing unit is not changed. See 6.6 for what that unit is.

### 5.2 Which containers it starts

The container ids come from **dockerd's own journal for the current daemon run**, not from a
guess about state. The run is selected by the systemd invocation id of `docker.service`
(`systemctl show docker -p InvocationID --value`, then `journalctl
_SYSTEMD_INVOCATION_ID=<id>`), not by a timestamp, so a wall-clock step or two daemon runs in
the same second cannot be mixed up. Every line `failed to start swarm container ...
container=<id>` in that invocation names a container Docker tried to start after the swarm
came up and failed. Each of those ids is then inspected, and started only if all of these
hold:

| Condition | Why |
|---|---|
| `State.Status = exited` | It is still down. If it is running again (Dokploy, a person or Docker started it) it is left alone. |
| `HostConfig.RestartPolicy.Name` is `always`, `unless-stopped` or `on-failure` | Docker would have restarted it itself. |
| No `com.docker.swarm.task.id` label | Swarm service tasks are owned by the swarm orchestrator. (`com.docker.swarm.task` is present but empty on every task on this host, so it cannot be used.) |
| `State.Error` is not empty | A start failure is recorded there. If it is empty, the container has been started or stopped since the failure, so it is skipped and logged. |
| Not on the exclusion list (5.7) | Lead Gen is excluded by default. |

What this avoids:

- `FinishedAt` is not used. A failed start only sets `State.Error` (it does not touch
  `FinishedAt`), and a graceful `docker restart` stamps `FinishedAt` at shutdown, so it is not
  a reliable marker of "failed in this run". The journal is the ground truth.
- One-shot containers that exited 0 and containers stopped by a user have no such line in
  this run, so they are never candidates.
- A stale `State.Error` (it survives a later manual stop, and stopping an already-exited
  container sets no manual-stop flag) could make an old failure look current. The journal
  limits candidates to this run, and **enforce refuses to run when dockerd is older than 15
  minutes** (`DOKPLOY_BOOT_RECOVER_MAX_AGE`, 900 s, exit 4). The age is computed on the
  monotonic clock (`ExecMainStartTimestampMonotonic` against `/proc/uptime`), so an NTP or DHCP
  time step cannot make an old daemon look young. A manual `systemctl restart`
  of the unit hours after boot therefore cannot resurrect stopped containers. A dry-run has
  no such limit, so it can be used at any time.
- If a container is listed in the journal but its `State.Error` text changed wording in a
  Docker upgrade, nothing breaks: the test is "not empty", not a phrase match.

### 5.3 What it does

1. Wait (up to 300 s) for swarm `active`, `ControlAvailable` and a node that is `Ready
   Leader` (`docker info` and `docker node ls` run under `timeout 30`). Settle 20 s.
2. In `enforce` mode, refuse if dockerd is older than 15 minutes (5.2).
3. Select candidates (5.2) and drop the excluded ones (5.7, each logged as `EXCLUDED
   (lead-gen) <name>`). In `dry-run` mode, log the rest, each with the DNS names it would
   verify (5.8), and exit 0.
4. In `enforce` mode, for each candidate record its expected DNS names, `docker start` it
   (batches of 6, each with a 90 s timeout), then verify the names (5.8). A missing name is
   logged; it is repaired only if alias repair is switched on.
5. A `docker start` that fails is tried again in the next pass (passes are 45 s apart, a
   container is started at most 4 times per run). If every start in a pass succeeded the
   script stops there: no further pause and no extra pass. There is no other re-queue: once a start
   succeeds, Docker's own restart policy takes over. (An earlier draft re-started anything
   that had exited again. That was wrong: it re-ran one-shot containers that exit 0, and
   Docker's restart manager only uses the 10 s of uptime to reset its backoff, it does not
   stop restarting before that.)
6. Everything is logged once to the journal through stdout (`journalctl -t
   dokploy-boot-recover`; priorities are set with `<N>` prefixes, there is no second
   `logger` copy). Names only. The final line is `done: N running after recovery, M still
   failing to start, alias problems: yes/no`. Exit 3 if any start failed or any alias is
   missing (or its repair failed), exit 4 for the age refusal, exit 2 if swarm never became
   ready, the invocation id is unknown or the age cannot be read.

Safety properties: a lock (`flock`) prevents two runs overlapping. It never creates, removes,
stops or restarts anything that is running, never edits Docker or Dokploy state (the only
exception, and only when alias repair is switched on, is reconnecting a container's network
to restore aliases, see 5.8), and never prints environment or argv. A `docker start` on a container that Dokploy removed meanwhile fails harmlessly.

### 5.4 Behaviour on a plain `systemctl restart docker`

The unit is not boot-only. With `live-restore` off, restarting the daemon stops every
container and then runs the same restore path as a reboot (restore, skip swarm-endpoint
containers, swarm init, `RestartSwarmContainers`), so the same attach race can happen.

- `systemctl restart docker` is a restart of a unit that `dokploy-boot-recover.service`
  has `BindsTo=` and `After=`. systemd stops our unit first (if the script is mid-run it
  is terminated with the rest of its cgroup, and the lock is released) and starts it again
  after `docker.service` is active, because of `WantedBy=docker.service`. The same happens
  for `systemctl stop docker` followed by `start`, and for a crash restart (`Restart=always`).
  This is documented systemd behaviour for `BindsTo`/`Requires`; it has not been exercised
  on the host. Step 4 of the rollout checks it at the first real Docker restart or reboot,
  in `dry-run`.
- The script reads the invocation id of the running `docker.service` and only looks at that
  invocation's journal lines, so after a restart it only considers failures from the new
  daemon run. Leftovers from an earlier run are ignored.
- Nothing about the selection changes: containers stopped before the restart have no
  failure line in the new run, and containers Docker restores without trouble are
  `running`, so neither is a candidate.
- Idempotent: running it twice, or once per restart, is safe; a started container is no
  longer `exited`, and a container that was started and stopped again has an empty
  `State.Error` or is skipped.
- A manual `systemctl restart dokploy-boot-recover` is safe in `dry-run` at any time, and
  refused in `enforce` once dockerd is older than 15 minutes (5.2). Restarting Docker on prod
  is still governed by the existing rule that nothing restarts Dokploy while the deploy queue
  has jobs; this unit neither changes nor bypasses that.

### 5.5 Dry run first

The script's mode is `dry-run` unless `DOKPLOY_BOOT_RECOVER_MODE` is exactly `enforce`.
A missing, empty or mistyped environment file therefore also gives a dry run. In
`dry-run` the script waits for swarm, selects candidates, logs one `DRY-RUN would start
<name>; would verify DNS names: <network>|<name>,<name> ...` line per container (the post-check
of 5.8 that would run after the start), plus `EXCLUDED` and `SKIP` lines, and exits 0
without running any `docker start`, `network disconnect` or `network connect`. The
files install in `dry-run`, and the first run after approval is a dry run (rollout steps 3
and 4). Moving to `enforce` is a separate, explicit edit.

### 5.6 Pause and retry: included

- **Pause.** The unit waits for `Ready Leader`, then sleeps 20 s. On this host it would
  start after `docker.service` is active, which in the incident was 07:25:44, about 91 s
  after the manager became leader, and the burst of attaches (07:24:21 to 07:25:33) was
  already over. The 20 s settle is margin, not the mechanism; the real protection is that
  the unit only starts after Docker has finished its own attempt.
- **Retry.** A single attempt is not assumed to be enough. A `docker start` that fails
  again is retried in the next pass, passes are 45 s apart, a container is started at most
  4 times per run, and starts run 6 at a time so we do not recreate the burst. When every
  start in a pass succeeds the script stops at once, without the 45 s pause. This is a
  fixed pause, not exponential, because each attempt already carries its own 20 s attach
  budget inside Docker and the number of candidates is small (at most tens). Exhausting the
  attempts exits non-zero and logs at `err`, so the failure is visible instead of silent.

### 5.7 Lead Gen exclusion (default on)

Decision from Amin (2026-10-16): Lead Gen containers are never started by this unit unless
Amin opts them in. The mechanism stays generic (one exclusion list, no per-stack code):

- The script reads `DOKPLOY_BOOT_RECOVER_EXCLUDE`, a space separated list of shell globs. A
  candidate is excluded if any glob matches its **container name** or its **compose project**
  (the `com.docker.compose.project` label, which Dokploy sets to the stack's `appName`), or
  if the glob equals a prefix of the container name followed by `-`. Excluded containers are
  not started in any mode and are logged as `EXCLUDED (lead-gen) <name>` on every run.
- Built-in default when the variable is unset **or empty**: `*lead-gen* *leadgen*`. A
  missing, broken or blanked setting therefore still excludes the obvious names, and the
  protection cannot be switched off by accident. Excluding nothing needs a separate, explicit
  `DOKPLOY_BOOT_RECOVER_EXCLUDE_NONE=yes`; the script then logs `exclusions are disabled` at
  warning on every run. Tested on prod in the manual dry-run (6.4): with the variable set to
  an empty string both Lead Gen containers were still excluded, with `_NONE=yes` they were
  offered.
- The globs alone are not enough, because some Lead Gen stacks have generated names (an
  application called `app-input-online-monitor-xxxxxx` belongs to the "Lead Gen System"
  project). The authoritative list comes from Dokploy's database.

How the list is built: `dokploy-boot-recover-exclusions` (5.9) runs **one read-only joined
query** in the `dokploy-postgres` container: `compose` and `application` `appName` ->
`environment` -> `project`, keeping projects whose name matches `%lead%gen%` or `%leadgen%`
(case-insensitive). It selects only the `appName`, writes nothing, and prints the resulting
`DOKPLOY_BOOT_RECOVER_EXCLUDE='...'` line to stdout. A human reviews it and pastes it into
`/etc/default/dokploy-boot-recover`. On 2026-10-16 it produced the two globs plus 17
`appName` values across 8 projects (Instagram, TikTok, GitHub, Google, Google Maps, Upwork
and Wellfound Lead Gen, and Lead Gen System). A Lead Gen project whose name does not match
that pattern is not found. The appNames themselves are not committed here; they are
generated on the host at install time.

How it is refreshed: on demand, not automatically. **Re-run the helper whenever a Lead Gen
stack is created** (its generated `appName` may not match the globs) and update the env file;
also when a stack or project is renamed or moved, before switching to `enforce`, and after
any change to the project list. A stack missing from the list is only
protected if its name matches the globs. This is the main weakness of the design (see 7),
and the reason `dry-run` prints the `EXCLUDED` lines: during the dry-run phase, check them
against the Lead Gen project list.

Opting a stack in: remove its entry from the line in `/etc/default/dokploy-boot-recover`
(for a stack that only a glob covers, remove the glob and list the stacks that must stay
excluded by `appName`). No restart or reload; the file is read at each unit start.

### 5.8 DNS alias check (always on) and alias repair (opt-in, off by default)

Why: see the Evidence section. A recovered container can be `Up` and healthy and still
unreachable by its service name, which breaks its clients without any container being down.
`State=running` is therefore not a success criterion on its own.

**The check (always on, changes nothing).** Per started container, for every user network it
is on (`bridge`, `host` and `none` are skipped):

1. **Before the start**: read the network's stored `Aliases`. For a compose container, also
   expect the `com.docker.compose.service` label as a name (this covers a container whose
   stored aliases were already empty).
2. **Start** it.
3. **After the start**: every expected name must be in the endpoint's `DNSNames`
   (`docker inspect --format` on `NetworkSettings.Networks`, names only). If one is not, the
   script logs `ALIASES MISSING <name> <net> <missing names> (repair is off, nothing
   changed)` at warning, finishes with `alias problems: yes` and exits 3.

**The repair (opt-in: `DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR=on`, default `off`).** Docker has no
way to add an alias to a network a container is already on (a second `network connect` is
rejected as a duplicate endpoint), so a repair is `network disconnect` followed by `network
connect --alias ...`. That is not free, which is why it is off:

- the connect goes through the same swarm round trip, with the same 20 s budget, that failed
  at boot, so it can fail the same way;
- it drops everything the endpoint had besides what we pass back: links, the mac address,
  gateway priority and driver options;
- the container can come back with a different IP, and Traefik may keep routing to the old
  address until it notices;
- the cause of the one alias loss we saw is unproven and has not been reproduced (in the T3
  sandbox, 0 of 30 plain starts lost an alias), so we do not know how often a repair would be
  needed.

So by default the script only reports. **T3 (6.4) provoked the loss and showed that the repair
restores aliases and a static address (a dynamic address can change); the loss itself has
not been reproduced naturally, so the switch stays off until Amin decides.** With it on,
for each network that is missing a name:

1. Re-read `State.Status` and `State.StartedAt` and compare them with what the script
   recorded right after its own start. If the container is not running or was restarted
   since, log `SKIP alias repair` and leave it alone (somebody else is managing it).
2. `docker network disconnect <net> <id>`. If that fails, log `ALIAS REPAIR FAILED`, change
   nothing more, exit 3.
3. `docker network connect --alias <each expected name> [--ip <stored static IP>] <net> <id>`,
   up to 3 tries, 20 s apart (`DOKPLOY_BOOT_RECOVER_REPAIR_PAUSE`). The `--ip` is carried over
   only when the endpoint had a static address (`IPAMConfig`) before and it is a dotted IPv4.
   (The inspect template prints the raw address fields, because their type differs by Docker
   version: plain strings on Docker 28, where an unset address is empty and `.IsValid` would
   be a template error, and `netip.Addr` on Docker 29, where an unset address prints `invalid
   IP`. The shell accepts the current IP only if it is a dotted IPv4 and treats anything else
   as empty, and `--ip` is built only from a dotted IPv4 that is logged and ignored otherwise,
   so a bad `--ip` can never be built on either version.)
4. If all 3 tries fail, a last `docker network connect <net> <id>` with **no options at all**
   (no `--ip`, no `--alias`) so the container is never left off the network, then `ALIAS REPAIR FAILED ... plain connect
   used: yes` at `err` and exit 3.
5. Log the IP before and after. If it changed, `IP CHANGED <name> <net>: <old> -> <new>,
   check the Traefik route` at warning.
6. Re-check `DNSNames`; log `aliases restored ...` at notice.

Options compared:

| Option | Verdict |
|---|---|
| **Check and log, repair opt-in** (above). | **Chosen.** Uses only data Docker already holds for that container, needs no knowledge of Dokploy or compose and works for non-compose containers too. The risky part (disconnect/connect) does not run unless someone turns it on after T3. |
| Always repair after a missing alias. | Rejected for now (it was the previous draft): a reconnect depends on the same manager round trip that just failed and can change the address, with no evidence yet that it is needed more than once. |
| Recover through `docker compose -p <project> up -d --no-deps <service>`. | Rejected. The host script does not know where Dokploy keeps each stack's compose file or its env, and would have to read them (secrets). It recreates the container, which is more than a start, and it can change the running image or config if the stack was edited after the last deploy. It does not apply to Dokploy applications or to non-compose containers. |

Limits, stated plainly: the DNS check is on the endpoint metadata; whether the name actually
resolves from another container is a manual check in the success criteria (6.5). The
manual fix used on 2026-10-16 (`disconnect` then `connect --alias <service> --alias <container
name>`) is exactly the repair above without the IP carry-over.

### 5.9 Files

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

`/etc/default/dokploy-boot-recover` (ships as `dry-run`; flip to `enforce` after step 5 of
the rollout). The `EXCLUDE` line is replaced with the helper's output at install time (5.7);
the value shown is the safe floor. `ALIAS_REPAIR` stays `off` until Amin decides to enable it (T3 and T3b in
6.4 show what it does and does not guarantee).

```sh
DOKPLOY_BOOT_RECOVER_MODE=dry-run
DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR=off
DOKPLOY_BOOT_RECOVER_EXCLUDE='*lead-gen* *leadgen*'
```

`/usr/local/sbin/dokploy-boot-recover` (mode 0755, root)

```bash
#!/usr/bin/env bash
# dokploy-boot-recover: after dockerd is up, start the restart-policy containers whose
# swarm-network attach failed during dockerd's own startup (moby RestartSwarmContainers,
# "failed to start swarm container ... attaching to network failed ... context deadline
# exceeded"), because the daemon does not retry a failed START, and check that a recovered
# container kept its DNS aliases. See docs/design/host-boot-network-ordering.md.
#
# Selection: the container ids come from dockerd's own journal for the CURRENT daemon run
# (selected by systemd invocation id, "failed to start swarm container"). Of those, only
# containers that are still exited, have a restart policy, are not swarm tasks, still carry a
# State.Error, and do not match the exclusion list are started. A container stopped by a user
# has no journal line in this run.
#
# Containers whose compose project or name matches DOKPLOY_BOOT_RECOVER_EXCLUDE (space
# separated shell globs) are never started; they are logged as "EXCLUDED (lead-gen) <name>".
# Opting a stack in means removing its entry from that list.
#
# Alias repair (disconnect + connect --alias) is OFF by default: with it off, a missing alias
# is only logged. Turn it on with DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR=on (see the design doc).
set -u

MODE=${DOKPLOY_BOOT_RECOVER_MODE:-dry-run}                # dry-run | enforce
ALIAS_REPAIR=${DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR:-off}    # off | on
READY_TIMEOUT=${DOKPLOY_BOOT_RECOVER_READY_TIMEOUT:-300}  # s to wait for swarm leader
SETTLE=${DOKPLOY_BOOT_RECOVER_SETTLE:-20}                 # s pause once swarm is ready
MAX_PASSES=${DOKPLOY_BOOT_RECOVER_MAX_PASSES:-4}
PASS_PAUSE=${DOKPLOY_BOOT_RECOVER_PASS_PAUSE:-45}
BATCH=${DOKPLOY_BOOT_RECOVER_BATCH:-6}                    # parallel docker start
START_TIMEOUT=${DOKPLOY_BOOT_RECOVER_START_TIMEOUT:-90}   # s per docker start
MAX_AGE=${DOKPLOY_BOOT_RECOVER_MAX_AGE:-900}              # enforce refuses when dockerd is older (s)
REPAIR_PAUSE=${DOKPLOY_BOOT_RECOVER_REPAIR_PAUSE:-20}     # s between connect retries
# Space separated globs matched on container name and compose project. Empty or unset means the
# two name globs below, so a missing or blanked setting still excludes Lead Gen. Excluding
# nothing needs the explicit DOKPLOY_BOOT_RECOVER_EXCLUDE_NONE=yes.
if [ "${DOKPLOY_BOOT_RECOVER_EXCLUDE_NONE:-no}" = yes ]; then
  EXCLUDE=""
else
  EXCLUDE=${DOKPLOY_BOOT_RECOVER_EXCLUDE:-*lead-gen* *leadgen*}
fi

# One line per message. Under systemd stdout goes to the journal, so no logger call (it would
# duplicate every line); the <N> prefix sets the journal priority.
log() {
  local p=6
  case "${2:-info}" in err) p=3 ;; warning) p=4 ;; notice) p=5 ;; esac
  if [ -n "${JOURNAL_STREAM:-}" ]; then echo "<$p>$1"; else echo "$1"; fi
}

LOCK=${DOKPLOY_BOOT_RECOVER_LOCK:-/run/dokploy-boot-recover.lock}
exec 9>"$LOCK"
flock -n 9 || { log "another run holds the lock, exiting"; exit 0; }

swarm_ready() {
  [ "$(timeout 30 docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null)" = "active true" ] &&
    timeout 30 docker node ls --format '{{.Status}} {{.ManagerStatus}}' 2>/dev/null | grep -qx 'Ready Leader'
}

# systemd invocation id of the running docker.service: it names exactly this daemon run in the
# journal, so a wall-clock step cannot mix runs.
daemon_invocation() {
  local i
  i=$(systemctl show docker -p InvocationID --value 2>/dev/null)
  case "$i" in '' | *[!0-9a-f]*) return 1 ;; esac
  echo "$i"
}

# Seconds since the running dockerd started, from the monotonic clock against /proc/uptime.
daemon_age() {
  local m up
  m=$(systemctl show docker -p ExecMainStartTimestampMonotonic --value 2>/dev/null)
  up=$(cut -d' ' -f1 "${DOKPLOY_BOOT_RECOVER_UPTIME_FILE:-/proc/uptime}" 2>/dev/null)
  case "$m" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$up" ] || return 1
  awk -v m="$m" -v u="$up" 'BEGIN { a = u - m / 1000000; if (a < 0) a = 0; printf "%d\n", a }'
}

# True if the container (name, compose project) matches an entry of the exclusion list.
excluded() {
  local e rc=1
  set -f
  for e in $EXCLUDE; do
    case "$2" in $e) rc=0; break ;; esac
    case "$1" in $e | $e-*) rc=0; break ;; esac
  done
  set +f
  return $rc
}

# Container ids dockerd itself reported as failed to start in this daemon run.
journal_failed_ids() {
  journalctl _SYSTEMD_INVOCATION_ID="$INVOCATION" -o cat --no-pager 2>/dev/null |
    grep -F 'failed to start swarm container' | grep -oE 'container=[0-9a-f]{12,64}' | cut -d= -f2 | sort -u
}

ROW_FMT='{{.Name}}|{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{with index .Config.Labels "com.docker.swarm.task.id"}}swarm{{end}}|{{with index .Config.Labels "com.docker.compose.project"}}{{.}}{{end}}|{{with index .Config.Labels "com.docker.compose.service"}}{{.}}{{end}}|{{.State.Error}}'
NET_FMT='{{range $k,$v := .NetworkSettings.Networks}}{{$k}}|{{join $v.Aliases ","}}|{{join $v.DNSNames ","}}|{{$v.IPAddress}}|{{with $v.IPAMConfig}}{{.IPv4Address}}{{end}}{{"\n"}}{{end}}'

QUIET=0 # classify logs what it leaves alone on the first pass only
say() { [ "$QUIET" = 1 ] || log "$@" >&2; }

# Classify the journal ids. Prints "id|name|project|service" for every start candidate; what it
# leaves alone is logged on stderr (stdout is data).
classify() {
  local id name status policy swarm project service error
  while read -r id; do
    [ -n "$id" ] || continue
    IFS='|' read -r name status policy swarm project service error \
      < <(docker inspect --format "$ROW_FMT" "$id" 2>/dev/null) || continue
    [ -n "$name" ] || continue # container was removed since
    name=${name#/}
    [ "$status" = exited ] || continue # running again (Dokploy, a person, or Docker itself)
    if excluded "$name" "$project"; then say "EXCLUDED (lead-gen) $name" notice; continue; fi
    [ -z "$swarm" ] || continue
    case "$policy" in always | unless-stopped | on-failure) ;; *) continue ;; esac
    if [ -z "$error" ]; then say "SKIP $name: State.Error is empty, it was started or stopped since" notice; continue; fi
    echo "$id|$name|$project|$service"
  done < <(journal_failed_ids)
}

# "net|aliases|dnsnames|ip|staticip" lines, bridge/host/none dropped. The address fields are raw
# Docker output, which differs by version (Docker 28: plain strings, empty when unset; Docker 29:
# netip.Addr, which prints "invalid IP" when unset), so the current IP is accepted only if it is
# a dotted IPv4 and is empty otherwise. A static address is checked where it is used (repair_net).
# If docker inspect itself fails, say so on stderr instead of silently verifying nothing.
net_lines() {
  local out
  out=$(docker inspect --format "$NET_FMT" "$1" 2>/dev/null) || {
    log "cannot read the network data of ${1:0:12} (docker inspect failed)" warning >&2
    return 1
  }
  printf '%s\n' "$out" | grep -vE '^(bridge|host|none)\|' | sed '/^$/d' |
    awk -F'|' -v OFS='|' '$4 !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { $4 = "" } 1'
}

# Names of the user-defined networks the container is attached to, one per line.
user_networks() {
  docker inspect --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$1" 2>/dev/null |
    grep -vE '^(bridge|host|none)?$'
}

# Expected names per network before the start: the stored aliases plus, for a compose
# container, its service name. Prints "net|name,name|staticip".
expected_names() { # id service
  local net aliases dns ip static
  while IFS='|' read -r net aliases dns ip static; do
    [ -n "$net" ] || continue
    [ -n "$2" ] && case ",$aliases," in *",$2,"*) ;; *) aliases="${aliases:+$aliases,}$2" ;; esac
    [ -n "$aliases" ] && echo "$net|$aliases|$static"
  done < <(net_lines "$1")
}

# Names from <want> that are not in the endpoint's DNSNames on <net>, space separated.
missing_names() { # id net want
  local dns a out=""
  dns=$(net_lines "$1" | awk -F'|' -v n="$2" '$1 == n { print $3 }')
  for a in ${3//,/ }; do
    case ",$dns," in *",$a,"*) ;; *) out="${out:+$out }$a" ;; esac
  done
  echo "$out"
}

# Alias repair (opt-in). A reconnect on the swarm overlay uses the same manager round trip as
# the attach that failed at boot, so it can fail; hence the retries, the plain-connect fallback
# and the state check right before touching the network. Returns 1 if a name is still missing.
repair_net() { # id name net want static started missing
  local id=$1 name=$2 net=$3 want=$4 static=$5 started=$6 missing=$7
  local a args="" ipopt="" ip_before ip_after state try ok=0
  ip_before=$(net_lines "$id" | awk -F'|' -v n="$net" '$1 == n { print $4 }')
  state=$(docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}' "$id" 2>/dev/null)
  if [ "$state" != "running|$started" ]; then
    log "SKIP alias repair $name $net: state changed since our start ($state), someone else is managing it" notice
    return 0
  fi
  log "ALIASES MISSING $name $net $missing, repairing (ip before: ${ip_before:-none})" warning
  for a in ${want//,/ }; do args="$args --alias $a"; done
  # The stored static address is only used if it is a dotted IPv4 (Docker 29 prints "invalid IP"
  # for an unset netip.Addr); anything else is ignored and logged.
  case "$static" in
    '') ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) ipopt="--ip $static" ;;
    *) log "ignoring a static address that is not IPv4 on $name $net" notice ;;
  esac
  if ! docker network disconnect "$net" "$id" >/dev/null 2>&1; then
    log "ALIAS REPAIR FAILED $name $net: disconnect failed, nothing changed" err
    return 1
  fi
  for try in 1 2 3; do
    # shellcheck disable=SC2086
    if docker network connect $args $ipopt "$net" "$id" >/dev/null 2>&1; then ok=1; break; fi
    [ "$try" -lt 3 ] && sleep "$REPAIR_PAUSE"
  done
  if [ "$ok" = 0 ]; then
    # Never leave the container off the network: a last attempt with no options at all.
    docker network connect "$net" "$id" >/dev/null 2>&1
  fi
  ip_after=$(net_lines "$id" | awk -F'|' -v n="$net" '$1 == n { print $4 }')
  missing=$(missing_names "$id" "$net" "$want")
  if [ -n "$missing" ]; then
    log "ALIAS REPAIR FAILED $name $net: still missing $missing (ip ${ip_before:-none} -> ${ip_after:-none}, plain connect used: $([ "$ok" = 0 ] && echo yes || echo no))" err
    return 1
  fi
  log "aliases restored $name $net: $want (ip ${ip_before:-none} -> ${ip_after:-none})" notice
  [ -z "$ip_before" ] || [ "$ip_before" = "$ip_after" ] || log "IP CHANGED $name $net: $ip_before -> $ip_after, check the Traefik route" warning
  return 0
}

# After a start: every expected name must be in the endpoint's DNSNames. Missing names are
# logged; they are repaired only when DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR=on.
verify_aliases() { # id name expected-file started-at
  local id=$1 name=$2 exp=$3 started=$4 net want static missing rc=0
  while IFS='|' read -r net want static; do
    missing=$(missing_names "$id" "$net" "$want")
    [ -n "$missing" ] || continue
    if [ "$ALIAS_REPAIR" != on ]; then
      log "ALIASES MISSING $name $net $missing (repair is off, nothing changed)" warning
      rc=1
      continue
    fi
    repair_net "$id" "$name" "$net" "$want" "$static" "$started" "$missing" || rc=1
  done < "$exp"
  return $rc
}

RESDIR=$(mktemp -d)
trap 'rm -rf "$RESDIR"' EXIT

start_one() { # id name service
  local id=$1 name=$2 out exp started
  exp=$(mktemp)
  # The container is on a user network but nothing could be read about it: say so, do not skip
  # the check silently.
  if [ -z "$(net_lines "$id")" ] && [ -n "$(user_networks "$id")" ]; then
    log "no network data could be read for $name, its DNS names will not be verified" warning
    : > "$RESDIR/alias-problem"
  fi
  expected_names "$id" "$3" > "$exp"
  if out=$(timeout "$START_TIMEOUT" docker start "$id" 2>&1); then
    log "started $name"
    started=$(docker inspect --format '{{.State.StartedAt}}' "$id" 2>/dev/null)
    verify_aliases "$id" "$name" "$exp" "$started" || : > "$RESDIR/alias-problem"
    rm -f "$exp"
    return 0
  fi
  rm -f "$exp"
  log "start failed $name: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)" warning
  : > "$RESDIR/start-failed"
  return 1
}

waited=0
until swarm_ready; do
  [ "$waited" -ge "$READY_TIMEOUT" ] && { log "swarm not ready after ${READY_TIMEOUT}s, giving up" err; exit 2; }
  sleep 5; waited=$((waited + 5))
done
INVOCATION=$(daemon_invocation) || { log "cannot determine the docker invocation id, giving up" err; exit 2; }
sleep "$SETTLE"
AGE=$(daemon_age) || { log "cannot determine dockerd age, giving up" err; exit 2; }
log "swarm ready, mode=$MODE, alias repair=$ALIAS_REPAIR, docker invocation ${INVOCATION:0:8}, dockerd age ${AGE}s"
[ -n "$EXCLUDE" ] || log "exclusions are disabled (DOKPLOY_BOOT_RECOVER_EXCLUDE_NONE=yes)" warning

# A State.Error outlives a later manual stop, so late in a daemon's life this unit must not
# act (a manual restart of the unit hours after boot could resurrect stopped containers).
if [ "$MODE" = enforce ] && [ "$AGE" -gt "$MAX_AGE" ]; then
  log "refusing to enforce: dockerd is ${AGE}s old (> ${MAX_AGE}s). Run dry-run to look." err
  exit 4
fi

declare -A attempts=() # id -> start attempts this run
pass=1
while [ "$pass" -le "$MAX_PASSES" ]; do
  todo=$(classify | sort -u)
  QUIET=1
  # Drop containers that already used all their attempts.
  count=0
  list=""
  while IFS='|' read -r id name project service; do
    [ -n "$id" ] || continue
    [ "${attempts[$id]:-0}" -lt "$MAX_PASSES" ] || continue
    list="$list$id|$name|$project|$service"$'\n'
    count=$((count + 1))
  done <<< "$todo"
  [ "$count" -gt 0 ] || { log "pass $pass: nothing to do"; break; }
  log "pass $pass: $count candidate(s)"

  if [ "$MODE" != "enforce" ]; then
    # Dry run: no docker start. Print what a recovery would verify afterwards.
    while IFS='|' read -r id name project service; do
      [ -n "$id" ] || continue
      log "DRY-RUN would start $name; would verify DNS names: $(expected_names "$id" "$service" | cut -d'|' -f1,2 | tr '\n' ' ')"
    done <<< "$list"
    exit 0
  fi

  running=0
  while IFS='|' read -r id name project service; do
    [ -n "$id" ] || continue
    attempts[$id]=$(( ${attempts[$id]:-0} + 1 ))
    start_one "$id" "$name" "$service" &
    running=$((running + 1))
    if [ "$running" -ge "$BATCH" ]; then wait; running=0; fi
  done <<< "$list"
  wait
  # Another pass only if a start failed; no pause after the last useful pass.
  [ -e "$RESDIR/start-failed" ] || break
  rm -f "$RESDIR/start-failed"
  pass=$((pass + 1))
  [ "$pass" -le "$MAX_PASSES" ] && sleep "$PASS_PAUSE"
done

left=$(classify | wc -l)
recovered=0
for id in "${!attempts[@]}"; do
  [ "$(docker inspect --format '{{.State.Status}}' "$id" 2>/dev/null)" = running ] && recovered=$((recovered + 1))
done
problems=no
[ -e "$RESDIR/alias-problem" ] && problems=yes
if [ "$left" -gt 0 ] || [ "$problems" = yes ]; then
  log "done: $recovered running after recovery, $left still failing to start, alias problems: $problems" err
  exit 3
fi
log "done: $recovered running after recovery, 0 still failing to start, alias problems: no"
exit 0
```

`/usr/local/sbin/dokploy-boot-recover-exclusions` (mode 0755, root; run by hand, never by
the unit)

```bash
#!/usr/bin/env bash
# dokploy-boot-recover-exclusions: print the DOKPLOY_BOOT_RECOVER_EXCLUDE line for the Lead Gen
# stacks, read from Dokploy's own database. Read-only: one SELECT, nothing is written, nothing
# secret is selected (project name and appName only). Review the output, then paste it into
# /etc/default/dokploy-boot-recover. See docs/design/host-boot-network-ordering.md.
set -eu
PG=$(docker ps --filter name=dokploy-postgres -q | head -n 1)
[ -n "$PG" ] || { echo "dokploy-postgres container not found" >&2; exit 1; }

# compose/application appName -> environment -> project, one joined query.
names=$(docker exec -i "$PG" psql -U dokploy -d dokploy -At <<'SQL'
select x."appName"
from project p
join environment e on e."projectId" = p."projectId"
join (
  select "environmentId", "appName" from compose
  union all
  select "environmentId", "appName" from application
) x on x."environmentId" = e."environmentId"
where p.name ilike '%lead%gen%' or p.name ilike '%leadgen%'
order by x."appName";
SQL
)
printf "DOKPLOY_BOOT_RECOVER_EXCLUDE='*lead-gen* *leadgen*"
for n in $names; do printf ' %s' "$n"; done
printf "'\n"
```

---

## 6. Rollout, rollback, testing

### 6.1 Rollout

1. Review and merge this document. (Merging is separate from installing.)
2. Install the four files on `devino-first`, run `dokploy-boot-recover-exclusions` and put
   its output in `/etc/default/dokploy-boot-recover`. `systemctl daemon-reload` and
   `systemctl enable dokploy-boot-recover.service`. Do **not** start it yet. No restart of
   Docker or Dokploy is involved, and the deploy queue is not touched.
3. Prove the selector on the live host, no side effects: `systemctl start
   dokploy-boot-recover.service` in `dry-run`. Expected: `DRY-RUN would start` lines for
   exactly the non-Lead-Gen containers that dockerd reported as failed to start in this daemon
   run and that are still down, with the DNS names it would verify, plus one `EXCLUDED
   (lead-gen) <name>` line per excluded container that is down. Nothing is started. Compare
   with `journalctl -u docker | grep 'failed to start swarm container'` and `docker ps -a
   --filter status=exited`.
4. Leave it in `dry-run` through the next reboot or Docker restart. After it, compare
   its `DRY-RUN` list with the ground truth from the Docker log
   (`journalctl -b -u docker | grep "failed to start swarm container"`, same containers).
5. Set `DOKPLOY_BOOT_RECOVER_MODE=enforce` in `/etc/default/dokploy-boot-recover`.
   No reload needed, the file is read on each start.
6. At the next reboot confirm the success criteria in 6.5.
7. `DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR` stays `off`. Turn it on only on Amin's decision (T3b in 6.4
   showed the repair works on real Docker for aliases and a static address, and that a dynamic
   address can change), and only with a note on who checks the Traefik route after the next
   real event.
8. Whenever a Lead Gen stack is created, re-run `dokploy-boot-recover-exclusions` and update
   `/etc/default/dokploy-boot-recover` (5.7).

### 6.2 Rollback

`systemctl disable --now dokploy-boot-recover.service`, then remove the four files and
`systemctl daemon-reload`. Instant neutralisation without touching systemd: set the mode
back to `dry-run`. Rolling back returns the host to today's behaviour (manual recovery).
The unit changes no Docker or Dokploy configuration, so nothing else needs undoing. Turning
`DOKPLOY_BOOT_RECOVER_ALIAS_REPAIR` back to `off` removes the only code path that writes to
Docker. Keep the exclusion list current while the unit is installed (6.1, step 8).

### 6.3 Related finding, not part of this fix

The swarm node's advertised address is a LAN address (`.180`) that no longer exists on the
host: the current addresses are `.16` (wired) and `.93` (Wi-Fi), and neighbour lookup for
`.180` fails. At boot the agent's first session dials the stale address (`no route to
host`, 07:24:15) and falls back to the local manager. It costs about 3 s per boot, so it
does not cause the attach timeouts, but it is a latent hazard: a DHCP-assigned advertise
address on a workstation host. Tracked separately as T-2642 (pin it to a stable address in a
quiet window); not part of this fix.

### 6.4 Testing without rebooting prod

Done:

- **T1, manual dry-run on the live host (read-only).** This is a manual dry-run of the
  final script, not a Docker-restart dry-run. The script text was piped over `ssh` stdin
  (`bash -c "$(cat)"`, nothing copied to the host) with the mode forced to `dry-run` and the
  lock pointed at `/dev/null`. It ran at about 11:40Z on 2026-10-16 (dockerd 4.2 hours old,
  which a dry run is allowed), with the exclusion list generated by the helper from the live
  database (stack names replaced here, as this repository is public):

  ```
  swarm ready, mode=dry-run, alias repair=off, docker invocation <8 hex>, dockerd age 15299s
  EXCLUDED (lead-gen) <lead-gen stack 1>-app-1
  EXCLUDED (lead-gen) <lead-gen stack 2>-api-1
  pass 1: 1 candidate(s)
  DRY-RUN would start <ordinary stack>-<service>-1; would verify DNS names: dokploy-network|<ordinary stack>-<service>-1,<service>
  ```

  Controls: with `DOKPLOY_BOOT_RECOVER_EXCLUDE` set to an empty string the output was
  identical (the floor globs still protect both Lead Gen containers). With
  `DOKPLOY_BOOT_RECOVER_EXCLUDE_NONE=yes` it logged `exclusions are disabled` and offered 3
  containers (the two Lead Gen ones plus the one above). On the previous revision of the
  script, with the two globs removed so only the 17 `appName` entries remained, the output
  was also identical. Nothing was started, no network was changed, and nothing was left on
  the host (the only leftover, an empty `/run` lock file from an earlier run of mine, was
  removed). `bash -s` is not usable for this, because `docker` inside the script reads the
  same stdin and swallows the rest of it, hence `bash -c "$(cat)"`.
- **T1b, two bugs found by dry-runs, now fixed and covered.** (1) On Docker 29.9.0 a
  `--format` template that starts with `{{.Id}}` prints a missing label as `<no value>`, and
  the label `com.docker.swarm.task` is present but empty on every task, so the earlier
  selector matched nothing. The script now uses `{{with index .Config.Labels
  "com.docker.swarm.task.id"}}...{{end}}`. The test stub prints `<no value>` for any
  template that does not use `with`, and a test confirms the old template shape finds 0
  candidates where the current one finds all 7 expected (default exclusions). (2) A dry-run and the review of this PR also
  found that the first selector keyed on `FinishedAt` and that a re-queue would re-run
  one-shot containers; both are gone (5.2, 5.3).
- **T2, script logic against a stub `docker`, `journalctl` and `systemctl` (local, no host
  touched).** 15 fixture containers. Dry run listed 6 and started nothing. Enforce with the
  default `ALIAS_REPAIR=off`: started those 6 (one needed 3 attempts because it failed twice,
  one exited again by itself and was correctly **not** re-started by the script), logged
  `ALIASES MISSING ... (repair is off, nothing changed)` for the two containers whose stub
  start loses the aliases (one by its stored aliases, one by the compose service fallback),
  made **no** `network` call, and exited 3. With `ALIAS_REPAIR=on`: the exact `disconnect` and
  `connect --alias` calls for those two, `--ip 10.0.0.50` carried over from the stored static
  address, IP before and after logged, `IP CHANGED` for the one that got a new address; two
  failing connects were retried; when every connect fails the script tried 3 times, fell back
  to a plain connect, logged `ALIAS REPAIR FAILED` and exited 3; a container whose
  `StartedAt` changed under the script got `SKIP alias repair` and no network call. Left alone
  in every run: a container stopped before boot, one stopped after boot, an old failure that
  is not in this run's journal, a swarm task, a `no`-policy container, a one-shot that exited
  0, a container whose `State.Error` is empty (logged `SKIP`), and two excluded containers
  (by name glob and by generated `appName`). A second enforce run found nothing to start.
  Enforce on a daemon 3 hours old exited 4 and started nothing; a dry-run on the same
  daemon worked. An empty or unset `EXCLUDE` kept the Lead Gen globs; only
  `EXCLUDE_NONE=yes` disabled them (with the warning). A run where every start succeeds made
  one pass and no 45 s pause. Case 11: a stub that prints `invalid IP` for an unset static
  address produced no `--ip` argument and an `ignoring a static address` log line; case 12:
  when every connect fails the last attempt is a connect with no options at all. Cases 13
  and 14: Docker 28 style raw strings (unset = empty) and Docker 29 `invalid IP` in both the
  current and the static address give the same repair, with `ip none -> ...` in the log and
  no `invalid` in any connect or log line. Case 15: when `docker inspect` of the network
  data fails, the script logs `cannot read the network data` and `no network data could be
  read ... will not be verified`, makes no network call and exits 3, instead of silently
  verifying nothing. Also run:
  `bash -n` on both scripts.

- **T3, real Docker in an isolated sandbox (run 2026-10-16, 11:43Z to about 13:20Z).** A
  throwaway privileged `docker:29.9.0-dind` container on `devino-second` (same Docker version
  as prod) with its own `dockerd` and swarm. The host daemon was not touched: its swarm state
  was `inactive` before and after, no network or container of the host was changed, and the
  container, its volume and the image were removed afterwards. Setup: `swarm init`, attachable
  overlay `dokploy-network`, a compose-style `restart: always` container with the aliases
  `demo-root_db-1` and `root_db`, 59 `unless-stopped` standalone containers with one alias
  each, 111 swarm services, one client container. The sandbox host was itself busy (load
  average 40 to 70).

  *Failure reproduced once.* Restarting the inner `dockerd` with the container capped at
  `--cpus 0.5`, right after the services had been created, produced the prod signature:
  30 lines `failed to start swarm container ... attaching to network failed, make sure your
  network options are correct and check manager logs: context deadline exceeded` (first one 70 s
  after `Loading containers: done`, spread over the roughly 10 minutes until the daemon finished starting), and 31
  containers `Exited (255)`, including the compose-style one, with that text in `State.Error`.
  So the mechanism in section 3 is real on Docker 29.9.0 and does not need a host reboot. It
  is load dependent: three more inner restarts that completed (0.5 and 0.2 CPUs, 45 and 175
  services) produced **0** failures, and a fourth (245 services, overlay deliberately
  over-subscribed, 0.5 CPUs) never finished starting within 20 minutes, so I could not make
  the failure repeatable.

  *Script against the reproduced state (real Docker, the daemon's real log as the journal;
  only `journalctl`/`systemctl` are shimmed because the sandbox has no systemd):*
  - Dry-run: `pass 1: 30 candidate(s)`, one `DRY-RUN would start ...; would verify DNS names:
    dokploy-network|demo-root_db-1,root_db` line for the compose container, nothing started.
  - Enforce, alias repair off, while the sandbox manager could not allocate addresses (I had
    over-subscribed the /24 overlay, a sandbox mistake that made every attach fail again):
    every start failed with the same Docker error, 4 passes, exit 3. The script did what it
    should when the manager stays unhealthy: report and exit non-zero, no tight loop.
  - Enforce, alias repair off, after freeing addresses: `pass 1: 30 candidate(s)`, 30
    started, exit 0. **Aliases were identical before and after for all 30** (`Aliases` and
    `DNSNames` compared per container), and from the client container `getent hosts root_db`
    and `getent hosts svc-27` returned the right addresses. **A plain `docker start` did not
    lose a DNS alias in any of the 30**, including the compose container. The alias loss seen
    on prod on 2026-10-16 was therefore **not reproduced**.
  - Selection controls (a second pass over fabricated state, see below): containers that were
    stopped or killed by the sandbox itself, and containers whose `State.Error` was empty, were
    logged `SKIP` or ignored, and only containers with both a journal failure line and a
    `State.Error` were candidates.

  *Not achieved in the first sandbox.* The alias-loss path: with no natural loss, the planned
  test of the repair could not be completed there. Fabricating a second failed state by
  editing `config.v2.json` after `kill -9` of the inner daemon left the container store
  inconsistent (`failed to load container mount: RW layer ... does not exist`), the inner
  `dockerd` stopped making progress during startup, and I tore that sandbox down.

- **T3b, repair path on real Docker (second sandbox, same day, about 25 minutes).** A fresh
  `docker:29.9.0-dind` on `devino-second` (host swarm `inactive` before and after; container,
  volume, image and temp files removed). No `kill -9` and no config editing: three containers
  on an overlay (`10.50.0.0/24`) were started once, stopped, had their entrypoint file
  removed and were started again, which gives a genuine `exited` container with a real
  `State.Error` (a failed start of a container that had run before, the same shape as the
  prod failure). The journal shim named their ids. A `docker` wrapper in the script's `PATH`
  provoked the prod symptom: right after the script's plain `docker start` of two of them (one
  with a static `--ip 10.50.0.50`, both compose-style with a service alias) it disconnected and
  plain-reconnected the endpoint, which strips the aliases exactly as seen on prod.
  - **Repair off:** `ALIASES MISSING demo-a ... a_svc` and `demo-b ... b_svc (repair is off,
    nothing changed)`, `alias problems: yes`, exit 3. From the client container `a_svc` and
    `b_svc` did **not** resolve (the prod symptom), `demo-c` did.
  - **Repair on:** both containers repaired: `aliases restored` for each, `getent hosts a_svc`
    and `b_svc` resolved again. The container with the static address got **the same address
    back** (`10.50.0.25 -> 10.50.0.50`, the stripped endpoint had received a dynamic one); the
    dynamic one **changed address** (`10.50.0.24 -> 10.50.0.26`) and the script logged `IP
    CHANGED ... check the Traefik route`. Note that "before" is the address after the start,
    not the address before the reboot.
  - The `invalid IP` problem found by review405 was real on this Docker: an exited container's
    `IPAddress` printed `invalid IP`. That run used the earlier `IsValid` form of the template;
    it was replaced afterwards by raw fields plus a shell check, so that it also works on
    Docker 28 (`.IsValid` is a template error there). The raw template was then checked
    read-only on prod's Docker 29 (unset addresses print `invalid IP` and are treated as
    empty); Docker 28 is covered by the stub tests only.
  - Not covered here: a reconnect that fails or times out under manager load (stub tests only),
    and a real Traefik route. A link or gateway-priority loss through the reconnect is by
    construction, not measured.

  *Consequence for the design.* The check-and-report default (section 5.8) is harmless and
  sufficient on a healthy Docker: no alias loss occurred in 30 plain starts. The repair path
  now works on real Docker for aliases and for a static address, and changes a dynamic
  address, as documented. It still **stays `off`**: the loss itself is not reproduced (it was
  only provoked), so we cannot say how often it would run, and the failure case under load is
  untested. Turning it on is a decision for Amin with those two caveats and the Traefik check
  in 6.5.
- **T4, first real event.** See 6.5.

### 6.5 Success criteria at the next reboot or Docker restart

- `journalctl -t dokploy-boot-recover -b` shows `done: N running after recovery, 0 still
  failing to start, alias problems: no`.
- N matches the number of non-excluded ids in `journalctl -u docker | grep 'failed to start
  swarm container'` (minus containers removed since).
- For each recovered container, on every user network: `docker inspect --format '{{range
  $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.Aliases}} {{$v.DNSNames}}{{"\n"}}{{end}}'`
  shows the same aliases as the healthy containers of the same stack, and every alias is in
  `DNSNames`. Zero `ALIASES MISSING` lines. (With repair on: each followed by `aliases
  restored`, and no `ALIAS REPAIR FAILED`.)
- Traefik route (needed when repair is on, cheap otherwise): for every recovered web
  container, and for every `IP CHANGED` line, request the public hostname through Traefik and
  confirm it answers from that container (status code only), or confirm that Traefik's
  router lists the container's current address.
- In-network name resolution: from another container on the same network,
  `getent hosts <service name>` returns the recovered container's address (spot-check at
  least one database container and one web container).
- No restart-policy container outside the exclusion list remains `exited` with a
  `State.Error` set.
- Time from `docker.service` active to the last container running is under 5 minutes.
- `EXCLUDED (lead-gen)` lines list exactly the Lead Gen containers that were down.

### 6.6 Existing boot units on devino-first, and how this unit relates to them

Read-only inspection on 2026-10-16 (`systemctl cat/show`, `journalctl -u ... -b`, `stat`).

**`boot-traefik-fix.service`** (the one named in `After=`):

- *What it is.* A oneshot, `After=docker.service tailscaled.service`, `WantedBy=
  multi-user.target`, running `/usr/local/bin/boot-traefik-fix.sh`. Its purpose is stated in
  the script: Tailscale Serve binds `100.x:443`, which makes Docker Swarm's host-mode publish
  of Traefik on `0.0.0.0:443` fail with `EADDRINUSE`. So it stops `tailscaled`, waits for port
  443 to be free, runs `docker service update --force dokploy-traefik`, waits until Traefik
  is running and bound to 443, then starts `tailscaled` again (and deliberately does not
  re-enable Tailscale Serve on 443, because of the 2026-09-22 outage). Update from a later
  read-only probe (2026-10-16): Tailscale was **not** on 443 that day (it binds only ports
  8443-8445), so that premise did not apply.
- *Who and when.* The host does not record who installed it (root-owned files, no package or
  git metadata). The unit file was created 2026-05-19 13:27Z (the `multi-user.target.wants`
  symlink is dated 2026-05-10), and the script was last changed 2026-09-22 03:25Z, which
  matches the outage its comments mention. Ask the people who did the 2026-09-22 work; I did
  not guess.
- *Did it run at 07:22Z?* It ran at 07:25:44Z, when `docker.service` became active (that
  is its `After=`), and finished at 07:27:41Z with status 0. Its journal shows `docker service
  update --force dokploy-traefik` at 07:26:05Z followed by about 1.5 minutes of `no suitable
  node (host-mode port already in use on 1 node)` until Traefik bound 443 at about 07:27:38Z.
  The previous boot (2026-10-14) shows the same script: a 15 s wait warning, a failed first
  service update that it retried, Traefik up at 18:07:22Z. So **Traefik itself was not
  serving until 07:27:41Z on 2026-10-16, independently of the 53 containers.** That is a
  second, smaller contribution to the outage window and is not addressed by this design.
  Its cause, found by that probe, is a false failure in the script itself: `docker service
  update --force dokploy-traefik 2>&1 | tee /dev/stderr | logger` fails under systemd
  (`tee: /dev/stderr: No such device or address`), and with `pipefail` the first update counts
  as failed although it had converged (07:26:35Z). The script then forces a second update at
  07:26:40Z, which kills the healthy Traefik; its replacements fail with `:80 already
  allocated` until 07:27:40Z. Tracked as T-2657, outside this fix.
- *Overlap or conflict with `dokploy-boot-recover`?* No overlap: it acts on one swarm service
  (`dokploy-traefik`) and on `tailscaled`; this unit acts on standalone containers and never
  touches either. There is a shared resource, the swarm manager, which is busy during
  Traefik's forced update. `After=boot-traefik-fix.service` orders recovery after it, so the
  two never run together. Cost: recovery starts about two minutes later than it could (the
  script took 1 min 57 s at 07:25:44Z). Benefit: recovered containers come up behind a working
  Traefik and the manager is not loaded by two jobs at once. It is only ordering, not
  `Requires=`/`Wants=`: if `boot-traefik-fix` fails or is removed, recovery still runs, and
  its own `TimeoutStartSec=300` bounds the wait.
- *Does recovery touch Traefik's transient tasks from that window?* No, on three separate
  grounds, checked read-only on 2026-10-16 against the `dokploy-traefik.1.*` containers (the
  running one and the four `Created` ones left from failed replacements): each carries the
  `com.docker.swarm.task.id` label, which the selector excludes (5.2); each has restart policy
  `no`, which the selector requires to be `always`, `unless-stopped` or `on-failure`; and
  they are not `exited` (the replacements are `Created`, never started) and have no
  `failed to start swarm container` journal line, which is where candidates come from. A
  swarm task is never a target, whatever state it is in.
- *Should it be folded in?* No. Different failure (port 443 ownership vs. network attach),
  different object, and the working unit should not be made riskier. Its false failure and the
  second forced update are described above (T-2657).

**`devino-container-maintenance-recovery.service`** (not named in `After=`, but relevant):

- A oneshot installed 2026-10-14 17:59Z, `Requires=docker.service`, guarded by
  `ConditionPathExists=/root/devino-maintenance-20261014/container-recovery-pending.json`,
  running a Python script from the same directory with the argument `restore`.
- On 2026-10-14 it ran at 18:07Z, after that day's maintenance reboot, and logged `restored:
  true, tracked: 326`. The containers that failed on 10-14 have a `StartedAt` of 18:07Z, so it
  most likely recovered them; I did not read the script, so this is inference.
- On 2026-10-16 it was skipped at 07:25:44Z (`start condition unmet`): the pending file no
  longer exists, because that mechanism is a one-off created by hand for a planned
  maintenance. The 10-16 reboot was unplanned (a Windows update), which is why nothing
  restored these containers.
- Relationship: it is the same idea (start what should be running after boot) but driven by a
  hand-made inventory for one maintenance window. This design is the permanent, selection-by-
  evidence version for the unplanned case. They do not conflict: if the inventory restore ever
  runs again it starts containers by name from its own list, and `dokploy-boot-recover` then
  finds them `running` and does nothing. The one-off could be retired once this unit is
  proven.

---

## 7. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Starts a container a user meant to keep stopped. | Very low. Candidates must have a failure line in this daemon run's journal. The remaining case is a user stopping an already-exited container in the minutes between the daemon's failure and this unit's first pass (that sets no manual-stop flag and leaves `State.Error`). | Runs about 20 s after Docker is ready. Enforce refuses once dockerd is older than 15 minutes. `dry-run` first. Every name touched is logged. |
| Start storm re-overloads the manager. | Low. | Batches of 6 versus 53 at once, passes 45 s apart, `Nice=10`, 4 attempts max per container. |
| Dependency order (an app starts before its DB). | Medium, harmless. | Once started, Docker's restart policy keeps restarting a container that exits. Databases on stack-only networks come back by themselves before this unit runs. |
| A recovered container is up but unreachable by name (aliases lost). | Seen once on 2026-10-16. | The check in 5.8 reports it (`ALIASES MISSING`, exit 3), in the success criteria, and in T3. Cause unproven. By default nothing is repaired, so this stays a manual fix until repair is enabled. |
| The opt-in repair (disconnect, connect) fails, drops the endpoint's links or gateway priority, or changes the container's IP so Traefik routes to a stale address. | Only when `ALIAS_REPAIR=on` (off by default). | Enabled only on Amin's decision (T3b ran it on real Docker). State re-check right before touching the network, 3 connect tries 20 s apart, a last connect with no options as a last resort so it is never left off the network, IP before and after logged, `IP CHANGED` warning, a Traefik route check in the success criteria. |
| Docker changes the journal wording `failed to start swarm container` on upgrade. Recovery silently stops. | Medium over time. | Dry-run after every Docker upgrade and compare with the journal; a restore that leaves restart-policy containers `exited` with no `EXCLUDED`, `SKIP` or `started` line for them is the signal. |
| Unit fails at boot (swarm never ready). | Low. | Gives up after 300 s with exit 2, logs at `err`, blocks nothing. Nothing is `After=` it. |
| A start fails with a legitimate non-network error (bad mount, missing image). | Possible. | Logged by name with the Docker error and retried at most 4 times. |
| A Lead Gen stack is missing from the exclusion list and gets started. | Low to medium. New or renamed Lead Gen projects, or a project not named "... Lead Gen", are only protected by the name globs. | Dry-run first and review the `EXCLUDED` lines. Re-run the helper whenever a Lead Gen stack is created, after any change to Lead Gen stacks, and before `enforce`. An empty setting keeps the globs; disabling needs `EXCLUDE_NONE=yes`. |
| Excluded Lead Gen containers stay down after a reboot. | Certain, by decision. | They are logged on every run so the owner can start them. Opting in is a one-line edit (5.7). |
| Root cause remains: attaches still time out. | Certain. | This fix removes the outage, not the timeout. Long term options are in 4 (c) and 6.3. |

---

## 8. Decisions needed

- **Lead Gen (decided):** excluded by default, see 5.7. Still open: who starts the excluded
  Lead Gen containers after a reboot, and whether any should be opted in later.
- Whether to move from `dry-run` to `enforce` after step 4, or straight after step 3.
- Whether to turn alias repair on (it is off by default; T3b showed it works on real Docker when the loss is provoked, the natural loss was not reproduced).
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
`systemctl show docker -p InvocationID` and `-p ExecMainStartTimestampMonotonic`,
`journalctl _SYSTEMD_INVOCATION_ID=<id>`, `docker info --format` (swarm fields),
`docker node ls --format`, `docker network ls/inspect --format` (driver, scope, attachable,
created), `docker inspect --format` with State, HostConfig.RestartPolicy, network names and
one label (never `Config.Env` or `Config.Cmd`), `ip route get`, `ip neigh`, `ss -tlnH`,
`journalctl --list-boots`.
