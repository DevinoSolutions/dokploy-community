# Dokploy build-once rollout runbook

Owner item 18. Docs only: nothing in this document was executed against the live
Dokploy instance. The only live calls made while writing it were two read-only
settings reads (`settings.getDokployVersion`, `settings.getReleaseTag`) and one
read-only `overview.services` listing, used for the unit count in §1.

Audience: the owner, running this by hand on the prod host `devino`.
Sources: the fork's `canary` branch at `b0cadcd`, the build-once design spec
(`runner-infra/docs/superpowers/specs/2026-09-10-ci-build-once-and-pool-design.md`),
the Dokploy exports in `S/dokploy/`, the cost aggregate in `S/cost/aggregate.json`,
and the four review rounds in `S/track2/w6-review-2.md`.

Secrets: this document names secrets and tokens by name only. Four Notifly
application units carry an OAuth token inside their custom git URL; they are
referred to by unit name throughout and their URLs are never reproduced.

---

## 1. Current state

### 1.1 The live instance

| Fact | Value | How it was read |
|---|---|---|
| Running Dokploy version | `v0.30.5-community.1` | `settings.getDokployVersion` (read-only) |
| Latest upstream release tag it compares against | `v0.27.1` | `settings.getReleaseTag` (read-only) |
| Units on the instance | 247 total: 102 applications, 80 composes, 57 postgres, 6 redis, 1 mysql, 1 mongo | `overview.services` (read-only) |
| Units in the audit export | 89 applications, 42 compose units (201 compose service rows) | `S/dokploy/applications.csv`, `S/dokploy/composes.csv` |
| Units currently building on the build server | **0 of 131** - every row reads `buildsOn = DokployHost` | both CSVs |
| Units with a registry configured | **0 of 89** - `registryId`, `buildRegistryId` and `buildServerId` are empty on every application | `applications.csv` |

The instance already runs the fork, not upstream Dokploy: the version string
carries the `-community.1` suffix that only `DevinoSolutions/dokploy-community`
produces. The image is `ghcr.io/devinosolutions/dokploy-community`.

**The version string will not change when you roll #209 on.** The fork's
`apps/dokploy/package.json:3` on `canary` is already `v0.30.5-community.1`, the
same string the live instance reports. Version is therefore useless as a
rollout marker; pin and verify by **digest**.

**The export is smaller than the instance, and the gap is yours to close.** The
live instance has 102 applications and 80 compose units; the audit export in
`S/dokploy/` has 89 and 42. So roughly **13 applications and 38 compose units
are not in the tables in §4**, most likely created after the export was taken.
Before you flip the org-wide switch, re-export the unit list and classify the
missing ones by the same two rules in §4.1: a GitHub-sourced application is a
candidate, a compose unit is not. A unit you did not classify is a unit the
switch will enforce anyway.

### 1.2 The fork

| Fact | Value |
|---|---|
| Fork canary head when this was written | `b0cadcd296b377889b550b10a0ade25987192ea4`; since advanced by #211 (`3a27cec`) and #212 (`e92e4ad`), both runtime-neutral - see §3.1 |
| What it is | Merge of PR #209 `feat/build-policy` into `canary`, 2026-09-10 20:00:25 -0400 |
| Behavioural baseline (merge base) | `cf4abf059` |
| Size | 79 files changed, +22,568 / -41 |
| Review history | 4 rounds, final verdict MERGE (`S/track2/w6-review-2.md`) |
| Tests at the merged head | 2315 total / 2291 passed / 15 failed; failure set byte-identical to the `cf4abf059` baseline in both directions. 20 build-policy suites, 322 assertions, 0 failures |
| Typecheck | `./node_modules/.bin/tsc --noEmit` in `apps/dokploy`, exit 0 |

Verified in a fresh clone at `S/work/dokploy-plan`:
`git rev-parse HEAD` and `git ls-remote origin canary` both return `b0cadcd296…`.

### 1.3 What #209 adds

Eight behaviours, all in `packages/server/src/services/build-policy/` plus
listed hook points in upstream files.

| # | Behaviour | Files |
|---|---|---|
| 1 | Org setting `enforceRemoteBuilds`, unit exclusions, audited break-glass | `settings.ts`, `exclusions.ts`, `audit.ts` |
| 2 | Enforced units build on the org build server; **no silent local fallback** | `policy.ts`, `apply.ts` |
| 3 | Push `<repository>:<sha>`, capture the digest, deploy by digest | `apply.ts`, `image.ts` |
| 4 | Queue coalescing at enqueue time | `coalesce.ts`, `webhook.ts` |
| 5 | Derived default `watchPaths`, `[skip deploy]` commit marker | `watch-paths.ts`, `skip-deploy.ts`, `webhook.ts` |
| 6 | Per-unit `requiredChecks`, over check runs **and** commit statuses, applications and composes | `required-checks.ts`, `github-checks.ts`, `compose-checks.ts` |
| 7 | Deploy-hook body `{image, tag, digest}`, restricted to the unit's own repository | `hook-body.ts`, `pinned-deploy.ts` |
| 8 | Rollback to a stored digest with no build | `rollback.ts`, `pinned-deploy.ts` |

New schema: three tables (`build_policy_settings`, `build_policy_exclusion`,
`build_policy_audit`) plus an enum, and four nullable columns on existing
tables - `application.requiredChecks`, `compose.requiredChecks`,
`deployment.imageTag`, `deployment.imageDigest`. Migration
`apps/dokploy/drizzle/0200_handy_lifeguard.sql`, written idempotently
(`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`). No data migration.

New UI: a Build Policy card and an exclusions list under Settings, an audit
view, and a per-application Required Checks panel
(`apps/dokploy/components/dashboard/settings/build-policy.tsx`,
`build-policy-exclusions.tsx`, `build-policy-audit.tsx`,
`components/dashboard/application/advanced/show-required-checks.tsx`).

New tRPC router `buildPolicy` (`apps/dokploy/server/api/routers/build-policy.ts`).
`settings` and `exclusions` are `protectedProcedure`; `updateSettings`,
`addExclusion`, `removeExclusion`, `allowLocalBuildOnce`, `rollbackToDigest` and
`audit` are `adminProcedure`. The organization is read only from
`ctx.session.activeOrganizationId`, never from input.

### 1.4 Default-off confirmation, with references

The switch is off unless a row exists **and** its boolean is set.

| Claim | Reference |
|---|---|
| The column default is `false` | `packages/server/src/db/schema/build-policy.ts:58` - `enforceRemoteBuilds: boolean("enforceRemoteBuilds").notNull().default(false)` |
| An absent row means off, and a read never creates one | `schema/build-policy.ts:45-46` comment; `services/build-policy/settings.ts:9-22` (`findBuildPolicySettings` returns `row ?? null`) |
| The decision function returns upstream behaviour first | `services/build-policy/policy.ts:65-68` - `if (!settings?.enforceRemoteBuilds) return { mode: "local", reason: "not_enforced" }` |
| Enqueue-time paths short-circuit on one cached boolean | `services/build-policy/settings.ts:44-58` (`isBuildPolicyEnforcedAnywhere`, 5 s process-local cache) |
| Per-unit `requiredChecks` alone cannot change behaviour | round-2 finding E fix: the pre-build gate is policy-gated; `README.md` § "When the gate runs, and what it costs" |
| Asserted by tests, including the absence of calls | `apps/dokploy/__test__/build-policy/policy-off-is-upstream.test.ts` (450 lines), `required-checks-before-build.test.ts` |
| Re-verified at the two round-3 touch points | `S/track2/w6-review-2.md`, section "Default-off, re-verified at the two new touch points" |

Cost of the fork while off: one cached boolean read at enqueue time, and one
`build_policy_settings` SELECT on the deploy path. No extra SSH round trip, no
audit write, no organization lookup.

**So rolling the image and enabling the policy are two separate decisions.**
§2 and §3 cover the image roll, which changes no deploy behaviour. §4 covers
enabling, which does.

---

## 2. Pre-flight

Everything below runs on the prod host `devino` as root. Nothing here is
reversible by itself, so do it in order and keep the output.

### 2.1 Capture the rollback target first

This is the single most important step, and it has a trap. On GHCR the tags
`canary`, `latest` and `v0.30.5-community.1` **all already point at the #209
build** (manifest `sha256:8773cca09190ff905a8bedaebcd100dd295bef8eb56254a16f680eb91efee7e6`,
pushed 2026-09-11T00:09:20Z by workflow run 34544614934 at `b0cadcd`). The
pre-#209 image, built 2026-09-06 from `cf4abf059`, now carries **no tag at all**.
There is no tag you can roll back to. Capture the digest, and keep a local copy.

```
# 1. The digest the live service is actually running. This is authoritative.
docker service inspect dokploy \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'

# 2. Write it down, and also save it to a file on the host.
docker service inspect dokploy \
  --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' \
  > /root/dokploy-rollback-image.txt
cat /root/dokploy-rollback-image.txt

# 3. Save the image itself to a tar, so a GHCR retention sweep or a tag
#    overwrite cannot take your rollback away.
CURRENT=$(cat /root/dokploy-rollback-image.txt)
docker pull "$CURRENT"
docker save "$CURRENT" | gzip > /root/dokploy-rollback-image.tar.gz
ls -lh /root/dokploy-rollback-image.tar.gz
```

The likely value of step 1 is the multi-arch index
`sha256:e9a136f73b682e6e616b9fd961d6877a9a44df5ab8113e1f5850f18e232341c1`
(created 2026-09-06T18:28:49Z, the last index pushed by the `cf4abf059` build).
**Do not assume it.** Read it from the running service; if `docker service
inspect` returns a bare tag with no `@sha256:` suffix, get the digest from the
running task instead:

```
docker inspect "$(docker ps --filter name=dokploy. --format '{{.ID}}' | head -1)" \
  --format '{{.Image}} {{index .Config.Image}}'
docker image inspect "$CURRENT" --format '{{index .RepoDigests 0}}'
```

Second trap: `install.sh update` resolves `latest` by default
(`install.sh:354`). Running it today pulls the #209 build. Do not use it for
either direction of this rollout; use the explicit `docker service update`
commands below.

Third, a smaller point that is easy to misread as a bigger one:
**any merge to the fork's `canary` branch republishes the image and moves the
`canary`, `latest` and version tags to a new digest.**
`.github/workflows/dokploy.yml` triggers on `push: branches: [canary]` with no
`paths` filter, so even a docs-only merge rebuilds both architectures and runs
`docker buildx imagetools create` for all three tags.

**This does not invalidate the rollback digest.** Step 1 above reads the digest
off the *running service* on the host, not off a tag, and a republish only adds
a new version to the GHCR package - it does not delete or rewrite the old
manifest. The `docker save` in step 3 makes the point moot regardless. The real
consequences are narrower:

- **Re-read the digest you are rolling *to* if `canary` moves mid-window.**
  §3.2 pins a specific digest for the `b0cadcd` build; if something lands on
  `canary` between reading this and running the update, that digest is still
  valid and still `b0cadcd`, but `:canary` no longer points at it. Pin the
  digest, not the tag, and this stops mattering.
- **Untagged manifests are what retention sweeps collect.** Each republish
  leaves the previous build untagged, which is already how the pre-#209 image
  ended up with no tag. That is an argument for the `docker save`, not for
  freezing the branch.

A `paths-ignore: [docs/**]` on `dokploy.yml` removes the docs case entirely, so
a markdown edit stops producing a container image. That landed on `canary` as
PR #211 (`3a27cec`). It is hygiene, not a prerequisite for this rollout.

Worth stating plainly, because it is the question this raises: the fork itself
is **not** a Dokploy unit. `dokploy-community` appears in neither
`applications.csv` nor `composes.csv`, so merging to `canary` redeploys nothing
on the live instance. The only thing a merge changes is what is in the registry.
Rolling the instance is the separate, deliberate act in §3.

### 2.2 Database dump

Dokploy's own state is a Postgres swarm service `dokploy-postgres`, database
`dokploy`, user `dokploy`, password in the swarm secret named
`dokploy_postgres_password` mounted at `/run/secrets/postgres_password`.

```
# Find the running postgres task container.
PG=$(docker ps --filter name=dokploy-postgres --format '{{.ID}}' | head -1)
echo "$PG"

# Dump. PGPASSWORD is read from the mounted secret inside the container, so no
# password is ever typed on this shell or stored in history.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker exec "$PG" sh -c \
  'PGPASSWORD=$(cat /run/secrets/postgres_password) pg_dump -U dokploy -d dokploy --format=custom' \
  > "/root/dokploy-db-${STAMP}.dump"

ls -lh "/root/dokploy-db-${STAMP}.dump"
```

Verify the dump rather than trusting its size:

```
# Must list hundreds of TABLE DATA entries and exit 0.
pg_restore --list "/root/dokploy-db-${STAMP}.dump" | head -30
pg_restore --list "/root/dokploy-db-${STAMP}.dump" | wc -l

# The tables that matter must be present.
pg_restore --list "/root/dokploy-db-${STAMP}.dump" \
  | /usr/bin/grep -E ' (application|compose|deployment|server|registry|organization)$'
```

If `pg_restore` is not installed on the host, run the verify inside the postgres
container instead:

```
docker cp "/root/dokploy-db-${STAMP}.dump" "$PG:/tmp/check.dump"
docker exec "$PG" pg_restore --list /tmp/check.dump | wc -l
docker exec "$PG" rm -f /tmp/check.dump
```

Expected: a few thousand entries. A dump that lists under 100 entries did not
capture the instance and must not be relied on.

### 2.3 Docker volume backup

Three named volumes and one bind mount hold everything else.

| What | Kind | Holds |
|---|---|---|
| `dokploy-postgres` | volume | the database files (belt and braces alongside §2.2) |
| `dokploy-redis` | volume | the deployment queue |
| `dokploy` | volume | `/root/.docker`, registry credentials |
| `/etc/dokploy` | bind mount | traefik config, dynamic config, SSH keys, compose files, application code dirs |

```
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "/root/dokploy-backup-${STAMP}"

# Bind mount: straight tar, no container needed.
tar -czf "/root/dokploy-backup-${STAMP}/etc-dokploy.tar.gz" -C / etc/dokploy

# Named volumes: tar each through a throwaway alpine.
for V in dokploy-postgres dokploy-redis dokploy; do
  docker run --rm \
    -v "${V}:/src:ro" \
    -v "/root/dokploy-backup-${STAMP}:/out" \
    alpine tar -czf "/out/${V}.tar.gz" -C /src .
done

ls -lh "/root/dokploy-backup-${STAMP}/"
```

Verify each archive by listing it, not by looking at its size:

```
for F in "/root/dokploy-backup-${STAMP}"/*.tar.gz; do
  echo "== $F"
  tar -tzf "$F" | wc -l
  tar -tzf "$F" | head -5
done
```

Expected shapes: `etc-dokploy.tar.gz` contains `etc/dokploy/traefik/traefik.yml`
and entries under `etc/dokploy/applications/` and `etc/dokploy/compose/`;
`dokploy-postgres.tar.gz` contains `base/`, `pg_wal/` and `PG_VERSION`;
`dokploy.tar.gz` contains `config.json`. An archive listing zero entries is a
failed backup.

`dokploy-postgres.tar.gz` is taken while Postgres is running, so it is a
crash-consistent copy, not a clean one. The `pg_dump` in §2.2 is the restore
path you should actually plan to use; the volume tar is the fallback if the
dump itself turns out to be bad.

### 2.4 Expected downtime

| Phase | Duration | What is affected |
|---|---|---|
| Backups (§2.2 + §2.3) | 2 to 10 minutes | nothing; instance stays up |
| `docker service update --image` | 30 to 90 seconds of rolling replace | the Dokploy **UI and API** only |
| First boot: `wait-for-postgres` then `migration.mjs` then `server.mjs` | 20 to 60 seconds inside that window | same |
| Migration `0200` itself | sub-second: three `CREATE TABLE IF NOT EXISTS`, one enum, four `ADD COLUMN` on nullable columns, no table rewrite, no data migration | same |

**Deployed applications do not restart.** Dokploy is a control plane; the swarm
services it manages keep running through its replacement. Traefik
(`dokploy-traefik`) is a separate container and is untouched, so published
sites stay up. What is unavailable for that minute: the dashboard, the API, and
webhook-triggered deploys. A push landing in that window will have its webhook
delivery fail; GitHub retries, and the deploy can also be re-triggered by hand
afterwards.

Pick a window with no deploy in flight. Check first:

```
docker service logs dokploy --since 10m --tail 50
```

### 2.5 Rollback sequence

Back to the image captured in §2.1, at any point, without touching the database.

```
CURRENT=$(cat /root/dokploy-rollback-image.txt)

# If the image is still local or still on GHCR:
docker service update --image "$CURRENT" --force dokploy

# If GHCR no longer has it (untagged, so a retention sweep can reach it):
gunzip -c /root/dokploy-rollback-image.tar.gz | docker load
docker service update --image "$CURRENT" --force dokploy

# Watch it come back.
docker service ps dokploy --no-trunc | head -5
curl -fs http://localhost:3000/api/trpc/settings.health && echo OK
```

**The database does not need to be rolled back, and should not be.** Migration
`0200` is purely additive: three new tables the old image never queries, and
four nullable columns the old image never selects (drizzle emits explicit
column lists, not `SELECT *`). The old image's migration run on restart applies
only entries in its own journal, so it will not see `0200` and will not try to
undo it. Leaving the schema in place also means a second attempt at the roll
needs no migration at all.

Roll the database back **only** if the instance fails to start against it:

```
PG=$(docker ps --filter name=dokploy-postgres --format '{{.ID}}' | head -1)
docker service scale dokploy=0
docker cp "/root/dokploy-db-<STAMP>.dump" "$PG:/tmp/restore.dump"
docker exec "$PG" sh -c \
  'PGPASSWORD=$(cat /run/secrets/postgres_password) pg_restore -U dokploy -d dokploy --clean --if-exists /tmp/restore.dump'
docker exec "$PG" rm -f /tmp/restore.dump
docker service scale dokploy=1
```

Rollback of the **policy**, as opposed to the image, is cheaper and is what you
will almost certainly want instead: turn `enforceRemoteBuilds` off in Settings.
Every path in the module then short-circuits to upstream behaviour on the next
deploy, and no restart is needed - `upsertBuildPolicySettings` clears the
enforcement cache on write (`settings.ts:78-96`).

---

## 3. Rolling the fork onto the live instance

### 3.1 The image already exists

Workflow `.github/workflows/dokploy.yml` on the fork builds `linux/amd64` and
`linux/arm64` on every push to `canary` and combines them into one manifest
tagged `canary`, `latest` and the package.json version. Run 34544614934 for
`b0cadcd` completed `success` at 2026-09-11T00:00:29Z, and the manifest
`sha256:8773cca09190ff905a8bedaebcd100dd295bef8eb56254a16f680eb91efee7e6` was
pushed at 00:09:20Z.

So there is nothing to build. If you want to rebuild anyway, re-run that
workflow rather than building on the prod host - a local `docker buildx build`
of this image on `devino` is exactly the prod-host build load the whole
programme exists to remove.

**`canary` has moved since that build, and the moves are runtime-neutral.**
Two follow-ups to #209 landed on 2026-09-11: #211 (`3a27cec`), the
`paths-ignore` on this workflow, and #212 (`e92e4ad`), one added namespace in a
test mock. Neither changes a line the running container executes - one is a CI
trigger, the other is a file under `__test__/`. Both nevertheless rebuilt the
image and moved the `canary`, `latest` and version tags, because they are not
under `docs/**`. Either build is a valid rollout target; the current head is
the tidier choice, because it is the one whose test suite is green.

### 3.2 Pin by digest, not by tag

Resolve the digest for the commit you mean, rather than trusting a tag:

```
# The current canary head, and the manifest its build published.
gh api repos/DevinoSolutions/dokploy-community/commits/canary --jq .sha
docker buildx imagetools inspect ghcr.io/devinosolutions/dokploy-community:canary \
  --format '{{.Manifest.Digest}}'

NEW=ghcr.io/devinosolutions/dokploy-community@<that digest>

docker pull "$NEW"
docker image inspect "$NEW" --format '{{.Created}} {{index .RepoDigests 0}}'
```

The `b0cadcd` build - #209 exactly, before the two follow-ups - remains valid
and pinnable at
`sha256:8773cca09190ff905a8bedaebcd100dd295bef8eb56254a16f680eb91efee7e6`
if you would rather roll the reviewed commit and nothing else.

Using a digest and not `:canary` is the point either way: `canary` moves on
every push that touches something outside `docs/**`, and a later unrelated push
would silently change what a `--force` update pulls.

### 3.3 The switch

```
docker service update --image "$NEW" --force dokploy

# Follow the replacement.
docker service ps dokploy --no-trunc | head -5
docker service logs dokploy --since 5m --follow
```

In the logs you should see, in order: the `wait-for-postgres` probe succeeding,
the drizzle migrator applying `0200_handy_lifeguard`, then the Next.js server
listening. The healthcheck in the Dockerfile polls
`http://localhost:3000/api/trpc/settings.health` every 30 s with a 60 s start
period; the task goes `healthy` on the first success.

### 3.4 Verification checklist

Run all of it. Anything that fails is a rollback trigger, not a puzzle to solve
with the instance in this state.

**A. The control plane is up.**

```
curl -fs http://localhost:3000/api/trpc/settings.health && echo HEALTH-OK
docker service ps dokploy --format '{{.CurrentState}} {{.Error}}' | head -3
```
Then load the dashboard in a browser and confirm the projects list renders.

**B. The migration landed and the policy is off.**

```
PG=$(docker ps --filter name=dokploy-postgres --format '{{.ID}}' | head -1)

# Three new tables exist.
docker exec "$PG" sh -c \
  'PGPASSWORD=$(cat /run/secrets/postgres_password) psql -U dokploy -d dokploy -c "\dt build_policy_*"'

# And there are zero rows, which is what "off" looks like.
docker exec "$PG" sh -c \
  'PGPASSWORD=$(cat /run/secrets/postgres_password) psql -U dokploy -d dokploy -t -c "SELECT count(*) FROM build_policy_settings;"'
```
Expected: three tables listed, count `0`. A count of 0 means every unit still
builds exactly where it did yesterday, because `policy.ts:65` returns
`not_enforced` on a missing row.

In the UI: Settings shows a Build Policy card with the enforcement toggle
**off**, no default build server and no default registry selected.

**C. Existing deploys are unaffected.**

The strongest single check is a deploy of a unit you do not mind redeploying.
Pick `Devino Landing Page / NextJS DEV` (dev branch, single-purpose repo,
`autoDeploy` on) and push a trivial commit, or hit Redeploy in the UI.

```
# The build must still run on the Dokploy host, not a build server.
docker events --since 2m --filter event=create --filter type=image | head
```
Expected, all four: a deployment row appears; its log shows a local
`docker build` / nixpacks build on `devino`; the deployment reaches `done`;
and the deployment row's new `imageTag` / `imageDigest` columns are **null**
(they are only written by an enforced deploy).

```
docker exec "$PG" sh -c \
  'PGPASSWORD=$(cat /run/secrets/postgres_password) psql -U dokploy -d dokploy -t -c "SELECT \"imageTag\", \"imageDigest\" FROM deployment ORDER BY \"createdAt\" DESC LIMIT 3;"'
```

**D. The enqueue-time paths did not change.**

Confirm on the same push that none of the policy's enqueue behaviours fired:
the webhook returned 200 and not 301 (a 301 is the derived-`watchPaths` skip),
the deployment was not coalesced away, and `build_policy_audit` is empty.

```
docker exec "$PG" sh -c \
  'PGPASSWORD=$(cat /run/secrets/postgres_password) psql -U dokploy -d dokploy -t -c "SELECT count(*) FROM build_policy_audit;"'
```
Expected: `0`.

**E. Nothing regressed in the areas #209 touched but did not intend to change.**

Spot-check, in the UI: a compose unit's Redeploy button still works; the
deployments list for one application still renders its history; a preview
deployment for an open PR still appears; rollback on a unit with
`rollbackActive` still offers its snapshot.

### 3.5 Detecting regressions in the first hour

The failure modes worth watching are all cheap to watch.

| Signal | Command / place | What a bad reading looks like |
|---|---|---|
| Task restarts | `docker service ps dokploy` | more than one `Shutdown` entry, or a task flapping |
| Errors in the control plane | `docker service logs dokploy --since 1h \| /usr/bin/grep -iE 'error\|unhandled\|ECONN'` | anything naming `build-policy`, `buildPolicySettings` or `drizzle` |
| Deploys still completing | Dokploy dashboard, deployments list | a deployment stuck in `running` past its usual duration |
| Deploys silently not happening | `build_policy_audit` count, and the webhook delivery list on a repo you pushed to | a `deploy_skipped` row, or a 301 response on a delivery |
| Queue depth | `docker service logs dokploy --since 1h \| /usr/bin/grep -i queue` | deployments piling up behind one job |
| Memory | `docker stats --no-stream $(docker ps --filter name=dokploy. -q \| head -1)` | steady growth over the hour |
| Sites still served | the published domains, or Uptimely | any site down (would indicate traefik disruption, which this change should not cause) |

A useful hour-long passive check, because it needs no instrumentation: let the
fleet's normal push traffic run, then confirm the deployment count in that hour
matches a typical hour, and that `build_policy_audit` is still empty.

**Rollback triggers, decided in advance.** Roll back with §2.5 if any of these
appear, without further diagnosis:

1. The `dokploy` service does not reach `healthy` within 5 minutes.
2. Migration `0200` errors in the logs.
3. Any deployment that used to succeed now fails, on any unit.
4. A `build_policy_audit` row appears while `build_policy_settings` is empty
   (that would mean the default-off claim is wrong on this instance).
5. The dashboard renders but the projects or deployments list does not.


---

## 4. Enabling build-once, unit by unit

### 4.1 Read this before flipping anything

**Candidacy is not what the programme brief's shorthand suggests.** The brief's
test was "CI already builds and pushes an image the unit could deploy". Measured
across the fleet, exactly **one** repo publishes an image
(`sendly/publish-web-image.yml` to `ghcr.io/devinosolutions/sendly-web`,
`:latest` + `:main-<sha>`, `workflow_dispatch` only) and exactly **one** repo
calls a Dokploy deploy hook (`caly/deploy-caly-web.yml`, which posts the push
payload, not an image body). They are different repos.
Source: `S/review-products.md` § 2, the CI-image table and its reading.

So under that test, 0 of 131 units qualify today. That is not how #209 works.
#209 inverts the flow: **Dokploy becomes the publisher.** An enforced unit
builds on the org build server, is tagged `<appName>:<sha>`
(`services/build-policy/image.ts:26`), pushed to the org registry as
`<registry>/<prefix>/<appName>:<sha>`, and deployed by digest. CI never needs to
publish anything; it waits for the image via the `wait-for-image` composite
action from Track 2 §5.5.

The candidacy test that actually applies is therefore:

1. the unit is an **application**, not a compose unit (see 4.2);
2. its source is github.com - `sourceType: "github"`, or `sourceType: "git"`
   with a github.com `customGitUrl` (`services/build-policy/source.ts:38-44`).

The deploy-hook `{image, tag, digest}` body (behaviour 7) is the other door, for
a repo that later decides to publish its own image. Today only sendly could use
it, and sendly's Dokploy unit is a `raw` compose that pins digests by hand, so
it cannot: a compose deploy hook **refuses** an image body with a 400 while the
org enforces (`pages/api/deploy/compose/[refreshToken].ts:250-257`). Leave
sendly alone.

**Three prerequisites before any unit is enabled.** None of them is in #209.

| Prerequisite | State | Where |
|---|---|---|
| A build server registered and reachable | Registered as Main Build Server `z23s7X5TGtmf0VRFc3Q43` on `devino-second`; **never used** - 0 of 1,296 deployments since 2025-09-01 | spec §1, §5.3 |
| A registry the instance can push to and pull from | `registry.devino.ca` is configured and unused (11 repos); the design makes it a pull-through proxy of GHCR. **Neither the proxy nor a registry record for it exists yet.** Every application's `registryId` is empty | spec §5.4; `applications.csv` |
| `buildsConcurrency` raised above 1 | Not done. On a self-hosted instance every job lands in the single `LOCAL_PARTITION` with concurrency `buildsConcurrency ?? 1` | README § "When the gate runs, and what it costs" |

If you set `enforceRemoteBuilds` with no default build server or no default
registry, every enforced deploy **fails** with `NO_BUILD_SERVER` or `NO_REGISTRY`
(`policy.ts:112-133`). That is deliberate - there is no silent local fallback -
but it means the switch is not the first step.

**And read this line twice.** Enabling `enforceRemoteBuilds` is org-wide, not
per-unit. The moment it is on, five things change for **every** GitHub-sourced
unit in the organization at once, whether or not you meant to enable that unit:

1. **Derived `watchPaths` start filtering pushes.** Any unit with a build path
   and no explicit `watchPaths` gets `<buildPath>/**`. In a monorepo a push
   touching only `packages/**` stops at the webhook with a 301 and no
   deployment record. README calls this "the single highest-blast-radius
   consequence". **80 of 89 application units and 39 of 42 compose units have
   no explicit `watchPaths` today.** The nine applications that do are BioFlow
   `Landing`, Caly `caly-landing`, all five SuperBooks units, upAPI `docs` and
   uNotes `pdf2html Dev`. The heaviest monorepos - marka, shorty, caly, uNotes,
   Postify, BioFlow `Web` and `Workers`, upAPI `web` and `landing` - are
   exactly the ones without them.
2. Every GitHub-sourced **application**'s build moves to the build server.
3. Queued deploys start coalescing (previews excluded).
4. `[skip deploy]` starts being honoured.
5. A deploy-hook body carrying `image` stops being ignored: validated on an
   application, 400 on a compose.

Required checks are a **separate** opt-in on top, per unit, and nothing waits on
CI until you set them.

**The safe sequencing that follows from this:** set explicit `watchPaths` on
every monorepo unit *first*, add exclusions for everything you are not ready to
move *second*, and only then flip the switch. Batch 1 is then genuinely the
first thing that moves.

### 4.2 Compose units cannot relocate their build, and that is permanent here

`decideBuildPolicy` returns `local` / `compose_build_not_relocatable` for every
compose unit (`policy.ts:104-106`), because a compose unit builds and runs in a
single `docker compose up --build` and splitting that would require every
buildable service to declare an `image:` key pointing at the org registry.

What a compose unit **does** get: queue coalescing, `[skip deploy]`, derived
`watchPaths`, and `requiredChecks` (on deploy, Redeploy and both preview paths).
What it does **not** get: exclusions, break-glass, and the relocated build. The
router refuses a `composeId` on `addExclusion` and `allowLocalBuildOnce` with a
400 rather than writing a row nothing reads.

Operationally this matters a great deal for the double-build story. **42 of the
131 units are compose units, and they include most of the heavy stacks**:
GetItDone (both), uNotes (both), BioFlow (both), demofy, SafeMeet, Notifly,
Postify (both), Shorty (both), Uptimely (both plus rehearsal), dodomain (both),
upAPI `iii`, DoDomain, Dub, SnapVisor. Their Dokploy-host build is **not**
removed by #209. Only their webhook-side waste (bursts, docs-only pushes) is.

### 4.3 The exact settings to flip

**Org-wide, once** - Settings, Build Policy card
(`components/dashboard/settings/build-policy.tsx`), or `buildPolicy.updateSettings`:

| Field | Column | Set to |
|---|---|---|
| Default build server | `build_policy_settings.defaultBuildServerId` | `z23s7X5TGtmf0VRFc3Q43` (Main Build Server, `devino-second`) |
| Default registry | `build_policy_settings.defaultRegistryId` | the registry record for the GHCR pull-through proxy, once it exists |
| Required-checks timeout | `build_policy_settings.requiredChecksTimeoutMinutes` | leave at `5` |
| Enforce remote builds | `build_policy_settings.enforceRemoteBuilds` | `true` - **last**, after the two above and after the exclusions below |

The toggle is `adminProcedure`. Writing it clears the enforcement cache
immediately (`settings.ts:78-96`), so there is no restart and no TTL wait.

**Per unit that must keep building locally** - Settings, Build Policy
Exclusions (`build-policy-exclusions.tsx`), or `buildPolicy.addExclusion` with
`{applicationId, reason}`. Applications only; a `composeId` is refused with a
400. Every add writes an `exclusion_added` audit row.

Exclusions you want on day one, per spec §5.2.2 and the shape of this fleet:

- the Dokploy fork's own deployment, if it is ever made a unit (it is in neither
  CSV today, so there is nothing to exclude yet);
- runner-infra's deployment, same;
- the registry's own unit, same;
- **every application in a batch you have not reached yet.** This is the real
  use of exclusions here. Because the switch is org-wide, the only way to roll
  out in batches is to exclude batches 2..22 before flipping it, then remove
  one batch's exclusions at a time.

**Per unit, to gate on CI** - the application's Advanced tab, Required Checks
panel (`components/dashboard/application/advanced/show-required-checks.tsx`), or
`application.update` / `compose.update` with `requiredChecks: [...]`.

Empty is the default and means ungated. A non-empty list is refused with a 400
unless the unit has all three of: a github.com source, a resolvable
`owner`/`repo`, and a GitHub App installation (`githubId`). Clearing to `[]` is
always allowed.

**Break-glass** - `buildPolicy.allowLocalBuildOnce`, admin only, applications
only, applies to the next deploy and writes `break_glass_granted` then
`break_glass_consumed`.

### 4.4 Required-checks mapping

Set `requiredChecks` only after a unit has run at least one enforced deploy
successfully. Two traps:

- **The check must exist on the deployed commit.** `requiredChecks` reads check
  runs and commit statuses for the sha being deployed. A repo whose CI runs only
  on `pull_request` has no check runs on the merge commit that lands on `main`,
  so the deploy waits the full timeout and fails with
  `REQUIRED_CHECKS_TIMEOUT`. Track 1's W1 restricted push triggers to `main`
  and `dev` rather than removing them, so main pushes do still run CI - confirm
  per repo before gating.
- **The name must match exactly.** Read it off a real commit rather than from
  this table:
  ```
  gh api repos/DevinoSolutions/<repo>/commits/<sha>/check-runs \
    --jq '.check_runs[].name'
  ```

Recommended gate per repo, taken from the jobs that actually ran on the pool in
the 30 days to 2026-09-10 (`S/cost/jobs/`, aggregated in
`S/track5/jobagg.txt`). `n` is that job's run count in the window.

| Repo | Recommended `requiredChecks` | n |
|---|---|---|
| BioFlow | `validate` | 40 |
| GetItDone | `Build` | 49 |
| SafeMeet | `Lint · Typecheck · Test` | 30 |
| demofy | `hard rules · format · lint · tsc · knip · vitest` | 64 |
| dodomain | `typecheck · test · build` | 22 |
| marka | `TypeScript + Vitest` | 11 |
| notifly | `Build, lint, and test` | 13 |
| postify | `gates` | 39 |
| snapvisor | `static-analysis` | 10 |
| superbooks | `next build (web, landing, docs)` | 32 |
| shorty | `repo-guards` | 19 |
| upAPI | `Repo invariants`, `Node quality gate` | 51 |
| uNotes | `Compose Parity Gate` | 27 |
| uptimely | `Lint, format, typecheck, knip, test, build` | 6 |
| voicelabs | `backend-quality`, `frontend-quality` | 29 |
| lead-gen-system | `all gates` | 22 |
| caramel-coupons | `test` | 22 |
| github-lead-gen | `ci / tests (pytest, network blocked)` | 12 |
| sendly | `Build (all apps)` | 20 |
| devino-landing-page | `Build (next build)` | 2 |
| caly | **leave empty** - no CI gate runs on a `main` push; the pool jobs are a PWA prod probe and PR title validation | - |
| syncara | **leave empty** - one pool job in 30 days | 1 |

Repos with **no pool CI at all** in the window, so no check to require - leave
`requiredChecks` empty on every unit sourced from them: `anotifier-landing`,
`usepostify`, `postify-landing`, `caramel`, `google-lead-gen`, `gpu-service`,
`upup`, `usesend`, `magent-landing`, `stealthly-landing`, `wellfound_scraper`,
`upwork-lead-gen`, `google-maps-lead-gen`, `contra-lead-gen-new`,
`dokploy-webhook-relay`, `voicelabs-web`.

Note the consequence: **16 of the repos behind these units have no CI gate to
attach**, so for a large part of the fleet build-once buys the relocated build
and the coalescing, and nothing else.

Before enabling required checks anywhere, raise `buildsConcurrency`
(Settings, or `settings.updateBuildsConcurrency`) to at least 3. The wait holds
a deployment slot, and on a self-hosted instance there is one.

### 4.5 Application units, in rollout order

Ordering rule: landing and docs units first (a bad deploy is visible and
harmless), then `dev`-branch units, then production units, then the seven
custom-git units last. Four units per batch.

| # | Project | Unit | Source | Repo / branch | Auto | Build | Candidate | Batch |
|---|---|---|---|---|---|---|---|---|
| 1 | Devino Landing Page | NextJS DEV | `github` | devino-landing-page @ `dev` | yes | nixpacks | yes - GitHub App application | 1 |
| 2 | Postify | nextjs - landing page | `github` | postify-landing @ `dev` | yes | nixpacks | yes - GitHub App application | 1 |
| 3 | Anotifier | landing | `github` | anotifier-landing @ `main` | yes | dockerfile | yes - GitHub App application | 1 |
| 4 | BioFlow | Landing | `github` | BioFlow @ `main` | no | nixpacks | yes - GitHub App application | 1 |
| 5 | Caly | caly-landing | `github` | caly @ `main` | yes | dockerfile | yes - GitHub App application | 2 |
| 6 | Devino Landing Page | NextJS | `github` | devino-landing-page @ `main` | yes | nixpacks | yes - GitHub App application | 2 |
| 7 | DoDomain | Landing | `github` | dodomain @ `main` | no | dockerfile | yes - GitHub App application | 2 |
| 8 | Marka | marka-docs | `github` | marka @ `main` | yes | dockerfile | yes - GitHub App application | 2 |
| 9 | Notifly | Notifly Docs | `github` | notifly @ `main` | yes | dockerfile | yes - GitHub App application | 3 |
| 10 | Postify | Landing Page | `github` | usepostify @ `main` | no | dockerfile | yes - GitHub App application | 3 |
| 11 | SnapVisor | Snapvisor Docs | `github` | snapvisor @ `main` | yes | dockerfile | yes - GitHub App application | 3 |
| 12 | SnapVisor | Snapvisor Landing | `github` | snapvisor @ `main` | yes | dockerfile | yes - GitHub App application | 3 |
| 13 | Stealthly | Landing | `github` | stealthly-landing @ `main` | yes | dockerfile | yes - GitHub App application | 4 |
| 14 | SuperBooks | docs | `github` | superbooks @ `main` | yes | nixpacks | yes - GitHub App application | 4 |
| 15 | SuperBooks | landing | `github` | superbooks @ `main` | yes | nixpacks | yes - GitHub App application | 4 |
| 16 | Uptimely | Landing | `github` | uptimely @ `master` | no | dockerfile | yes - GitHub App application | 4 |
| 17 | mAgent | Landing | `github` | magent-landing @ `main` | yes | dockerfile | yes - GitHub App application | 5 |
| 18 | upAPI | docs | `github` | upAPI @ `main` | yes | dockerfile | yes - GitHub App application | 5 |
| 19 | upAPI | landing | `github` | upAPI @ `main` | yes | dockerfile | yes - GitHub App application | 5 |
| 20 | voicekit | VoiceLabs Docs | `github` | voicelabs @ `main` | yes | dockerfile | yes - GitHub App application | 5 |
| 21 | Caramel | NextJS | `github` | caramel @ `dev` | no | nixpacks | yes - GitHub App application | 6 |
| 22 | ContraBot | Contra Lead Gen DEV | `github` | contra-lead-gen-new @ `dev` | no | dockerfile | yes - GitHub App application | 6 |
| 23 | GPU Service | Celery Worker Dev | `github` | gpu-service @ `dev` | yes | dockerfile | yes - GitHub App application | 6 |
| 24 | GPU Service | GPU Django APP Dev | `github` | gpu-service @ `dev` | yes | nixpacks | yes - GitHub App application | 6 |
| 25 | GPU Service | Realtime FastAPI Dev | `github` | gpu-service @ `dev` | yes | nixpacks | yes - GitHub App application | 7 |
| 26 | GitHub Lead Gen | github-lead-gen-dev | `github` | github-lead-gen @ `dev` | no | dockerfile | yes - GitHub App application | 7 |
| 27 | GoogleLeadGen | Google Lead Gen DEV | `github` | google-lead-gen @ `dev` | yes | dockerfile | yes - GitHub App application | 7 |
| 28 | Postify | NextJS APP DEV | `github` | postify @ `dev` | yes | nixpacks | yes - GitHub App application | 7 |
| 29 | Postify | Worker | `github` | postify @ `dev` | yes | nixpacks | yes - GitHub App application | 8 |
| 30 | Shorty | Mastra Dev | `github` | shorty @ `dev` | no | dockerfile | yes - GitHub App application | 8 |
| 31 | Shorty | NextJS | `github` | shorty @ `dev` | no | nixpacks | yes - GitHub App application | 8 |
| 32 | Shorty | iii Dev | `github` | shorty @ `dev` | no | dockerfile | yes - GitHub App application | 8 |
| 33 | Syncara | Drip Cron Service | `github` | syncara @ `dev` | no | dockerfile | yes - GitHub App application | 9 |
| 34 | Syncara | NextJS DEV | `github` | syncara @ `dev` | no | nixpacks | yes - GitHub App application | 9 |
| 35 | UpUp | UpupDEV | `github` | upup @ `dev` | no | nixpacks | yes - GitHub App application | 9 |
| 36 | UpUp | upup-playground-dev | `github` | upup @ `dev` | no | nixpacks | yes - GitHub App application | 9 |
| 37 | uNotes | Mastra Dev | `github` | uNotes @ `dev` | no | nixpacks | yes - GitHub App application | 10 |
| 38 | uNotes | SocketDev | `github` | uNotes @ `dev` | no | nixpacks | yes - GitHub App application | 10 |
| 39 | uNotes | iii Dev | `github` | uNotes @ `dev` | no | nixpacks | yes - GitHub App application | 10 |
| 40 | uNotes | nextjs | `github` | uNotes @ `dev` | no | nixpacks | yes - GitHub App application | 10 |
| 41 | uNotes | pdf2html Dev | `github` | uNotes @ `dev` | no | dockerfile | yes - GitHub App application | 11 |
| 42 | BioFlow | Web | `github` | BioFlow @ `main` | no | nixpacks | yes - GitHub App application | 11 |
| 43 | BioFlow | Workers | `github` | BioFlow @ `main` | no | dockerfile | yes - GitHub App application | 11 |
| 44 | Caly | caly-api | `github` | caly @ `main` | yes | dockerfile | yes - GitHub App application | 11 |
| 45 | Caly | caly-web | `github` | caly @ `main` | yes | dockerfile | yes - GitHub App application | 12 |
| 46 | Caly | iii-cron | `github` | caly @ `main` | yes | dockerfile | yes - GitHub App application | 12 |
| 47 | Caramel | CouponScraper | `github` | caramel-coupons @ `main` | no | nixpacks | yes - GitHub App application | 12 |
| 48 | Caramel | CouponScraper (Dokploy) | `github` | caramel-coupons @ `main` | no | nixpacks | yes - GitHub App application | 12 |
| 49 | Caramel | NextJS ( Dokploy ) | `github` | caramel @ `main` | no | nixpacks | yes - GitHub App application | 13 |
| 50 | ContraBot | Contra Lead Gen PROD | `github` | contra-lead-gen-new @ `main` | yes | dockerfile | yes - GitHub App application | 13 |
| 51 | DoDomain | Web | `github` | dodomain @ `main` | no | dockerfile | yes - GitHub App application | 13 |
| 52 | GPU Service | GPU Django APP Prod | `github` | gpu-service @ `main` | yes | nixpacks | yes - GitHub App application | 13 |
| 53 | GPU Service | Realtime FastAPI Prod | `github` | gpu-service @ `main` | yes | nixpacks | yes - GitHub App application | 14 |
| 54 | GitHub Lead Gen | github-lead-gen | `github` | github-lead-gen @ `main` | yes | dockerfile | yes - GitHub App application | 14 |
| 55 | Google Maps Lead Gen | google-maps-lead-gen | `github` | google-maps-lead-gen @ `main` | yes | dockerfile | yes - GitHub App application | 14 |
| 56 | GoogleLeadGen | Google Lead Gen | `github` | google-lead-gen @ `main` | yes | dockerfile | yes - GitHub App application | 14 |
| 57 | Infrastructure | webhook-relay | `github` | dokploy-webhook-relay @ `main` | yes | dockerfile | yes - GitHub App application | 15 |
| 58 | Lead Gen System | Dashboard | `github` | lead-gen-system @ `main` | yes | nixpacks | yes - GitHub App application | 15 |
| 59 | Marka | iii | `github` | marka @ `main` | yes | dockerfile | yes - GitHub App application | 15 |
| 60 | Marka | marka-ai | `github` | marka @ `main` | yes | dockerfile | yes - GitHub App application | 15 |
| 61 | Marka | web | `github` | marka @ `main` | yes | dockerfile | yes - GitHub App application | 16 |
| 62 | Notifly | Notifly Dashboard | `github` | notifly @ `main` | no | dockerfile | yes - GitHub App application | 16 |
| 63 | Postify | Postify - NextJs | `github` | usepostify @ `main` | no | dockerfile | yes - GitHub App application | 16 |
| 64 | Postify | Postify Mastra | `github` | usepostify @ `main` | no | dockerfile | yes - GitHub App application | 16 |
| 65 | Postify | Postify Workers | `github` | usepostify @ `main` | no | dockerfile | yes - GitHub App application | 17 |
| 66 | Shorty | Mastra PROD | `github` | shorty @ `main` | no | dockerfile | yes - GitHub App application | 17 |
| 67 | Shorty | NextJS PROD (Dokploy) | `github` | shorty @ `main` | no | nixpacks | yes - GitHub App application | 17 |
| 68 | Shorty | iii PROD (Dokploy) | `github` | shorty @ `main` | no | dockerfile | yes - GitHub App application | 17 |
| 69 | SuperBooks | iii-engine | `github` | superbooks @ `main` | yes | nixpacks | yes - GitHub App application | 18 |
| 70 | SuperBooks | mastra | `github` | superbooks @ `main` | yes | nixpacks | yes - GitHub App application | 18 |
| 71 | SuperBooks | web | `github` | superbooks @ `main` | yes | nixpacks | yes - GitHub App application | 18 |
| 72 | Syncara | Drip Cron Service | `github` | syncara @ `main` | yes | dockerfile | yes - GitHub App application | 18 |
| 73 | Syncara | NextJS PROD | `github` | syncara @ `main` | no | nixpacks | yes - GitHub App application | 19 |
| 74 | Syncara | usesend-app | `github` | usesend @ `main` | yes | dockerfile | yes - GitHub App application | 19 |
| 75 | UpUp | UpupPROD | `github` | upup @ `master` | yes | nixpacks | yes - GitHub App application | 19 |
| 76 | Uptimely | Web | `github` | uptimely @ `master` | no | nixpacks | yes - GitHub App application | 19 |
| 77 | Upwork Lead Gen | Upwork Lead Gen PROD | `github` | upwork-lead-gen @ `main` | yes | dockerfile | yes - GitHub App application | 20 |
| 78 | Wellfound Lead Gen | Wellfound Lead Gen PROD | `github` | wellfound_scraper @ `main` | yes | dockerfile | yes - GitHub App application | 20 |
| 79 | upAPI | web | `github` | upAPI @ `main` | yes | dockerfile | yes - GitHub App application | 20 |
| 80 | voicekit | voicelabs-web | `github` | voicelabs-web @ `main` | no | dockerfile | yes - GitHub App application | 20 |
| 81 | DoDomain | DoDomain Landing | `git` | custom git URL (github.com) @ `main` | no | dockerfile | yes if `githubId` present - verify first | 21 |
| 82 | DoDomain | DoDomain Web | `git` | custom git URL (github.com) @ `main` | no | dockerfile | yes if `githubId` present - verify first | 21 |
| 83 | Notifly | Notifly API | `git` | custom git URL (github.com) @ `main` | no | dockerfile | yes if `githubId` present - verify first | 21 |
| 84 | Notifly | Notifly Landing | `git` | custom git URL (github.com) @ `main` | no | dockerfile | yes if `githubId` present - verify first | 21 |
| 85 | Notifly | Notifly WS | `git` | custom git URL (github.com) @ `main` | no | dockerfile | yes if `githubId` present - verify first | 22 |
| 86 | Notifly | Notifly Worker | `git` | custom git URL (github.com) @ `main` | no | dockerfile | yes if `githubId` present - verify first | 22 |
| 87 | Personal Portfolio | Portfolio Next.js | `git` | custom git URL (github.com) @ `main` | yes | dockerfile | yes if `githubId` present - verify first | 22 |
| 88 | UseSend | usesend-app | `docker` | registry image @ `` | no | nixpacks | no - `docker` source, policy inert (`not_github`) | - |
| 89 | UseSend | usesend-smtp-proxy | `docker` | registry image @ `` | yes | nixpacks | no - `docker` source, policy inert (`not_github`) | - |

**Batch grouping.**

| Batches | Units | Character |
|---|---|---|
| 1 to 5 | 1-20 | Landing and docs. Start here. Batch 1 is two dev-branch landings plus two standalone landing repos - the lowest-consequence four units on the instance |
| 6 to 11 | 21-41 | `dev`-branch application units. A broken deploy affects a staging surface |
| 11 to 20 | 42-80 | Production application units, grouped by project so a project's units move together |
| 21 to 22 | 81-87 | The seven `sourceType: "git"` units. Last, and conditional - see below |

**The seven custom-git units need work before they are touched.** All seven
point at github.com, so the policy *will* enforce them once the switch is on,
but:

- four Notifly units (`Notifly API`, `Notifly Landing`, `Notifly WS`,
  `Notifly Worker`) embed a GitHub OAuth token in their git URL. Spec §10 lists
  rotating that token and moving those apps to the GitHub App provider as an
  owner prerequisite. Do that first; it is a security item independent of this
  rollout;
- `DoDomain Landing` and `DoDomain Web` point at a personal fork
  (`BSalaeddin/dodomain`), not the org repo, so their check runs and their
  GitHub App installation are not the org's;
- `Portfolio Next.js` points at a personal repo.

For all seven, verify `githubId` is non-null before setting any
`requiredChecks`; `describeRequiredChecksSupport` will refuse otherwise
(`source.ts:70-100`). If you are not ready, add exclusions and leave them local.

**Two units are never candidates**: `UseSend / usesend-app` and
`UseSend / usesend-smtp-proxy` are `sourceType: "docker"`, so
`decideBuildPolicy` returns `not_github` and the module is inert for them
(`policy.ts:70-72`). Nothing to do.

### 4.6 Compose units

None of these relocates its build. They are listed so the coalescing,
`watchPaths` and `requiredChecks` half is deliberate rather than a surprise.
Enable in batches of five, after the application batches, and set explicit
`watchPaths` on each **before** the org switch is flipped.

| # | Project | Compose unit | Source | Repo / branch | Auto | Services (with build) | Gets | Batch |
|---|---|---|---|---|---|---|---|---|
| 1 | Amazon Buy Bot | amazon-buy-bot | `github` | DevinoSolutions/amazon-buy-bot @ `main` | yes | 2 (2) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C1 |
| 2 | BioFlow | BioFlow Stack | `github` | DevinoSolutions/BioFlow @ `main` | yes | 7 (4) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C1 |
| 3 | BioFlow | BioFlow Stack Dev | `github` | DevinoSolutions/BioFlow @ `main` | no | 7 (4) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C1 |
| 4 | Caramel | Caramel Prod Compose (LIVE) | `github` | DevinoSolutions/caramel @ `main` | no | 2 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C1 |
| 5 | Caramel | caramel-compose | `github` | DevinoSolutions/caramel @ `dev` | yes | 2 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C1 |
| 6 | Caramel Coupon Bot (LIVE) | coupon-bot-stack | `github` | DevinoSolutions/caramel-coupons @ `main` | no | 3 (2) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C2 |
| 7 | Demofy | demofy-stack | `github` | DevinoSolutions/demofy @ `main` | yes | 6 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C2 |
| 8 | DoDomain | dodomain-rehearsal | `github` | DevinoSolutions/dodomain @ `main` | no | 5 (3) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C2 |
| 9 | DoDomain | dodomain-stack | `github` | DevinoSolutions/dodomain @ `main` | yes | 5 (3) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C2 |
| 10 | Dub | dub-stack | `github` | DevinoSolutions/dub @ `deploy` | yes | 12 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C2 |
| 11 | GPU Service | Celery Worker Prod | `github` | DevinoSolutions/gpu-service @ `main` | yes | 1 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C3 |
| 12 | GetItDone | GetItDone Compose (DEV — live, autodeploy) | `github` | DevinoSolutions/GetItDone @ `dev` | yes | 9 (7) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C3 |
| 13 | GetItDone | GetItDone Compose (PROD) | `github` | DevinoSolutions/GetItDone @ `main` | yes | 9 (7) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C3 |
| 14 | Lead Gen System | Lead Gen Workers | `github` | DevinoSolutions/lead-gen-system @ `main` | no | 1 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C3 |
| 15 | Lead Gen System | Lead Gen Workers | `github` | DevinoSolutions/lead-gen-system @ `master` | yes | 1 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C3 |
| 16 | Marka | iii | `github` | DevinoSolutions/marka @ `main` | yes | 1 (0) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C4 |
| 17 | Notifly | notifly-mig-cutover | `raw` | - @ `-` | yes | 1 (0) | coalescing only - no commit, no checks | - |
| 18 | Notifly | notifly-rehearsal | `github` | DevinoSolutions/notifly @ `feat/one-root-compose` | no | 7 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C4 |
| 19 | Notifly | notifly-stack | `github` | DevinoSolutions/notifly @ `main` | yes | 7 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C4 |
| 20 | Personal Portfolio | Portfolio Compose | `git` | https://github.com/AminDhouib/personal-portfolio.git @ `main` | yes | 2 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C4 |
| 21 | Postify | Postify Compose (dev rehearsal) | `github` | DevinoSolutions/postify @ `main` | no | 6 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C4 |
| 22 | Postify | Postify Compose (prod) | `github` | DevinoSolutions/postify @ `main` | yes | 6 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C5 |
| 23 | SafeMeet | safemeet-stack | `github` | DevinoSolutions/SafeMeet @ `main` | yes | 8 (6) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C5 |
| 24 | Sendly | sendly | `raw` | - @ `-` | no | 10 (0) | coalescing only - no commit, no checks | - |
| 25 | Shorty | Shorty Dev Compose | `github` | DevinoSolutions/shorty @ `dev` | yes | 6 (4) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C5 |
| 26 | Shorty | Shorty PROD Compose | `github` | DevinoSolutions/shorty @ `main` | yes | 6 (4) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C5 |
| 27 | SnapVisor | ArgosCI Redis + RabbitMQ + Web + API | `github` | DevinoSolutions/snapvisor @ `main` | yes | 6 (3) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C5 |
| 28 | SuperBooks | iii-engine-server | `raw` | - @ `-` | yes | 1 (0) | coalescing only - no commit, no checks | - |
| 29 | TikTok Lead Gen | tiktok-lead-gen | `github` | DevinoSolutions/tiktok-lead-gen @ `main` | yes | 3 (2) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C6 |
| 30 | UpUp | UpupProdSite | `github` | DevinoSolutions/upup @ `master` | yes | 3 (3) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C6 |
| 31 | UpUp | UpupSite | `github` | DevinoSolutions/upup @ `dev` | yes | 3 (3) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C6 |
| 32 | Uptimely | UpstreamOneUpTime | `git` | https://github.com/OneUptime/oneuptime.git @ `master` | no | 7 (0) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C6 |
| 33 | Uptimely | iii-runtime | `github` | DevinoSolutions/uptimely @ `master` | no | 1 (0) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C6 |
| 34 | Uptimely | uptimely-rehearsal | `github` | DevinoSolutions/uptimely @ `master` | no | 8 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C7 |
| 35 | Uptimely | uptimely-stack | `github` | DevinoSolutions/uptimely @ `main` | yes | 8 (5) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C7 |
| 36 | VoiceBox | Voicebox | `github` | DevinoSolutions/voicebox @ `dokploy` | yes | 1 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C7 |
| 37 | Wellfound Lead Gen | Wellfound Lead Gen COMPOSE | `github` | DevinoSolutions/wellfound_scraper @ `main` | yes | 2 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C7 |
| 38 | uNotes | uNotes Stack Dev | `github` | DevinoSolutions/uNotes @ `dev` | yes | 9 (6) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C7 |
| 39 | uNotes | uNotes Stack Prod | `github` | DevinoSolutions/uNotes @ `main` | yes | 9 (6) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C8 |
| 40 | upAPI | iii | `github` | DevinoSolutions/upAPI @ `main` | no | 5 (3) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C8 |
| 41 | voicekit | VoiceLabs Engine (compose) | `github` | DevinoSolutions/voicelabs @ `main` | yes | 1 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C8 |
| 42 | voicekit | VoiceLabs Web (compose) | `github` | DevinoSolutions/voicelabs @ `main` | yes | 2 (1) | coalescing, `[skip deploy]`, derived `watchPaths`, `requiredChecks` | C8 |

Three compose units are `raw` (inline compose, no git source):
`Notifly / notifly-mig-cutover`, `Sendly / sendly` and
`SuperBooks / iii-engine-server`. They carry no commit, so they can never be
check-gated. `Sendly / sendly` is the one unit in the fleet already deploying
digest-pinned images built by CI; leave it exactly as it is.

Two compose units have an **unresolved** YAML origin (configured branch or path
does not exist) and nine fall back to the default branch. Fix those before
gating them; a derived `watchPaths` on a unit whose compose path is wrong
produces skips that look like the policy misbehaving.

### 4.7 What to observe between batches

After each batch, before starting the next, confirm all five. Any failure stops
the rollout and the batch is excluded again.

1. **Exactly one image build per commit.** On the *deploy* host and the *build*
   host: `docker events --since 30m --filter type=image --filter event=build`.
   The build must appear on `devino-second` and **not** on `devino`.
2. **The deployment stored a digest.**
   `SELECT "imageTag", "imageDigest" FROM deployment WHERE "applicationId" = '<id>' ORDER BY "createdAt" DESC LIMIT 1;`
   Both non-null, digest matching `sha256:` + 64 hex.
3. **The image is in the registry** under `<registry>/<prefix>/<appName>:<sha>`
   with that digest.
4. **Deploy latency is unchanged** in ungated mode. Compare the deployment's
   duration against the same unit's previous three deployments. A large jump
   means the build server is contended (the render daemon on `devino-second`
   takes ~22 cores; load 150-250 is normal there) - lower
   `buildsConcurrency` or stop.
5. **The audit log says what you expect.**
   `SELECT action, count(*) FROM build_policy_audit GROUP BY action;`
   `remote_build_enforced` and `deploy_by_digest` rows are the batch working.
   A `deploy_skipped` row you did not expect means a derived `watchPaths` is
   filtering real pushes - that is the highest-blast-radius failure and the
   reason landing units go first.

Also check, once, after the first batch only: **rollback with no build.** Pick
one unit from batch 1, use `buildPolicy.rollbackToDigest` against its previous
deployment, and confirm the deployment completes with no build event on either
host. If a deployment row has no stored digest the call is refused with
`DIGEST_NOT_PUBLISHED`, which is correct for anything deployed before
enforcement.

---

## 5. Known gaps from the #209 review rounds

Four rounds of review; the merged state is MERGE with five non-blocking
follow-ups. These are the ones with operational consequences.

**G1. Compose redeploy gating (round-3 finding H - fixed, but the shape is
worth knowing).** `runComposeBuild` clones *before* it gates, so a refused check
leaves the unchecked commit sitting in the unit's code directory. `rebuildCompose`
(the Redeploy button) has its own inlined pipeline and originally had no gate
call, which meant Redeploy would build precisely the commit the push gate had
just rejected. Fixed at `compose.ts:533`, ahead of the `down --volumes` step, so
a refused check never leaves a stack torn down.
**Operationally:** if a third compose deploy path is ever added upstream, it
needs the call too, and `compose-redeploy-gate.test.ts` is the tripwire. Also,
if you enable the policy *between* a push and a Redeploy, the Redeploy gates on
the checked-out commit, which may predate the checks and will fail closed after
5 minutes. That is correct behaviour but it will look like a bug the first time.

**G2. GitLab webhook (round-2 finding G - fixed).** The GitLab push route now
consults the gate for both unit types and reads `[skip deploy]` from the commit
rather than the job title (`pages/api/deploy/gitlab.ts`, `gitlab-route-gate.test.ts`).
**Operationally:** no unit in either CSV is GitLab-sourced today - 89 apps are
`github`/`git`/`docker` and 42 composes are `github`/`git`/`raw` - so this gate
is dormant on this instance. It matters only if a unit is ever moved to GitLab,
and then `buildPathForSource` (round-3 finding K) is what keeps its derived
watch paths reading `gitlabBuildPath` rather than a stale `buildPath`.

**G3. `requiredChecks` versus `sourceType: "git"` (round-2 finding F - fixed).**
Setting a non-empty `requiredChecks` used to resolve `owner`/`repo` and then
throw at deploy time, after the image had been built, tagged and pushed. It is
now refused at the API boundary with a 400 naming the unit and the remedy.
A `sourceType: "git"` unit *is* gateable if it kept its `githubId`, because
`saveGitProvider` sets `sourceType: "git"` without clearing it.
**Operationally:** this is exactly the seven custom-git units in batches 21-22.
Check `githubId` before you try. And note the residual hole (follow-up 1):
`disconnectGitProvider` writes `githubId: null` without re-validating, and a
compose unit switched to `sourceType: "raw"` skips the validation too - so a
unit can still be moved into an unsupported state *after* its checks were set.
The result is a fail-closed deploy that names its own remedy, but it costs a
clone and 5 minutes.

**G4. The required-checks wait holds a deployment slot (round-2 finding E -
accepted, not fixed).** `jobData.serverId` is set only under `IS_CLOUD`, so on
a self-hosted instance every deployment job lands in one `LOCAL_PARTITION` with
concurrency `buildsConcurrency ?? 1`. One unit waiting on a check that never
arrives queues **every other deploy on the instance** for the whole timeout.
Mitigations shipped: the wait moved ahead of the build, so a refused check no
longer costs a build, and the default timeout is 5 minutes rather than 30.
**Operationally:** this is the single strongest argument for raising
`buildsConcurrency` before enabling required checks anywhere, and for enabling
them on a handful of units rather than fleet-wide. Removing the occupancy needs
a queue redesign; that is owner item 19.

**G5. Check-run pagination (declined nit N7).** `github-checks.ts:145` and
`:167` use `per_page: 100` with no pagination. A commit with more than 100 check
runs drops a required one and times out - fail-closed.
**Operationally:** upAPI runs 51 jobs per CI run and GetItDone 49; neither is
near 100 today, but a repo that adds a large matrix could cross it.

**G6. #209 turned the fork's PR workflow red, and the review rounds could not
see it.** This was found while opening the PR that adds this document, and it is
the one gap here that was not already known.

`pull-request.yml` job `pr-check (test)` fails on every PR targeting `canary`
since #209. Five tests fail, all in one file,
`apps/dokploy/__test__/deploy/application.real.test.ts`, with
`TypeError: Cannot read properties of undefined (reading 'findFirst')` raised at
`packages/server/src/services/build-policy/settings.ts:18`
(`db.query.buildPolicySettings.findFirst`), through
`previewBuildPolicyDecision` (`resolve.ts:57`), `resolveBuildPolicy`
(`resolve.ts:107`), `planApplicationBuild` (`apply.ts:243`) and
`deployApplication` (`services/application.ts:211`).

Evidence, three runs of the same workflow:

| Run | Head | Contains #209 | Test files | Tests | Failures |
|---|---|---|---|---|---|
| 34048304936 | `b0161304` (`port/upr-5182`) | no | 190 passed (190) | 1912 passed, 1 skipped (1913) | **0** |
| 34543739811 | `6d27c886` (the #209 head merged as `b0cadcd`) | yes | 1 failed, 213 passed (214) | 5 failed, 2309 passed, 1 skipped (2315) | 5 |
| 34611157554 | `3b7e233` (this document's PR, docs-only) | yes | 1 failed, 213 passed (214) | 5 failed, 2309 passed, 1 skipped (2315) | **the same 5** |

**Verdict: inherited from #209, not a pre-existing fork baseline.** The docs PR
did not cause it - its diff against `canary` is one markdown file, 1123
insertions, zero deletions - and its failure set is identical to the #209 head's.
But the last pre-#209 run of this workflow was fully green, so #209 introduced
it.

**Why four review rounds missed it.** The reviewers ran the suite locally on
Windows and compared failing-test sets against the merge base, which matched
exactly (2315 total, 15 failed, both directions empty). `w6-review-2.md:78`
lists `deploy/application.real.test.ts` as item 5 of the files that already fail
on that host, for an unrelated reason: `Command failed: mkdir -p C:\…`. The file
was red before and after, so a set comparison could not show that #209 changed
*why* it is red. On Linux CI the Windows path problem does not exist, and the
file fails for the new build-policy reason instead. A local baseline that
already fails a file cannot prove anything about that file.

**What it means operationally.**

- **Production risk is low.** The real `db` is built from the full schema
  barrel, which now exports the build-policy tables, so
  `db.query.buildPolicySettings` exists at runtime. The failure is confined to a
  test that mocks `@dokploy/server/db` with a hand-written `query` namespace
  (`application.real.test.ts:15-53`) listing only `applications`, `deployHook`,
  `domains`, `patch` and `member`. The fix is one line in that mock.
- **But it is not zero risk, and the failure mode is instructive.** The README
  claims "the fork never crashes a deploy", and the guard behind that claim
  covers a missing organization relation only. It does not cover a `db.query`
  namespace without the table. When it is missing, the TypeError is raised
  inside the deploy's own `try`, and the deployment log gets
  `[build-policy] cannot read properties of undefined (reading 'findfirst')`
  where the deploy's own error should be - which is exactly what the second
  failing assertion caught. Any future caller that hands the module a partial
  `db` gets a build-policy error in place of the real one.
- **Fixed, before anything else in this runbook runs.** PR #212 added
  `buildPolicySettings` to that mock's `query` namespace and merged to `canary`
  as `e92e4ad`. Run 34615190789 on it reports `Test Files 214 passed (214)` and
  `Tests 2314 passed | 1 skipped (2315)`, zero failures, with
  `application.real.test.ts` passing - exactly the five tests recovered against
  run 34611157554 on the same base. The reason it was worth doing first: a red
  `pull-request.yml` on every canary PR masks the next real regression, and
  #209's integration test is the designated tripwire for upstream merges
  (spec §11). A tripwire nobody can read is not one.

**G7. Docker Hub reference normalisation (follow-up 3).**
`docker.io/prefix/app` and `prefix/app` are the same image but whole-repository
equality treats them as different, so an explicitly qualified Docker Hub
reference is refused against a hostless allowlist. Fail-closed and cosmetic;
relevant only if a unit's registry record ever points at Docker Hub.

---

## 6. Estimated compute saved

Window: 30 days, 2026-08-11 to 2026-09-10 (`S/cost/aggregate.json`, `since`
field, generated 2026-09-10T23:38:29Z). Total pool job-minutes in the
aggregate: **41,776** across 142 workflows.

### 6.1 Workflows whose output Dokploy currently rebuilds

These are the workflows that build a production image in CI, discard it, and let
Dokploy rebuild the identical Dockerfile from git on deploy
(`S/review-products.md` § 2).

| Workflow | Job-min | Jobs | Dokploy unit that rebuilds it | Relocatable by #209? |
|---|---|---|---|---|
| `upAPI:ci.yml` | 5,707 | 601 | upAPI `web`, `landing`, `docs` (apps) + `iii` (compose) | partly |
| `marka:ci.yml` | 3,150 | 88 | Marka `web`, `marka-ai`, `iii`, `marka-docs` (apps) | yes |
| `GetItDone:tests.yml` | 1,727 | 190 | GetItDone Compose PROD + DEV | **no** (compose) |
| `uNotes:CI.yml` | 1,269 | 337 | uNotes Stack Prod + Dev | **no** (compose) |
| `GetItDone:visual-regression.yml` | 827 | 35 | same | **no** (compose) |
| `SafeMeet:e2e.yml` | 571 | 113 | safemeet-stack | **no** (compose) |
| `uNotes:visual-regression.yml` | 539 | 46 | uNotes Stack | **no** (compose) |
| `dodomain:ci.yml` | 540 | 85 | dodomain-stack | **no** (compose) |
| `voicelabs:platform-ci.yml` | 438 | 70 | VoiceLabs Engine + Web (composes) | **no** (compose) |
| `uNotes:functional-e2e.yml` | 307 | 27 | uNotes Stack | **no** (compose) |
| `uNotes:journeys-e2e.yml` | 227 | 14 | uNotes Stack | **no** (compose) |
| `uptimely:nightly-e2e.yml` | 164 | 13 | uptimely-stack | **no** (compose) |
| `snapvisor:ci.yml` | 136 | 30 | Snapvisor Docs + Landing (apps) | yes |
| `BioFlow:nightly.yml` | 81 | 6 | BioFlow Stack | **no** (compose) |
| `SafeMeet:nightly.yml` | 76 | 18 | safemeet-stack | **no** (compose) |
| `devino-landing-page:ci.yml` | 60 | 22 | Devino Landing Page NextJS + DEV (apps) | yes |
| `dodomain:e2e-nightly.yml` | 40 | 4 | dodomain-stack | **no** (compose) |
| `marka:nightly.yml` | 39 | 2 | Marka apps | yes |
| **Total** | **15,898** | **1,701** | | |

`notifly:docker-image-canary.yml`, `uptimely:lighthouse.yml`,
`voicelabs-web:ci.yml` and `sendly:publish-web-image.yml` are named in the
products review but did not run on the pool in this window, so they contribute
0 measured minutes.

**15,898 job-min is 38% of all pool compute in the window.** That is the
envelope, not the saving: these workflows also run tests, lint and e2e that stay.

### 6.2 The recoverable subset

Isolating the jobs inside those workflows that actually build images, from the
per-job aggregate (`S/track5/jobagg.txt`, built from `S/cost/jobs/*.jsonl`,
pool-labelled jobs only):

| Job | Repo | Job-min | Runs |
|---|---|---|---|
| `E2E (prod-mode compose)` | GetItDone | 538 | 42 |
| `Docker Compose Build` | marka | 485 | 11 |
| `Visual regression (compose stack)` | uNotes | 450 | 35 |
| `Docker build (worker-ts)` | upAPI | 353 | 23 |
| `Docker build (worker-python)` | upAPI | 338 | 23 |
| `Docker build (worker-rust)` | upAPI | 312 | 23 |
| `Boundary specs vs the full compose stack` | uNotes | 278 | 25 |
| `Docker build (web)` | upAPI | 252 | 23 |
| `Real-user journeys vs the full compose stack` | uNotes | 220 | 14 |
| `Docker build (landing)` | upAPI | 217 | 23 |
| `Docker build (docs)` | upAPI | 210 | 23 |
| `browser e2e (compose stack + playwright)` | dodomain | 201 | 22 |
| `docker-build` | snapvisor | 73 | 10 |
| `Runtime E2E against the real compose graph` | uptimely | 49 | 3 |
| `Landing Docker image` | SafeMeet | 33 | 30 |
| `compose-stack-clean-boot` | BioFlow | 27 | 2 |
| four `Full-graph … E2E` legs | SafeMeet | 29 | 8 |
| `Docker build (Dokploy parity)` | devino-landing-page | 8 | 2 |
| `Compose Parity Gate` | uNotes | 6 | 27 |
| **Total** | | **4,079** | **369** |

Of that 4,079 job-min:

- **1,682 job-min** (upAPI's six `Docker build (…)` legs) is pure discard: the
  next step is `docker image rm -f "$TAG"`. Those jobs are deleted outright
  under build-once and their Dokploy counterparts for `web`, `landing` and
  `docs` relocate to the build server. The three worker legs feed the upAPI
  `iii` compose unit, which does **not** relocate.
- **566 job-min** (marka `Docker Compose Build` 485, snapvisor `docker-build`
  73, devino-landing-page 8) sits in front of application units that #209 can
  relocate today.
- **1,831 job-min** (GetItDone, uNotes ×4, dodomain, uptimely, SafeMeet ×5,
  BioFlow) sits in front of **compose** units, which #209 cannot relocate. The
  CI-side half of that is still recoverable by Track 1's build-once-and-reuse
  edits (bake once, pull in the other jobs), but the prod-host rebuild stays.

**Honest bottom line.** #209 alone, applied to every eligible application unit,
removes the *prod-host* build for 87 of the 131 units in the export and makes
the CI-side deletion of **2,248 job-min/month** safe to do (1,682 upAPI +
566 app-backed). That is **5.4% of the 41,776 measured pool minutes**, and
**55% of the 4,079 job-minutes measured on image-building jobs**. The
remaining 1,831 job-min of compose-stack builds needs either the compose
`image:` work the README's Known gap defers, or Track 1's per-repo reuse edits.

The other half of the saving is not on the pool at all: it is the 139
auto-deploy units the spec measured (§1: 209 units built from git on every
deploy, 139 of them auto-deploying on push) that build on `devino`, the **prod** machine
(16 cores), on every push. Moving those builds to `devino-second` is the point
of the track, and its benefit shows up as prod-host load, not as job-minutes.
Measure it as `devino` load average before and after, per the spec's
acceptance criteria in §5.6.

---

## 7. One-page sequence

0. **Done.** The `pull-request.yml` test failure #209 introduced (§5 G6) is
   fixed on `canary` by PR #212 (`e92e4ad`), so the suite is green and the
   upstream-merge tripwire is readable for everything below.
1. Rotate the Notifly OAuth token and move those four units to the GitHub App
   provider (owner prerequisite, spec §10).
2. Stand up the GHCR pull-through proxy on `registry.devino.ca`, add the
   registry record in Dokploy, and land the retention job (spec §5.4).
3. Raise `buildsConcurrency` from 1 to at least 3.
4. Back up: database dump (§2.2), volumes (§2.3), rollback image tar (§2.1).
5. `docker service update --image <digest> --force dokploy` (§3.3); verify (§3.4);
   watch for an hour (§3.5). **Policy still off.**
6. Set explicit `watchPaths` on every monorepo unit.
7. Add exclusions for application batches 2 to 22.
8. Set the default build server and default registry; then flip
   `enforceRemoteBuilds`.
9. Remove batch 1's exclusions; observe (§4.7); repeat one batch at a time.
10. Only once a unit has deployed cleanly under enforcement, add its
    `requiredChecks` from §4.4.

## 8. Provenance

Everything in this document was read, not assumed, except where marked.

| Claim | Source |
|---|---|
| Live version, release tag, 247 units | read-only MCP calls `settings.getDokployVersion`, `settings.getReleaseTag`, `overview.services` |
| Fork head `b0cadcd`, diffstat, file list | fresh clone at `S/work/dokploy-plan`, `git rev-parse HEAD`, `git ls-remote origin canary`, `git show --stat b0cadcd` |
| Default-off line references | `packages/server/src/db/schema/build-policy.ts`, `services/build-policy/policy.ts`, `settings.ts`, `source.ts`, `README.md` at that head |
| Review findings and follow-ups | `S/track2/w6-review-2.md` rounds 2, 3 and 4 |
| G6, the CI test regression | job logs of runs 34048304936, 34543739811 and 34611157554 of `pull-request.yml`, read via `gh api repos/DevinoSolutions/dokploy-community/actions/jobs/<id>/logs`; the db mock at `apps/dokploy/__test__/deploy/application.real.test.ts:15-53`; the local-failure attribution at `S/track2/w6-review-2.md:78` |
| The canary republish hazard | `.github/workflows/dokploy.yml` trigger block at `b0cadcd` |
| Unit inventory and field values | `S/dokploy/applications.csv`, `S/dokploy/composes.csv` |
| CI image-build table | `S/review-products.md` § 2 |
| Workflow and job minutes | `S/cost/aggregate.json` `per_workflow`; `S/cost/jobs/*.jsonl` aggregated by `S/track5/jobagg.py` into `S/track5/jobagg.txt` |
| GHCR tags and digests | `gh api orgs/DevinoSolutions/packages/container/dokploy-community/versions`, `gh api …/actions/workflows/dokploy.yml/runs` |
| Service, volume and secret names | the fork's `install.sh` at `b0cadcd` |
| Rollback digest candidate `e9a136f7…` | inferred from GHCR creation timestamps; **must be confirmed** against the running service per §2.1 |
