# Upstream Sync Playbook

How this community fork (`DevinoSolutions/dokploy-community`) stays in sync with
upstream [`Dokploy/dokploy`](https://github.com/Dokploy/dokploy). Read this before
every upstream sync.

## Guiding principle

**Diverge only for features upstream lacks. When upstream ships an equivalent,
drop ours and take theirs.** The fork's long-term maintenance cost is the set of
files where we differ from upstream — keep that set as small as possible. Every
sync is an opportunity to *delete* fork-specific code that upstream has since
absorbed.

We sync to **release tags only** (e.g. `v0.29.11`), never to `upstream/canary`
HEAD. Tags are the tested, published states; canary is a moving target.

## One-time setup

```bash
# Upstream remote (fetch tags too)
git remote add upstream https://github.com/Dokploy/dokploy.git
git fetch upstream --tags

# Enable the `merge=ours` driver referenced by .gitattributes. This is a local
# git config that is NOT stored in the repo, so every clone/CI runner that will
# perform a sync merge must run it once:
git config merge.ours.driver true
```

Without `merge.ours.driver true`, the `merge=ours` entries in `.gitattributes`
are silently ignored and fork-owned files will conflict on every sync (you then
resolve them by hand — annoying but not dangerous).

## Sync procedure (tag-based merge)

1. Confirm the target tag exists locally: `git fetch upstream --tags && git tag -l 'vX.Y.Z'`.
2. Branch off `canary`:
   ```bash
   git checkout canary
   git checkout -b sync/upstream-vX.Y.Z
   ```
3. **Merge the tag — never rebase.** A real merge commit preserves the merge
   base so the *next* sync only has to reconcile new upstream changes:
   ```bash
   git merge vX.Y.Z --no-commit --no-ff
   ```
4. Resolve conflicts per the policy below. Also force-resolve any *auto-merged*
   overlap files that fall under a "theirs" rule — a clean auto-merge can still
   splice a fork line we mean to drop into an upstream file. Determine the
   overlap set with:
   ```bash
   MB=$(git merge-base canary vX.Y.Z)
   comm -12 <(git diff --name-only $MB canary | sort) \
            <(git diff --name-only $MB vX.Y.Z | sort)
   ```
5. Set the version (see convention) and commit the merge.
6. Regenerate fork migrations (see Drizzle) as follow-up commits.
7. Verify (see Verification), then open the sync PR into `canary`.

## Conflict policy (strict, in priority order)

1. **Upstream wins by default.** Any overlap where both sides changed the same
   code → take theirs (`git checkout vX.Y.Z -- <file>`).
2. **Drop fork features upstream now provides.** When upstream ships an
   equivalent of something we forked, delete our implementation entirely — take
   upstream's version of shared files, `git rm` our net-new files, and revert
   our edits to shared helpers back to upstream. Before deleting a shared
   helper, grep that no *kept* fork feature imports it.
3. **Keep fork features upstream lacks.** Re-integrate them **on top of
   upstream's refactored files**, not by keeping our stale copies. Upstream
   frequently reorganizes imports / restructures components (e.g. the Tailwind
   v4 pass in v0.29.11); re-apply our small additions to *their* current file.
4. **Fork-owned files: ours always wins** (see ownership table). These carry
   `merge=ours` in `.gitattributes`.
5. **Version**: set `apps/dokploy/package.json` to `vX.Y.Z-community.N`.
6. **`pnpm-lock.yaml`**: take theirs, then run `pnpm install` and commit any delta.

## File ownership

| Path | Owner | Rule |
|---|---|---|
| `README.md` | Fork | ours (`merge=ours`) |
| `CNAME` | Fork | ours (`merge=ours`) |
| `install.sh` | Fork | ours (`merge=ours`) |
| `.github/workflows/dokploy.yml` | Fork | ours (`merge=ours`) — GHCR publish; ignore upstream release automation |
| `apps/dokploy/package.json` (`version`) | Fork | `vX.Y.Z-community.N` |
| `packages/server/src/services/settings.ts` | Shared | keep fork image/update sources (DevinoSolutions repo, `ghcr.io/devinosolutions`); adopt unrelated upstream logic around them |
| Network management feature (below) | Fork | keep; re-integrate onto upstream |
| Everything else | Upstream | theirs |

### Dropped at v0.29.14: fork Docker network management

Upstream's own network management (#3774) landed in v0.29.14 and replaced the
fork's implementation (same lineage — prod DBs already had the table/enum/
`networkIds`). Migration 0193 dropped the fork-only columns
(`scope`/`ingress`/`configOnly`); the fork's 6-value `networkDriver` enum stays
in the schema TS to avoid an enum recreate. The fork re-applies
`withPermission` gates on upstream's network router (upstream checks only org
membership) — preserve those on every sync.

### Dropped at v0.30.0: self-scoped sessions page (fork PR #164)

Upstream v0.30.0 ships its own session management (list/filter/sort + revoke)
and it is now the owner of `pages/dashboard/settings/sessions.tsx`,
`components/dashboard/settings/sessions/*`, and the `listSessions`/
`revokeSession` procedures in `routers/user.ts`. Behavioral difference accepted
under theirs-wins: the fork's port was strictly self-scoped (users saw only
their own sessions); upstream lets org owners list and revoke every member's
sessions (IPs/user-agents visible to owners, with audit log). Do not re-apply
the fork's `permissions.member.read` page gate — upstream intends members to
see their own sessions. The fork's `apiKeyPrefixSchema` hardening in
`routers/user.ts` is separate and must survive.

### Adapted at v0.30.2: `project.one` column projections vs. the member ACL

Upstream #5103 rewrote `projectRouter.one`'s member branch to (a) pre-check
`accessedProjects` and bail early, and (b) project every nested service down to
`serviceColumns` (hoisted out of `findProjectById` and now exported from
`packages/server/src/services/project.ts`) so the relational query stops blowing
Postgres' 100-argument `json_build_array` limit. The fork's member ACL (#183)
cannot keep upstream's early bail: service- or environment-level access must
also open the project. Resolution kept on every sync: take upstream's projected
`db.query.projects.findFirst(...)` verbatim, drop the `accessedProjects`
pre-check, and re-apply the fork's
`hasProjectAccess || hasEnvironmentAccess || hasServiceAccess` gate *after* the
query (a missing row now means UNAUTHORIZED rather than upstream's NOT_FOUND).
`filterEnvironmentServices` on the way out is redundant with the query's
`buildServiceFilter` where-clauses but is kept as defence in depth.

### Dropped at v0.30.3: fork `guardedBackup` volume-backup restart guard

Upstream #5082 shipped `createRestartSafeBackupCommand` in
`packages/server/src/utils/volume-backups/backup.ts`, a strict superset of the
fork's `guardedBackup` (it also captures a *restart* failure and reports it).
Ours was deleted. The fork's own rclone layer in that file must survive every
sync: `getRclonePathAndFlags` + `buildRcloneCommand` (crypt/generic
destinations, env-var credentials) instead of upstream's `getS3Credentials`,
the `effectivePrefix` fallback to `getVolumeServiceAppName(...)`, and the
"destination" wording in `uploadCommand`. Upstream renamed the shell variable
`BACKUP_EXIT` → `DOKPLOY_VOLUME_BACKUP_STATUS`; the fork's integration-level
regression test `__test__/volume-backups/backup.test.ts` was retargeted at the
new name rather than deleted, because upstream's
`__test__/backups/volume-backup-restart.test.ts` only unit-tests the helper and
does not assert that `backupVolume` actually wires it into both service types.

### Adapted at v0.30.3: `network.resync` and the fork permission verbs

Upstream #5198 added `networkRouter.resync` (dockerId-based delete/recreate
detection) as a `protectedProcedure`. The fork gates every network procedure
with `withPermission`, and its `network` statement only has
`["read", "create", "delete"]` — there is no `update` verb. `resync` is
therefore gated on `withPermission("network", "delete")`, matching the existing
`recreate` procedure it most resembles. The wave-3 `assertServerInOrganization`
calls on `create` / `import` / `networksToSync` and the `withPermission` gates
on every other procedure are re-applied on every sync.

### Adapted at v0.30.3: multi-IP domain validation vs. fork domain features

Upstream #5214 changed `validateDomain(domain, expectedIp?)` to
`validateDomain(domain, expectedIps?: string[])`, added
`getServerIpCandidates()` in `packages/server/src/services/domain.ts`, and
switched `domainRouter.validateDomain`'s input from `serverIp` to `serverId`
(with its own org check, which subsumes the fork's guard). Take all of that
verbatim, then re-apply the three fork additions to that file: the
`validateDomainRestriction` gate in `createDomain`, the canonical host
lowercasing in `createDomain`/`updateDomainById`, and the private-IP →
public-IP resolution plus `baseDomain` argument in `generateTraefikMeDomain`.
The wave-3 `assertServerInOrganization` guards on `generateDomain` and
`canGenerateTraefikMeDomains` also stay.

Since the user-owned wildcard base feature, `generateTraefikMeDomain` also takes
a fourth `projectId` argument and returns `{ domain, baseDomain, source }`
instead of a bare string, its base domain comes from `resolveGeneratedDomainBase`
(same file), and `updateDomainById` enforces `validateDomainRestriction` on the
host. `domain.generateDomain` / `domain.canGenerateTraefikMeDomains` take an
optional `projectId` guarded by `assertProjectInOrganization`. Re-apply all of
that on top of upstream's version of the file.

### Adapted at v0.30.5: swarm convergence vs. the fork's stability check

Upstream #5247 added `waitForSwarmServiceConvergence` +
`ServiceConvergenceError` to `packages/server/src/utils/docker/utils.ts` and
calls it from the six database services
(`services/{libsql,mariadb,mongo,mysql,postgres,redis}.ts`) after a deploy. It
conflicted with the fork's `waitForSwarmServiceStable` only *positionally* —
both blocks are inserted immediately before `checkPostgresHealth`. **Keep
both.** They are different functions with disjoint call sites: upstream's is
DB-deploy convergence (`services/application.ts` never calls it), the fork's is
the application deploy stability window from #184/#188.

Upstream's check is **not** a superset of the fork's. It returns the moment
`runningTasksCount >= desiredTasksCount`, so it has no post-running stability
window (a container that starts then crash-loops still counts as converged), it
counts `DesiredState === "running"` tasks without excluding the outgoing task of
a rolling update or tasks created before the poll started, and it compares no
timestamps so it needs no daemon-clock anchoring. Swapping the fork's helper for
it would reintroduce exactly the two bugs lmichelin fixed. If a future upstream
release grows those behaviours, drop `waitForSwarmServiceStable` then.

### Adapted at v0.30.5: `generateTraefikMeDomain` call sites in new upstream code

Upstream's onboarding wizard (#5264) added
`applicationRouter.deployNginxQuickstart`, which calls
`generateTraefikMeDomain(appName, ownerId, serverId)` and uses the return value
directly as a host string. Since the wildcard-base feature the fork's version
takes a fourth `projectId` argument and returns
`{ domain, baseDomain, source }`. Every upstream call site of that function must
be adapted on sync: pass the project id and read `.domain`. This one auto-merged
cleanly and only the typecheck caught it — grep for `generateTraefikMeDomain`
after every merge.

### BREAKING at v0.30.5: default Docker build context is now the repo root

Upstream `f1e2467bb` ("fix/docker-context-path-default") changed the *default*
build context for `buildType: "dockerfile"` applications:

- `getDockerContextPath` used to return `null` when the app had no explicit
  `dockerContextPath`, and `builders/docker-file.ts` then fell back to
  `defaultContextPath` — **the directory containing the Dockerfile**.
- It now returns `<APPLICATIONS_PATH>/<appName>/code/<dockerContextPath || ".">`
  and the fallback was deleted, so the default context is **the repository
  root**, matching what the UI placeholder always claimed.

Taken under theirs-wins (it is deliberate, and it is a file upstream edits), but
it is a **behaviour break for existing users**: any Dockerfile app whose
Dockerfile sits in a subdirectory and copies paths relative to that
subdirectory (`COPY package.json .`, `COPY deno.json .`, …) will start failing
its build with a "file not found" until the user sets `dockerContextPath`
explicitly. This must be called out in the release notes for the release that
ships this sync.

The fork's `__test__/deploy/application.real.test.ts` "should REALLY build with
Dockerfile" case caught it on CI (it builds `Dokploy/examples` `/deno`, whose
Dockerfile does `COPY deno.json .`). The test now sets
`dockerContextPath: "/deno"` — the same migration a user has to make. That test
file's `@dokploy/server/services/deployment` mock also gained
`getDeploymentErrorMessage`; without it, *any* real deploy failure surfaces as a
missing-mock-export error and the actual build error is lost.

### Superseded at v0.30.5: remote Traefik writes go through SFTP

Upstream #5246 replaced the `echo <base64> | base64 -d > path` remote write in
`packages/server/src/utils/traefik/application.ts` with `writeFileRemote`
(SFTP). The fork's regression test
`__test__/traefik/traefik.test.ts` ("Remote Traefik writer preserves
shell-sensitive YAML values") was retargeted at `writeFileRemote` rather than
deleted — the invariant it guards (the YAML reaches the transport with its
quoting intact) still matters; only the transport changed.

### Cloud onboarding wizard (#5264) on self-hosted

`projectRouter.onboardingStatus` gates on
`isOwner && !user.onboardingCompletedAt && projectCount === 0 && billingGate`,
where `billingGate` is `!hasActiveAccess` on cloud and unconditionally `true`
self-hosted. So a **self-hosted fork instance does show the wizard** to a brand
new owner with zero projects — but never to anyone who existed before the
upgrade, because migration `0199` backfills `onboardingCompletedAt`. The
cloud-only content is filtered inside the wizard:
`components/dashboard/onboarding/onboarding-wizard.tsx` drops the `plan`
(Stripe billing) and `server` steps when `settings.isCloud` is false, leaving
welcome → project → deploy → complete. No fork change was needed.

### Historical (superseded): fork Docker network management file map

Net-new fork files (kept as-is unless upstream restructures their neighbors):
`packages/server/src/db/schema/network.ts`, `packages/server/src/services/network.ts`,
`apps/dokploy/server/api/routers/network.ts`, `apps/dokploy/pages/dashboard/networks.tsx`,
`apps/dokploy/components/dashboard/networks/*`, `apps/dokploy/__test__/network/*`.

Small additions re-applied onto upstream's versions of shared files:
- `apps/dokploy/server/api/root.ts` — register `networkRouter`.
- `apps/dokploy/components/layouts/side.tsx` — Networks nav entry.
- `apps/dokploy/pages/dashboard/project/.../services/*/[*Id].tsx` (7 pages) — `<ResourceNetworksCard>`.
- `apps/dokploy/server/api/routers/{application,libsql,mariadb,mongo,mysql,postgres,redis}.ts` — `assertNetworkIdsAttachableToResource` on update.
- `packages/server/src/db/schema/{account,server,application,<db>}.ts` — `networks` relations + `networkIds` columns.
- `packages/server/src/db/schema/index.ts`, `packages/server/src/index.ts` — re-export network schema/service.
- `packages/server/src/db/schema/audit-log.ts` — `"network"` audit action.
- `packages/server/src/lib/access-control.ts` — network permissions.
- `packages/server/src/services/mount.ts` — projected column select (avoids Postgres 100-arg `json_build_array` limit once `networkIds` is added).
- `packages/server/src/services/rollbacks.ts`, `packages/server/src/utils/builders/index.ts`, `packages/server/src/utils/databases/*.ts` — pass `resolveNetworkNamesForResource(...)` into `generateConfigContainer`.
- `packages/server/src/utils/docker/utils.ts` — `mergeNetworks` + `extraNetworks` param on `generateConfigContainer` (defaults to `[]`, so upstream callers are unaffected).

### Dropped at v0.29.11: per-target concurrent deployments (fork PR#5)

Superseded by upstream's in-memory queue (#4645) + OSS concurrent builds
(#4778). We took upstream's `deployments-queue.ts`, `queueSetup.ts`, `server.ts`,
`server/api/routers/{server,settings,application,compose,preview-deployment}.ts`,
`web-server-settings.ts` / `server.ts` schema (upstream's `buildsConcurrency`),
`show-deployments.tsx`, `setup-server.tsx`; `git rm`'d our net-new concurrency
files (`queue-routing.ts`, `utils/process/job-context.ts`, concurrency
modals/sections, `__test__/queues/{global-state,routing}.test.ts`); and reverted
`execAsync.ts`, `esbuild.config.ts`, `pages/api/deploy/*.ts`,
`show-queue-table.tsx`, `show-dokploy-actions.tsx` to upstream.

## Drizzle migrations (read carefully)

Both fork and upstream branch from the same last shared migration and each add
new numbered migrations. Rules:

1. **Take upstream's `drizzle/` state verbatim** on merge (their new `.sql`,
   snapshots, and `_journal.json` entries). Delete the fork's *old*
   numbered migrations that collided with upstream's numbers.
2. **Fork migrations always regenerate AFTER upstream's.** Once the schema `.ts`
   files are in their final merged state, run:
   ```bash
   pnpm install
   pnpm --filter=dokploy run migration:generate   # offline; no DB needed
   ```
   This emits the fork's feature migration at the next free number (e.g. `0174`).
   **Inspect the SQL**: it must contain *only* fork-feature objects. If it
   contains anything else, the schema merge is wrong — fix the `.ts` and
   regenerate.
3. **Idempotency guards (required).** Instances already running the *previous*
   fork release ran the fork's *old* migration, so the objects already exist
   there — but drizzle sees the regenerated migration as new and will run it
   once. Make that run a no-op with guards:
   - `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`.
   - Enum types and `ADD CONSTRAINT` have no `IF NOT EXISTS`; wrap each in
     `DO $$ BEGIN <stmt>; EXCEPTION WHEN duplicate_object THEN null; END $$;`
     (keep `--> statement-breakpoint` separators intact).
4. **Number collisions: re-issue upstream's migration in a fork slot.** Rule 1
   only works while upstream's new numbers are still free. Once the fork has
   *released* migrations at those numbers (instances have already run them),
   dropping ours would strand production. Instead: delete upstream's colliding
   `.sql` + snapshot and their `_journal.json` entries, keep the fork's, and let
   `migration:generate` re-emit the schema delta at the fork's next free number.
   Upstream migrations that are pure **data** backfills are not schema-derivable
   and will not be re-emitted — hand-carry the exact statement into the
   generated `.sql` after a `--> statement-breakpoint`, and confirm it is
   idempotent (upstream's usually are). Done at v0.30.3 for upstream's `0186`
   (`network.dockerId`) and `0187` (`server.terminal` role backfill), both
   folded into the fork's `0196_robust_lucky_pierre`. Done again at **v0.30.5**
   for upstream's `0188_volatile_piledriver` (`VaultProviderType` += `phase`),
   `0189_wooden_nextwave` (`DnsProviderType` += `porkbun`) and
   `0190_nappy_anita_blake` (`user.onboardingCompletedAt` + a backfill),
   all three folded into the fork's `0199_complex_mantis`. The `0190` backfill
   (`UPDATE "user" SET "onboardingCompletedAt" = now() WHERE
   "onboardingCompletedAt" IS NULL`) was hand-carried; it must **not** become a
   column `DEFAULT`, or newly created users would skip the onboarding wizard.
5. **Guard upstream migrations only on a real column-name collision.** If an
   upstream migration adds a column our *old* dropped migration already created
   under the **same name**, add `IF NOT EXISTS` to our copy of that upstream
   `.sql`. Upstream never retro-edits released migrations, so this never causes a
   future merge conflict. (At v0.29.11 there was **no** collision: upstream named
   its column `buildsConcurrency`, our dropped one was `deploymentConcurrency`.)

### Fork columns on upstream-owned tables (schema ledger)

Some fork features add columns to tables upstream owns. On a sync the schema
`.ts` files resolve theirs-wins, which silently drops these unless they are
re-applied by hand **before** `migration:generate` runs (rule 2). If one is
dropped, the regenerated migration will contain a `DROP COLUMN` — that is the
tell.

| Table | Column | Feature | Landed in |
|---|---|---|---|
| `organization` | `wildcard_domain` (text, null) | user-owned wildcard base for generated domains | `0197` |
| `project` | `wildcardDomain` (text, null) | per-project wildcard base override | `0197` |
| `project` | `useOrganizationWildcard` (bool, not null, default true) | opt a project out of the organization wildcard | `0197` |

The catch-up migration `0195_fork_schema_catchup` exists for exactly this class
of drift: upstream→fork upgrades that skipped fork migrations get every
fork-owned column/table re-created idempotently. When a new fork column is added
to an upstream table, add it to the table above; if it is ever found missing in
the wild, extend the catch-up migration rather than editing a released one.

### Fork-owned tables (schema ledger)

Whole tables that exist only in the fork. On a sync, keep the schema file and
make sure the regenerated migration does not `DROP` them.

| Table | Schema file | Feature | Landed in |
|---|---|---|---|
| `oauth_application`, `oauth_access_token`, `oauth_consent` | `packages/server/src/db/schema/mcp-oauth.ts` | remote MCP server OAuth (better-auth `mcp` plugin storage) | `0198` |

### Migrator ordering gotcha (drizzle `postgres-js` migrator)

`migrate()` finds the single highest `created_at` in `__drizzle_migrations`, then
runs every journal entry whose `when` (folderMillis) **exceeds** it. It does
**not** track a per-migration applied set. Consequence for forks: if the fork's
*old* migrations had a higher `when` than an upstream migration that a
previous-release instance never saw, that upstream migration is **silently
skipped** on upgrade (its `when` is below the fork's high-water mark).

At v0.29.11 this hit `0172_quick_the_professor` (`when=1781045439162`, adds
`buildsConcurrency`) vs the fork's old `0173_deployment_concurrency`
(`when=1781673664599`). Fix: bump the fork's copy of the shadowed upstream
migration's `when` in `_journal.json` to just above the fork high-water mark
(here `1781673664600`), keeping it below the next upstream migration. Fresh
installs are unaffected (empty migrations table ⇒ every entry runs in array
order regardless of `when`). The bump is self-healing: after this release every
instance has the column, and the next sync takes upstream's journal verbatim.

**Rule of thumb:** after a merge, scan for any upstream migration whose journal
`when` is below the previous fork release's highest `when`; bump those so
upgraders don't skip them.

## Version convention

`vX.Y.Z-community.N` where `X.Y.Z` is the synced upstream release and `N` starts at
`1`, incrementing for subsequent fork-only releases on the same upstream base.

## Verification (before merging the sync PR)

```bash
pnpm install
pnpm --filter=dokploy run typecheck        # app + packages/server MUST pass
pnpm --filter=dokploy run build-server      # fast esbuild bundle
pnpm --filter=dokploy test -- run           # unit suite
pnpm --filter=dokploy run build-next        # optional full Next build
```

Note: `pnpm -r run typecheck` currently fails in `apps/api` and `apps/schedules`
on **upstream itself** — their tsconfigs lack `esModuleInterop`, so they can't
typecheck the shared `packages/server` source (unrelated to the fork). Verify the
fork with the `apps/dokploy` + `packages/server` typechecks, which pass. Several
`*.real.test.ts` / docker / filesystem tests require live Docker, git, nixpacks
and Unix tools (`awk`, `mkdir -p`) — they fail in sandboxed/Windows envs and pass
on a Linux CI runner with Docker.
