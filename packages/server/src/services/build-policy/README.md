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
| 6 | Per-unit `requiredChecks` gating, over check runs **and** commit statuses | `required-checks.ts`, `github-checks.ts` |
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
`isBuildPolicyEnforcedAnywhere()` (`settings.ts`), one indexed
`enforceRemoteBuilds = true` lookup cached process-locally for five seconds. On
an instance where nobody enforces, that cached boolean is the entire cost of the
fork at enqueue time: no organization lookup, no settings read, no audit write.
`upsertBuildPolicySettings` clears the cache, so turning the policy on through
the UI takes effect at once; a direct database write takes up to the TTL.

The deploy path is the same story. `prepareBuildPolicyDeploy` (`apply.ts`)
returns the application unchanged before it reads a commit sha or a settings row
when the plan is unenforced and the unit has no required checks, so an
unenforced deploy makes no extra SSH round trip and no extra query.

`policy-off-is-upstream.test.ts` asserts all of this directly, including the
absence of the calls.

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
| `resolve.ts` | database-backed wrapper around `policy.ts`; the only place a grant is spent |
| `apply.ts` | the application deploy path: plan, remote tag/push/digest shell, digest read-back, deploy-by-digest preparation |
| `image.ts` | `<app>:<sha>` tagging, digest validation, digest-marker parsing, `repo@sha256:…` refs |
| `hook-body.ts` | validation of a deploy-hook `{image, tag, digest}` body against the unit's own repository |
| `pinned-deploy.ts` | a whole deploy of a supplied image, with no build |
| `rollback.ts` | redeploy the digest a past deployment stored (see Rollback) |
| `required-checks.ts` | pure check evaluation plus a polling wait with an injectable clock |
| `github-checks.ts` | the same wait, wired to the GitHub App installation token; merges check runs and commit statuses |
| `coalesce.ts` | drop still-waiting deploys for a unit and audit what was dropped |
| `watch-paths.ts` | derive default `watchPaths` from `buildPath` / Dockerfile / compose path |
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

---

## Hook points in upstream code

Every one is marked in the source with `build-policy hook`. Grep for that string
to find them all. There are **thirty-three**, in ten files, plus six import
markers, two zod lines in the schema files, and the two UI fields below.

| File | Hooks |
|---|---|
| `packages/server/src/services/application.ts` | 18 |
| `packages/server/src/services/deployment.ts` | 2 |
| `packages/server/src/utils/builders/index.ts` | 1 |
| `apps/dokploy/pages/api/deploy/github.ts` | 2 |
| `apps/dokploy/pages/api/deploy/gitlab.ts` | 3 |
| `apps/dokploy/pages/api/deploy/[refreshToken].ts` | 2 |
| `apps/dokploy/pages/api/deploy/compose/[refreshToken].ts` | 1 |
| `apps/dokploy/server/queues/queueSetup.ts` | 2 |
| `apps/dokploy/server/queues/queue-types.ts` | 1 |
| `apps/dokploy/server/queues/deployments-queue.ts` | 1 |

### `packages/server/src/services/application.ts`

The same four hooks in each of four deploy paths — `deployApplication`,
`rebuildApplication`, `deployPreviewApplication`, `rebuildPreviewApplication` —
plus one line in each of the two non-preview paths that creates the deployment
log on the build host.

| Hook | What it replaces / adds |
|---|---|
| 1/4 | `const serverId = application.buildServerId \|\| application.serverId` becomes the same expression with `buildPolicy.buildServerId` in front. `planApplicationBuild` throws `BuildPolicyError` on an `error` decision, which is how a missing build server fails the deploy. |
| 2/4 | after `getBuildCommand`, appends `getBuildPolicyPushCommand(...)`. Returns `""` when not enforcing, so the built command is byte-identical in that case. |
| 3/4 | after the build shell runs, `prepareBuildPolicyDeploy(...)` gates on required checks, reads the published digest, writes it to the deployment row, and returns the application object to deploy. Returns the input unchanged when not enforcing. |
| 4/4 | `mechanizeDockerContainer(application)` becomes `mechanizeDockerContainer(deployTarget)`. |

Plus one import block, marked `Fork module`.

In the two preview paths hook 1/4 is split: the plan is computed before
`createDeploymentPreview`, because the log file has to be created on the host
that will build, and a refusal is rethrown from inside the `try`, so the preview
status, the deployment log and the PR comment all carry the reason.

**Merge note:** if upstream moves the `serverId` line or the
`mechanizeDockerContainer` call, re-apply hooks 1/4 and 4/4 to the new location.
Hooks 2/4 and 3/4 must stay between the build shell and the swarm update.

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

- the gate, plus `resolveDeployHookImage(...)` for the optional
  `{image, tag, digest}` body; a validated image is passed through the job as
  `pinnedImage`.

### `apps/dokploy/pages/api/deploy/compose/[refreshToken].ts`

- the gate, plus `rejectComposeDeployHookImage(...)`. A supplied image is
  **rejected with a 400 while the organization enforces**, and ignored otherwise
  — see Known gap.

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

**Every other behaviour applies to compose units in full**: exclusions,
break-glass, queue coalescing, `[skip deploy]`, derived `watchPaths` and
`requiredChecks`.

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
| `gitlab-route-gate.test.ts` | that the GitLab push webhook consults the gate for both unit types, and reads `[skip deploy]` from the commit rather than the job title |
| `deploy-path.integration.test.ts` | the real deploy path end to end, with docker, ssh and git mocked |

The integration test is the tripwire for upstream merges (spec §11): it drives
the real `deployApplication` and `rebuildApplication` with the real `policy.ts`,
`apply.ts` and `image.ts`, so if an upstream merge removes a hook point these
fail loudly rather than silently reverting the policy.

Run: `cd apps/dokploy && npx vitest run --config __test__/vitest.config.ts __test__/build-policy`
