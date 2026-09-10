# build-policy — enforced remote builds

Fork module. Dokploy is the only builder: GitHub-sourced applications build on
the organization's build server, the image is pushed to the organization
registry tagged `<repository>:<sha>`, and the deploy pulls it **by digest**. CI
never builds a production image; it waits for this one.

Upstream Dokploy has none of this. Everything here is additive, and the touch
points in upstream files are listed below so an upstream merge has one page to
reconcile rather than a search.

Design source: `docs/superpowers/specs/2026-09-10-ci-build-once-and-pool-design.md`
§5.1–5.6, §7, §8, §11.

---

## Behaviours

| # | Behaviour | Where |
|---|---|---|
| 1 | Org setting `enforceRemoteBuilds`, exclusions, audited break-glass | `settings.ts`, `exclusions.ts`, `audit.ts` |
| 2 | Enforced units build on `defaultBuildServerId`; no silent local fallback | `policy.ts`, `apply.ts` |
| 3 | Push `<repository>:<sha>`, capture the digest, deploy by digest | `apply.ts`, `image.ts` |
| 4 | Queue coalescing on enqueue | `coalesce.ts`, `webhook.ts` |
| 5 | Derived default `watchPaths`, `[skip deploy]` marker | `watch-paths.ts`, `skip-deploy.ts`, `webhook.ts` |
| 6 | Per-unit `requiredChecks` gating, over check runs **and** commit statuses, for applications and compose units | `required-checks.ts`, `github-checks.ts`, `compose-checks.ts` |
| 7 | Deploy-hook body `{image, tag, digest}`, restricted to the unit's own repository | `hook-body.ts`, `pinned-deploy.ts` |
| 8 | Rollback to a digest a past deployment stored, with no build | `rollback.ts`, `pinned-deploy.ts` |

PR previews are enforced too: they are GitHub App sourced like any other deploy,
so they build on the build server and deploy by digest. See **Preview
deployments** below for the one place they are deliberately different.

## Off by default, and it means it

The policy is off until an organization has a `build_policy_settings` row with
`enforceRemoteBuilds` set. While it is off **every** path in this module
short-circuits to upstream behaviour, and that includes the ones that live at
enqueue time rather than deploy time:

- the `[skip deploy]` marker is not honoured, because upstream does not honour it;
- derived default `watchPaths` are not applied, because a derived watch path
  *stops* deploys and a team must never discover that by accident;
- queued deploys are not coalesced;
- a deploy-hook `{image, …}` body is ignored on an application and ignored on a
  compose unit, exactly as upstream ignores the body. Turning a request upstream
  accepts into a 400 the day this merges is the same mistake.

`buildPolicyDeployGate` and `resolveDeployHookImage` both begin with
`isBuildPolicyEnforcedAnywhere()` (`settings.ts`), one
`enforceRemoteBuilds = true` lookup cached process-locally for five seconds.
There is no index on that column and there deliberately is not one: the table
holds one row per organization, so the scan is free. On
an instance where nobody enforces, that cached boolean is the entire cost of the
fork at enqueue time: no organization lookup, no settings read, no audit write.
`upsertBuildPolicySettings` clears the cache, so turning the policy on through
the UI takes effect at once; a direct database write takes up to the TTL.

The deploy path is the same story. `runBuildPolicyPreBuildGate` returns the
caller's command string unchanged, having executed nothing, unless the
organization enforces; `prepareBuildPolicyDeploy` returns the application
unchanged on the plan's `enforced` flag alone, before it reads a commit sha or
anything else. So an unenforced deploy makes no extra SSH round trip and one
settings read — the single `build_policy_settings` SELECT `resolveBuildPolicy`
needs to decide the plan at all. The compose path costs even less: an empty
`requiredChecks` returns before the cached enforcement probe.

`policy-off-is-upstream.test.ts` asserts all of this directly, including the
absence of the calls, and it is where the "one settings read, not none" number
comes from ("reads the organization settings exactly once").

## Before you turn it on

"Off by default" is only half the story. This is what changes the moment an
operator sets `enforceRemoteBuilds`, in rough order of blast radius. Round-2
review finding B: the section above was excellent and this one did not exist.

1. **Derived `watchPaths` start filtering pushes.** Every unit with a build
   path and no explicit `watchPaths` immediately gets `<buildPath>/**` from
   `deriveDefaultWatchPaths`, reading the build-path column that matches its
   source type. In a monorepo — the common shape across this
   fleet — a push that touches only shared code under `packages/**` now stops at
   the webhook with a 301 and no deployment record. This is the single
   highest-blast-radius consequence of enabling the policy.
   **Set explicit `watchPaths` on your monorepo units first.** Every such skip
   now writes a `deploy_skipped` audit row carrying the derived paths and the
   changed-file list, so "why did my push not deploy" has an answer; before, the
   only trace was a webhook delivery response nobody reads.
2. **Every GitHub-sourced unit's build moves to the org build server**, and its
   deploy pulls by digest. A unit that must keep building where it is needs an
   exclusion, added before the switch is flipped.
3. **Queued deploys start coalescing.** A burst of pushes produces one build.
   Previews are never coalesced.
4. **`[skip deploy]` starts being honoured** on the routes listed in
   `skip-deploy.ts`.
5. **A deploy-hook `{image, …}` body stops being ignored**: validated on an
   application, refused with a 400 on a compose unit.
6. **Required checks are a separate opt-in on top.** Nothing waits on CI until
   somebody sets `requiredChecks` on a unit. Before you do, read the slot cost
   in the required-checks section below and raise `buildsConcurrency`.

The audit log (`buildPolicy.audit`, admin only) is where all of this is visible:
`deploy_skipped`, `deploy_coalesced`, `required_checks_failed`,
`required_checks_timeout`, `deploy_by_digest`, `exclusion_added`,
`break_glass_granted`.

## The decision

`policy.ts` holds the whole decision as a pure function, in this order:

1. enforcement off, or no settings row → `local` / `not_enforced`
2. not a github.com source → `local` / `not_github`
3. excluded → `local` / `excluded` (checked before break-glass so an exclusion
   never burns a grant)
4. a pending break-glass grant → `local` / `break_glass`, and the grant is spent
5. a compose unit → `local` / `compose_build_not_relocatable` (see Known gap)
6. no build server → `error` / `NO_BUILD_SERVER`
7. no registry → `error` / `NO_REGISTRY`
8. otherwise → `remote`

Steps 6 and 7 are the "no silent local fallback" rule from spec 5.2.8: an
enforced unit with nowhere to build fails the deploy with a named error. The
manual escape is the audited break-glass, not an automatic downgrade.

**A refused plan is a visible failure.** `planApplicationBuild` runs after
`createDeployment` and its error is raised from inside the deploy's own `try`,
so a `NO_BUILD_SERVER` or `NO_REGISTRY` refusal produces a deployment row in
`error` status, an application marked `error`, the reason in the deployment log
and a build-error notification — not a throw into the void.
`plan-failure.test.ts` pins that, because an enforcement that fails silently is
worse than no enforcement.

**And the fork never crashes a deploy.** The policy reaches through
`application.environment.project` for the organization. `findApplicationById`
always loads that relation, but a caller with a leaner row plans as
`no_organization` and deploys unchanged, with a warning, rather than throwing a
`TypeError` out of somebody else's deploy path.

## Files

| File | Contents |
|---|---|
| `policy.ts` | the pure decision (above) |
| `source.ts` | github.com detection for `sourceType: github` and for a `git` source whose `customGitUrl` is on github.com; `owner/repo` parsing |
| `settings.ts` | organization settings read/upsert, the cached "does anybody enforce" probe, required-checks timeout |
| `exclusions.ts` | exclusion list / lookup / add / remove |
| `ownership.ts` | asserts a unit id taken from tRPC input belongs to the active organization |
| `audit.ts` | append-only trail; break-glass grant, lookup and consumption |
| `resolve.ts` | database-backed wrapper around `policy.ts`; the only place a grant is spent. `previewBuildPolicyDecision` is its read-only sibling: same answer, no grant spent, no audit row |
| `apply.ts` | the application deploy path: plan, remote tag/push/digest shell, digest read-back, deploy-by-digest preparation |
| `image.ts` | `<app>:<sha>` tagging, digest validation, digest-marker parsing, `repo@sha256:…` refs |
| `hook-body.ts` | validation of a deploy-hook `{image, tag, digest}` body against the unit's own repository |
| `pinned-deploy.ts` | a whole deploy of a supplied image, with no build |
| `rollback.ts` | redeploy the digest a past deployment stored (see Rollback) |
| `required-checks.ts` | pure check evaluation plus a polling wait with an injectable clock |
| `github-checks.ts` | the same wait, wired to the GitHub App installation token; merges check runs and commit statuses |
| `coalesce.ts` | drop still-waiting deploys for a unit and audit what was dropped |
| `compose-checks.ts` | `requiredChecks` for compose units, run between the clone and the build |
| `watch-paths.ts` | derive default `watchPaths` from the unit's build path (selected by source type, as `getBuildAppDirectory` does) / Dockerfile / compose path |
| `skip-deploy.ts` | the `[skip deploy]` commit-message marker |
| `webhook.ts` | the single enqueue-time gate every deploy entry point calls, plus deploy-hook body resolution |
| `errors.ts` | `BuildPolicyError` with stable codes |

**On the directory.** The spec named
`packages/server/src/community/build-policy/`. The module lives under
`services/` instead, next to the `application.ts` and `deployment.ts` it hooks,
at the cost of sitting in an upstream directory. Every file in it is new — no
upstream file was renamed into it — so an upstream merge conflicts only on the
hooked files listed below, which is what the hook catalogue is for. Moving it is
a mechanical rename if that trade stops being worth it; do it before a merge,
not after.

## The tRPC router

`apps/dokploy/server/api/routers/build-policy.ts`. The organization is read
exclusively from `ctx.session.activeOrganizationId` and never from input, so
there is no id to swap. Every unit id, build server id and registry id that
arrives in input is checked against that organization before use
(`ownership.ts`).

| Procedure | Access |
|---|---|
| `settings`, `exclusions` | `protectedProcedure` |
| `updateSettings`, `addExclusion`, `removeExclusion`, `allowLocalBuildOnce`, `rollbackToDigest`, `audit` | `adminProcedure` |

`audit` is admin-only because its rows carry registry ids, build server ids and
break-glass reasons.

`addExclusion` and `allowLocalBuildOnce` **refuse a `composeId`** with a 400.
Both decide where a unit builds and a compose build is never relocated, so the
row they would write is one nothing ever reads. See "What a compose unit does
and does not get".

Two upstream mutations also gained a build-policy check: `application.update`
and `compose.update` refuse a non-empty `requiredChecks` on a unit that can
never satisfy one. See "What a unit needs before it can be check-gated".

---

## Hook points in upstream code

Every one is marked in the source with `build-policy hook`. Grep for that string
to find them all. There are **thirty-eight**, in eleven files, plus seven import
markers, two zod lines in the schema files, and the two UI fields below.

| File | Hooks |
|---|---|
| `packages/server/src/services/application.ts` | 22 |
| `packages/server/src/services/deployment.ts` | 2 |
| `packages/server/src/utils/builders/index.ts` | 1 |
| `packages/server/src/services/compose.ts` | 1 |
| `apps/dokploy/pages/api/deploy/github.ts` | 2 |
| `apps/dokploy/pages/api/deploy/gitlab.ts` | 3 |
| `apps/dokploy/pages/api/deploy/[refreshToken].ts` | 2 |
| `apps/dokploy/pages/api/deploy/compose/[refreshToken].ts` | 1 |
| `apps/dokploy/server/queues/queueSetup.ts` | 2 |
| `apps/dokploy/server/queues/queue-types.ts` | 1 |
| `apps/dokploy/server/queues/deployments-queue.ts` | 1 |

### `packages/server/src/services/application.ts`

The same five hooks in each of four deploy paths — `deployApplication`,
`rebuildApplication`, `deployPreviewApplication`, `rebuildPreviewApplication` —
plus one line in each of the two non-preview paths that creates the deployment
log on the build host.

| Hook | What it replaces / adds |
|---|---|
| 1/4 | `const serverId = application.buildServerId \|\| application.serverId` becomes the same expression with `buildPolicy.buildServerId` in front. `planApplicationBuild` throws `BuildPolicyError` on an `error` decision, which is how a missing build server fails the deploy. |
| 2a/4 | before `getBuildCommand`, `runBuildPolicyPreBuildGate(...)` gates on required checks. Returns the caller's command string unchanged, and executes nothing, when the gate is inactive. |
| 2/4 | after `getBuildCommand`, appends `getBuildPolicyPushCommand(...)`. Returns `""` when not enforcing, so the built command is byte-identical in that case. |
| 3/4 | after the build shell runs, `prepareBuildPolicyDeploy(...)` reads the published digest, writes it to the deployment row, and returns the application object to deploy. Returns the input unchanged when not enforcing. Required checks are no longer here; see 2a/4. |
| 4/4 | `mechanizeDockerContainer(application)` becomes `mechanizeDockerContainer(deployTarget)`. |

Plus one import block, marked `Fork module`.

In the two preview paths hook 1/4 is split: the plan is computed before
`createDeploymentPreview`, because the log file has to be created on the host
that will build, and a refusal is rethrown from inside the `try`, so the preview
status, the deployment log and the PR comment all carry the reason.

**Merge note:** if upstream moves the `serverId` line or the
`mechanizeDockerContainer` call, re-apply hooks 1/4 and 4/4 to the new location.
Hook 2a/4 must stay between the clone and `getBuildCommand`; hooks 2/4 and 3/4 must stay between the build shell and the swarm update.

### `packages/server/src/services/deployment.ts`

`createDeployment` and `createDeploymentPreview` take an optional forced
`buildServerId`. The deployment log file is created on whichever host is going to
build, which is no longer `application.buildServerId || serverId` once the policy
relocates the build.

### `packages/server/src/utils/builders/index.ts`

- `ApplicationNested` gains an optional `buildPolicyImage?: string | null`.
- `getImageName` returns it first when set. Three lines.

This is the deploy-by-digest seam. Nothing else in the builders is touched, so
the six build types are exactly upstream's.

### `packages/server/src/services/compose.ts`

Two calls to `waitForComposeRequiredChecks`, one per compose deploy pipeline:

- in `runComposeBuild`, between the clone/patches steps and the build step, and
  ahead of the `down --volumes` step so a refused check never leaves the stack
  torn down. `runComposeBuild` already ran its deploy as discrete `runStep`
  calls, so this is a single inserted line rather than a restructure.
  `deployCompose` and both compose preview paths reach it.
- in `rebuildCompose`, which has its own inlined pipeline, in the same position
  relative to the patches step, the teardown and the build.

Plus one import block, marked `Fork module`.

**Merge note:** if upstream reorders the steps in either function, the call must
stay after the clone or the patches (so the sha is the one being deployed) and
before the teardown and the build. If upstream adds a third compose deploy
pipeline, it needs its own call: missing one is round-3 review finding H.

### `apps/dokploy/pages/api/deploy/github.ts`

- one import of `buildPolicyDeployGate`, one of the two coalescing helpers.
- in the push→applications loop and the push→composes loop, a
  `buildPolicyDeployGate({...}); if (!gate.deploy) continue;` block **after**
  upstream's own `shouldDeploy` check, so upstream's lines are untouched.

Tag pushes and pull-request previews are deliberately not gated here: a preview
is created by opening a PR, and coalescing or watch-path filtering it would
silently drop the preview a reviewer is waiting for.

### `apps/dokploy/pages/api/deploy/gitlab.ts`

The same two gate blocks as `github.ts`, in the Push Hook handler's applications
and composes loops, again **after** upstream's own `shouldDeploy` check. Tag
pushes and merge-request previews are not gated, for the same reasons.

One extra local helper, `gitlabHeadCommitMessage`, because GitLab's job title is
`Push to <branch>` rather than the commit message, so `[skip deploy]` has to be
read out of the payload: the commit whose `id` equals `checkout_sha`, falling
back to the newest entry in `commits`.

Coalescing is the reason this route is gated at all. A GitLab-sourced unit is
never build-relocated (`decideBuildPolicy` returns `not_github`), but coalescing
is a pure compute win that applies whatever the source type, and before this the
busiest route for some units did not have it.

### `apps/dokploy/pages/api/deploy/[refreshToken].ts`

- `resolveDeployHookImage(...)` for the optional `{image, tag, digest}` body,
  **then** the gate; a validated image is passed through the job as
  `pinnedImage`.
- the order matters. The gate coalesces, which drops this unit's still-waiting
  deploys, and the body validation can answer 400. Coalescing on behalf of a
  request that is then refused leaves the queue empty and nothing enqueued, and
  a CI job retrying with a broken body would keep it that way. The validation
  reads nothing the gate produces, so putting it first is free.

### `apps/dokploy/pages/api/deploy/compose/[refreshToken].ts`

- `rejectComposeDeployHookImage(...)`, **then** the gate. A supplied image is
  **rejected with a 400 while the organization enforces**, and ignored otherwise
  — see Known gap.
- the ordering argument above applies here with more force: this refuses *every*
  body carrying an image while enforcing, so a CI job that standardises on
  always posting one would otherwise coalesce the queue and 400 on every single
  push, for ever.

### `apps/dokploy/server/queues/queueSetup.ts`

- `cleanQueuesByApplication` and `cleanQueuesByCompose` now return the number of
  jobs they dropped. Both were already exported and both existing callers ignore
  the value, so this is additive.
- `coalesceQueuedApplicationDeploys` / `coalesceQueuedComposeDeploys`, the
  coalescing siblings of those two. See **Coalescing** below.

### `apps/dokploy/server/queues/queue-types.ts`

- the `applicationType: "application"` arm gains an optional `pinnedImage`.

### `apps/dokploy/server/queues/deployments-queue.ts`

- one `if (job.data.pinnedImage)` branch ahead of the existing `deploy` /
  `redeploy` branches, calling `deployPinnedApplicationImage`.

### UI

- `components/dashboard/application/advanced/show-build-server.tsx` — while the
  organization enforces and the unit is GitHub sourced, the build server and
  build registry selects and the save button are disabled and an info block says
  why. Spec 5.2.1: the field is ignored at deploy time, so it must not accept an
  edit that will have no effect.
- `components/dashboard/application/advanced/show-required-checks.tsx` — the
  field description says a name matches a check run **or** a commit status.

### Barrels

- `packages/server/src/db/schema/index.ts` — one export line.
- `packages/server/src/index.ts` — one export line.
- `apps/dokploy/server/api/root.ts` — one import and one router key.

### Schema columns on upstream tables

- `application.requiredChecks` (`text[]`), plus one zod line in the file's
  `createSchema` overrides because drizzle-zod 0.5.1 does not infer array columns
  (`watchPaths` needs the same line).
- `compose.requiredChecks` (`text[]`), same.
- `deployment.imageTag`, `deployment.imageDigest` (`text`).

---

## Migration

`apps/dokploy/drizzle/0200_handy_lifeguard.sql`, written idempotently
(`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`) in the fork house
style, so a re-run on a partially migrated database is a no-op.

Creates `build_policy_settings`, `build_policy_exclusion`, `build_policy_audit`
and the `buildPolicyAuditAction` enum; adds the four columns above. No data
migration: an organization with no settings row has the policy off, which is the
pre-change behaviour.

---

## The deploy-hook image body, and which repository it may name

A deploy hook URL is a bearer token pasted into CI configs across the fleet, so
the `{image, tag, digest}` body has two gates: it does nothing while the policy
is off, and the image must be **this unit's own repository**, compared for exact
whole-repository equality. An org-wide *host* allowlist would let any one unit's
token deploy any image on ghcr.io, which is why it is not one.

"Its own repository" is not a fixed precedence, it is wherever this unit's image
actually lives, so the allowlist asks the plan through
`previewBuildPolicyDecision`:

- a unit the policy would **enforce** publishes to `settings.defaultRegistryId`,
  so that is the allowed repository;
- a unit the policy leaves **local** — excluded, break-glassed, or not GitHub
  sourced — publishes to its own `registryId`, exactly as it did before the
  fork, so that is the allowed one.

Gate 1 tests whether the *organization* enforces, not whether this unit does, so
both cases are live and a fixed precedence gets one of them wrong whichever way
it points. Round-2 finding D pointed it at the org default and fixed the
enforced case; round-3 finding I caught the local case it broke.

`previewBuildPolicyDecision` is read-only on purpose: validating a request body
must not spend the one-shot break-glass grant that belongs to the next deploy,
and must not write an audit row per webhook delivery.

There is deliberately **no** "must be fully qualified with a registry host"
check. `registryUrl` is `notNull().default("")` and an empty string is the
supported Docker Hub configuration, so `getRegistryTag` legitimately returns
`prefix/app` with no host. Requiring a host meant that an organization whose
default registry is Docker Hub rejected every deploy-hook body once the
allowlist started resolving through that default (round-3 finding J). The check
bought something when the allowlist was a host allowlist; under whole-repository
equality a hostless reference can only match a hostless allowed repository,
which is the same repository.

---

## How the digest crosses hosts

The build runs as a detached shell on the build server; its only channel back is
the deployment log file. So the appended shell echoes

```
__DOKPLOY_IMAGE_DIGEST__ <registry>/<prefix>/<app>:<sha> sha256:<64 hex>
```

and `readPublishedImage` greps that one line back off the build server. If the
line is absent the deploy fails with `DIGEST_NOT_PUBLISHED` rather than deploying
a mutable tag.

The sha is resolved inside the shell with `git rev-parse HEAD` rather than passed
in, because a manual redeploy has no webhook payload to read it from.

**The marker is not trusted on its name.** That same log file carries the
repository's own `docker build` output, so a `RUN echo` in a Dockerfile can put a
forged marker line in it. `readPublishedImage` therefore rejects any marker whose
tag does not start with the repository this deploy is publishing, and runs it
through `assertSafeImageReference`, before anything is pinned. `set -e` also
happens to keep the genuine marker last today, but the deploy does not rest on
that.

---

## Required checks

`requiredChecks` names are matched against **both** the Checks API
(`checks.listForRef`) and the legacy commit statuses API
(`repos.listCommitStatusesForRef`), with a status `state` mapped onto a check
conclusion, so a name published either way resolves. A token without the statuses
scope logs and falls back to check runs alone rather than failing the deploy.

Without the statuses half, a team that typed the name of a check published as a
commit status would wait the full timeout and then fail with
`REQUIRED_CHECKS_TIMEOUT` naming a check that had in fact passed.

### When the gate runs, and what it costs

The gate runs **between the clone and the build** (`runBuildPolicyPreBuildGate`,
hook 2a/4), on the sha the clone just fetched. When it is active it executes the
clone half of the deploy command itself and hands the caller a fresh `set -e;`
prefix to build the rest from; when it is inactive it returns the caller's
string unchanged and executes nothing, so the assembled command is
byte-identical to upstream's. Every generated build command uses absolute paths
or does its own `cd`, so nothing depends on a working directory the clone half
left behind.

It is also **policy-gated**: it does nothing unless the organization has
`enforceRemoteBuilds` on. A `requiredChecks` value alone used to be enough to
enter the branch, which meant a per-unit field could change deploy behaviour on
an instance where nobody had turned the policy on. It *is* still honoured for a
unit the policy left local — an exclusion decides where a unit builds, not
whether its team gave up its CI gate.

**What this does not fix, and you have to plan for it.** The wait still occupies
the deployment slot it is running in. `jobData.serverId` is set only under
`IS_CLOUD`, so on a self-hosted instance every deployment job lands in the single
`LOCAL_PARTITION`, whose concurrency is `buildsConcurrency ?? 1`. One unit
waiting on a check that never arrives therefore queues every other deploy on the
instance for the whole timeout. Two consequences:

- the default timeout is **5 minutes**, not 30. A mistyped check name costs five
  minutes of the instance's deploy capacity;
- **raise `buildsConcurrency` before enabling required checks** on a busy
  instance.

Taking the wait out of the queue entirely means not enqueueing the deploy until
the checks pass — a waiter that lives outside the queue and survives a restart.
That is a queue redesign rather than a hook point, and it is deliberately left as
follow-up rather than smuggled into this branch. What has changed is that the
ordering is now a decision rather than an accident of where hook 3/4 sat, and
that a refused check no longer costs a whole build.

### What a unit needs before it can be check-gated

Three things, all of them, and `describeRequiredChecksSupport` (`source.ts`)
tests all three:

1. **A github.com source.** Either `sourceType: "github"`, or `sourceType: "git"`
   with a github.com `customGitUrl`. Enterprise GitHub hosts are excluded on
   purpose: they use a different API base.
2. **A resolvable `owner`/`repo`**, from the unit's own columns for a GitHub App
   unit or parsed out of `customGitUrl` for a plain git remote.
3. **A GitHub App installation** — `githubId`. The checks and statuses endpoints
   are authenticated and there is no anonymous path, so a unit that never had an
   App connection can never satisfy a check, however well its repository parses.

The `sourceType: "git"` fallback is not decorative: `saveGitProvider` sets
`sourceType: "git"` without clearing `githubId`, so a unit moved from the App to
a plain git remote keeps a usable installation token and stays gateable. A unit
that never had one does not.

`application.update` refuses a non-empty `requiredChecks` on a unit failing any
of the three, with a 400 naming the unit and the remedy. Setting an **empty**
list is always allowed, so a unit can always be cleared out of an unsupported
state. Round-2 review finding F: before this, the owner/repo resolved, the very
next step threw, and the operator learned about it one wasted build at a time —
after the image had been tagged and pushed.

---

## Coalescing

Coalescing drops the unit's still-waiting **plain deploys only**. A queued PR
preview for the same application carries the same `applicationId`, and upstream's
`cleanQueuesByApplication` matches on that alone — which is right for the
explicit "clean queues" action it backs, and wrong here. Coalescing runs
automatically on every push; dropping a preview nobody asked to cancel would make
the PR's preview simply never appear.

So `coalesceQueuedApplicationDeploys` additionally requires
`applicationType === "application"` (and the compose sibling `"compose"`), and
both report the titles of what they dropped so the audit row names it.

---

## Rollback

Two mechanisms, and they do not touch each other.

- **Upstream**, `services/rollbacks.ts`: the build command snapshots
  `<appName>:latest` into a dedicated `rollbackRegistry` when `rollbackActive`,
  and a rollback redeploys that tag. Unchanged by this branch, and it still works
  under the policy because the snapshot runs as part of the build, on whichever
  host built.
- **This module**, `rollback.ts` (spec 5.2.4): every enforced deploy already
  writes `imageTag` and `imageDigest` onto its deployment row, so
  `buildPolicy.rollbackToDigest` can put any past deployment back with a pull and
  a service update and no build at all. It needs no `rollbackRegistry` and no
  `rollbackActive`.

The digest path deliberately does **not** re-run required checks: the commit
being restored already shipped, and a rollback is the one moment a team cannot
afford to wait on CI. A deployment row with no stored digest is refused with
`DIGEST_NOT_PUBLISHED` rather than being silently turned into a build; rows from
before the policy was enforced have none.

---

## Preview deployments

PR previews are enforced: `deployPreviewApplication` and
`rebuildPreviewApplication` carry the same four hooks, so a preview builds on the
organization build server and deploys by digest like everything else. Unloading
the deploy host is the point of the track, and previews are a large share of its
build load.

Two deliberate differences:

- The preview image is tagged and pushed under the **preview's own** `appName`,
  so a preview never overwrites the production tag for the same repository.
- Previews are not gated in the webhook: no coalescing, no derived watch paths,
  no `[skip deploy]`. A preview is created by opening a PR, and a reviewer
  waiting on it should not have it filtered away by a path rule.

---

## Known gap: compose units

A compose unit builds and runs in a single `docker compose up --build`, so its
build cannot be moved to another host without splitting the deploy in two and
requiring every buildable service to declare an `image:` key pointing at the org
registry. That is a large change to upstream's compose path and it would break
every compose unit in the fleet that has no `image:` keys today.

So `decideBuildPolicy` returns `local` / `compose_build_not_relocatable` for
compose units, and the compose deploy hook rejects a supplied image with a 400
while the organization enforces. There is a test asserting exactly that reason
(`policy-decision.test.ts` → "does not relocate a compose build, and says so
explicitly"), so the gap is visible and any future change to it is deliberate.

### What a compose unit does and does not get

Not everything, and the difference is deliberate. Round-2 review finding A: this
paragraph used to claim all six behaviours applied "in full", three of them did
not, and `compose.requiredChecks` was a writable API field that silently did
nothing — a document claiming a CI gate that is not wired is wrong in the
dangerous direction.

| Behaviour | Compose | Where |
|---|---|---|
| Queue coalescing | **yes** | `buildPolicyDeployGate`, enqueue time |
| `[skip deploy]` | **yes** | same gate |
| Derived `watchPaths` | **yes** | same gate |
| `requiredChecks` | **yes**, on deploy, redeploy and previews | `compose-checks.ts`, called from `runComposeBuild` and from `rebuildCompose`, between the clone and the build |
| Exclusions | **no** | nothing to exclude from |
| Break-glass | **no** | no relocated build to grant an escape from |
| Relocated build, push by sha, deploy by digest | **no** | the Known gap above |

Exclusions and break-glass decide **where** a unit builds. A compose build is
never relocated, so `resolveBuildPolicy` — the only reader of exclusions and
grants — is never called on the compose path at all. Both procedures therefore
refuse a `composeId` with a 400 that says why, rather than writing an FK-linked
row nothing will ever read: before this, a break-glass grant issued against a
compose unit stayed pending for ever and the audit log showed a grant that was
never spent.

`requiredChecks` is different, and is the half with real value, so it is wired.
`runComposeBuild` already runs the deploy in discrete steps, which gives a clean
hook between the clone/patches steps and the build step — the compose equivalent
of the application path's hook 2a/4. It sits **ahead** of the
`down --volumes` step, so a refused check never leaves the stack torn down. It
carries the same default-off shape as everything else here (an empty list reads
nothing; a non-empty one costs the cached enforcement boolean first) and the
same API-boundary validation as an application (see "What a unit needs before it
can be check-gated").

**Every compose deploy path must call it, and there are two.** `deployCompose`
and both compose preview paths go through `runComposeBuild`; `rebuildCompose`
— the Redeploy button — has its own inlined pipeline and needs its own call.
Round-3 review finding H was exactly that call missing, and it was worse than a
stale table row: `runComposeBuild` clones *before* it gates, so a refused deploy
leaves the unchecked commit in the code directory, and an ungated Redeploy would
build precisely the commit the gate had just rejected. If a third compose deploy
path is ever added, it needs the call too.

---

## Tests

`apps/dokploy/__test__/build-policy/`:

| File | Covers |
|---|---|
| `policy-decision.test.ts` | the pure decision, every branch |
| `source-and-markers.test.ts` | github.com detection, `[skip deploy]`, derived watch paths |
| `image-and-hook-body.test.ts` | tagging, digest parsing, deploy-hook body validation |
| `published-image.test.ts` | the digest read-back, including forged markers |
| `required-checks.test.ts` | check-run and commit-status evaluation, and the polling wait |
| `coalesce.test.ts` | that a queued preview for the same unit survives coalescing |
| `router-and-checks.test.ts` | organization ownership on every id taken from input |
| `plan-failure.test.ts` | that a refused plan still produces a deployment row and a notification |
| `policy-off-is-upstream.test.ts` | that nothing here changes behaviour while the policy is off |
| `rollback-by-digest.test.ts` | rollback to a stored digest, and the refusal when there is none |
| `required-checks-support.test.ts` | that a unit with no GitHub App is refused a required check at the API boundary, and that clearing one is always allowed |
| `required-checks-before-build.test.ts` | that the checks gate is policy-gated, runs before the build on the freshly cloned sha, and is a no-op that executes nothing while the policy is off |
| `gate-audit-and-registry.test.ts` | that a derived watch-path skip is audited, and that the deploy-hook allowlist follows the registry an enforced build publishes to |
| `watch-paths-by-source.test.ts` | that the derived watch paths read the build-path column matching the unit's source type, so a unit migrated from GitHub to GitLab is not filtered by a stale path |
| `hook-allowlist-follows-plan.test.ts` | that the deploy-hook allowlist names the repository this unit's image will actually live on, for enforced and for local units alike, and that a Docker Hub registry with no host is accepted |
| `hook-body-before-coalescing.test.ts` | that a refused deploy-hook body never coalesces the unit's queue |
| `compose-redeploy-gate.test.ts` | that the Redeploy button is check-gated too, so a commit the push gate refused cannot be shipped from the code directory it left behind |
| `compose-required-checks.test.ts` | that a compose unit's required checks are honoured, that the gate is default-off, and that it never consults exclusions or break-glass |
| `gitlab-route-gate.test.ts` | that the GitLab push webhook consults the gate for both unit types, and reads `[skip deploy]` from the commit rather than the job title |
| `deploy-path.integration.test.ts` | the real deploy path end to end, with docker, ssh and git mocked |

The integration test is the tripwire for upstream merges (spec §11): it drives
the real `deployApplication` and `rebuildApplication` with the real `policy.ts`,
`apply.ts` and `image.ts`, so if an upstream merge removes a hook point these
fail loudly rather than silently reverting the policy.

Run: `cd apps/dokploy && npx vitest run --config __test__/vitest.config.ts __test__/build-policy`
