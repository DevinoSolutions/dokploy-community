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
| 6 | Per-unit `requiredChecks` gating | `required-checks.ts`, `github-checks.ts` |
| 7 | Deploy-hook body `{image, tag, digest}` | `hook-body.ts`, `pinned-deploy.ts` |

The policy is **off by default**. With no `build_policy_settings` row for an
organization, every code path below short-circuits to the upstream behaviour.

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

## Files

| File | Contents |
|---|---|
| `policy.ts` | the pure decision (above) |
| `source.ts` | github.com detection for `sourceType: github` and for a `git` source whose `customGitUrl` is on github.com; `owner/repo` parsing |
| `settings.ts` | organization settings read/upsert, required-checks timeout |
| `exclusions.ts` | exclusion list / lookup / add / remove |
| `audit.ts` | append-only trail; break-glass grant, lookup and consumption |
| `resolve.ts` | database-backed wrapper around `policy.ts`; the only place a grant is spent |
| `apply.ts` | the application deploy path: plan, remote tag/push/digest shell, digest read-back, deploy-by-digest preparation |
| `image.ts` | `<app>:<sha>` tagging, digest validation, digest-marker parsing, `repo@sha256:…` refs |
| `hook-body.ts` | validation of a deploy-hook `{image, tag, digest}` body against the org registries |
| `pinned-deploy.ts` | a whole deploy of a supplied image, with no build |
| `required-checks.ts` | pure check-run evaluation plus a polling wait with an injectable clock |
| `github-checks.ts` | the same wait, wired to the GitHub App installation token |
| `coalesce.ts` | drop still-waiting deploys for a unit and audit it |
| `watch-paths.ts` | derive default `watchPaths` from `buildPath` / Dockerfile / compose path |
| `skip-deploy.ts` | the `[skip deploy]` commit-message marker |
| `webhook.ts` | the single enqueue-time gate every deploy entry point calls |
| `errors.ts` | `BuildPolicyError` with stable codes |

---

## Hook points in upstream code

Every one is marked in the source with `build-policy hook`. Grep for that
string to find them all. There are **eleven**, in eight files.

### `packages/server/src/services/application.ts`

Four hooks in `deployApplication`, and the same four in `rebuildApplication`.

| Hook | What it replaces / adds |
|---|---|
| 1/4 | `const serverId = application.buildServerId \|\| application.serverId` becomes the same expression with `buildPolicy.buildServerId` in front. `planApplicationBuild` throws `BuildPolicyError` on an `error` decision, which is how a missing build server fails the deploy. |
| 2/4 | after `getBuildCommand`, appends `getBuildPolicyPushCommand(...)`. Returns `""` when not enforcing, so the built command is byte-identical in that case. |
| 3/4 | after the build shell runs, `prepareBuildPolicyDeploy(...)` gates on required checks, reads the published digest, writes it to the deployment row, and returns the application object to deploy. Returns the input unchanged when not enforcing. |
| 4/4 | `mechanizeDockerContainer(application)` becomes `mechanizeDockerContainer(deployTarget)`. |

Plus one import block, marked `Fork module`.

**Merge note:** if upstream moves the `serverId` line or the
`mechanizeDockerContainer` call, re-apply hooks 1/4 and 4/4 to the new location.
Hooks 2/4 and 3/4 must stay between the build shell and the swarm update.

### `packages/server/src/utils/builders/index.ts`

- `ApplicationNested` gains an optional `buildPolicyImage?: string | null`.
- `getImageName` returns it first when set. Three lines.

This is the deploy-by-digest seam. Nothing else in the builders is touched, so
the six build types are exactly upstream's.

### `apps/dokploy/pages/api/deploy/github.ts`

- one import of `buildPolicyDeployGate`, one of the two `cleanQueues*` helpers.
- in the push→applications loop and the push→composes loop, a
  `buildPolicyDeployGate({...}); if (!gate.deploy) continue;` block **after**
  upstream's own `shouldDeploy` check, so upstream's lines are untouched.

Tag pushes and pull-request previews are deliberately not gated.

### `apps/dokploy/pages/api/deploy/[refreshToken].ts`

- the gate, plus `resolveDeployHookImage(...)` for the optional
  `{image, tag, digest}` body; a validated image is passed through the job as
  `pinnedImage`.

### `apps/dokploy/pages/api/deploy/compose/[refreshToken].ts`

- the gate. A supplied image is **rejected with a 400**, not ignored — see
  Known gap.

### `apps/dokploy/server/queues/queueSetup.ts`

- `cleanQueuesByApplication` and `cleanQueuesByCompose` now return the number of
  jobs they dropped. Both were already exported and both existing callers ignore
  the value, so this is additive.

### `apps/dokploy/server/queues/queue-types.ts`

- the `applicationType: "application"` arm gains an optional `pinnedImage`.

### `apps/dokploy/server/queues/deployments-queue.ts`

- one `if (job.data.pinnedImage)` branch ahead of the existing
  `deploy` / `redeploy` branches, calling `deployPinnedApplicationImage`.

### Barrels

- `packages/server/src/db/schema/index.ts` — one export line.
- `packages/server/src/index.ts` — one export line.
- `apps/dokploy/server/api/root.ts` — one import and one router key.

### Schema columns on upstream tables

- `application.requiredChecks` (`text[]`), plus one zod line in the file's
  `createSchema` overrides because drizzle-zod 0.5.1 does not infer array
  columns (`watchPaths` needs the same line).
- `compose.requiredChecks` (`text[]`), same.
- `deployment.imageTag`, `deployment.imageDigest` (`text`).

---

## Migration

`apps/dokploy/drizzle/0200_handy_lifeguard.sql`, written idempotently
(`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`) in the fork house
style, so a re-run on a partially migrated database is a no-op.

Creates `build_policy_settings`, `build_policy_exclusion`,
`build_policy_audit` and the `buildPolicyAuditAction` enum; adds the four
columns above. No data migration: an organization with no settings row has the
policy off, which is the pre-change behaviour.

---

## How the digest crosses hosts

The build runs as a detached shell on the build server; its only channel back
is the deployment log file. So the appended shell echoes

```
__DOKPLOY_IMAGE_DIGEST__ <registry>/<prefix>/<app>:<sha> sha256:<64 hex>
```

and `readPublishedImage` greps that one line back off the build server. If the
line is absent the deploy fails with `DIGEST_NOT_PUBLISHED` rather than
deploying a mutable tag.

The sha is resolved inside the shell with `git rev-parse HEAD` rather than
passed in, because a manual redeploy has no webhook payload to read it from.

---

## Known gap: compose units

A compose unit builds and runs in a single `docker compose up --build`, so its
build cannot be moved to another host without splitting the deploy in two and
requiring every buildable service to declare an `image:` key pointing at the org
registry. That is a large change to upstream's compose path and it would break
every compose unit in the fleet that has no `image:` keys today.

So `decideBuildPolicy` returns `local` / `compose_build_not_relocatable` for
compose units, and the compose deploy hook rejects a supplied image with a 400.
There is a test asserting exactly that reason
(`policy-decision.test.ts` → "does not relocate a compose build, and says so
explicitly"), so the gap is visible and any future change to it is deliberate.

**Every other behaviour applies to compose units in full**: exclusions,
break-glass, queue coalescing, `[skip deploy]`, derived `watchPaths` and
`requiredChecks`.

---

## Tests

- `apps/dokploy/__test__/build-policy/*.test.ts` — unit tests for the pure core.
- `apps/dokploy/__test__/build-policy/deploy-path.integration.test.ts` — drives
  the deploy path end to end with docker, ssh and git mocked, and is the
  tripwire for upstream merges (spec §11): if an upstream merge removes a hook
  point, these fail loudly rather than silently reverting the policy.

Run: `cd apps/dokploy && npx vitest run --config __test__/vitest.config.ts __test__/build-policy`
