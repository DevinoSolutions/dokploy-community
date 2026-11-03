# Native GitHub Actions Connect, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service in this Dokploy follows a repository's GitHub Actions releases without exposing Dokploy to GitHub: the workflow publishes a manifest as a run artifact, Dokploy (outbound only) verifies it against the run and deploys the digest, and the dashboard shows the connection state. Tracking: T-13719. The deploy gate (T-13720) is phase 3, see "Where the deploy gate lands".

**Architecture:** Phase 1 sits on PR #577 (GitHub Deployments pull, device-flow token, `github_deployment_watch` cursor). A new `gha_connection` row owns one #577 watch per service. Each poll tick, Dokploy lists new GitHub Deployments whose task is `dokploy:<key>`, treats them as wake-ups only, and accepts a release only after checking the run, the `dokploy-release` artifact, the registry digest, the environment branch policy and commit order (spec rules 1 to 6). #577's tick is split into `prepareTick` and `handleFresh` so the connection path reuses its cursor, in-flight and status code unchanged. The release workflow is a new public action repository, `DevinoSolutions/dokploy-release`.

**Tech Stack:** TypeScript, Drizzle ORM and PostgreSQL migrations, tRPC with MCP tool generation, Next.js pages router with React and shadcn components, vitest, biome, GitHub REST (runs, artifacts, compare, environments, Deployments), Node 24 scripts and a composite GitHub Action.

Spec: `docs/superpowers/specs/2026-11-03-gha-native-connect-design.md` (revision 4, merged on canary at 037535ab). Read its "Trust model", "Credentials", "Poisoning controls", "Connection state machine" and "Phased delivery" sections first.

---

## Ground truth (checked 2026-11-03)

- **Base.** `origin/canary` is 037535abc. PR #577 (`feat/github-deployments-pull-t12166`, head `7a4c11d09d1ead76712a5a41c8977f69b9bb39dc`) is a draft, 5 commits, 44 files, merge base 9ec4e294, 18 commits behind canary.
- **#577 does not merge cleanly.** GitHub reports `CONFLICTING` / `DIRTY`. `git merge-tree` against 037535abc finds exactly three conflicting files:

| File | Conflict | Resolution |
|---|---|---|
| `apps/dokploy/drizzle/meta/_journal.json` | #577's entry `0226_github_deployment_watch` (when 1793540000000) collides with canary's `0226_watchdog_max_minutes_default` and `0227_deployment_live_github_run` (last when 1793690805783) | Renumber #577's migration to 0228 with a `when` above canary's last (Task 0) |
| `apps/dokploy/server/server.ts` | Both sides add a poller start after the queue restore: canary starts `startGithubRunPoller`, #577 starts `startGithubDeploymentsPoller` | Keep both (Task 0) |
| `packages/server/src/services/compose.ts` | Both add one import: canary `claimLiveGithubBuild` from `./live-build-claim`, #577 `loginGhcrForCompose` from `./github-deployments/registry-auth` | Keep both imports (Task 0) |

  The journal rule that makes the renumbering matter: Drizzle's migrator applies an entry only when its `when` is greater than the newest applied one, so a `when` below 1793690805783 would be skipped silently on every database that already ran 0227.
- **Migrations on canary end at `0227_deployment_live_github_run`** (idx 227, when 1793690805783). #577 becomes 0228 and this plan's migration is 0229.
- **The idempotency gate** is `apps/dokploy/__test__/db/migration-idempotency.test.ts`. Every `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN` and `ADD CONSTRAINT` in a fork migration (idx 174 and up) must be `IF NOT EXISTS` or wrapped in a `DO $$ ... EXCEPTION WHEN duplicate_object ... END $$;` block. Journal `when` values must be increasing and files must use LF line endings, because the migrator hashes file content.

### Real symbols this plan extends (all from #577 unless noted)

| Area | Symbols |
|---|---|
| Poll core (`packages/server/src/services/github-deployments/poll-core.ts`) | `pollWatch`, `WatchRow`, `PollDeps`, `StartOutcome`, `InflightState`, `DeployPayload`, `selectNewDeployments`, `STATUS_TEXT`, `watchKey`, `connectionKey`, `postStatus`, `reportEnd`, `describeError`, `WATCH_ERROR_BACKOFF_MS`, `POLL_INTERVAL_MS` |
| GitHub calls (`github-api.ts`) | `createDeploymentStatus`, `GithubDeployment`, `GITHUB_API`, `rateLimitRetryAt`, `fetchTokenOwner` |
| Payload (`payload.ts`) | `parsePinnedImage`, `parseDeploymentPayload`, `normalizeRunUrl`, `ParsedPayload` |
| Service writes (`service-image.ts`) | `decideApplicationImage`, `pinComposeImage`, `repositoryOfReference` |
| Store (`store.ts`) | `upsertGithubWatch`, `findGithubWatch`, `deleteGithubWatch`, `patchGithubWatch`, `listEnabledGithubWatches`, `loadConnectionToken`, `markGithubConnectionRevoked`, `findGithubConnectionInOrganization`, `loadGhcrCredentials` |
| Device flow | `GITHUB_DEVICE_SCOPE`, `startDeviceFlow`, `beginGithubConnect`, `progressGithubConnect` |
| App wiring | `apps/dokploy/server/queues/github-deployments-poller.ts` (`startDeploy`, `inspectInflight`, `runGithubDeploymentsTick`, `createGithubDeploymentsPollDeps`, `githubDeploymentTitle`), `apps/dokploy/server/api/routers/github-deployment.ts` |
| Canary live rows (c45, c46) | `registerExternalBuild` and `finishExternalBuild` in `packages/server/src/services/external-build.ts`, queue job field `deploymentId` in `apps/dokploy/server/queues/queue-types.ts`, `claimLiveGithubBuild`, `startGithubRunPoller` |
| Canary source switch | `saveDockerProvider`, `disconnectGitProvider`, `updateApplication`, `resolveDockerProviderFields` |
| Canary build policy | `evaluateRequiredChecks` in `packages/server/src/services/build-policy/required-checks.ts` (the gate reuses it in phase 3) |

### Assumptions and deviations from the spec

1. **The deploy gate is phase 3** (spec PR 10). Phase 1 stores `gateMode` (default `image`, the only mode that acts) and nothing else of the gate.
2. **Live rows exist only for services that already run an image** (application with a Docker source, raw compose). `registerExternalBuild` refuses a service Dokploy builds itself, so a git-sourced application shows the first run in the connection status text and gets its row at the first deploy.
3. **Connect refuses `repository-secret` protection mode** in phase 1. The column and acceptance rule 5 support it, but the confirmation wording belongs to the phase 2 wizard.
4. **Upkeep runs at most every 2 minutes per connection**, to keep the polling budget near the spec's 360 requests an hour per repository. The Deployment list still polls every 20 seconds.
5. **Drift protection (read-only image and compose for GitHub-managed services) and "Take over locally" are not in phase 1.** `disconnect` restores the saved source for an application when asked, which is the phase 1 form of take over.
6. **The wizard, scan, environment-secret writes and pull request creation are phase 2.** Phase 1 connect is "Copy the file".
7. **Phase 1 token.** The #577 device flow now asks `repo_deployment public_repo` (or `repo_deployment repo` for private repositories). `read:packages` is dropped, so `loadGhcrCredentials` returns null for a connection without it and prod never holds a GHCR token for a connected service.
8. **The `delivery: push|pull` guard.** Dokploy deploys only `pull` manifests. A `push` manifest is verified and advances the deployed commit record without deploying (spec "Migration path").
9. **Signatures verified in a scratch tree.** The pure modules, their tests and the action scripts below were run before this plan was written: 17 vitest files, 382 tests passing with `tsc --strict` clean against the #577 head plus these edits, 20 node tests for the action, and the migration applied twice on PostgreSQL 16. The app-layer wiring (router, poller dependencies, `startDeploy` extension, UI) could not be run there and is marked "wiring" with a typecheck gate and a manual proof.

### The proof adopter: voicekit (web service, `dev` environment)

Pick **voicekit web on its `dev` environment** as the first adopter. Reasons from the live GitHub data: it calls the shared `dokploy-compose.yml` wrapper at a sha, so one wrapper change in the `.github` repository covers it; its `dev` environment has a custom deployment branch policy limited to one branch, which is exactly what acceptance rule 5 and the Connect check require; and `dev` is not production, so a wrong release costs nothing. The other shared-workflow adopters follow once voicekit has held for a week.

---

## PR map

Phase 1 is Task 0 plus six pull requests. Each PR is reviewable alone, passes its own tests, and changes no runtime behavior until PR 4 turns the poller on for connections that exist.

| # | Repo | Content | Migration | Manual proof (lead) |
|---|---|---|---|---|
| Task 0 | fork | Rebase and land #577 | 0228 (renumbered) | #577's own design-doc proof |
| PR 1 | `DevinoSolutions/dokploy-release` (new) | Action, schema, fixtures, artifact upload, Deployment creation, self-test | none | Self-test run on the action repository |
| PR 2 | fork | `gha_connection` and `gha_release` tables, scope change, connect checks, `ghaConnection` API and MCP | 0229 | Reconnect GitHub, call `ghaConnection.connect` against voicekit web `dev` |
| PR 3 | fork | Acceptance engine: manifest parser, zip reader, registry probe, ordering, vendored fixtures | none | None (no runtime path yet) |
| PR 4 | fork | Poller: #577 refactor, connection poll, upkeep and stale, flip, release rows, statuses with URLs, live rows | none | Push-mode dry run, then the first pull release |
| PR 5 | fork | Copy-the-file connect UI and status panel | none | Click-through on the service page |
| PR 6 | `DevinoSolutions/.github` | `dokploy-compose.yml` wrapper: `push-deploy`, `delivery`, manifest publish; the ten cutovers by their lanes | none | voicekit cutover steps 1 to 3 |

Order: Task 0, then PR 1, PR 2 and PR 3 in any order (PR 3 vendors the fixtures PR 1 publishes, so merge PR 1 first), then PR 4, PR 5, PR 6. One review per PR head by an `opus5-worker` (high effort) pass or the standing Codex review; findings go in as commits, and a new head gets a new review.

## Conventions for every task

- Work in a worktree of your own: `git fetch origin canary && git worktree add C:/wt/<name> -b <branch> origin/canary` (a stacked PR branches from its parent branch instead). Never `git worktree remove` a worktree that contains a junction before unlinking the junction.
- Run tests from `apps/dokploy`: `pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect/<file>`. Typecheck with `pnpm -r run typecheck`. Format and lint changed files with `pnpm exec biome check --write <files>`.
- Commit with `git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "<message>"`. No AI attribution lines.
- Open pull requests with `gh pr create --repo DevinoSolutions/dokploy-community ...` (or `--repo DevinoSolutions/dokploy-release`, `--repo DevinoSolutions/.github`). Never open one against the upstream repository.
- Every work item has a GetItDone task; keep its status current, and mark it COMPLETED only when merged and live.
- Never touch a running instance, the MCP of a production Dokploy or prod data from a task. "Manual proof" steps are for the lead.
- After changing code run `graphify update .`.

## Task 0: Rebase and land #577

**Why first:** every later task edits #577's files and builds on its tables. Nothing in this plan merges before #577 is on canary.

**Files:**
- Modify (resolve): `apps/dokploy/drizzle/meta/_journal.json`, `apps/dokploy/server/server.ts`, `packages/server/src/services/compose.ts`
- Rename: `apps/dokploy/drizzle/0226_github_deployment_watch.sql` to `apps/dokploy/drizzle/0228_github_deployment_watch.sql`
- Create: `apps/dokploy/drizzle/meta/0228_snapshot.json`
- Modify: `docs/design/github-deployments-pull.md` (the two migration-number mentions)

- [ ] **Step 1: Work on the PR branch in its own worktree**

```bash
git fetch origin canary feat/github-deployments-pull-t12166
git worktree add C:/wt/pr577-land feat/github-deployments-pull-t12166
cd C:/wt/pr577-land
git rev-parse HEAD   # expect 7a4c11d09d1ead76712a5a41c8977f69b9bb39dc
git merge origin/canary
```

Expected: `CONFLICT` in exactly the three files above. A merge keeps the five reviewed commits intact. If a rebase is preferred, repeat the same three resolutions on each commit that touches them; the result is identical.

- [ ] **Step 2: Resolve `server.ts` by keeping both pollers**

In `apps/dokploy/server/server.ts` replace the conflict block with:

```ts
				// Follows the GitHub Actions runs behind the live deployment rows
				// (deployment.registerExternalBuild): one loop, one cheap query when none.
				const { startGithubRunPoller } = await import("@dokploy/server");
				startGithubRunPoller();
				// Services that follow GitHub Deployments (T-12166): one poll every
				// 20s, started after the restore so a restart never replays a deploy
				// it already queued.
				const { startGithubDeploymentsPoller } = await import(
					"./queues/github-deployments-poller"
				);
				const stopGithubDeploymentsPoller = startGithubDeploymentsPoller();
				// First in line on SIGTERM, ahead of the queue's own handler (see
				// registerShutdownHandler): no tick may enqueue a deploy into a queue
				// that is draining.
				process.prependListener("SIGTERM", stopGithubDeploymentsPoller);
```

- [ ] **Step 3: Resolve `compose.ts` by keeping both imports**

```ts
import { claimLiveGithubBuild } from "./live-build-claim";
import { loginGhcrForCompose } from "./github-deployments/registry-auth";
```

Run `pnpm exec biome check --write packages/server/src/services/compose.ts` so the import order matches the repository's sorting.

- [ ] **Step 4: Renumber the migration to 0228**

```bash
git mv apps/dokploy/drizzle/0226_github_deployment_watch.sql apps/dokploy/drizzle/0228_github_deployment_watch.sql
```

In `_journal.json` keep canary's entries up to idx 227, remove #577's `0226_github_deployment_watch` entry, and append after idx 227:

```json
    {
      "idx": 228,
      "version": "7",
      "when": 1793777205783,
      "tag": "0228_github_deployment_watch",
      "breakpoints": true
    }
```

`1793777205783` is canary's last `when` (1793690805783) plus one day. It must stay above every earlier entry. In the SQL header comment change "Numbered after 0225 (PR #576, T-12149)" to "Numbered after 0227". In `docs/design/github-deployments-pull.md` change the two mentions of 0226 (lines near 131 and 147) to 0228.

- [ ] **Step 5: Add the snapshot Drizzle expects for 0228**

Canary keeps one snapshot per migration (`meta/0226_snapshot.json`, `meta/0227_snapshot.json`), so 0228 needs one. Generate it, then keep only the snapshot:

```bash
cd apps/dokploy
pnpm exec drizzle-kit generate --config ./server/db/drizzle.config.ts --name tmp_snapshot_only
# It writes drizzle/00NN_tmp_snapshot_only.sql, meta/00NN_snapshot.json and a journal entry.
```

Then: move the new `meta/00NN_snapshot.json` to `meta/0228_snapshot.json`; delete the generated `.sql` file; remove the generated journal entry (the hand-guarded 0228 SQL and its entry from Step 4 stay). Open `0228_snapshot.json` and check its `prevId` equals the `id` of `0227_snapshot.json` (`c76aa1ca-d116-462a-9691-4b19b471edac`) and that its `tables` now include `public.github_deployment_connection` and `public.github_deployment_watch`. If the generator wants a different journal state, restore `_journal.json` from Step 4 first and rerun.

- [ ] **Step 6: Run the gates**

```bash
cd apps/dokploy
pnpm exec vitest run --config __test__/vitest.config.ts __test__/db/migration-idempotency.test.ts __test__/github-deployments __test__/mcp
pnpm -r run typecheck
```

Expected: all pass. The MCP scope snapshot may need `-u` only if canary added tools since #577 branched; review the snapshot diff and accept only additions that come from canary.

- [ ] **Step 7: Commit the merge and push**

```bash
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "chore: merge canary into the GitHub Deployments PR and renumber its migration to 0228 (T-12166)"
git push origin feat/github-deployments-pull-t12166
```

- [ ] **Step 8: Review gate (one review per PR head)**

Request one review of the new head from an `opus5-worker` pass at high effort (fallback order: the standing Codex review, then another opus5-worker). The reviewer gets the diff against canary, `docs/design/github-deployments-pull.md`, and this section. Required findings to fix before merge: none open. A fix commit is a new head and gets a new review.

- [ ] **Step 9: Mark ready and merge**

```bash
gh pr ready 577 --repo DevinoSolutions/dokploy-community
gh pr checks 577 --repo DevinoSolutions/dokploy-community
```

When every check is green, merge. The merge is the lead's call; do not merge for the lead.

- [ ] **Step 10: Manual proof for the lead (not for the implementer)**

Follow the proof section of `docs/design/github-deployments-pull.md` on a test instance: connect GitHub with the device flow, set a watch on one service, create a GitHub Deployment with a digest payload, confirm Dokploy deploys it and writes `success` back. Record the result on the PR. Do not do this on a production service.

## PR 1: The action repository `DevinoSolutions/dokploy-release`

A new public repository. It owns the manifest contract: the schema, the fixtures and the action. The fork vendors the fixtures in PR 3 and pins their hash, so the two cannot drift silently. No Dokploy address or API key appears anywhere in it.

Release manifest, as written by `scripts/build-manifest.mjs` (shape fixed by `schema/dokploy.release.v1.schema.json`): `{ schema: "dokploy.release/v1", sha, delivery, release: {id: "gh-<run>.<attempt>", services: [...]}, source: {forge: "github", ref, runId, runAttempt}, environment, services: [{ key, images: [{name, composeService, ref: "<repository>@sha256:<digest>"}], compose?: {path}, migrations: null }] }`. A tag next to a digest, build inputs (not available in v1), and any `migrations` value other than null are refused. Unknown fields and minor versions (`dokploy.release/v1.2`) are tolerated, an unknown major is not.

**Files (all in the new repository):**
- Create: `package.json`, `README.md`, `.gitignore`, `action.yml`, `schema/dokploy.release.v1.schema.json`
- Create: `scripts/make-fixtures.mjs`, `scripts/validate-fixtures.mjs`, `scripts/build-manifest.mjs`, `scripts/create-deployments.mjs`, `scripts/cli.mjs`
- Create: `fixtures/` (generated, committed), `test/build-manifest.test.mjs`, `test/create-deployments.test.mjs`, `test/cli.test.mjs`
- Create: `.github/workflows/selftest.yml`

### Task 1.1: Repository skeleton

- [ ] **Step 1: Create the repository (lead action, outward facing)**

```bash
gh repo create DevinoSolutions/dokploy-release --public --description "Publishes a release manifest and GitHub Deployments for Dokploy" --add-readme=false
git clone https://github.com/DevinoSolutions/dokploy-release C:/wt/dokploy-release
cd C:/wt/dokploy-release
git checkout -b feat/action-v1
```

Add a `LICENSE` file (MIT, holder DevinoSolutions) from GitHub's template.

- [ ] **Step 2: Write `package.json`, `.gitignore` and `README.md`**

**`package.json`**

```json
{
  "name": "dokploy-release",
  "version": "1.0.0",
  "private": true,
  "description": "Publishes a release manifest and GitHub Deployments for Dokploy.",
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "fixtures": "node scripts/make-fixtures.mjs",
    "test": "node --test \"test/*.test.mjs\"",
    "validate": "node scripts/validate-fixtures.mjs"
  },
  "devDependencies": {
    "ajv": "8.17.1"
  }
}
```

**`.gitignore`**

```text
node_modules/
```

**`README.md`**

````markdown
# dokploy-release

Publishes a release for [Dokploy](https://github.com/DevinoSolutions/dokploy-community) from a GitHub Actions run.
The action holds no Dokploy address and no Dokploy API key. It does two things:

1. Uploads the release manifest (`dokploy.release/v1`) as the run artifact `dokploy-release`.
2. Creates one GitHub Deployment per service (`task: dokploy:<key>`, `ref` = the commit sha) as the wake-up record.

Dokploy polls GitHub (outbound only), reads the artifact, checks it against the run, and deploys the digest.
The Deployment is only a signal. The artifact is the record Dokploy trusts, because only the run itself can upload its own artifacts.

## Use it (phase 1: your own job builds and pushes the image)

Add one job after the job that pushes your image. Take the image from an output of that job in the same run.

```yaml
  dokploy-release:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production        # deployment branches limited to main
    permissions:
      contents: read
      deployments: write
    steps:
      - uses: DevinoSolutions/dokploy-release@v1
        with:
          service: shop
          environment: production
          delivery: pull           # push while your workflow still calls the Dokploy API
          existing-image: ${{ needs.build.outputs.image }}   # ghcr.io/acme/shop@sha256:...
```

Rules the action enforces: the image must be `<repository>@sha256:<digest>` (a tag is refused), no build inputs are accepted yet
(`image`, `dockerfile`, `context`, `builder`, `registry` arrive later), and several services are written `key=image` or
`key/composeService=image`, one per line.

`delivery: push` publishes the same manifest but tells Dokploy not to deploy it: your own workflow still deploys, and
Dokploy only verifies the release and advances its record of the deployed commit. In that mode a failure to publish only warns.

## Files

| Path | What it is |
|---|---|
| `action.yml` | The composite action. Third-party actions are pinned by commit sha. |
| `schema/dokploy.release.v1.schema.json` | JSON Schema of the manifest. |
| `fixtures/` | Valid and invalid manifests (`index.json` lists them). Dokploy vendors these and pins their hash. |
| `scripts/` | `build-manifest.mjs`, `create-deployments.mjs`, `cli.mjs`, and the fixture generator and validator. |

Run `npm test` for the unit tests, `npm run fixtures` to regenerate the fixtures after a manifest change, and `npm run validate` to
check them against the schema.
````

- [ ] **Step 3: Commit**

```bash
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "chore: package, readme and license"
```

### Task 1.2: Schema and fixtures

- [ ] **Step 1: Write the schema**

**`schema/dokploy.release.v1.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/DevinoSolutions/dokploy-release/schema/dokploy.release.v1.schema.json",
  "title": "Dokploy release manifest",
  "description": "The run artifact dokploy-release (dokploy-release.json). Unknown fields are ignored by readers; an unknown major version is refused. Rules a schema cannot express (release.services equals the service keys, sha equals the run head) are checked by Dokploy.",
  "type": "object",
  "required": ["schema", "sha", "delivery", "release", "source", "environment", "services"],
  "properties": {
    "schema": { "type": "string", "pattern": "^dokploy\\.release/v1(\\.[0-9]+)?$" },
    "sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "delivery": { "enum": ["pull", "push"] },
    "release": {
      "type": "object",
      "required": ["id", "services"],
      "properties": {
        "id": { "type": "string", "pattern": "^[A-Za-z0-9._-]{1,128}$" },
        "services": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "$ref": "#/$defs/key" }
        }
      }
    },
    "source": {
      "type": "object",
      "required": ["forge", "ref", "runId", "runAttempt"],
      "properties": {
        "forge": { "const": "github" },
        "ref": { "type": "string", "pattern": "^refs/heads/.+" },
        "runId": { "type": "string", "pattern": "^[0-9]{1,18}$" },
        "runAttempt": { "type": "integer", "minimum": 1 }
      }
    },
    "environment": { "type": "string", "minLength": 1, "maxLength": 255 },
    "services": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["key", "images"],
        "properties": {
          "key": { "$ref": "#/$defs/key" },
          "images": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "required": ["name", "composeService", "ref"],
              "properties": {
                "name": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
                "composeService": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
                "ref": { "type": "string", "pattern": "@sha256:[0-9a-f]{64}$" }
              }
            }
          },
          "compose": {
            "type": ["object", "null"],
            "properties": { "path": { "type": "string", "pattern": "^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$" } }
          },
          "migrations": {
            "description": "Reserved. Dokploy phase 1 refuses any manifest where this is not null.",
            "type": ["object", "null"]
          }
        }
      }
    }
  },
  "$defs": {
    "key": { "type": "string", "pattern": "^[a-z0-9][a-z0-9._-]{0,62}$" }
  }
}
```

- [ ] **Step 2: Write the fixture generator**

The generator is the single source of the fixtures: valid manifests, and invalid ones that each break exactly one rule (a tag instead of a digest, an unknown major, a non-null `migrations`, a missing field, and so on). `fixtures/index.json` lists every file with `ok` true or false and a `reason` for the invalid ones. Dokploy's parser tests read the same files.

**`scripts/make-fixtures.mjs`**

```js
// Writes fixtures/valid/*.json, fixtures/invalid/*.json and fixtures/index.json.
// Deterministic: running it twice changes nothing. The index is the contract
// test list: { file, ok, code } where code is the failure the Dokploy parser
// must report (valid files have none).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const d = (c) => `sha256:${c.repeat(64)}`;

export const base = () => ({
	schema: "dokploy.release/v1",
	sha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	delivery: "pull",
	release: { id: "gh-9876543210.1", services: ["web", "worker"] },
	source: {
		forge: "github",
		ref: "refs/heads/main",
		runId: "9876543210",
		runAttempt: 1,
	},
	environment: "production",
	services: [
		{
			key: "web",
			images: [
				{
					name: "web",
					composeService: "web",
					ref: `registry.example.com/acme/shop/web@${d("e")}`,
				},
			],
			compose: { path: "docker-compose.prod.yml" },
			migrations: null,
		},
		{
			key: "worker",
			images: [
				{
					name: "worker",
					composeService: "worker",
					ref: `registry.example.com/acme/shop/worker@${d("a")}`,
				},
			],
			migrations: null,
		},
	],
});

const mutate = (fn) => {
	const m = base();
	fn(m);
	return m;
};

const valid = {
	"multi-service-pull": base(),
	"single-service-push": mutate((m) => {
		m.delivery = "push";
		m.release.services = ["web"];
		m.services = [m.services[0]];
	}),
	"multi-image-compose": mutate((m) => {
		m.release.services = ["stack"];
		m.services = [
			{
				key: "stack",
				images: [
					{
						name: "web",
						composeService: "web",
						ref: `registry.devino.ca/shorty/web@${d("1")}`,
					},
					{
						name: "docs",
						composeService: "docs",
						ref: `registry.devino.ca/shorty/docs@${d("2")}`,
					},
				],
				compose: { path: "docker-compose.yml" },
				migrations: null,
			},
		];
	}),
	"minor-version-and-unknown-fields": mutate((m) => {
		m.schema = "dokploy.release/v1.2";
		m.futureField = { anything: true };
		m.services[0].extra = "ignored";
	}),
};

const invalid = {
	"not-an-object": [null, "invalid"],
	"unknown-major": [mutate((m) => (m.schema = "dokploy.release/v2")), "unknown-schema"],
	"no-schema": [mutate((m) => delete m.schema), "unknown-schema"],
	"short-sha": [mutate((m) => (m.sha = "3f9c2a1")), "invalid"],
	"uppercase-sha": [mutate((m) => (m.sha = m.sha.toUpperCase())), "invalid"],
	"bad-delivery": [mutate((m) => (m.delivery = "later")), "invalid"],
	"tag-instead-of-digest": [
		mutate((m) => (m.services[0].images[0].ref = "registry.example.com/acme/shop/web:latest")),
		"invalid",
	],
	"tag-next-to-digest": [
		mutate((m) => (m.services[0].images[0].ref = `registry.example.com/acme/shop/web:v1@${d("e")}`)),
		"invalid",
	],
	"tag-ref-source": [mutate((m) => (m.source.ref = "refs/tags/v1")), "invalid"],
	"run-attempt-zero": [mutate((m) => (m.source.runAttempt = 0)), "invalid"],
	"services-do-not-match-release": [
		mutate((m) => (m.release.services = ["web", "api"])),
		"invalid",
	],
	"duplicate-compose-service": [
		mutate((m) => m.services[0].images.push({ ...m.services[0].images[0] })),
		"invalid",
	],
	"compose-path-traversal": [
		mutate((m) => (m.services[0].compose.path = "../outside.yml")),
		"invalid",
	],
	"asks-for-migrations": [
		mutate((m) => (m.services[0].migrations = { command: "pnpm db:migrate", destructive: false })),
		"migrations-unsupported",
	],
};

rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "valid"), { recursive: true });
mkdirSync(join(root, "invalid"), { recursive: true });
const index = [];
for (const [name, body] of Object.entries(valid)) {
	writeFileSync(join(root, "valid", `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
	index.push({ file: `valid/${name}.json`, ok: true });
}
for (const [name, [body, code]] of Object.entries(invalid)) {
	writeFileSync(join(root, "invalid", `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
	index.push({ file: `invalid/${name}.json`, ok: false, code });
}
writeFileSync(join(root, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${index.length} fixtures`);
```

- [ ] **Step 3: Write the schema validator (CI only)**

**`scripts/validate-fixtures.mjs`**

```js
// CI only: every valid fixture follows the JSON schema. (The invalid ones
// break rules a schema cannot state, so they are checked by Dokploy's parser,
// whose tests read the same files.)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "schema", "dokploy.release.v1.schema.json"), "utf8"));
const index = JSON.parse(readFileSync(join(root, "fixtures", "index.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

let failed = 0;
for (const entry of index.filter((e) => e.ok)) {
	const body = JSON.parse(readFileSync(join(root, "fixtures", entry.file), "utf8"));
	if (!validate(body)) {
		failed += 1;
		console.error(`${entry.file} does not follow the schema:`, JSON.stringify(validate.errors));
	}
}
if (failed > 0) process.exit(1);
console.log(`${index.filter((e) => e.ok).length} valid fixtures follow the schema`);
```

- [ ] **Step 4: Generate and validate**

```bash
npm install --no-audit --no-fund
node scripts/make-fixtures.mjs
npm run validate
```

Expected: `fixtures/index.json` plus `fixtures/valid/*.json` and `fixtures/invalid/*.json` exist, and the validator prints `N valid fixtures follow the schema` (N is the count of `ok` entries). The generator is deterministic: a second run changes nothing (`git status` stays clean after the first commit).

- [ ] **Step 5: Commit**

```bash
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: release manifest schema and fixtures"
```

### Task 1.3: Manifest builder

- [ ] **Step 1: Write the failing test**

**`test/build-manifest.test.mjs`**

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildManifest, InputError } from "../scripts/build-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, "..", "fixtures", name), "utf8"));
const D = (c) => `sha256:${c.repeat(64)}`;

const run = {
	GITHUB_SHA: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	GITHUB_REF: "refs/heads/main",
	GITHUB_RUN_ID: "9876543210",
	GITHUB_RUN_ATTEMPT: "1",
};
const env = (extra) => ({ INPUT_ENVIRONMENT: "production", INPUT_DELIVERY: "pull", ...run, ...extra });
const refuses = (extra, pattern) =>
	assert.throws(() => buildManifest(env(extra)), (error) => error instanceof InputError && pattern.test(error.message));

test("a compose with two images equals the golden fixture", () => {
	const manifest = buildManifest(
		env({
			INPUT_SERVICE: "stack",
			INPUT_COMPOSE: "docker-compose.yml",
			INPUT_EXISTING_IMAGE: [
				`stack/web=registry.devino.ca/shorty/web@${D("1")}`,
				`stack/docs=registry.devino.ca/shorty/docs@${D("2")}`,
			].join("\n"),
		}),
	);
	assert.deepEqual(manifest, fixture("valid/multi-image-compose.json"));
});

test("a bare image belongs to the only service", () => {
	const manifest = buildManifest(
		env({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/acme/shop/web@${D("e")}` }),
	);
	assert.deepEqual(manifest.services, [
		{
			key: "web",
			images: [{ name: "web", composeService: "web", ref: `ghcr.io/acme/shop/web@${D("e")}` }],
			migrations: null,
		},
	]);
	assert.equal(manifest.release.id, "gh-9876543210.1");
	assert.equal(manifest.source.runAttempt, 1);
});

test("several services each get their own image, from services and service", () => {
	const manifest = buildManifest(
		env({
			INPUT_SERVICES: "web\nworker",
			INPUT_EXISTING_IMAGE: `web=reg.example.com/a/web@${D("a")}\nworker=reg.example.com/a/worker@${D("b")}`,
		}),
	);
	assert.deepEqual(manifest.release.services, ["web", "worker"]);
	assert.equal(manifest.services[1].images[0].ref, `reg.example.com/a/worker@${D("b")}`);
	assert.equal(manifest.delivery, "pull");
});

test("push delivery is carried into the manifest", () => {
	const manifest = buildManifest(
		env({ INPUT_DELIVERY: "push", INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }),
	);
	assert.equal(manifest.delivery, "push");
});

test("a tag is refused, with and without a digest next to it", () => {
	refuses({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: "ghcr.io/a/b/web:latest" }, /not\. A tag is refused/);
	refuses({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web:v1@${D("e")}` }, /is not/);
});

test("with several services every line names its service", () => {
	refuses({ INPUT_SERVICES: "web\nworker", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /<key>=<image>/);
});

test("a service without an image, an unknown service and a repeated image are refused", () => {
	refuses({ INPUT_SERVICES: "web\nworker", INPUT_EXISTING_IMAGE: `web=ghcr.io/a/b/web@${D("e")}` }, /worker has no image/);
	refuses({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `api=ghcr.io/a/b/api@${D("e")}` }, /not one of the services/);
	refuses(
		{ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `web=ghcr.io/a/b/web@${D("e")}\nweb=ghcr.io/a/b/web@${D("f")}` },
		/two images/,
	);
});

test("odd inputs are refused", () => {
	refuses({ INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /Name the service/);
	refuses({ INPUT_SERVICE: "Web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /lowercase/);
	refuses({ INPUT_SERVICES: "web\nweb", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /twice/);
	refuses({ INPUT_SERVICE: "web", INPUT_DELIVERY: "later", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /pull" or "push/);
	refuses({ INPUT_SERVICE: "web", INPUT_ENVIRONMENT: " ", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /environment is required/);
	refuses({ INPUT_SERVICE: "web", INPUT_COMPOSE: "../x.yml", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /relative path/);
});

test("build inputs are refused until a later version builds", () => {
	for (const name of ["IMAGE", "DOCKERFILE", "CONTEXT", "BUILDER", "REGISTRY"]) {
		refuses({ INPUT_SERVICE: "web", [`INPUT_${name}`]: "x", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` }, /later version/);
	}
});

test("a run that is not on a branch cannot release", () => {
	refuses(
		{ GITHUB_REF: "refs/tags/v1", INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` },
		/from a branch/,
	);
	refuses(
		{ GITHUB_REF: "refs/pull/3/merge", INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `ghcr.io/a/b/web@${D("e")}` },
		/from a branch/,
	);
});

test("comments and blank lines in existing-image are ignored", () => {
	const manifest = buildManifest(
		env({ INPUT_SERVICE: "web", INPUT_EXISTING_IMAGE: `# built by the build job\n\n ghcr.io/a/b/web@${D("e")} \n` }),
	);
	assert.equal(manifest.services[0].images.length, 1);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../scripts/build-manifest.mjs'`.

- [ ] **Step 3: Write the implementation**

**`scripts/build-manifest.mjs`**

```js
// Builds the release manifest (dokploy.release/v1) from the action's inputs and
// the GitHub Actions run context. No dependency, no network: it only reads the
// environment it is given, so it is tested with plain objects.
//
// Phase 1 builds nothing: the image comes from `existing-image`, taken from an
// output of a job in the same run. A tag is refused.

const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const COMPOSE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMPOSE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const SHA = /^[0-9a-f]{40}$/;
const REF = new RegExp(
	"^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?/)?" +
		"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*" +
		"@sha256:[0-9a-f]{64}$",
);

export class InputError extends Error {}

const lines = (value) =>
	String(value ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

/**
 * @param {Record<string, string | undefined>} env
 * @returns {object} the manifest
 */
export const buildManifest = (env) => {
	for (const unsupported of ["IMAGE", "DOCKERFILE", "CONTEXT", "BUILDER", "REGISTRY"]) {
		if (String(env[`INPUT_${unsupported}`] ?? "").trim() !== "") {
			throw new InputError(
				`The input ${unsupported.toLowerCase()} builds an image, which arrives with a later version of this action. Build and push in your own job and pass its output as existing-image.`,
			);
		}
	}

	const keys = [...lines(env.INPUT_SERVICES), ...lines(env.INPUT_SERVICE)];
	if (keys.length === 0) {
		throw new InputError("Name the service with the service input (or services).");
	}
	for (const key of keys) {
		if (!KEY.test(key)) {
			throw new InputError(
				`Service key ${JSON.stringify(key)} must be lowercase letters, digits, dots, dashes or underscores.`,
			);
		}
	}
	if (new Set(keys).size !== keys.length) {
		throw new InputError("A service key is listed twice.");
	}

	const delivery = String(env.INPUT_DELIVERY ?? "pull").trim() || "pull";
	if (delivery !== "pull" && delivery !== "push") {
		throw new InputError('delivery must be "pull" or "push".');
	}
	const environment = String(env.INPUT_ENVIRONMENT ?? "").trim();
	if (environment === "" || environment.length > 255) {
		throw new InputError("environment is required (the GitHub Environment name).");
	}
	const compose = String(env.INPUT_COMPOSE ?? "").trim();
	if (compose !== "" && (!COMPOSE_PATH.test(compose) || compose.includes(".."))) {
		throw new InputError("compose must be a relative path inside the repository.");
	}

	const images = new Map(keys.map((key) => [key, []]));
	for (const line of lines(env.INPUT_EXISTING_IMAGE)) {
		const eq = line.indexOf("=");
		let target = null;
		let ref = line;
		if (eq > 0 && !line.slice(0, eq).includes("@")) {
			target = line.slice(0, eq).trim();
			ref = line.slice(eq + 1).trim();
		}
		if (!REF.test(ref)) {
			throw new InputError(
				`existing-image must be <repository>@sha256:<64 hex>; ${JSON.stringify(ref.slice(0, 120))} is not. A tag is refused: pass the digest your build job output.`,
			);
		}
		let key;
		let composeService;
		if (target === null) {
			if (keys.length !== 1) {
				throw new InputError(
					"With several services, write each image as <key>=<image> or <key>/<compose service>=<image>.",
				);
			}
			key = keys[0];
			composeService = key;
		} else {
			const slash = target.indexOf("/");
			key = slash < 0 ? target : target.slice(0, slash);
			composeService = slash < 0 ? target : target.slice(slash + 1);
		}
		if (!images.has(key)) {
			throw new InputError(`existing-image names ${JSON.stringify(key)}, which is not one of the services.`);
		}
		if (!COMPOSE_SERVICE.test(composeService)) {
			throw new InputError(`${JSON.stringify(composeService)} is not a compose service name.`);
		}
		const list = images.get(key);
		if (list.some((image) => image.composeService === composeService)) {
			throw new InputError(`${key} has two images for ${composeService}.`);
		}
		list.push({ name: composeService, composeService, ref });
	}
	for (const [key, list] of images) {
		if (list.length === 0) {
			throw new InputError(`Service ${key} has no image: set existing-image.`);
		}
	}

	const sha = String(env.GITHUB_SHA ?? "");
	const ref = String(env.GITHUB_REF ?? "");
	const runId = String(env.GITHUB_RUN_ID ?? "");
	const attempt = Number(env.GITHUB_RUN_ATTEMPT ?? "");
	if (!SHA.test(sha)) throw new InputError("GITHUB_SHA is not a commit sha.");
	if (!ref.startsWith("refs/heads/")) {
		throw new InputError(`A release is made from a branch; this run is on ${ref || "no ref"}.`);
	}
	if (!/^[0-9]{1,18}$/.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1) {
		throw new InputError("The run id or attempt is missing.");
	}

	return {
		schema: "dokploy.release/v1",
		sha,
		delivery,
		release: { id: `gh-${runId}.${attempt}`, services: keys },
		source: { forge: "github", ref, runId, runAttempt: attempt },
		environment,
		services: keys.map((key) => ({
			key,
			images: images.get(key),
			...(compose === "" ? {} : { compose: { path: compose } }),
			migrations: null,
		})),
	};
};
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: the `build-manifest` tests PASS (the other two test files do not exist yet).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-manifest.mjs test/build-manifest.test.mjs
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: build the release manifest from the action inputs"
```

### Task 1.4: Deployment creation

A Deployment is created with `ref` = the commit sha (never a branch name, so GitHub cannot move it), `task` = `dokploy:<key>`, `required_contexts: []` (so a failing check never blocks creating it), `auto_merge: false`, `transient_environment: false`, and a payload `{schema: "dokploy.deployment/v1", run_id, run_attempt, artifact: "dokploy-release"}`. It retries three times on a server error.

- [ ] **Step 1: Write the failing test**

**`test/create-deployments.test.mjs`**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeployments, deploymentBody, WAKE_SCHEMA } from "../scripts/create-deployments.mjs";

const manifest = {
	sha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	environment: "production",
	release: { id: "gh-9876543210.2", services: ["web", "worker"] },
	source: { runId: "9876543210", runAttempt: 2 },
};

const reply = (status, json = {}) => ({
	status,
	json: async () => json,
	text: async () => JSON.stringify(json),
});

test("the Deployment is a wake-up record: the commit, a dokploy task, no waiting on checks", () => {
	assert.deepEqual(deploymentBody(manifest, "web"), {
		ref: manifest.sha,
		task: "dokploy:web",
		environment: "production",
		auto_merge: false,
		required_contexts: [],
		transient_environment: false,
		description: "Dokploy release gh-9876543210.2",
		payload: { schema: WAKE_SCHEMA, run_id: 9876543210, run_attempt: 2, artifact: "dokploy-release" },
	});
});

test("one Deployment per service, posted to the repository, with the token only in the header", async () => {
	const calls = [];
	const created = await createDeployments(
		{
			repository: "DevinoSolutions/voicekit",
			token: "ghs_secret",
			fetch: async (url, init) => {
				calls.push({ url, init });
				return reply(201, { id: 1000 + calls.length });
			},
		},
		manifest,
	);
	assert.deepEqual(created, [
		{ key: "web", id: 1001 },
		{ key: "worker", id: 1002 },
	]);
	assert.equal(calls[0].url, "https://api.github.com/repos/DevinoSolutions/voicekit/deployments");
	assert.equal(calls[0].init.headers.Authorization, "Bearer ghs_secret");
	assert.equal(JSON.parse(calls[1].init.body).task, "dokploy:worker");
	assert.ok(!calls[0].init.body.includes("ghs_secret"));
});

test("a server error is retried, a client error is not", async () => {
	let n = 0;
	const created = await createDeployments(
		{
			repository: "a/b",
			token: "t",
			sleep: async () => {},
			fetch: async () => (++n < 3 ? reply(502) : reply(201, { id: 7 })),
		},
		{ ...manifest, release: { ...manifest.release, services: ["web"] } },
	);
	assert.equal(n, 3);
	assert.deepEqual(created, [{ key: "web", id: 7 }]);

	let calls = 0;
	await assert.rejects(
		createDeployments(
			{ repository: "a/b", token: "t", sleep: async () => {}, fetch: async () => (calls++, reply(422, { message: "bad ref" })) },
			{ ...manifest, release: { ...manifest.release, services: ["web"] } },
		),
		/Could not create the GitHub Deployment for web: HTTP 422/,
	);
	assert.equal(calls, 1);
});

test("a network failure ends in an error naming the service", async () => {
	await assert.rejects(
		createDeployments(
			{
				repository: "a/b",
				token: "t",
				sleep: async () => {},
				fetch: async () => {
					throw new Error("socket hang up");
				},
			},
			{ ...manifest, release: { ...manifest.release, services: ["web"] } },
		),
		/for web: socket hang up/,
	);
});

test("a repository that is not owner/name is refused before any request", async () => {
	await assert.rejects(
		createDeployments({ repository: "../x", token: "t", fetch: async () => assert.fail("no request") }, manifest),
		/owner\/name/,
	);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../scripts/create-deployments.mjs'`.

- [ ] **Step 3: Write the implementation**

**`scripts/create-deployments.mjs`**

```js
// Creates the GitHub Deployment of a release: the user-visible record and the
// wake-up signal Dokploy polls for. Nothing in it is trusted by Dokploy except
// the run id: the release itself is the run artifact.
//
// One Deployment per service key: ref = the commit, task = dokploy:<key>,
// required_contexts = [] (never waits on checks), auto_merge = false.

export const WAKE_SCHEMA = "dokploy.deployment/v1";

export const deploymentBody = (manifest, key) => ({
	ref: manifest.sha,
	task: `dokploy:${key}`,
	environment: manifest.environment,
	auto_merge: false,
	required_contexts: [],
	transient_environment: false,
	description: `Dokploy release ${manifest.release.id}`.slice(0, 140),
	payload: {
		schema: WAKE_SCHEMA,
		run_id: Number(manifest.source.runId),
		run_attempt: manifest.source.runAttempt,
		artifact: "dokploy-release",
	},
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ fetch: typeof fetch, token: string, repository: string, apiUrl?: string, sleep?: (ms: number) => Promise<void> }} deps
 * @returns {Promise<Array<{ key: string, id: number }>>}
 */
export const createDeployments = async (deps, manifest) => {
	const base = (deps.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
	if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(deps.repository)) {
		throw new Error("GITHUB_REPOSITORY is not owner/name.");
	}
	const wait = deps.sleep ?? sleep;
	const created = [];
	for (const key of manifest.release.services) {
		const body = JSON.stringify(deploymentBody(manifest, key));
		let lastError = "no attempt was made";
		let id = null;
		for (let attempt = 1; attempt <= 3 && id === null; attempt += 1) {
			try {
				const response = await deps.fetch(`${base}/repos/${deps.repository}/deployments`, {
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${deps.token}`,
						"X-GitHub-Api-Version": "2022-11-28",
						"Content-Type": "application/json",
						"User-Agent": "dokploy-release",
					},
					body,
				});
				if (response.status === 201) {
					const json = await response.json();
					id = Number(json?.id);
					if (!Number.isSafeInteger(id)) throw new Error("GitHub answered without a deployment id");
					break;
				}
				const text = (await response.text()).slice(0, 200);
				lastError = `HTTP ${response.status}: ${text}`;
				// 4xx other than 429 will not change on a retry.
				if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			if (attempt < 3) await wait(attempt * 1000);
		}
		if (id === null) {
			throw new Error(`Could not create the GitHub Deployment for ${key}: ${lastError}`);
		}
		created.push({ key, id });
	}
	return created;
};
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/create-deployments.mjs test/create-deployments.test.mjs
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: create one GitHub Deployment per service"
```

### Task 1.5: Command line entry

With `delivery: push` the workflow already deploys by itself, so publishing is best effort there: a failure prints a warning and exits 0.

- [ ] **Step 1: Write the failing test**

**`test/cli.test.mjs`**

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");
const D = (c) => `sha256:${c.repeat(64)}`;

const baseEnv = (dir, extra = {}) => ({
	PATH: process.env.PATH,
	SystemRoot: process.env.SystemRoot,
	RUNNER_TEMP: dir,
	GITHUB_OUTPUT: join(dir, "out.txt"),
	GITHUB_SHA: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
	GITHUB_REF: "refs/heads/dev",
	GITHUB_RUN_ID: "123",
	GITHUB_RUN_ATTEMPT: "1",
	INPUT_ENVIRONMENT: "development",
	INPUT_SERVICE: "web",
	INPUT_EXISTING_IMAGE: `registry.devino.ca/voicekit/web@${D("e")}`,
	...extra,
});

const withDir = (fn) => {
	const dir = mkdtempSync(join(tmpdir(), "dokploy-release-"));
	try {
		writeFileSync(join(dir, "out.txt"), "");
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("manifest writes the file and the outputs", () =>
	withDir((dir) => {
		const result = spawnSync("node", [cli, "manifest"], { env: baseEnv(dir), encoding: "utf8" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const manifest = JSON.parse(readFileSync(join(dir, "dokploy-release", "dokploy-release.json"), "utf8"));
		assert.equal(manifest.release.id, "gh-123.1");
		const out = readFileSync(join(dir, "out.txt"), "utf8");
		assert.match(out, /^path=.*dokploy-release\.json$/m);
		assert.match(out, /^release-id=gh-123\.1$/m);
		assert.match(out, /^published=true$/m);
	}));

test("a bad input fails the step when the release is pulled", () =>
	withDir((dir) => {
		const result = spawnSync("node", [cli, "manifest"], {
			env: baseEnv(dir, { INPUT_EXISTING_IMAGE: "ghcr.io/a/b/web:latest", INPUT_DELIVERY: "pull" }),
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stdout, /::error title=dokploy-release::/);
	}));

test("the same bad input only warns while the workflow still deploys by push", () =>
	withDir((dir) => {
		const result = spawnSync("node", [cli, "manifest"], {
			env: baseEnv(dir, { INPUT_EXISTING_IMAGE: "ghcr.io/a/b/web:latest", INPUT_DELIVERY: "push" }),
			encoding: "utf8",
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /::warning title=dokploy-release::/);
		assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /^published=false$/m);
	}));

test("deploy without a manifest file fails a pulled release and warns a pushed one", () =>
	withDir((dir) => {
		const pulled = spawnSync("node", [cli, "deploy"], { env: baseEnv(dir), encoding: "utf8" });
		assert.equal(pulled.status, 1);
		const pushed = spawnSync("node", [cli, "deploy"], {
			env: baseEnv(dir, { INPUT_DELIVERY: "push" }),
			encoding: "utf8",
		});
		assert.equal(pushed.status, 0);
	}));
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`
Expected: FAIL, `cli.mjs` is missing.

- [ ] **Step 3: Write the implementation**

**`scripts/cli.mjs`**

```js
// Entry points of action.yml.
//   node cli.mjs manifest   writes $RUNNER_TEMP/dokploy-release/dokploy-release.json and the step outputs
//   node cli.mjs deploy     reads that file and creates the GitHub Deployments
// A failure fails the step, except with delivery "push": there the workflow
// already deploys by itself, so publishing is best effort and only warns.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, InputError } from "./build-manifest.mjs";
import { createDeployments } from "./create-deployments.mjs";

const command = process.argv[2];
const dir = join(process.env.RUNNER_TEMP ?? ".", "dokploy-release");
const file = join(dir, "dokploy-release.json");

const output = (name, value) => {
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	}
};

const fail = (message, delivery) => {
	const line = String(message).replace(/[\r\n]+/g, " ");
	if (delivery === "push") {
		console.log(`::warning title=dokploy-release::${line} The workflow's own deploy is not affected.`);
		output("published", "false");
		process.exit(0);
	}
	console.log(`::error title=dokploy-release::${line}`);
	process.exit(1);
};

const delivery = String(process.env.INPUT_DELIVERY ?? "pull").trim() || "pull";

if (command === "manifest") {
	try {
		const manifest = buildManifest(process.env);
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
		output("path", file);
		output("release-id", manifest.release.id);
		output("published", "true");
		console.log(`Release ${manifest.release.id}: ${manifest.release.services.join(", ")} (${manifest.delivery})`);
	} catch (error) {
		fail(error instanceof InputError ? error.message : `Unexpected error: ${error}`, delivery);
	}
} else if (command === "deploy") {
	try {
		const manifest = JSON.parse(readFileSync(file, "utf8"));
		const created = await createDeployments(
			{
				fetch,
				token: process.env.GITHUB_TOKEN ?? "",
				repository: process.env.GITHUB_REPOSITORY ?? "",
				apiUrl: process.env.GITHUB_API_URL,
			},
			manifest,
		);
		for (const { key, id } of created) console.log(`GitHub Deployment ${id} for ${key}`);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), delivery);
	}
} else {
	console.log("::error title=dokploy-release::usage: cli.mjs manifest|deploy");
	process.exit(2);
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: 20 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cli.mjs test/cli.test.mjs
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: command line entry for the action steps"
```

### Task 1.6: The composite action and its self-test

- [ ] **Step 1: Re-verify the pinned shas**

The two files below pin third-party actions by commit sha. The shas were correct when this plan was written; confirm them again before committing and replace any that differ:

```bash
gh api repos/actions/upload-artifact/commits/v7.0.2 --jq .sha   # expect cf430e030ddbb5b0abf93d22962f4752f3646cd9
gh api repos/actions/checkout/commits/v7.0.1 --jq .sha          # expect 3d3c42e5aac5ba805825da76410c181273ba90b1
gh api repos/actions/setup-node/commits/v7.1.0 --jq .sha        # expect 949feb2413d6458794dcd2491c4babbbce0c15c1
```

- [ ] **Step 2: Write `action.yml`**

The `image`, `dockerfile`, `context`, `builder` and `registry` inputs are declared but refused with "Not available yet": they reserve the names for phase 2 so a later minor version needs no input rename.

**`action.yml`**

```yaml
name: Dokploy release
description: >-
  Publishes a release for Dokploy: a manifest uploaded as the run artifact
  dokploy-release, and one GitHub Deployment per service as the wake-up record.
  Needs no Dokploy address and no Dokploy API key.
author: DevinoSolutions
branding:
  icon: upload-cloud
  color: blue

inputs:
  service:
    description: Service key (the Deployment task is dokploy:<key>). Use services for several.
    required: false
  services:
    description: Service keys, one per line.
    required: false
  existing-image:
    description: >-
      Images your own job built and pushed, taken from an output of a job in the
      same run. One line per image, <repository>@sha256:<digest>. With several
      services write <key>=<image> or <key>/<compose service>=<image>. A tag is refused.
    required: true
  environment:
    description: GitHub Environment of the release (its deployment branch policy must allow only the tracked branch).
    required: true
  delivery:
    description: "pull: Dokploy deploys from this release. push: your workflow still deploys; Dokploy only verifies the release."
    required: false
    default: pull
  compose:
    description: Path of the compose file in the repository, when the service is a compose stack.
    required: false
  github-token:
    description: Token used to create the Deployments. Needs deployments write.
    required: false
    default: ${{ github.token }}
  image:
    description: Not available yet (arrives with a later version).
    required: false
  dockerfile:
    description: Not available yet (arrives with a later version).
    required: false
  context:
    description: Not available yet (arrives with a later version).
    required: false
  builder:
    description: Not available yet (arrives with a later version).
    required: false
  registry:
    description: Not available yet (arrives with a later version).
    required: false

outputs:
  release-id:
    description: The release id, gh-<run id>.<attempt>.
    value: ${{ steps.manifest.outputs.release-id }}

runs:
  using: composite
  steps:
    - name: Build the release manifest
      id: manifest
      shell: bash
      env:
        INPUT_SERVICE: ${{ inputs.service }}
        INPUT_SERVICES: ${{ inputs.services }}
        INPUT_EXISTING_IMAGE: ${{ inputs.existing-image }}
        INPUT_ENVIRONMENT: ${{ inputs.environment }}
        INPUT_DELIVERY: ${{ inputs.delivery }}
        INPUT_COMPOSE: ${{ inputs.compose }}
        INPUT_IMAGE: ${{ inputs.image }}
        INPUT_DOCKERFILE: ${{ inputs.dockerfile }}
        INPUT_CONTEXT: ${{ inputs.context }}
        INPUT_BUILDER: ${{ inputs.builder }}
        INPUT_REGISTRY: ${{ inputs.registry }}
      run: |
        command -v node >/dev/null || { echo "::error title=dokploy-release::node is not installed on this runner"; exit 1; }
        node "${{ github.action_path }}/scripts/cli.mjs" manifest

    - name: Upload the release manifest
      if: steps.manifest.outputs.published == 'true'
      continue-on-error: ${{ inputs.delivery == 'push' }}
      uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
      with:
        name: dokploy-release
        path: ${{ steps.manifest.outputs.path }}
        retention-days: 7
        if-no-files-found: error

    - name: Create the GitHub Deployments
      if: steps.manifest.outputs.published == 'true'
      shell: bash
      env:
        INPUT_DELIVERY: ${{ inputs.delivery }}
        GITHUB_TOKEN: ${{ inputs.github-token }}
      run: node "${{ github.action_path }}/scripts/cli.mjs" deploy
```

- [ ] **Step 3: Write the self-test workflow**

It runs the unit tests and the fixture checks on every pull request, and on `main` pushes it runs the real action against this repository (artifact plus a Deployment whose payload it then reads back).

**`.github/workflows/selftest.yml`**

```yaml
name: selftest

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: selftest-${{ github.ref }}
  cancel-in-progress: true

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - name: Fixtures are what the generator writes
        run: |
          node scripts/make-fixtures.mjs
          git diff --exit-code -- fixtures
      - name: Fixtures follow the schema
        run: |
          npm install --no-save --no-audit --no-fund ajv@8.17.1
          node scripts/validate-fixtures.mjs
      - name: Unit tests
        run: node --test "test/*.test.mjs"

  release:
    # The real thing, against this repository: artifact and Deployment.
    needs: unit
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    environment: selftest
    permissions:
      contents: read
      deployments: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - id: release
        uses: ./
        with:
          service: selftest
          environment: selftest
          delivery: push
          existing-image: ghcr.io/devinosolutions/dokploy-release/selftest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      - name: The Deployment and its payload exist
        env:
          GH_TOKEN: ${{ github.token }}
          RELEASE_ID: ${{ steps.release.outputs.release-id }}
        run: |
          set -euo pipefail
          test -n "$RELEASE_ID"
          gh api "repos/${GITHUB_REPOSITORY}/deployments?task=dokploy:selftest&sha=${GITHUB_SHA}&per_page=5" \
            --jq '.[0] | select(.payload.schema == "dokploy.deployment/v1" and .payload.run_id == ('"${GITHUB_RUN_ID}"') and .task == "dokploy:selftest")' \
            | tee /dev/stderr | grep -q payload
```

In the repository settings create the GitHub Environment `selftest` with no secrets and no protection rules (the job only needs the environment name).

- [ ] **Step 4: Check the YAML parses**

Run: `node -e "const y=require('node:fs').readFileSync('action.yml','utf8'); if(!/using: composite/.test(y)) process.exit(1)"` and open the file in an editor with YAML validation, or run `npx --yes yaml-lint action.yml .github/workflows/selftest.yml`.
Expected: no errors.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: composite action and self-test"
git push -u origin feat/action-v1
gh pr create --repo DevinoSolutions/dokploy-release --base main --title "feat: dokploy-release action v1 (manifest, artifact, Deployments)" --body "Phase 1 of the native GitHub Actions connect (T-13719): publishes the dokploy-release run artifact and one GitHub Deployment per service. No Dokploy address or API key."
```

- [ ] **Step 6: Review gate**

One review of the PR head (opus5-worker at high effort). Check specifically: every third-party action is pinned by sha; `existing-image` refuses a tag; the Deployment `ref` is the commit sha; nothing logs a token.

- [ ] **Step 7: Manual proof for the lead**

After merge, open the Actions tab of `DevinoSolutions/dokploy-release` and confirm the `selftest` run on `main` is green, that the run page lists the artifact `dokploy-release` (retention 7 days), and that `gh api "repos/DevinoSolutions/dokploy-release/deployments?task=dokploy:selftest&per_page=1"` returns a Deployment whose `payload.schema` is `dokploy.deployment/v1`. Then create the release tag: `git tag -a v1.0.0 -m "dokploy-release 1.0.0" && git tag -f v1 && git push origin v1.0.0 && git push -f origin v1`. The fork's PR 3 vendors fixtures from the commit tagged `v1.0.0`.

## PR 2: Connection tables, scope change, connect checks, API and MCP

**Branch:** `feat/gha-connect-tables` from `origin/canary` (after Task 0 merged). **Migration:** 0229, additive, in the idempotency gate.

What it adds, in the order the tasks build it: the pure rules Connect and acceptance share (image namespace, ordering, environment branch policy), the connection state machine, the GitHub read calls, the Connect checks, the two tables, the token scope change, and the `ghaConnection` tRPC router (which becomes MCP tools automatically). Nothing polls yet, so no deploy can happen from this PR.

**Files:**
- Create: `packages/server/src/services/gha-connect/{ordering,environment-policy,namespace,processed,state-machine,flip,actions-api,connect,connect-service,present,store,index}.ts`
- Create: `packages/server/src/db/schema/gha-connection.ts`; modify `packages/server/src/db/schema/index.ts`, `packages/server/src/db/schema/github-deployment.ts`
- Create: `apps/dokploy/drizzle/0229_gha_connection.sql`, `apps/dokploy/drizzle/meta/0229_snapshot.json`; modify `apps/dokploy/drizzle/meta/_journal.json`
- Modify: `packages/server/src/services/github-deployments/{device-flow,connect-flow,store}.ts`
- Create: `apps/dokploy/server/api/routers/gha-connection.ts`; modify `apps/dokploy/server/api/routers/github-deployment.ts`, `apps/dokploy/server/api/root.ts`
- Modify: `apps/dokploy/components/dashboard/settings/git/github-deployments-connection.tsx`, `docs/UPSTREAM_SYNC.md`
- Tests: `apps/dokploy/__test__/gha-connect/{rules,state-machine,flip,actions-api,connect,connect-service}.test.ts`, `gha-helpers.ts`; modify `apps/dokploy/__test__/github-deployments/{device-flow,store}.test.ts`, `apps/dokploy/__test__/mcp/__snapshots__/scopes-snapshot.test.ts.snap`

### Task 2.1: Image namespace, ordering and environment policy (pure)

Acceptance rules 4, 5 and 6 and the Connect environment check use these. `allowedNamespaces` returns `ghcr.io/<owner>/<repo>/` and, when a registry host is set, `<registryHost>/<repo>/`. `checkImageRepository` refuses anything under `<repo>/preview/` and, after the first release, anything but the repositories the service runs now. `decideOrdering` implements rule 6. `evaluateEnvironmentPolicy` accepts exactly one policy, of type branch, named like the tracked branch.

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/rules.test.ts`**

```ts
import { evaluateEnvironmentPolicy } from "@dokploy/server/services/gha-connect/environment-policy";
import {
	allowedNamespaces,
	checkImageRepository,
	splitRepository,
} from "@dokploy/server/services/gha-connect/namespace";
import {
	type CompareStatus,
	decideOrdering,
	type ReleaseStamp,
} from "@dokploy/server/services/gha-connect/ordering";
import { describe, expect, it } from "vitest";

describe("image namespace", () => {
	const namespaces = allowedNamespaces({
		owner: "DevinoSolutions",
		repo: "VoiceKit",
		registryHost: "registry.devino.ca",
	});

	it("allows the owner's public GHCR path and the instance registry path, lower-cased", () => {
		expect(namespaces).toEqual([
			"ghcr.io/devinosolutions/voicekit/",
			"registry.devino.ca/voicekit/",
		]);
	});

	it("has no registry namespace when the connection names no registry host", () => {
		expect(
			allowedNamespaces({ owner: "acme", repo: "shop", registryHost: null }),
		).toEqual(["ghcr.io/acme/shop/"]);
	});

	it("accepts an image inside the namespace before the service runs anything", () => {
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicekit/web",
				namespaces,
				currentRepositories: [],
			}),
		).toEqual({ ok: true });
	});

	it("refuses another registry, another repository path and a look-alike prefix", () => {
		for (const repository of [
			"evil.example.com/voicekit/web",
			"registry.devino.ca/other/web",
			"registry.devino.ca/voicekit-extra/web",
			"ghcr.io/devinosolutions/voicekit-other/web",
		]) {
			expect(
				checkImageRepository({ repository, namespaces, currentRepositories: [] }),
			).toMatchObject({ ok: false, code: "image-namespace" });
		}
	});

	it("refuses the preview namespace, even for the first release", () => {
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicekit/preview/pr-4/web",
				namespaces,
				currentRepositories: [],
			}),
		).toMatchObject({ ok: false, code: "image-namespace" });
	});

	it("once the service runs an image, only that repository may move", () => {
		const current = ["registry.devino.ca/voicekit/web"];
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicekit/web",
				namespaces,
				currentRepositories: current,
			}),
		).toEqual({ ok: true });
		expect(
			checkImageRepository({
				repository: "registry.devino.ca/voicekit/worker",
				namespaces,
				currentRepositories: current,
			}),
		).toMatchObject({ ok: false, code: "image-repository" });
	});

	it("compares case-insensitively", () => {
		expect(
			checkImageRepository({
				repository: "Registry.Devino.CA/VoiceKit/Web",
				namespaces,
				currentRepositories: ["registry.devino.ca/voicekit/web"],
			}),
		).toEqual({ ok: true });
	});

	it("splits host and name", () => {
		expect(splitRepository("ghcr.io/acme/shop/web")).toEqual({
			host: "ghcr.io",
			name: "acme/shop/web",
		});
		expect(splitRepository("localhost:5000/x/y")).toEqual({
			host: "localhost:5000",
			name: "x/y",
		});
		expect(splitRepository("library/nginx")).toBeNull();
		expect(splitRepository("nginx")).toBeNull();
	});
});

describe("decideOrdering", () => {
	const D1 = ["sha256:" + "1".repeat(64)];
	const D2 = ["sha256:" + "2".repeat(64)];
	const stamp = (overrides: Partial<ReleaseStamp> = {}): ReleaseStamp => ({
		sha: "a".repeat(40),
		runId: 100,
		attempt: 1,
		digests: D1,
		...overrides,
	});
	const decide = (
		overrides: Partial<Parameters<typeof decideOrdering>[0]> = {},
	) =>
		decideOrdering({
			deployed: stamp(),
			candidate: stamp({ sha: "b".repeat(40), runId: 101, digests: D2 }),
			deployedToCandidate: "ahead",
			reachableFromBranch: true,
			allowBehind: false,
			...overrides,
		});

	it("accepts a newer commit", () => {
		expect(decide()).toEqual({ accept: true, noop: false });
	});

	it("accepts the first release", () => {
		expect(decide({ deployed: null, deployedToCandidate: null })).toEqual({
			accept: true,
			noop: false,
		});
	});

	it("refuses a commit that is not on the tracked branch", () => {
		expect(decide({ reachableFromBranch: false })).toMatchObject({
			accept: false,
			code: "not-on-branch",
		});
	});

	it("refuses an ancestor of the deployed commit unless it is a rollback", () => {
		expect(decide({ deployedToCandidate: "behind" })).toMatchObject({
			accept: false,
			code: "ordering-behind",
		});
		expect(decide({ deployedToCandidate: "behind", allowBehind: true })).toEqual({
			accept: true,
			noop: false,
		});
	});

	it("recovers from a force push (diverged)", () => {
		expect(decide({ deployedToCandidate: "diverged" })).toEqual({
			accept: true,
			noop: false,
		});
	});

	describe("two releases of one commit", () => {
		const same = (candidate: Partial<ReleaseStamp>, deployed: Partial<ReleaseStamp> = {}) =>
			decide({
				deployed: stamp(deployed),
				candidate: stamp(candidate),
				deployedToCandidate: null,
			});

		it("a higher attempt of the same run wins", () => {
			expect(same({ attempt: 2, digests: D2 })).toEqual({ accept: true, noop: false });
		});
		it("a higher attempt with identical digests is a no-op", () => {
			expect(same({ attempt: 2 })).toEqual({ accept: true, noop: true });
		});
		it("a lower attempt is refused", () => {
			expect(same({ attempt: 1 }, { attempt: 3 })).toMatchObject({
				accept: false,
				code: "ordering-lower-attempt",
			});
		});
		it("the same attempt again is a no-op only with identical digests", () => {
			expect(same({})).toEqual({ accept: true, noop: true });
			expect(same({ digests: D2 })).toMatchObject({
				accept: false,
				code: "ordering-lower-attempt",
			});
		});
		it("the later run of the commit wins, the older is refused", () => {
			expect(same({ runId: 101, digests: D2 })).toEqual({ accept: true, noop: false });
			expect(same({ runId: 99, digests: D2 })).toMatchObject({
				accept: false,
				code: "ordering-older-run",
			});
		});
	});

	it("needs a compare status for two different commits", () => {
		const status = null as CompareStatus | null;
		expect(() => decide({ deployedToCandidate: status })).toThrow();
	});
});

describe("evaluateEnvironmentPolicy", () => {
	const policy = (overrides = {}) => ({
		customBranchPolicies: true,
		protectedBranches: false,
		policies: [{ name: "main", type: "branch" }],
		...overrides,
	});

	it("passes when exactly the tracked branch is allowed", () => {
		expect(evaluateEnvironmentPolicy(policy(), "main")).toEqual({ ok: true });
	});

	it.each([
		["no custom policy (any branch)", policy({ customBranchPolicies: false, policies: [] })],
		["protected branches only", policy({ customBranchPolicies: false, protectedBranches: true, policies: [] })],
		["a second branch", policy({ policies: [{ name: "main", type: "branch" }, { name: "dev", type: "branch" }] })],
		["a wildcard", policy({ policies: [{ name: "*", type: "branch" }] })],
		["a pattern", policy({ policies: [{ name: "ma*", type: "branch" }] })],
		["a tag policy", policy({ policies: [{ name: "main", type: "tag" }] })],
		["another branch", policy({ policies: [{ name: "dev", type: "branch" }] })],
		["no policy at all", policy({ policies: [] })],
	])("refuses %s", (_name, value) => {
		expect(evaluateEnvironmentPolicy(value, "main").ok).toBe(false);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect/rules.test.ts`
Expected: FAIL, the three modules do not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/namespace.ts`**

```ts
/**
 * Which image repositories a connection may deploy. Pure.
 *
 * A release may only name images in the connection's own namespace, and once
 * a service runs an image it may only move to new digests of the repositories
 * it already runs. `<repo>/preview/*` belongs to pull request previews and is
 * refused for a service release, the first one included.
 */

const lower = (value: string) => value.trim().toLowerCase();

export interface NamespaceInput {
	/** GitHub owner of the connected repository. */
	owner: string;
	/** Name of the connected repository (without the owner). */
	repo: string;
	/** Registry host of this Dokploy's own registry, when images are mirrored there. */
	registryHost: string | null;
}

/** Repository prefixes (always ending in "/") a release of this connection may use. */
export const allowedNamespaces = (input: NamespaceInput): string[] => {
	const repo = lower(input.repo);
	const namespaces = [`ghcr.io/${lower(input.owner)}/${repo}/`];
	if (input.registryHost) {
		namespaces.push(`${lower(input.registryHost)}/${repo}/`);
	}
	return namespaces;
};

export type RepositoryCheck =
	| { ok: true }
	| {
			ok: false;
			code: "image-namespace" | "image-repository";
			message: string;
	  };

/**
 * @param repository the image repository named by the release, e.g. `registry.devino.ca/shorty/web`
 * @param currentRepositories the repositories the service runs now (empty before its first image)
 */
export const checkImageRepository = (input: {
	repository: string;
	namespaces: string[];
	currentRepositories: string[];
}): RepositoryCheck => {
	const repository = lower(input.repository);
	const namespace = input.namespaces.find((ns) => repository.startsWith(ns));
	if (!namespace) {
		return {
			ok: false,
			code: "image-namespace",
			message: `${input.repository} is outside this connection's registry namespace (${input.namespaces.join(", ")})`,
		};
	}
	if (repository.slice(namespace.length).startsWith("preview/")) {
		return {
			ok: false,
			code: "image-namespace",
			message: `${input.repository} belongs to pull request previews, which a service release never uses`,
		};
	}
	const current = input.currentRepositories.map(lower);
	if (current.length > 0 && !current.includes(repository)) {
		return {
			ok: false,
			code: "image-repository",
			message: `${input.repository} is not an image this service runs (${input.currentRepositories.join(", ")})`,
		};
	}
	return { ok: true };
};

/** `host/path` split at the first segment; null for Docker Hub style names that have no host. */
export const splitRepository = (
	repository: string,
): { host: string; name: string } | null => {
	const slash = repository.indexOf("/");
	if (slash <= 0) return null;
	const host = repository.slice(0, slash);
	if (!host.includes(".") && !host.includes(":") && host !== "localhost") {
		return null;
	}
	return { host: host.toLowerCase(), name: repository.slice(slash + 1) };
};
```

**`packages/server/src/services/gha-connect/ordering.ts`**

```ts
/**
 * Ordering and replay (acceptance rule 6). Pure.
 *
 * After a service is connected a release whose commit is an ancestor of the
 * deployed commit is refused (re-running an old run must not regress
 * production). Two releases of one commit: the higher run attempt wins, an
 * identical set of digests is a no-op, a lower attempt is refused, and between
 * different runs of one commit the later run wins.
 */

/** GitHub's compare status of `head` relative to `base`. */
export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface ReleaseStamp {
	sha: string;
	runId: number;
	attempt: number;
	/** Sorted digests of every image of the release. */
	digests: string[];
}

export type OrderingDecision =
	| { accept: true; noop: boolean }
	| {
			accept: false;
			code:
				| "not-on-branch"
				| "ordering-behind"
				| "ordering-lower-attempt"
				| "ordering-older-run";
			message: string;
	  };

const sameDigests = (a: string[], b: string[]) =>
	a.length === b.length && a.every((digest, index) => digest === b[index]);

export const decideOrdering = (input: {
	deployed: ReleaseStamp | null;
	candidate: ReleaseStamp;
	/** compare(deployed.sha ... candidate.sha); null when there is no deployed commit or the commits are equal. */
	deployedToCandidate: CompareStatus | null;
	/** The candidate commit is an ancestor of (or equal to) the tracked branch head. */
	reachableFromBranch: boolean;
	/** True only for an explicit rollback. */
	allowBehind: boolean;
}): OrderingDecision => {
	const { deployed, candidate } = input;
	if (!input.reachableFromBranch) {
		return {
			accept: false,
			code: "not-on-branch",
			message: "The release commit is not on the tracked branch",
		};
	}
	if (!deployed) return { accept: true, noop: false };

	if (deployed.sha === candidate.sha) {
		const noop = sameDigests(deployed.digests, candidate.digests);
		if (candidate.runId === deployed.runId) {
			if (candidate.attempt > deployed.attempt) return { accept: true, noop };
			if (candidate.attempt === deployed.attempt && noop) {
				return { accept: true, noop: true };
			}
			return {
				accept: false,
				code: "ordering-lower-attempt",
				message: "A later attempt of this run was already released",
			};
		}
		if (candidate.runId > deployed.runId) return { accept: true, noop };
		return {
			accept: false,
			code: "ordering-older-run",
			message: "A later run of this commit was already released",
		};
	}

	if (input.deployedToCandidate === null) {
		throw new Error("decideOrdering needs the compare status for two commits");
	}
	if (
		input.deployedToCandidate === "behind" ||
		input.deployedToCandidate === "identical"
	) {
		if (input.allowBehind) return { accept: true, noop: false };
		return {
			accept: false,
			code: "ordering-behind",
			message: "The release commit is older than the deployed commit",
		};
	}
	// ahead: the normal case. diverged: the deployed commit left the branch
	// (a force push); the candidate is on the branch, so it recovers the service.
	return { accept: true, noop: false };
};
```

**`packages/server/src/services/gha-connect/environment-policy.ts`**

```ts
/**
 * Acceptance rule 5: the GitHub Environment that holds the registry
 * credential must still allow deployments from the tracked branch ONLY.
 * Pure: the caller reads the environment and its branch policies.
 */

export interface EnvironmentPolicy {
	/** `deployment_branch_policy.custom_branch_policies`; false when the policy is null. */
	customBranchPolicies: boolean;
	protectedBranches: boolean;
	policies: Array<{ name: string; type: string }>;
}

export type PolicyCheck = { ok: true } | { ok: false; message: string };

export const evaluateEnvironmentPolicy = (
	policy: EnvironmentPolicy,
	trackedBranch: string,
): PolicyCheck => {
	if (!policy.customBranchPolicies) {
		return {
			ok: false,
			message: policy.protectedBranches
				? "The environment allows every protected branch, not only the tracked branch"
				: "The environment allows every branch",
		};
	}
	const [only, ...rest] = policy.policies;
	if (!only || rest.length > 0) {
		return {
			ok: false,
			message:
				"The environment must allow exactly one deployment branch, the tracked branch",
		};
	}
	if (only.type !== "branch" || only.name !== trackedBranch) {
		return {
			ok: false,
			message: `The environment allows ${only.name} (${only.type}), not only ${trackedBranch}`,
		};
	}
	return { ok: true };
};
```

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: image namespace, ordering and environment policy rules (T-13719)"
```

### Task 2.2: Handled-run memory and the connection state machine (pure)

The state machine is a reducer from `(state, event)` to `(state, detail)` plus `describeState`, which produces the exact row text of the spec's state table. Only `release-deployed` moves a connection to Connected. `processed` is the capped list of `(run id, attempt)` pairs a connection already looked at, so a repeated or spammed Deployment costs one request once.

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/state-machine.test.ts`**

```ts
import {
	type ConnectionEvent,
	describeState,
	reduceConnection,
	type StateView,
} from "@dokploy/server/services/gha-connect/state-machine";
import { describe, expect, it } from "vitest";

const at = (state: StateView["state"], detail: string | null = null): StateView => ({
	state,
	detail,
});
const step = (from: StateView, ...events: ConnectionEvent[]) =>
	events.reduce(reduceConnection, from);

describe("reduceConnection", () => {
	it("walks the happy path of phase 1", () => {
		const connected = step(
			at("not_connected"),
			{ type: "connect" },
			{ type: "release-deployed" },
		);
		expect(connected).toEqual(at("connected"));
	});

	it("walks the wizard path of phase 2", () => {
		expect(
			step(
				at("not_connected"),
				{ type: "proposed" },
				{ type: "workflow-detected" },
				{ type: "connect" },
			),
		).toEqual(at("waiting"));
		expect(step(at("proposed"), { type: "proposal-closed" })).toEqual(at("not_connected"));
	});

	it("blocks on a blocking refusal and not on a harmless one", () => {
		const refused = (block: boolean): ConnectionEvent => ({
			type: "release-refused",
			message: "The environment allows every branch",
			block,
		});
		expect(step(at("connected"), refused(true))).toEqual(
			at("blocked", "The environment allows every branch"),
		);
		expect(step(at("connected"), refused(false))).toEqual(at("connected"));
		expect(step(at("waiting"), refused(true)).state).toBe("blocked");
	});

	it("a deployed release clears blocked and stale", () => {
		expect(step(at("blocked", "x"), { type: "release-deployed" })).toEqual(at("connected"));
		expect(step(at("stale", "x"), { type: "release-deployed" })).toEqual(at("connected"));
	});

	it("goes stale from waiting or connected only, and recovers to where it was", () => {
		const stale: ConnectionEvent = { type: "stale", reason: "queued for 40 minutes" };
		expect(step(at("connected"), stale)).toEqual(at("stale", "queued for 40 minutes"));
		expect(step(at("waiting"), stale).state).toBe("stale");
		expect(step(at("blocked", "x"), stale).state).toBe("blocked");
		expect(step(at("disconnected"), stale).state).toBe("disconnected");
		expect(step(at("stale", "x"), { type: "fresh", hasRelease: true })).toEqual(at("connected"));
		expect(step(at("stale", "x"), { type: "fresh", hasRelease: false })).toEqual(at("waiting"));
		expect(step(at("connected"), { type: "fresh", hasRelease: true })).toEqual(at("connected"));
	});

	it("a lost token disconnects any connection, and a restored one returns it", () => {
		for (const state of ["waiting", "connected", "stale", "blocked"] as const) {
			expect(step(at(state), { type: "token-revoked" })).toEqual(at("disconnected"));
		}
		expect(step(at("not_connected"), { type: "token-revoked" }).state).toBe("not_connected");
		expect(step(at("disconnected"), { type: "token-restored", hasRelease: true })).toEqual(at("connected"));
		expect(step(at("disconnected"), { type: "token-restored", hasRelease: false })).toEqual(at("waiting"));
	});

	it("a disconnected connection ignores releases until the token is back", () => {
		expect(step(at("disconnected"), { type: "release-deployed" }).state).toBe("disconnected");
		expect(
			step(at("disconnected"), { type: "release-refused", message: "x", block: true }).state,
		).toBe("disconnected");
	});

	it("unblock leads to connected or waiting by whether a release ever ran", () => {
		expect(step(at("blocked", "x"), { type: "unblock", hasRelease: true })).toEqual(at("connected"));
		expect(step(at("blocked", "x"), { type: "unblock", hasRelease: false })).toEqual(at("waiting"));
		expect(step(at("connected"), { type: "unblock", hasRelease: true })).toEqual(at("connected"));
	});

	it("connect does nothing once connected", () => {
		expect(step(at("connected"), { type: "connect" })).toEqual(at("connected"));
	});
});

describe("describeState", () => {
	const now = new Date("2026-11-03T12:00:00Z");
	const context = {
		expectedSha: "3f9c2a1e5b7d9c0a1b2c3d4e5f60718293a4b5c6",
		deployedSha: null,
		lastReleaseAt: null,
		now,
	};

	it.each([
		[at("not_connected"), null],
		[at("proposed"), "Waiting for you to merge the pull request."],
		[at("detected"), "Workflow found. Waiting for a release."],
		[
			at("waiting"),
			"Waiting for GitHub Actions to publish 3f9c2a1. Git autodeploy is off.",
		],
		[at("connected"), "Deployed from GitHub Actions."],
		[at("blocked", "The registry does not serve web."), "The registry does not serve web."],
		[at("disconnected"), "GitHub access was lost. Reconnect."],
	])("%j", (state, expected) => {
		expect(describeState(state, context)).toBe(expected);
	});

	it("names the pull request", () => {
		expect(describeState(at("proposed"), { ...context, pullRequest: 12 })).toBe(
			"Waiting for you to merge pull request #12.",
		);
	});

	it("tells how long ago the last release was when stale", () => {
		expect(
			describeState(at("stale", "GitHub Actions has not published commit 3f9c2a1."), {
				...context,
				lastReleaseSha: "8d41b07aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				lastReleaseAt: new Date("2026-11-01T12:00:00Z"),
			}),
		).toBe(
			"GitHub Actions has not published commit 3f9c2a1. Last release 8d41b07, 2 days ago.",
		);
		expect(
			describeState(at("stale", "queued for 40 minutes, is a runner online?"), context),
		).toBe("queued for 40 minutes, is a runner online?");
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/processed.ts`**

```ts
/**
 * The runs a connection already looked at. A poll skips them without any
 * request, so a spammed or repeated Deployment costs one request once.
 */

export interface ProcessedEntry {
	runId: number;
	attempt: number;
	outcome: string;
	at: string;
}

/** Handled runs remembered per connection. */
export const PROCESSED_CAP = 50;

export const wasProcessed = (
	processed: readonly ProcessedEntry[],
	runId: number,
	attempt: number,
) => processed.some((p) => p.runId === runId && p.attempt === attempt);

/** Newest first, bounded: the oldest entries fall off. */
export const mergeProcessed = (
	existing: readonly ProcessedEntry[],
	added: readonly ProcessedEntry[],
): ProcessedEntry[] => [...added, ...existing].slice(0, PROCESSED_CAP);
```

**`packages/server/src/services/gha-connect/state-machine.ts`**

```ts
/**
 * The connection state machine of "Build on GitHub Actions". Pure: the poller
 * feeds events, the database stores the result (state, detail, since).
 *
 *   not_connected -> proposed -> detected -> waiting -> connected
 *                                   connected <-> stale
 *                          (any live state) -> blocked -> connected
 *                                   (any state) -> disconnected -> waiting | connected
 *
 * `proposed` (a pull request is open) and `detected` (the workflow is on the
 * tracked branch) belong to the wizard of phase 2; phase 1 creates a
 * connection the moment the user confirms, in `waiting`. The reducer already
 * knows them so phase 2 only adds events.
 */

export const CONNECTION_STATES = [
	"not_connected",
	"proposed",
	"detected",
	"waiting",
	"connected",
	"stale",
	"blocked",
	"disconnected",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface StateView {
	state: ConnectionState;
	/** Short reason shown after the state text (a refusal, a stale cause). */
	detail: string | null;
}

export type ConnectionEvent =
	| { type: "proposed" }
	| { type: "proposal-closed" }
	| { type: "workflow-detected" }
	/** The user confirmed Connect. */
	| { type: "connect" }
	/** A release was deployed (or a pull release matched what runs). */
	| { type: "release-deployed" }
	| { type: "release-refused"; message: string; block: boolean }
	| { type: "stale"; reason: string }
	| { type: "fresh"; hasRelease: boolean }
	| { type: "token-revoked" }
	| { type: "token-restored"; hasRelease: boolean }
	| { type: "unblock"; hasRelease: boolean };

const view = (state: ConnectionState, detail: string | null = null): StateView => ({
	state,
	detail,
});

export const reduceConnection = (
	current: StateView,
	event: ConnectionEvent,
): StateView => {
	const { state } = current;
	switch (event.type) {
		case "proposed":
			return state === "not_connected" ? view("proposed") : current;
		case "proposal-closed":
			return state === "proposed" ? view("not_connected") : current;
		case "workflow-detected":
			return state === "not_connected" || state === "proposed"
				? view("detected")
				: current;
		case "connect":
			return state === "not_connected" ||
				state === "proposed" ||
				state === "detected"
				? view("waiting")
				: current;
		case "release-deployed":
			return state === "disconnected" ||
				state === "not_connected" ||
				state === "proposed" ||
				state === "detected"
				? current
				: view("connected");
		case "release-refused":
			if (!event.block) return current;
			return state === "disconnected" ||
				state === "not_connected" ||
				state === "proposed" ||
				state === "detected"
				? current
				: view("blocked", event.message);
		case "stale":
			return state === "waiting" || state === "connected" || state === "stale"
				? view("stale", event.reason)
				: current;
		case "fresh":
			return state === "stale"
				? view(event.hasRelease ? "connected" : "waiting")
				: current;
		case "token-revoked":
			return state === "not_connected" ? current : view("disconnected");
		case "token-restored":
			return state === "disconnected"
				? view(event.hasRelease ? "connected" : "waiting")
				: current;
		case "unblock":
			return state === "blocked"
				? view(event.hasRelease ? "connected" : "waiting")
				: current;
	}
};

export interface DescribeContext {
	/** The commit the connection waits for (the branch head at Connect). */
	expectedSha: string | null;
	/** The commit running now. */
	deployedSha: string | null;
	/** Pull request number while `proposed`. */
	pullRequest?: number | null;
	/** When the last release was deployed. */
	lastReleaseAt: Date | null;
	/** The commit of the last release, for the stale line. */
	lastReleaseSha?: string | null;
	now: Date;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

const ago = (from: Date, now: Date): string => {
	const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	return `${Math.round(hours / 24)} days ago`;
};

/** The row text of the design's state table. */
export const describeState = (
	current: StateView,
	context: DescribeContext,
): string | null => {
	switch (current.state) {
		case "not_connected":
			return null;
		case "proposed":
			return context.pullRequest
				? `Waiting for you to merge pull request #${context.pullRequest}.`
				: "Waiting for you to merge the pull request.";
		case "detected":
			return "Workflow found. Waiting for a release.";
		case "waiting":
			return context.expectedSha
				? `Waiting for GitHub Actions to publish ${short(context.expectedSha)}. Git autodeploy is off.`
				: "Waiting for GitHub Actions to publish a release. Git autodeploy is off.";
		case "connected":
			return "Deployed from GitHub Actions.";
		case "stale": {
			const last =
				context.lastReleaseAt && context.lastReleaseSha
					? ` Last release ${short(context.lastReleaseSha)}, ${ago(context.lastReleaseAt, context.now)}.`
					: "";
			return `${current.detail ?? "GitHub Actions has not published the latest commit."}${last}`;
		}
		case "blocked":
			return current.detail ?? "A release was refused.";
		case "disconnected":
			return "GitHub access was lost. Reconnect.";
	}
};
```

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: connection state machine and handled-run memory (T-13719)"
```

### Task 2.3: The source flip plan (pure)

At Connect an application built from git keeps a copy of its source settings (`snapshotPreviousSource`, never the registry password) and turns git autodeploy off. At the first accepted release `planApplicationFlip` returns the update that moves it to a Docker image at the release digest (the same field reset `disconnectGitProvider` writes). A service already on a Docker image is not flipped.

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/flip.test.ts`**

```ts
import {
	APPLICATION_GIT_RESET,
	planApplicationFlip,
	snapshotPreviousSource,
} from "@dokploy/server/services/gha-connect/flip";
import { describe, expect, it } from "vitest";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("planApplicationFlip", () => {
	const gitApp = {
		sourceType: "github",
		autoDeploy: true,
		repository: "voicekit",
		owner: "DevinoSolutions",
		branch: "dev",
		githubId: "gh1",
		buildPath: "/",
		password: "secret",
		dockerImage: null,
	};

	it("does not flip an application that already deploys an image", () => {
		expect(planApplicationFlip({ sourceType: "docker" }, "x@sha256:1")).toEqual({ flip: false });
	});

	it("flips a git application to the image and keeps the old source whole", () => {
		const plan = planApplicationFlip(gitApp, `registry.devino.ca/voicekit/web@${D("e")}`);
		expect(plan.flip).toBe(true);
		if (!plan.flip) return;
		expect(plan.update).toMatchObject({
			...APPLICATION_GIT_RESET,
			sourceType: "docker",
			dockerImage: `registry.devino.ca/voicekit/web@${D("e")}`,
			autoDeploy: false,
			isPreviewDeploymentsActive: false,
		});
		expect(plan.previousSource).toMatchObject({
			sourceType: "github",
			autoDeploy: true,
			repository: "voicekit",
			owner: "DevinoSolutions",
			branch: "dev",
			githubId: "gh1",
		});
	});

	it("never keeps the registry password", () => {
		expect(snapshotPreviousSource(gitApp)).not.toHaveProperty("password");
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/flip.ts`**

```ts
/**
 * The flip: the one change a connection makes to a service, at the moment its
 * first release arrives (never at Connect). Pure planning; the poller applies
 * the result inside the transaction that starts the deploy.
 *
 * Application: git source -> Docker image source at the release digest. The
 * old git settings are kept whole in `previousSource` so "Take over locally"
 * can restore them, and git autodeploy is turned off so only one deployer can
 * fire. A service that already deploys an image is not flipped.
 *
 * Compose: only a compose whose file is stored in Dokploy (raw) is connected
 * in phase 1; there is nothing to flip.
 */

/** Everything that describes where an application's code comes from. */
export const APPLICATION_SOURCE_FIELDS = [
	"sourceType",
	"autoDeploy",
	"triggerType",
	"repository",
	"branch",
	"owner",
	"buildPath",
	"githubId",
	"gitlabRepository",
	"gitlabOwner",
	"gitlabBranch",
	"gitlabBuildPath",
	"gitlabId",
	"gitlabProjectId",
	"gitlabPathNamespace",
	"bitbucketRepository",
	"bitbucketOwner",
	"bitbucketBranch",
	"bitbucketBuildPath",
	"bitbucketId",
	"giteaRepository",
	"giteaOwner",
	"giteaBranch",
	"giteaBuildPath",
	"giteaId",
	"customGitBranch",
	"customGitBuildPath",
	"customGitUrl",
	"customGitSSHKeyId",
	"watchPaths",
	"enableSubmodules",
	"dockerImage",
	"registryId",
	"username",
	"password",
	"registryUrl",
] as const;
export type ApplicationSourceField = (typeof APPLICATION_SOURCE_FIELDS)[number];

/** What `disconnectGitProvider` writes, minus the source type (the flip sets its own). */
export const APPLICATION_GIT_RESET = {
	repository: null,
	branch: null,
	owner: null,
	buildPath: "/",
	githubId: null,
	triggerType: "push",
	gitlabRepository: null,
	gitlabOwner: null,
	gitlabBranch: null,
	gitlabBuildPath: null,
	gitlabId: null,
	gitlabProjectId: null,
	gitlabPathNamespace: null,
	bitbucketRepository: null,
	bitbucketOwner: null,
	bitbucketBranch: null,
	bitbucketBuildPath: null,
	bitbucketId: null,
	giteaRepository: null,
	giteaOwner: null,
	giteaBranch: null,
	giteaBuildPath: null,
	giteaId: null,
	customGitBranch: null,
	customGitBuildPath: null,
	customGitUrl: null,
	customGitSSHKeyId: null,
	watchPaths: null,
	enableSubmodules: false,
} as const;

export type PreviousSource = Partial<Record<ApplicationSourceField, unknown>>;

/**
 * A copy of the source settings. The registry password is not kept: the flip
 * does not touch registry credentials, so there is nothing to restore.
 */
export const snapshotPreviousSource = (
	application: Partial<Record<ApplicationSourceField, unknown>>,
): PreviousSource => {
	const snapshot: PreviousSource = {};
	for (const field of APPLICATION_SOURCE_FIELDS) {
		if (field === "password") continue;
		if (application[field] !== undefined) snapshot[field] = application[field];
	}
	return snapshot;
};

export type FlipPlan =
	| { flip: false }
	| {
			flip: true;
			previousSource: PreviousSource;
			update: Record<string, unknown>;
	  };

export const planApplicationFlip = (
	application: Partial<Record<ApplicationSourceField, unknown>>,
	dockerImage: string,
): FlipPlan => {
	if (application.sourceType === "docker") return { flip: false };
	return {
		flip: true,
		previousSource: snapshotPreviousSource(application),
		update: {
			...APPLICATION_GIT_RESET,
			sourceType: "docker",
			dockerImage,
			autoDeploy: false,
			isPreviewDeploymentsActive: false,
		},
	};
};
```

- [ ] **Step 4: Run the test, then commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: plan the git-to-image flip of an application (T-13719)"
```

### Task 2.4: The GitHub read calls

Every call goes through an injected `fetch`, maps failures the same way (`unauthorized`, `forbidden`, `rate-limited` with the retry time, `not-found`, `error`), validates the owner and repository names (a dot segment would walk out of `/repos`), and never logs or returns the token. `downloadArtifactZip` refuses a response larger than the byte limit. `createActionsApi` binds the calls to one repository for acceptance and the poller.

- [ ] **Step 1: Write the failing test and the scripted-GitHub helper**

**`apps/dokploy/__test__/gha-connect/gha-helpers.ts`**

```ts
import type { ApiFetch } from "@dokploy/server/services/gha-connect/actions-api";

export interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export type Reply = {
	status?: number;
	json?: unknown;
	text?: string;
	bytes?: Uint8Array;
	headers?: Record<string, string>;
};

/**
 * A scripted GitHub: replies by URL substring (first match wins), in the order
 * given, recording every call. A reply may be a function of the call.
 */
export const routedFetch = (
	routes: Array<[string, Reply | ((call: Recorded) => Reply)]>,
) => {
	const calls: Recorded[] = [];
	const fetch: ApiFetch = async (url, init) => {
		const call: Recorded = {
			url,
			method: init?.method ?? "GET",
			headers: init?.headers ?? {},
			body: init?.body,
		};
		calls.push(call);
		const route = routes.find(([needle]) => url.includes(needle));
		const reply: Reply = route
			? typeof route[1] === "function"
				? route[1](call)
				: route[1]
			: { status: 599, text: `no route for ${url}` };
		const status = reply.status ?? 200;
		const headers = Object.fromEntries(
			Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
			json: async () => reply.json ?? null,
			text: async () => reply.text ?? JSON.stringify(reply.json ?? ""),
			arrayBuffer: async () => {
				const bytes = reply.bytes ?? new Uint8Array();
				return bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer;
			},
		};
	};
	return { fetch, calls };
};
```

**`apps/dokploy/__test__/gha-connect/actions-api.test.ts`**

```ts
import {
	compareCommits,
	createActionsApi,
	downloadArtifactZip,
	getBranchHead,
	getEnvironmentPolicy,
	getFileText,
	getRepositoryById,
	getRunAttempt,
	listRunArtifacts,
	listWorkflowRuns,
} from "@dokploy/server/services/gha-connect/actions-api";
import { describe, expect, it } from "vitest";
import { routedFetch } from "./gha-helpers";

const NOW = 1_700_000_000_000;
const REPO = { owner: "DevinoSolutions", repo: "voicekit" };
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

const deps = (routes: Parameters<typeof routedFetch>[0]) => {
	const { fetch, calls } = routedFetch(routes);
	return { deps: { fetch, now: () => NOW }, calls };
};

describe("failure mapping (shared by every call)", () => {
	it.each([
		[401, { kind: "unauthorized" }],
		[404, { kind: "not-found" }],
		[500, { kind: "error", status: 500 }],
		[304, { kind: "not-modified" }],
	])("maps HTTP %s", async (status, expected) => {
		const { deps: d } = deps([["/branches/", { status }]]);
		expect(await getBranchHead(d, "t", REPO, "main")).toEqual(expected);
	});

	it("tells a rate limit from a plain refusal", async () => {
		const limited = deps([
			["/branches/", { status: 403, headers: { "retry-after": "30" }, text: "rate limit" }],
		]);
		expect(await getBranchHead(limited.deps, "t", REPO, "main")).toEqual({
			kind: "rate-limited",
			retryAt: NOW + 30_000,
		});
		const refused = deps([["/branches/", { status: 403, text: "Resource not accessible" }]]);
		expect(await getBranchHead(refused.deps, "t", REPO, "main")).toMatchObject({
			kind: "forbidden",
		});
	});

	it("reports an unreadable body as an error, and a network failure as status 0", async () => {
		const odd = deps([["/branches/", { json: { nope: true } }]]);
		expect(await getBranchHead(odd.deps, "t", REPO, "main")).toMatchObject({
			kind: "error",
		});
		const down: ReturnType<typeof deps> = {
			deps: {
				fetch: async () => {
					throw new Error("offline");
				},
				now: () => NOW,
			},
			calls: [],
		};
		expect(await getBranchHead(down.deps, "t", REPO, "main")).toEqual({
			kind: "error",
			status: 0,
		});
	});

	it("never calls GitHub for a dot segment or an odd repository name", async () => {
		const { deps: d, calls } = deps([["/", { json: {} }]]);
		expect(await getBranchHead(d, "t", { owner: "..", repo: "x" }, "main")).toEqual({
			kind: "not-found",
		});
		expect(await getBranchHead(d, "t", { owner: "a", repo: "b/c" }, "main")).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});

	it("sends the token only in the Authorization header", async () => {
		const { deps: d, calls } = deps([["/branches/", { json: { commit: { sha: SHA } } }]]);
		await getBranchHead(d, "gho_secret", REPO, "main");
		expect(calls[0]?.headers.Authorization).toBe("Bearer gho_secret");
		expect(calls[0]?.url).not.toContain("gho_secret");
	});
});

describe("repository and branch", () => {
	it("reads a repository by its immutable id", async () => {
		const { deps: d, calls } = deps([
			[
				"/repositories/42",
				{
					json: {
						id: 42,
						name: "voicekit",
						full_name: "DevinoSolutions/voicekit",
						owner: { login: "DevinoSolutions" },
						default_branch: "main",
						private: true,
					},
					headers: { etag: 'W/"x"' },
				},
			],
		]);
		expect(await getRepositoryById(d, "t", 42)).toEqual({
			kind: "ok",
			etag: 'W/"x"',
			value: {
				id: 42,
				owner: "DevinoSolutions",
				name: "voicekit",
				fullName: "DevinoSolutions/voicekit",
				defaultBranch: "main",
				isPrivate: true,
			},
		});
		expect(calls[0]?.url).toBe("https://api.github.com/repositories/42");
	});

	it("sends If-None-Match when given an etag", async () => {
		const { deps: d, calls } = deps([["/repositories/42", { status: 304 }]]);
		expect(await getRepositoryById(d, "t", 42, 'W/"x"')).toEqual({
			kind: "not-modified",
		});
		expect(calls[0]?.headers["If-None-Match"]).toBe('W/"x"');
	});

	it("encodes a branch name with a slash", async () => {
		const { deps: d, calls } = deps([["/branches/", { json: { commit: { sha: SHA } } }]]);
		expect(await getBranchHead(d, "t", REPO, "release/1.x")).toMatchObject({
			kind: "ok",
			value: { sha: SHA },
		});
		expect(calls[0]?.url).toContain("/branches/release%2F1.x");
	});

	it("refuses a branch head that is not a 40 character sha", async () => {
		const { deps: d } = deps([["/branches/", { json: { commit: { sha: "abc" } } }]]);
		expect(await getBranchHead(d, "t", REPO, "main")).toMatchObject({ kind: "error" });
	});
});

describe("runs", () => {
	const run = {
		id: 9876543210,
		run_attempt: 2,
		path: ".github/workflows/dokploy.yml@refs/heads/main",
		head_branch: "main",
		head_sha: SHA,
		event: "push",
		status: "completed",
		conclusion: "success",
		repository: { id: 42 },
		head_repository: { id: 42 },
		html_url: "https://github.com/DevinoSolutions/voicekit/actions/runs/9876543210/attempts/2",
	};

	it("reads one attempt and strips the @ref from the path", async () => {
		const { deps: d, calls } = deps([["/attempts/2", { json: run }]]);
		const result = await getRunAttempt(d, "t", REPO, 9876543210, 2);
		expect(calls[0]?.url).toContain("/actions/runs/9876543210/attempts/2");
		expect(result).toMatchObject({
			kind: "ok",
			value: {
				id: 9876543210,
				attempt: 2,
				path: ".github/workflows/dokploy.yml",
				headBranch: "main",
				headSha: SHA,
				event: "push",
				status: "completed",
				conclusion: "success",
				repositoryId: 42,
				headRepositoryId: 42,
			},
		});
	});

	it("keeps a missing head repository (a deleted fork) as null", async () => {
		const { deps: d } = deps([["/attempts/1", { json: { ...run, head_repository: null } }]]);
		const result = await getRunAttempt(d, "t", REPO, 1, 1);
		expect(result).toMatchObject({ kind: "ok", value: { headRepositoryId: null } });
	});

	it("lists the runs of the workflow file on a branch", async () => {
		const { deps: d, calls } = deps([
			["/workflows/dokploy.yml/runs", { json: { workflow_runs: [run, { nope: 1 }] } }],
		]);
		const result = await listWorkflowRuns(d, "t", REPO, "dokploy.yml", "main");
		expect(calls[0]?.url).toContain("branch=main&per_page=20");
		expect(result).toMatchObject({ kind: "ok" });
		if (result.kind === "ok") expect(result.value).toHaveLength(1);
	});

	it("refuses a workflow file name that could change the path", async () => {
		const { deps: d, calls } = deps([["/", { json: {} }]]);
		expect(await listWorkflowRuns(d, "t", REPO, "../x.yml", "main")).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});
});

describe("artifacts", () => {
	const artifact = {
		id: 77,
		name: "dokploy-release",
		expired: false,
		size_in_bytes: 321,
		workflow_run: { id: 9876543210, repository_id: 42, head_repository_id: 42 },
	};

	it("lists the artifacts of a run by name", async () => {
		const { deps: d, calls } = deps([["/artifacts?", { json: { artifacts: [artifact] } }]]);
		const result = await listRunArtifacts(d, "t", REPO, 9876543210, "dokploy-release");
		expect(calls[0]?.url).toContain("name=dokploy-release");
		expect(result).toMatchObject({
			kind: "ok",
			value: [
				{
					id: 77,
					expired: false,
					sizeInBytes: 321,
					workflowRunId: 9876543210,
					workflowRunRepositoryId: 42,
					workflowRunHeadRepositoryId: 42,
				},
			],
		});
	});

	it("treats a missing expired flag as expired", async () => {
		const { deps: d } = deps([
			["/artifacts?", { json: { artifacts: [{ ...artifact, expired: undefined }] } }],
		]);
		const result = await listRunArtifacts(d, "t", REPO, 1, "dokploy-release");
		expect(result).toMatchObject({ kind: "ok", value: [{ expired: true }] });
	});

	it("downloads the zip and refuses one above the limit", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const { deps: d } = deps([["/artifacts/77/zip", { bytes }]]);
		expect(await downloadArtifactZip(d, "t", REPO, 77, 10)).toEqual({
			kind: "ok",
			value: bytes,
			etag: null,
		});
		expect(await downloadArtifactZip(d, "t", REPO, 77, 3)).toEqual({
			kind: "error",
			status: 413,
		});
	});

	it("maps an expired artifact (410) to not-found", async () => {
		const { deps: d } = deps([["/artifacts/77/zip", { status: 410 }]]);
		expect(await downloadArtifactZip(d, "t", REPO, 77, 10)).toEqual({
			kind: "not-found",
		});
	});
});

describe("compare", () => {
	it("returns the status of head relative to base", async () => {
		const { deps: d, calls } = deps([["/compare/", { json: { status: "behind" } }]]);
		expect(await compareCommits(d, "t", REPO, SHA, SHA2)).toMatchObject({
			kind: "ok",
			value: "behind",
		});
		expect(calls[0]?.url).toContain(`/compare/${SHA}...${SHA2}`);
	});

	it("refuses anything that is not a full sha, without calling GitHub", async () => {
		const { deps: d, calls } = deps([["/", { json: {} }]]);
		expect(await compareCommits(d, "t", REPO, "main", SHA2)).toEqual({
			kind: "not-found",
		});
		expect(calls).toHaveLength(0);
	});

	it("refuses an unknown status", async () => {
		const { deps: d } = deps([["/compare/", { json: { status: "weird" } }]]);
		expect(await compareCommits(d, "t", REPO, SHA, SHA2)).toMatchObject({
			kind: "error",
		});
	});
});

describe("environment policy", () => {
	it("reads the environment and its branch policies", async () => {
		const { deps: d, calls } = deps([
			[
				"/deployment-branch-policies",
				{ json: { branch_policies: [{ name: "main", type: "branch" }] } },
			],
			[
				"/environments/production",
				{
					json: {
						deployment_branch_policy: {
							custom_branch_policies: true,
							protected_branches: false,
						},
					},
				},
			],
		]);
		expect(await getEnvironmentPolicy(d, "t", REPO, "production")).toEqual({
			kind: "ok",
			etag: null,
			value: {
				customBranchPolicies: true,
				protectedBranches: false,
				policies: [{ name: "main", type: "branch" }],
			},
		});
		expect(calls).toHaveLength(2);
	});

	it("needs one call when the environment has no custom policy", async () => {
		const { deps: d, calls } = deps([
			["/environments/production", { json: { deployment_branch_policy: null } }],
		]);
		expect(await getEnvironmentPolicy(d, "t", REPO, "production")).toMatchObject({
			kind: "ok",
			value: { customBranchPolicies: false, policies: [] },
		});
		expect(calls).toHaveLength(1);
	});

	it("reports a missing environment, and a failing policy list", async () => {
		const missing = deps([["/environments/", { status: 404 }]]);
		expect(await getEnvironmentPolicy(missing.deps, "t", REPO, "production")).toEqual({
			kind: "not-found",
		});
		const broken = deps([
			["/deployment-branch-policies", { status: 500 }],
			[
				"/environments/production",
				{ json: { deployment_branch_policy: { custom_branch_policies: true } } },
			],
		]);
		expect(await getEnvironmentPolicy(broken.deps, "t", REPO, "production")).toEqual({
			kind: "error",
			status: 500,
		});
	});
});

describe("file text and the bound api", () => {
	it("decodes a base64 file", async () => {
		const content = Buffer.from("uses: DevinoSolutions/dokploy-release@v1").toString("base64");
		const { deps: d, calls } = deps([["/contents/", { json: { content, encoding: "base64" } }]]);
		expect(
			await getFileText(d, "t", REPO, ".github/workflows/dokploy.yml", "main"),
		).toMatchObject({ kind: "ok", value: "uses: DevinoSolutions/dokploy-release@v1" });
		expect(calls[0]?.url).toContain("/contents/.github/workflows/dokploy.yml?ref=main");
	});

	it("binds the repository and token once", async () => {
		const { deps: d, calls } = deps([["/branches/", { json: { commit: { sha: SHA } } }]]);
		const api = createActionsApi(d, "gho_x", REPO);
		await api.branchHead("main");
		expect(calls[0]?.url).toContain("/repos/DevinoSolutions/voicekit/branches/main");
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, `actions-api` does not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/actions-api.ts`**

```ts
import type { FetchLike } from "../github-deployments/device-flow";
import { GITHUB_API, rateLimitRetryAt } from "../github-deployments/github-api";
import type { EnvironmentPolicy } from "./environment-policy";
import type { CompareStatus } from "./ordering";

/**
 * The GitHub REST calls the connection makes beyond #577's Deployments calls:
 * repositories, branches, workflow runs, artifacts, compare and environments.
 * Everything goes through an injected `fetch`. Nothing here logs or returns
 * the token.
 */

export type ApiResponse = Awaited<ReturnType<FetchLike>> & {
	arrayBuffer?: () => Promise<ArrayBuffer>;
};
export type ApiFetch = (
	input: string,
	init?: Parameters<FetchLike>[1],
) => Promise<ApiResponse>;

export interface ApiDeps {
	fetch: ApiFetch;
	now: () => number;
}

export type ApiResult<T> =
	| { kind: "ok"; value: T; etag: string | null }
	| { kind: "not-modified" }
	| { kind: "not-found" }
	| { kind: "unauthorized" }
	| { kind: "forbidden"; message: string }
	| { kind: "rate-limited"; retryAt: number }
	| { kind: "error"; status: number };

export type ApiFailure = Exclude<ApiResult<never>, { kind: "ok" }>;

const headers = (token: string, extra: Record<string, string> = {}) => ({
	Accept: "application/vnd.github+json",
	Authorization: `Bearer ${token}`,
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "dokploy-community",
	...extra,
});

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const isDotSegment = (name: string) => /^\.{1,2}$/.test(name);
export const isGithubName = (name: string) =>
	GITHUB_NAME.test(name) && !isDotSegment(name);

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
const str = (value: unknown): string | null =>
	typeof value === "string" ? value : null;
const int = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** One GET, with the failure statuses mapped the same way for every call. */
const get = async <T>(
	deps: ApiDeps,
	token: string,
	url: string,
	map: (json: unknown) => T | null,
	options: { etag?: string | null } = {},
): Promise<ApiResult<T>> => {
	let response: ApiResponse;
	try {
		response = await deps.fetch(url, {
			method: "GET",
			headers: headers(
				token,
				options.etag ? { "If-None-Match": options.etag } : {},
			),
		});
	} catch {
		return { kind: "error", status: 0 };
	}
	if (response.status === 304) return { kind: "not-modified" };
	if (response.status === 401) return { kind: "unauthorized" };
	if (response.status === 404) return { kind: "not-found" };
	if (response.status === 403 || response.status === 429) {
		const body = await response.text().catch(() => "");
		const retryAt = rateLimitRetryAt(
			response.status,
			response.headers,
			body,
			deps.now(),
		);
		return retryAt !== null
			? { kind: "rate-limited", retryAt }
			: { kind: "forbidden", message: "GitHub refused access" };
	}
	if (!response.ok) return { kind: "error", status: response.status };
	const value = map(await response.json().catch(() => null));
	if (value === null) return { kind: "error", status: response.status };
	return { kind: "ok", value, etag: response.headers.get("etag") };
};

export interface RepoRef {
	owner: string;
	repo: string;
}

const repoPath = (ref: RepoRef): string | null =>
	isGithubName(ref.owner) && isGithubName(ref.repo)
		? `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`
		: null;

const NOT_FOUND: ApiFailure = { kind: "not-found" };

export interface RepositoryInfo {
	id: number;
	owner: string;
	name: string;
	fullName: string;
	defaultBranch: string;
	isPrivate: boolean;
}

const mapRepository = (json: unknown): RepositoryInfo | null => {
	const o = asObject(json);
	const owner = str(asObject(o?.owner)?.login);
	const name = str(o?.name);
	const id = int(o?.id);
	if (!o || !owner || !name || id === null) return null;
	return {
		id,
		owner,
		name,
		fullName: str(o.full_name) ?? `${owner}/${name}`,
		defaultBranch: str(o.default_branch) ?? "main",
		isPrivate: o.private === true,
	};
};

/** `GET /repositories/{id}`: the repository by its immutable id (a rename changes nothing). */
export const getRepositoryById = (
	deps: ApiDeps,
	token: string,
	repoId: number,
	etag?: string | null,
) =>
	get<RepositoryInfo>(
		deps,
		token,
		`${GITHUB_API}/repositories/${repoId}`,
		mapRepository,
		{ etag },
	);

/** `GET /repos/{owner}/{repo}`: used once, at Connect, to learn the repository id. */
export const getRepositoryByName = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
): Promise<ApiResult<RepositoryInfo>> => {
	const base = repoPath(ref);
	if (!base) return Promise.resolve(NOT_FOUND);
	return get<RepositoryInfo>(deps, token, base, mapRepository);
};

/** `GET /repos/{o}/{r}/branches/{branch}`: the head commit of a branch. */
export const getBranchHead = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	branch: string,
) => {
	const base = repoPath(ref);
	if (!base || branch.length === 0 || branch.length > 255) {
		return Promise.resolve(NOT_FOUND);
	}
	return get<{ sha: string }>(
		deps,
		token,
		`${base}/branches/${encodeURIComponent(branch)}`,
		(json) => {
			const sha = str(asObject(asObject(json)?.commit)?.sha);
			return sha && /^[0-9a-f]{40}$/.test(sha) ? { sha } : null;
		},
	);
};

export interface RunInfo {
	id: number;
	attempt: number;
	/** `path` of the run with any `@ref` suffix removed. */
	path: string;
	headBranch: string | null;
	headSha: string;
	event: string;
	status: string;
	conclusion: string | null;
	repositoryId: number | null;
	headRepositoryId: number | null;
	htmlUrl: string;
	runStartedAt: string | null;
	updatedAt: string | null;
}

const mapRun = (json: unknown): RunInfo | null => {
	const o = asObject(json);
	const id = int(o?.id);
	const headSha = str(o?.head_sha);
	const status = str(o?.status);
	if (!o || id === null || !headSha || !status) return null;
	const path = (str(o.path) ?? "").split("@")[0] ?? "";
	return {
		id,
		attempt: int(o.run_attempt) ?? 1,
		path,
		headBranch: str(o.head_branch),
		headSha,
		event: str(o.event) ?? "",
		status,
		conclusion: str(o.conclusion),
		repositoryId: int(asObject(o.repository)?.id),
		headRepositoryId: int(asObject(o.head_repository)?.id),
		htmlUrl: str(o.html_url) ?? "",
		runStartedAt: str(o.run_started_at),
		updatedAt: str(o.updated_at),
	};
};

/** `GET /repos/{o}/{r}/actions/runs/{id}/attempts/{n}`: that attempt, not the latest. */
export const getRunAttempt = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	runId: number,
	attempt: number,
) => {
	const base = repoPath(ref);
	if (!base) return Promise.resolve(NOT_FOUND);
	return get<RunInfo>(
		deps,
		token,
		`${base}/actions/runs/${runId}/attempts/${attempt}`,
		mapRun,
	);
};

/** `GET .../actions/workflows/{file}/runs?branch=`: the newest runs of the release workflow. */
export const listWorkflowRuns = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	workflowFile: string,
	branch: string,
	etag?: string | null,
) => {
	const base = repoPath(ref);
	if (!base || !/^[A-Za-z0-9._-]{1,100}$/.test(workflowFile)) {
		return Promise.resolve(NOT_FOUND);
	}
	return get<RunInfo[]>(
		deps,
		token,
		`${base}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?branch=${encodeURIComponent(branch)}&per_page=20`,
		(json) => {
			const list = asObject(json)?.workflow_runs;
			if (!Array.isArray(list)) return null;
			return list.map(mapRun).filter((r): r is RunInfo => r !== null);
		},
		{ etag },
	);
};

export interface ArtifactInfo {
	id: number;
	name: string;
	expired: boolean;
	sizeInBytes: number;
	workflowRunId: number | null;
	workflowRunRepositoryId: number | null;
	workflowRunHeadRepositoryId: number | null;
}

/** `GET .../actions/runs/{id}/artifacts?name=`: artifacts of one run, filtered by name. */
export const listRunArtifacts = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	runId: number,
	name: string,
) => {
	const base = repoPath(ref);
	if (!base) return Promise.resolve(NOT_FOUND);
	return get<ArtifactInfo[]>(
		deps,
		token,
		`${base}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=30`,
		(json) => {
			const list = asObject(json)?.artifacts;
			if (!Array.isArray(list)) return null;
			const artifacts: ArtifactInfo[] = [];
			for (const item of list) {
				const o = asObject(item);
				const id = int(o?.id);
				const artifactName = str(o?.name);
				if (!o || id === null || !artifactName) continue;
				const run = asObject(o.workflow_run);
				artifacts.push({
					id,
					name: artifactName,
					expired: o.expired !== false,
					sizeInBytes: int(o.size_in_bytes) ?? Number.MAX_SAFE_INTEGER,
					workflowRunId: int(run?.id),
					workflowRunRepositoryId: int(run?.repository_id),
					workflowRunHeadRepositoryId: int(run?.head_repository_id),
				});
			}
			return artifacts;
		},
	);
};

/**
 * `GET .../actions/artifacts/{id}/zip`: GitHub answers 302 to a signed blob
 * URL; `fetch` follows it and drops the Authorization header on the other
 * origin. The caller has already checked the size against the listing.
 */
export const downloadArtifactZip = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	artifactId: number,
	maxBytes: number,
): Promise<ApiResult<Uint8Array>> => {
	const base = repoPath(ref);
	if (!base) return NOT_FOUND;
	let response: ApiResponse;
	try {
		response = await deps.fetch(`${base}/actions/artifacts/${artifactId}/zip`, {
			method: "GET",
			headers: headers(token),
		});
	} catch {
		return { kind: "error", status: 0 };
	}
	if (response.status === 401) return { kind: "unauthorized" };
	if (response.status === 404 || response.status === 410) return NOT_FOUND;
	if (response.status === 403 || response.status === 429) {
		const body = await response.text().catch(() => "");
		const retryAt = rateLimitRetryAt(
			response.status,
			response.headers,
			body,
			deps.now(),
		);
		return retryAt !== null
			? { kind: "rate-limited", retryAt }
			: { kind: "forbidden", message: "GitHub refused access" };
	}
	if (!response.ok || !response.arrayBuffer) {
		return { kind: "error", status: response.status };
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > maxBytes) return { kind: "error", status: 413 };
	return { kind: "ok", value: bytes, etag: null };
};

/** `GET .../compare/{base}...{head}`: how `head` relates to `base`. */
export const compareCommits = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	base: string,
	head: string,
) => {
	const root = repoPath(ref);
	if (!root || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
		return Promise.resolve(NOT_FOUND);
	}
	return get<CompareStatus>(
		deps,
		token,
		`${root}/compare/${base}...${head}?per_page=1`,
		(json) => {
			const status = str(asObject(json)?.status);
			return status === "ahead" ||
				status === "behind" ||
				status === "identical" ||
				status === "diverged"
				? status
				: null;
		},
	);
};

/**
 * The environment and its deployment branch policies (two calls). Needs
 * repository read access; a 404 means the environment does not exist.
 */
export const getEnvironmentPolicy = async (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	environment: string,
): Promise<ApiResult<EnvironmentPolicy>> => {
	const base = repoPath(ref);
	if (!base || environment.length === 0 || environment.length > 255) {
		return NOT_FOUND;
	}
	const envUrl = `${base}/environments/${encodeURIComponent(environment)}`;
	const env = await get<{ custom: boolean; protectedBranches: boolean }>(
		deps,
		token,
		envUrl,
		(json) => {
			const policy = asObject(asObject(json)?.deployment_branch_policy);
			return {
				custom: policy?.custom_branch_policies === true,
				protectedBranches: policy?.protected_branches === true,
			};
		},
	);
	if (env.kind !== "ok") return env;
	if (!env.value.custom) {
		return {
			kind: "ok",
			value: {
				customBranchPolicies: false,
				protectedBranches: env.value.protectedBranches,
				policies: [],
			},
			etag: null,
		};
	}
	const list = await get<Array<{ name: string; type: string }>>(
		deps,
		token,
		`${envUrl}/deployment-branch-policies?per_page=30`,
		(json) => {
			const items = asObject(json)?.branch_policies;
			if (!Array.isArray(items)) return null;
			const policies: Array<{ name: string; type: string }> = [];
			for (const item of items) {
				const o = asObject(item);
				const name = str(o?.name);
				if (!name) continue;
				policies.push({ name, type: str(o?.type) ?? "branch" });
			}
			return policies;
		},
	);
	if (list.kind !== "ok") return list;
	return {
		kind: "ok",
		value: {
			customBranchPolicies: true,
			protectedBranches: env.value.protectedBranches,
			policies: list.value,
		},
		etag: null,
	};
};

/** `GET .../contents/{path}?ref=`: the file text, for the "workflow found" check. */
export const getFileText = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
	path: string,
	branch: string,
) => {
	const base = repoPath(ref);
	if (!base || path.includes("..") || path.length > 255) {
		return Promise.resolve(NOT_FOUND);
	}
	const encoded = path.split("/").map(encodeURIComponent).join("/");
	return get<string>(
		deps,
		token,
		`${base}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
		(json) => {
			const o = asObject(json);
			const content = str(o?.content);
			if (!content || o?.encoding !== "base64") return null;
			return Buffer.from(content, "base64").toString("utf8");
		},
	);
};

/**
 * The repository-bound face of the calls above. Acceptance and the poller
 * depend on this interface, so tests can replace GitHub with a table.
 */
export interface ActionsApi {
	branchHead(branch: string): Promise<ApiResult<{ sha: string }>>;
	runAttempt(runId: number, attempt: number): Promise<ApiResult<RunInfo>>;
	artifacts(runId: number, name: string): Promise<ApiResult<ArtifactInfo[]>>;
	downloadArtifact(
		artifactId: number,
		maxBytes: number,
	): Promise<ApiResult<Uint8Array>>;
	compare(base: string, head: string): Promise<ApiResult<CompareStatus>>;
	environmentPolicy(environment: string): Promise<ApiResult<EnvironmentPolicy>>;
}

export const createActionsApi = (
	deps: ApiDeps,
	token: string,
	ref: RepoRef,
): ActionsApi => ({
	branchHead: (branch) => getBranchHead(deps, token, ref, branch),
	runAttempt: (runId, attempt) => getRunAttempt(deps, token, ref, runId, attempt),
	artifacts: (runId, name) => listRunArtifacts(deps, token, ref, runId, name),
	downloadArtifact: (artifactId, maxBytes) =>
		downloadArtifactZip(deps, token, ref, artifactId, maxBytes),
	compare: (base, head) => compareCommits(deps, token, ref, base, head),
	environmentPolicy: (environment) =>
		getEnvironmentPolicy(deps, token, ref, environment),
});
```

- [ ] **Step 4: Run the test, then commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: GitHub read calls for runs, artifacts, compare and environments (T-13719)"
```

### Task 2.5: The Connect checks

`planConnect` runs, in order: protection mode (only `environment` for now), the service kind (an application from GitHub or on a Docker image; a compose stored in Dokploy), the repository named like the application's own, the repository readable, the token scopes (`repo_deployment`, plus `public_repo` for a public repository or `repo` for a private one), the branch exists, the environment exists, and its deployment branch policy allows only the tracked branch. A GitHub read error is never a pass. A passing plan carries the repository id, the branch head as the expected commit, the saved source settings and the single service change (autodeploy off).

`connectGhaService` wraps it with the ownership checks in the order a user meets them: service of this organization, GitHub account active, nothing already connected, no plain "Deploy from GitHub Deployments" watch on the service, token present, then the plan, then the write.

- [ ] **Step 1: Write the failing tests**

**`apps/dokploy/__test__/gha-connect/connect.test.ts`**

```ts
import type {
	ApiResult,
	RepositoryInfo,
} from "@dokploy/server/services/gha-connect/actions-api";
import {
	type ConnectReads,
	type ConnectRequest,
	planConnect,
	type ServiceFacts,
	scopeProblem,
} from "@dokploy/server/services/gha-connect/connect";
import type { EnvironmentPolicy } from "@dokploy/server/services/gha-connect/environment-policy";
import { describe, expect, it } from "vitest";

const SHA = "c".repeat(40);
const ok = <T>(value: T): ApiResult<T> => ({ kind: "ok", value, etag: null });

const repo = (isPrivate = false): RepositoryInfo => ({
	id: 7,
	owner: "acme",
	name: "shop",
	fullName: "acme/shop",
	defaultBranch: "main",
	isPrivate,
});

const onlyMain: EnvironmentPolicy = {
	customBranchPolicies: true,
	protectedBranches: false,
	policies: [{ name: "main", type: "branch" }],
};

const request: ConnectRequest = {
	owner: "acme",
	repo: "shop",
	trackedBranch: "main",
	environment: "production",
	protectionMode: "environment",
};

const githubApp: ServiceFacts = {
	kind: "application",
	sourceType: "github",
	owner: "Acme",
	repository: "shop",
	fields: { sourceType: "github", autoDeploy: true, branch: "main", password: "x" },
};

const reads = (over: Partial<ConnectReads> = {}): ConnectReads => ({
	repository: async () => ok(repo()),
	branchHead: async () => ok({ sha: SHA }),
	environmentPolicy: async () => ok(onlyMain),
	...over,
});

const SCOPES = ["repo_deployment", "public_repo"];

describe("scopeProblem", () => {
	it("needs repo_deployment", () => {
		expect(scopeProblem(["repo"], false)).toMatch(/repo_deployment/);
	});
	it("accepts public_repo for a public repository only", () => {
		expect(scopeProblem(["repo_deployment", "public_repo"], false)).toBeNull();
		expect(scopeProblem(["repo_deployment", "public_repo"], true)).toMatch(/private/);
	});
	it("accepts repo for both", () => {
		expect(scopeProblem(["repo_deployment", "repo"], true)).toBeNull();
	});
	it("refuses the old scope set", () => {
		expect(scopeProblem(["repo_deployment", "read:packages"], false)).toMatch(/public_repo/);
	});
});

describe("planConnect", () => {
	it("plans a GitHub application: keep the old source, turn autodeploy off", async () => {
		const plan = await planConnect({ scopes: SCOPES, service: githubApp, request }, reads());
		expect(plan).toMatchObject({
			ok: true,
			repoId: 7,
			repoFullName: "acme/shop",
			expectedSha: SHA,
			serviceUpdate: { autoDeploy: false },
		});
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.previousSource).toMatchObject({ sourceType: "github", autoDeploy: true, branch: "main" });
		expect(plan.previousSource).not.toHaveProperty("password");
	});

	it("changes nothing on a service that already runs an image", async () => {
		const plan = await planConnect(
			{
				scopes: SCOPES,
				service: { kind: "application", sourceType: "docker", owner: null, repository: null, fields: {} },
				request,
			},
			reads(),
		);
		expect(plan).toMatchObject({ ok: true, previousSource: null, serviceUpdate: null });
	});

	it("accepts a raw compose and refuses the other compose sources", async () => {
		const raw = await planConnect({ scopes: SCOPES, service: { kind: "compose", sourceType: "raw" }, request }, reads());
		expect(raw).toMatchObject({ ok: true, serviceUpdate: null });
		const git = await planConnect({ scopes: SCOPES, service: { kind: "compose", sourceType: "git" }, request }, reads());
		expect(git).toMatchObject({ ok: false, code: "service" });
	});

	it("refuses an application built from another repository", async () => {
		const other: ServiceFacts = { ...githubApp, repository: "other" } as ServiceFacts;
		const plan = await planConnect({ scopes: SCOPES, service: other, request }, reads());
		expect(plan).toMatchObject({ ok: false, code: "repository" });
	});

	it("refuses application sources it cannot flip", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: { kind: "application", sourceType: "gitlab", owner: null, repository: null, fields: {} }, request },
			reads(),
		);
		expect(plan).toMatchObject({ ok: false, code: "service" });
	});

	it("refuses repository-secret mode for now", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request: { ...request, protectionMode: "repository-secret" } },
			reads(),
		);
		expect(plan).toMatchObject({ ok: false, code: "mode" });
	});

	it("blocks a private repository without the repo scope", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ repository: async () => ok(repo(true)) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "scope" });
	});

	it("blocks a missing branch", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ branchHead: async () => ({ kind: "not-found" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "branch" });
	});

	it("tells the user to create a missing environment", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ environmentPolicy: async () => ({ kind: "not-found" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "environment" });
		if (plan.ok) throw new Error("unreachable");
		expect(plan.message).toMatch(/Create the GitHub environment production/);
	});

	it("blocks an environment that allows more than the tracked branch", async () => {
		const wide: EnvironmentPolicy = { customBranchPolicies: false, protectedBranches: false, policies: [] };
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ environmentPolicy: async () => ok(wide) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "environment" });
	});

	it("never turns a read error into a pass", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ environmentPolicy: async () => ({ kind: "forbidden", message: "Resource not accessible" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "github" });
	});

	it("reports an unauthorized token as a reconnect", async () => {
		const plan = await planConnect(
			{ scopes: SCOPES, service: githubApp, request },
			reads({ repository: async () => ({ kind: "unauthorized" }) }),
		);
		expect(plan).toMatchObject({ ok: false, code: "github" });
		if (plan.ok) throw new Error("unreachable");
		expect(plan.message).toMatch(/Reconnect GitHub/);
	});
});
```

**`apps/dokploy/__test__/gha-connect/connect-service.test.ts`**

```ts
import type { ConnectPlan, ConnectReads, ServiceFacts } from "@dokploy/server/services/gha-connect/connect";
import {
	type ConnectServiceDeps,
	type ConnectServiceInput,
	connectGhaService,
} from "@dokploy/server/services/gha-connect/connect-service";
import { describe, expect, it, vi } from "vitest";

const SHA = "d".repeat(40);

const input: ConnectServiceInput = {
	serviceType: "application",
	serviceId: "app-1",
	githubConnectionId: "gc-1",
	owner: "acme",
	repo: "shop",
	workflowPath: ".github/workflows/dokploy.yml",
	trackedBranch: "main",
	environment: "production",
	serviceKey: "shop",
	registryHost: null,
	protectionMode: "environment",
	gateMode: "image",
};

const docker: ServiceFacts = {
	kind: "application",
	sourceType: "docker",
	owner: null,
	repository: null,
	fields: {},
};

const goodReads: ConnectReads = {
	repository: async () => ({
		kind: "ok",
		etag: null,
		value: { id: 7, owner: "acme", name: "shop", fullName: "acme/shop", defaultBranch: "main", isPrivate: false },
	}),
	branchHead: async () => ({ kind: "ok", etag: null, value: { sha: SHA } }),
	environmentPolicy: async () => ({
		kind: "ok",
		etag: null,
		value: { customBranchPolicies: true, protectedBranches: false, policies: [{ name: "main", type: "branch" }] },
	}),
};

const deps = (over: Partial<ConnectServiceDeps<string>> = {}): ConnectServiceDeps<string> => ({
	githubConnection: async () => ({ scopes: ["repo_deployment", "public_repo"], status: "active" }),
	token: async () => "tok",
	service: async () => docker,
	existing: async () => ({ connection: false, plainWatch: false }),
	reads: () => goodReads,
	persist: async () => "saved-row",
	isUniqueViolation: (error) => (error as { code?: string }).code === "23505",
	...over,
});

describe("connectGhaService", () => {
	it("connects a service that passes every check", async () => {
		const persist = vi.fn(async (_plan: ConnectPlan, _input: ConnectServiceInput) => "saved-row");
		const result = await connectGhaService(input, deps({ persist }));
		expect(result).toMatchObject({ ok: true, saved: "saved-row" });
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist.mock.calls[0]?.[0]).toMatchObject({ repoId: 7, expectedSha: SHA });
	});

	it("answers not found for a service of another organization", async () => {
		const result = await connectGhaService(input, deps({ service: async () => null }));
		expect(result).toMatchObject({ ok: false, code: "not-found" });
	});

	it("refuses a revoked GitHub connection and a missing one", async () => {
		const revoked = await connectGhaService(
			input,
			deps({ githubConnection: async () => ({ scopes: [], status: "revoked" }) }),
		);
		expect(revoked).toMatchObject({ ok: false, code: "connection" });
		const missing = await connectGhaService(input, deps({ githubConnection: async () => null }));
		expect(missing).toMatchObject({ ok: false, code: "connection" });
	});

	it("refuses a service that is already connected or already has a plain watch", async () => {
		const connected = await connectGhaService(
			input,
			deps({ existing: async () => ({ connection: true, plainWatch: false }) }),
		);
		expect(connected).toMatchObject({ ok: false, code: "conflict" });
		const plain = await connectGhaService(
			input,
			deps({ existing: async () => ({ connection: false, plainWatch: true }) }),
		);
		expect(plain).toMatchObject({ ok: false, code: "conflict" });
		if (plain.ok) throw new Error("unreachable");
		expect(plain.message).toMatch(/Deploy from GitHub Deployments/);
	});

	it("passes the account scopes to the checks", async () => {
		const result = await connectGhaService(
			input,
			deps({ githubConnection: async () => ({ scopes: ["repo_deployment", "read:packages"], status: "active" }) }),
		);
		expect(result).toMatchObject({ ok: false, code: "scope" });
	});

	it("does not persist when a check fails", async () => {
		const persist = vi.fn(async (_plan: ConnectPlan, _input: ConnectServiceInput) => "x");
		const wide = { customBranchPolicies: false, protectedBranches: false, policies: [] };
		await connectGhaService(
			input,
			deps({
				persist,
				reads: () => ({ ...goodReads, environmentPolicy: async () => ({ kind: "ok", etag: null, value: wide }) }),
			}),
		);
		expect(persist).not.toHaveBeenCalled();
	});

	it("turns a unique violation into a conflict that names the key", async () => {
		const result = await connectGhaService(
			input,
			deps({
				persist: async () => {
					throw Object.assign(new Error("duplicate"), { code: "23505" });
				},
			}),
		);
		expect(result).toMatchObject({ ok: false, code: "conflict" });
		if (result.ok) throw new Error("unreachable");
		expect(result.message).toMatch(/key shop/);
	});

	it("lets any other persist error through", async () => {
		await expect(
			connectGhaService(
				input,
				deps({
					persist: async () => {
						throw new Error("disk full");
					},
				}),
			),
		).rejects.toThrow("disk full");
	});
});
```

- [ ] **Step 2: Run them and see them fail**

Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/connect.ts`**

```ts
import type { ApiResult, RepositoryInfo } from "./actions-api";
import type { EnvironmentPolicy } from "./environment-policy";
import { evaluateEnvironmentPolicy } from "./environment-policy";
import { type PreviousSource, snapshotPreviousSource } from "./flip";

/**
 * Connect: every check that has to pass before a service starts following
 * GitHub Actions releases, and the one change made at that moment (git
 * autodeploy off, the old source kept). Pure over injected reads; the router
 * supplies the reads and applies the result.
 */

export type ConnectCode =
	| "scope"
	| "service"
	| "repository"
	| "branch"
	| "environment"
	| "mode"
	| "github";

export type ConnectRefusal = { ok: false; code: ConnectCode; message: string };

export interface ConnectRequest {
	owner: string;
	repo: string;
	trackedBranch: string;
	environment: string;
	protectionMode: "environment" | "repository-secret";
}

export type ServiceFacts =
	| {
			kind: "application";
			sourceType: string | null;
			/** Settings of a GitHub-sourced application. */
			owner: string | null;
			repository: string | null;
			fields: Record<string, unknown>;
	  }
	| { kind: "compose"; sourceType: string | null };

export interface ConnectReads {
	repository(): Promise<ApiResult<RepositoryInfo>>;
	branchHead(branch: string): Promise<ApiResult<{ sha: string }>>;
	environmentPolicy(environment: string): Promise<ApiResult<EnvironmentPolicy>>;
}

export interface ConnectPlan {
	ok: true;
	repoId: number;
	repoFullName: string;
	/** Head of the tracked branch at Connect: the commit the first release should carry. */
	expectedSha: string;
	/** Applications built from git: settings to keep and the change to make now. */
	previousSource: PreviousSource | null;
	serviceUpdate: { autoDeploy: false } | null;
}

const refuse = (code: ConnectCode, message: string): ConnectRefusal => ({
	ok: false,
	code,
	message,
});

const same = (a: string | null, b: string) =>
	a !== null && a.toLowerCase() === b.toLowerCase();

const failure = (
	result: Exclude<ApiResult<unknown>, { kind: "ok" }>,
	what: string,
): ConnectRefusal => {
	switch (result.kind) {
		case "unauthorized":
			return refuse("github", "GitHub rejected the connection. Reconnect GitHub and try again.");
		case "forbidden":
			return refuse("github", `GitHub refused to show ${what}: ${result.message}`);
		case "rate-limited":
			return refuse("github", "GitHub rate limit reached. Try again in a few minutes.");
		case "not-found":
			return refuse("github", `${what} was not found, or the connected GitHub account cannot see it.`);
		case "not-modified":
			return refuse("github", `GitHub gave no ${what} to read. Try again.`);
		default:
			return refuse("github", `GitHub could not be reached (status ${result.status}). Try again.`);
	}
};

export const scopeProblem = (
	scopes: readonly string[],
	isPrivate: boolean,
): string | null => {
	if (!scopes.includes("repo_deployment")) {
		return "The GitHub connection lacks the repo_deployment scope. Reconnect GitHub.";
	}
	const canRead = scopes.includes("repo") || (!isPrivate && scopes.includes("public_repo"));
	if (canRead) return null;
	return isPrivate
		? "This repository is private, and the GitHub connection lacks the repo scope. Reconnect GitHub and approve repository access."
		: "The GitHub connection lacks the public_repo scope. Reconnect GitHub.";
};

export const planConnect = async (
	input: {
		scopes: readonly string[];
		service: ServiceFacts;
		request: ConnectRequest;
	},
	reads: ConnectReads,
): Promise<ConnectPlan | ConnectRefusal> => {
	const { service, request } = input;

	if (request.protectionMode !== "environment") {
		return refuse(
			"mode",
			"Only environment protection is available now. Create the GitHub environment and limit its deployment branches to the tracked branch.",
		);
	}

	if (service.kind === "compose" && service.sourceType !== "raw") {
		return refuse(
			"service",
			"Only compose stacks whose file is stored in Dokploy can follow GitHub Actions releases for now.",
		);
	}
	if (service.kind === "application") {
		if (service.sourceType !== "github" && service.sourceType !== "docker") {
			return refuse(
				"service",
				"Only applications built from GitHub, or running a Docker image, can follow GitHub Actions releases for now.",
			);
		}
		if (
			service.sourceType === "github" &&
			!(same(service.owner, request.owner) && same(service.repository, request.repo))
		) {
			return refuse(
				"repository",
				`This application builds from ${service.owner ?? "?"}/${service.repository ?? "?"}, not ${request.owner}/${request.repo}.`,
			);
		}
	}

	const repository = await reads.repository();
	if (repository.kind !== "ok") {
		return failure(repository, `The repository ${request.owner}/${request.repo}`);
	}
	const problem = scopeProblem(input.scopes, repository.value.isPrivate);
	if (problem) return refuse("scope", problem);

	const head = await reads.branchHead(request.trackedBranch);
	if (head.kind === "not-found") {
		return refuse("branch", `Branch ${request.trackedBranch} does not exist in ${repository.value.fullName}.`);
	}
	if (head.kind !== "ok") return failure(head, `Branch ${request.trackedBranch}`);

	const policy = await reads.environmentPolicy(request.environment);
	if (policy.kind === "not-found") {
		return refuse(
			"environment",
			`Create the GitHub environment ${request.environment} in ${repository.value.fullName}, set Deployment branches to ${request.trackedBranch} only, and add the build secrets there.`,
		);
	}
	if (policy.kind !== "ok") {
		return failure(policy, `The environment ${request.environment}`);
	}
	const checked = evaluateEnvironmentPolicy(policy.value, request.trackedBranch);
	if (!checked.ok) {
		return refuse(
			"environment",
			`${checked.message}. Change the environment ${request.environment}, then connect again.`,
		);
	}

	const git =
		service.kind === "application" && service.sourceType === "github";
	return {
		ok: true,
		repoId: repository.value.id,
		repoFullName: repository.value.fullName,
		expectedSha: head.value.sha,
		previousSource:
			git && service.kind === "application"
				? snapshotPreviousSource(service.fields)
				: null,
		serviceUpdate: git ? { autoDeploy: false } : null,
	};
};
```

**`packages/server/src/services/gha-connect/connect-service.ts`**

```ts
import {
	type ConnectCode,
	type ConnectPlan,
	type ConnectReads,
	type ConnectRequest,
	planConnect,
	type ServiceFacts,
} from "./connect";

/**
 * The Connect action as a sequence: who may be connected to what, in the
 * order the user would hit the problems. Everything it touches is injected,
 * so the order and the messages are tested without a database or GitHub.
 */

export interface ConnectServiceInput extends ConnectRequest {
	serviceType: "application" | "compose";
	serviceId: string;
	githubConnectionId: string;
	workflowPath: string;
	serviceKey: string;
	registryHost: string | null;
	gateMode: "image" | "checks" | "workflows";
}

export type ConnectServiceError = {
	ok: false;
	code: ConnectCode | "not-found" | "conflict" | "connection";
	message: string;
};

export interface ConnectServiceDeps<Saved> {
	/** The organization's GitHub account: its scopes and whether the token still works. */
	githubConnection(
		id: string,
	): Promise<{ scopes: string[]; status: string } | null>;
	token(githubConnectionId: string): Promise<string | null>;
	/** The service of this organization, or null. */
	service(
		type: "application" | "compose",
		id: string,
	): Promise<ServiceFacts | null>;
	/** What already follows this service. */
	existing(
		type: "application" | "compose",
		id: string,
	): Promise<{ connection: boolean; plainWatch: boolean }>;
	reads(token: string, owner: string, repo: string): ConnectReads;
	/** Writes the watch, the connection row and the service change; throws on a unique violation. */
	persist(plan: ConnectPlan, input: ConnectServiceInput): Promise<Saved>;
	isUniqueViolation(error: unknown): boolean;
}

const refuse = (
	code: ConnectServiceError["code"],
	message: string,
): ConnectServiceError => ({ ok: false, code, message });

export const connectGhaService = async <Saved>(
	input: ConnectServiceInput,
	deps: ConnectServiceDeps<Saved>,
): Promise<{ ok: true; saved: Saved; plan: ConnectPlan } | ConnectServiceError> => {
	const service = await deps.service(input.serviceType, input.serviceId);
	if (!service) return refuse("not-found", "Service not found");

	const account = await deps.githubConnection(input.githubConnectionId);
	if (!account) return refuse("connection", "GitHub connection not found");
	if (account.status !== "active") {
		return refuse(
			"connection",
			"The GitHub connection was revoked. Connect GitHub again, then retry.",
		);
	}

	const existing = await deps.existing(input.serviceType, input.serviceId);
	if (existing.connection) {
		return refuse(
			"conflict",
			"This service already follows GitHub Actions. Disconnect it first to change the settings.",
		);
	}
	if (existing.plainWatch) {
		return refuse(
			"conflict",
			"This service already follows GitHub Deployments (Deploy from GitHub Deployments). Remove that setting first, so only one thing deploys it.",
		);
	}

	const token = await deps.token(input.githubConnectionId);
	if (!token) {
		return refuse(
			"connection",
			"The GitHub connection has no usable token. Connect GitHub again, then retry.",
		);
	}

	const plan = await planConnect(
		{ scopes: account.scopes, service, request: input },
		deps.reads(token, input.owner, input.repo),
	);
	if (!plan.ok) return plan;

	try {
		return { ok: true, saved: await deps.persist(plan, input), plan };
	} catch (error) {
		if (deps.isUniqueViolation(error)) {
			return refuse(
				"conflict",
				`Another service already follows ${plan.repoFullName} for environment ${input.environment} with the key ${input.serviceKey}. Pick another key.`,
			);
		}
		throw error;
	}
};
```

- [ ] **Step 4: Run the tests**

Expected: 24 tests PASS across the two files.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: Connect checks for a GitHub Actions connection (T-13719)"
```

### Task 2.6: Tables, migration 0229 and the idempotency gate

`gha_connection` keeps one row per service: the repository by id, the workflow path, tracked branch, environment, service key, protection and gate modes, state with its reason and since-time, the expected commit, the deployed commit (sha, run id, attempt, digests, time), the handled-run list, the saved source, activity time, and the last error. `gha_release` keeps one row per accepted release (unique on connection, run and attempt). Both live outside the `application` table, which is at the 100-argument limit.

- [ ] **Step 1: Write the schema file**

**`packages/server/src/db/schema/gha-connection.ts`**

```ts
import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import {
	apiGithubDeploymentEnvironment,
	apiGithubOwnerRepo,
	GITHUB_WATCH_SERVICE_TYPES,
	type GithubWatchServiceType,
	githubDeploymentConnection,
} from "./github-deployment";

/**
 * "Build on GitHub Actions", connected natively (T-13719). One row per
 * service that follows a repository's GitHub Actions releases: Dokploy reads
 * the release manifest from the run artifact and deploys it. Kept out of the
 * `application` table, which sits at the Drizzle / Postgres 100-argument cap.
 * See docs/superpowers/specs/2026-11-03-gha-native-connect-design.md.
 *
 * The repository is stored by its immutable id, so a rename changes nothing;
 * `repoFullName` is only the name seen at the last poll.
 */

export const GHA_CONNECTION_STATES = [
	"not_connected",
	"proposed",
	"detected",
	"waiting",
	"connected",
	"stale",
	"blocked",
	"disconnected",
] as const;
export type GhaConnectionState = (typeof GHA_CONNECTION_STATES)[number];

export const GHA_GATE_MODES = ["image", "checks", "workflows"] as const;
export type GhaGateMode = (typeof GHA_GATE_MODES)[number];

export const GHA_PROTECTION_MODES = ["environment", "repository-secret"] as const;
export type GhaProtectionMode = (typeof GHA_PROTECTION_MODES)[number];

/** A run that was looked at, newest first, capped. */
export interface GhaProcessedRun {
	runId: number;
	attempt: number;
	outcome: string;
	at: string;
}

export const ghaConnection = pgTable(
	"gha_connection",
	{
		ghaConnectionId: text("ghaConnectionId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceType: text("serviceType").$type<GithubWatchServiceType>().notNull(),
		/** applicationId or composeId; polymorphic, so no foreign key. */
		serviceId: text("serviceId").notNull(),
		/** The GitHub account (device flow token) used to read the repository. */
		githubConnectionId: text("githubConnectionId")
			.notNull()
			.references(() => githubDeploymentConnection.connectionId, {
				onDelete: "cascade",
			}),
		repoId: bigint("repoId", { mode: "number" }).notNull(),
		repoFullName: text("repoFullName").notNull(),
		workflowPath: text("workflowPath")
			.notNull()
			.default(".github/workflows/dokploy.yml"),
		trackedBranch: text("trackedBranch").notNull(),
		environment: text("environment").notNull(),
		/** Name in the Deployment task `dokploy:<key>` and in the manifest. */
		serviceKey: text("serviceKey").notNull(),
		protectionMode: text("protectionMode")
			.$type<GhaProtectionMode>()
			.notNull()
			.default("environment"),
		/** Host of this Dokploy's own registry, when releases are mirrored there. */
		registryHost: text("registryHost"),
		gateMode: text("gateMode").$type<GhaGateMode>().notNull().default("image"),
		gateStartedAt: timestamp("gateStartedAt"),
		state: text("state")
			.$type<GhaConnectionState>()
			.notNull()
			.default("waiting"),
		stateDetail: text("stateDetail"),
		stateSince: timestamp("stateSince").notNull().defaultNow(),
		/** The branch head when the user confirmed Connect. */
		expectedSha: text("expectedSha"),
		deployedSha: text("deployedSha"),
		deployedRunId: bigint("deployedRunId", { mode: "number" }),
		deployedRunAttempt: integer("deployedRunAttempt"),
		/** Sorted image digests of the deployed release. */
		deployedDigests: jsonb("deployedDigests").$type<string[]>(),
		deployedAt: timestamp("deployedAt"),
		/** Runs already looked at, so a poll never repeats a request for them. */
		processed: jsonb("processed")
			.$type<GhaProcessedRun[]>()
			.notNull()
			.default([]),
		/** The service's source before Connect (git settings, autodeploy), for "Take over locally". */
		previousSource: jsonb("previousSource").$type<Record<string, unknown>>(),
		lastActivityAt: timestamp("lastActivityAt"),
		lastRunSeenId: bigint("lastRunSeenId", { mode: "number" }),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => [
		unique("gha_connection_service_unique").on(
			table.serviceType,
			table.serviceId,
		),
		unique("gha_connection_repo_key_unique").on(
			table.repoId,
			table.environment,
			table.serviceKey,
		),
	],
);

export const GHA_RELEASE_STATUSES = [
	"accepted",
	"deployed",
	"failed",
	"noop",
	"verified",
] as const;
export type GhaReleaseStatus = (typeof GHA_RELEASE_STATUSES)[number];

/** Every release a connection accepted: the history rollback and retention read. */
export const ghaRelease = pgTable(
	"gha_release",
	{
		releaseId: text("releaseId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		ghaConnectionId: text("ghaConnectionId")
			.notNull()
			.references(() => ghaConnection.ghaConnectionId, {
				onDelete: "cascade",
			}),
		/** `release.id` of the manifest, e.g. gh-9876543210.1. */
		manifestReleaseId: text("manifestReleaseId").notNull(),
		sha: text("sha").notNull(),
		runId: bigint("runId", { mode: "number" }).notNull(),
		runAttempt: integer("runAttempt").notNull(),
		delivery: text("delivery").$type<"pull" | "push">().notNull(),
		status: text("status").$type<GhaReleaseStatus>().notNull(),
		/** The GitHub Deployment that woke Dokploy up; its statuses are the record. */
		githubDeploymentId: bigint("githubDeploymentId", { mode: "number" }),
		images: jsonb("images")
			.$type<Array<{ name: string; composeService: string; ref: string }>>()
			.notNull(),
		/** Sorted digests, to compare releases without reading the images. */
		digests: jsonb("digests").$type<string[]>().notNull(),
		/** Kept by retention and never garbage collected. */
		pinned: boolean("pinned").notNull().default(false),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		settledAt: timestamp("settledAt"),
	},
	(table) => [
		unique("gha_release_run_unique").on(
			table.ghaConnectionId,
			table.runId,
			table.runAttempt,
		),
		index("gha_release_connection_created_idx").on(
			table.ghaConnectionId,
			table.createdAt,
		),
	],
);

export const ghaConnectionRelations = relations(
	ghaConnection,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [ghaConnection.organizationId],
			references: [organization.id],
		}),
		githubConnection: one(githubDeploymentConnection, {
			fields: [ghaConnection.githubConnectionId],
			references: [githubDeploymentConnection.connectionId],
		}),
		releases: many(ghaRelease),
	}),
);

export const ghaReleaseRelations = relations(ghaRelease, ({ one }) => ({
	connection: one(ghaConnection, {
		fields: [ghaRelease.ghaConnectionId],
		references: [ghaConnection.ghaConnectionId],
	}),
}));

const REGISTRY_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

export const apiGhaConnectionOne = z.object({
	serviceType: z.enum(GITHUB_WATCH_SERVICE_TYPES),
	serviceId: z.string().min(1).describe("applicationId or composeId."),
});

export const apiGhaConnect = z.object({
	serviceType: z.enum(GITHUB_WATCH_SERVICE_TYPES),
	serviceId: z.string().min(1).describe("applicationId or composeId."),
	githubConnectionId: z
		.string()
		.min(1)
		.describe("GitHub account (from githubDeployment-connections) to read the repository with."),
	owner: apiGithubOwnerRepo.shape.owner,
	repo: apiGithubOwnerRepo.shape.repo,
	workflowPath: z
		.string()
		.trim()
		.regex(
			/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/,
			"Must be a workflow file under .github/workflows",
		)
		.default(".github/workflows/dokploy.yml")
		.describe("The workflow file whose runs are releases of this service."),
	trackedBranch: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.regex(/^[A-Za-z0-9._/-]+$/, "Not a valid branch name")
		.refine((name) => !name.includes("..") && !name.endsWith("/"), "Not a valid branch name")
		.describe("The branch whose releases are deployed."),
	environment: apiGithubDeploymentEnvironment,
	serviceKey: z
		.string()
		.regex(
			/^[a-z0-9][a-z0-9._-]{0,62}$/,
			"Lowercase letters, digits, dots, dashes and underscores",
		)
		.describe("The key in the Deployment task dokploy:<key> and in the release manifest."),
	registryHost: z
		.string()
		.trim()
		.toLowerCase()
		.regex(REGISTRY_HOST, "Not a valid registry host")
		.nullable()
		.default(null)
		.describe("Host of this Dokploy's own registry when releases are mirrored there."),
	protectionMode: z.enum(GHA_PROTECTION_MODES).default("environment"),
	gateMode: z.enum(GHA_GATE_MODES).default("image"),
});

export const apiGhaDisconnect = apiGhaConnectionOne.extend({
	restoreSource: z
		.boolean()
		.default(true)
		.describe(
			"Put an application back on the git source it had before it was connected (its saved settings). Has no effect on a compose stack.",
		),
});
export const apiGhaCheckNow = apiGhaConnectionOne;

export const apiGhaSnippet = z.object({
	serviceKey: apiGhaConnect.shape.serviceKey,
	trackedBranch: apiGhaConnect.shape.trackedBranch,
	environment: apiGithubDeploymentEnvironment,
	buildJob: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Not a valid job id")
		.describe("Id of the job in your workflow that builds and pushes the image."),
	imageOutput: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Not a valid output name")
		.describe("Output of that job holding repository@sha256:digest."),
	delivery: z.enum(["pull", "push"]).default("pull"),
});
```

Add to `packages/server/src/db/schema/index.ts`, after the `github-deployment` export:

```ts
export * from "./gha-connection";
```

- [ ] **Step 2: Write the migration**

The statements are guarded so that a re-run, or a database that already has them, is a no-op.

**`apps/dokploy/drizzle/0229_gha_connection.sql`**

```sql
-- "Build on GitHub Actions", connected natively (T-13719): the services that follow a repository's GitHub Actions
-- releases (gha_connection) and every release they accepted (gha_release). Tables of their own: the application table
-- sits at the Drizzle / Postgres 100-argument cap (error 54023), so nothing is added to it. Additive only; every
-- statement is guarded so a re-run is a no-op. Numbered after 0228 (PR #577, T-12166): renumber if the order changes.
CREATE TABLE IF NOT EXISTS "gha_connection" (
	"ghaConnectionId" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"serviceType" text NOT NULL,
	"serviceId" text NOT NULL,
	"githubConnectionId" text NOT NULL,
	"repoId" bigint NOT NULL,
	"repoFullName" text NOT NULL,
	"workflowPath" text DEFAULT '.github/workflows/dokploy.yml' NOT NULL,
	"trackedBranch" text NOT NULL,
	"environment" text NOT NULL,
	"serviceKey" text NOT NULL,
	"protectionMode" text DEFAULT 'environment' NOT NULL,
	"registryHost" text,
	"gateMode" text DEFAULT 'image' NOT NULL,
	"gateStartedAt" timestamp,
	"state" text DEFAULT 'waiting' NOT NULL,
	"stateDetail" text,
	"stateSince" timestamp DEFAULT now() NOT NULL,
	"expectedSha" text,
	"deployedSha" text,
	"deployedRunId" bigint,
	"deployedRunAttempt" integer,
	"deployedDigests" jsonb,
	"deployedAt" timestamp,
	"processed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previousSource" jsonb,
	"lastActivityAt" timestamp,
	"lastRunSeenId" bigint,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gha_release" (
	"releaseId" text PRIMARY KEY NOT NULL,
	"ghaConnectionId" text NOT NULL,
	"manifestReleaseId" text NOT NULL,
	"sha" text NOT NULL,
	"runId" bigint NOT NULL,
	"runAttempt" integer NOT NULL,
	"delivery" text NOT NULL,
	"status" text NOT NULL,
	"githubDeploymentId" bigint,
	"images" jsonb NOT NULL,
	"digests" jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"settledAt" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_service_unique" UNIQUE("serviceType","serviceId");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_repo_key_unique" UNIQUE("repoId","environment","serviceKey");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_release" ADD CONSTRAINT "gha_release_run_unique" UNIQUE("ghaConnectionId","runId","runAttempt");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_connection" ADD CONSTRAINT "gha_connection_githubConnectionId_github_deployment_connection_connectionId_fk" FOREIGN KEY ("githubConnectionId") REFERENCES "public"."github_deployment_connection"("connectionId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "gha_release" ADD CONSTRAINT "gha_release_ghaConnectionId_gha_connection_ghaConnectionId_fk" FOREIGN KEY ("ghaConnectionId") REFERENCES "public"."gha_connection"("ghaConnectionId") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gha_release_connection_created_idx" ON "gha_release" USING btree ("ghaConnectionId","createdAt");
```

Append to `apps/dokploy/drizzle/meta/_journal.json` after idx 228:

```json
    {
      "idx": 229,
      "version": "7",
      "when": 1793863605783,
      "tag": "0229_gha_connection",
      "breakpoints": true
    }
```

- [ ] **Step 3: Add the snapshot**

Use the recipe from Task 0 step 5: run `pnpm exec drizzle-kit generate --config ./server/db/drizzle.config.ts --name tmp_snapshot_only` in `apps/dokploy`, move the new snapshot to `meta/0229_snapshot.json`, delete the generated `.sql` file and the generated journal entry, and confirm the new snapshot's `prevId` equals the `id` inside `0228_snapshot.json` and that its `tables` include `public.gha_connection` and `public.gha_release`.

- [ ] **Step 4: Run the gate**

```bash
cd apps/dokploy
pnpm exec vitest run --config __test__/vitest.config.ts __test__/db/migration-idempotency.test.ts
```

Expected: PASS, with 0229 among the checked fork migrations.

- [ ] **Step 5: Apply the migration twice on a scratch database**

Use a throwaway PostgreSQL 16 container (never a real Dokploy database): load the repository's migrations up to 0228, then run the 0229 file twice with `psql -v ON_ERROR_STOP=1 -f apps/dokploy/drizzle/0229_gha_connection.sql`.
Expected: both runs finish without error and the second prints only `NOTICE: ... already exists, skipping` lines.

- [ ] **Step 6: Add the ledger rows to `docs/UPSTREAM_SYNC.md`**

Append to the "Fork-owned tables (schema ledger)" table:

```markdown
| `gha_connection`, `gha_release` | `packages/server/src/db/schema/gha-connection.ts` | native "Build on GitHub Actions" connection and release history (T-13719) | `0229` |
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/db/schema apps/dokploy/drizzle docs/UPSTREAM_SYNC.md
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: gha_connection and gha_release tables, migration 0229 (T-13719)"
```

### Task 2.7: Store and presenter

`store.ts` holds every read and write of the two tables. `applyConnectionEvent` runs the reducer inside a transaction with the row locked, and moves `stateSince` only when the state really changes. `settleRelease` marks a release deployed or failed and, on success, records it as the deployed release of the connection, safe to repeat. `recordRelease` inserts with `on conflict do nothing`. `presentGhaConnection` builds the API output field by field, so the saved source and the handled-run list never leave the server.

- [ ] **Step 1: Write the files**

**`packages/server/src/services/gha-connect/store.ts`**

```ts
import { db } from "@dokploy/server/db";
import {
	type GhaProcessedRun,
	type GhaReleaseStatus,
	type GithubWatchServiceType,
	ghaConnection,
	ghaRelease,
} from "@dokploy/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { mergeProcessed } from "./processed";
import {
	type ConnectionEvent,
	reduceConnection,
	type StateView,
} from "./state-machine";

/** Reads and writes of gha_connection and gha_release. The rules live in the pure modules next to this file. */

export type GhaConnectionRow = typeof ghaConnection.$inferSelect;
export type GhaReleaseRow = typeof ghaRelease.$inferSelect;

export const findGhaConnection = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	const [row] = await db
		.select()
		.from(ghaConnection)
		.where(
			and(
				eq(ghaConnection.serviceType, serviceType),
				eq(ghaConnection.serviceId, serviceId),
			),
		);
	return row ?? null;
};

export const findGhaConnectionById = async (ghaConnectionId: string) => {
	const [row] = await db
		.select()
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
	return row ?? null;
};

export const listGhaConnections = async () => db.select().from(ghaConnection);

export const createGhaConnection = async (
	input: typeof ghaConnection.$inferInsert,
	executor: Pick<typeof db, "insert"> = db,
) => {
	const [row] = await executor.insert(ghaConnection).values(input).returning();
	if (!row) throw new Error("Could not save the connection");
	return row;
};

export const deleteGhaConnection = async (
	serviceType: GithubWatchServiceType,
	serviceId: string,
) => {
	await db
		.delete(ghaConnection)
		.where(
			and(
				eq(ghaConnection.serviceType, serviceType),
				eq(ghaConnection.serviceId, serviceId),
			),
		);
};

/**
 * Apply one event to the stored state. Read-modify-write in a transaction;
 * `stateSince` only moves when the state really changes. `note` replaces
 * `lastError` (null clears it).
 */
export const applyConnectionEvent = async (
	ghaConnectionId: string,
	event: ConnectionEvent,
	note?: string | null,
): Promise<StateView | null> =>
	db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
			.for("update");
		if (!row) return null;
		const before: StateView = {
			state: row.state,
			detail: row.stateDetail,
		};
		const after = reduceConnection(before, event);
		const changed = after.state !== before.state;
		await tx
			.update(ghaConnection)
			.set({
				state: after.state,
				stateDetail: after.detail,
				...(changed ? { stateSince: new Date() } : {}),
				...(note !== undefined ? { lastError: note } : {}),
			})
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		return after;
	});

export const recordProcessedRuns = async (
	ghaConnectionId: string,
	entries: GhaProcessedRun[],
) => {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ processed: ghaConnection.processed })
			.from(ghaConnection)
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId))
			.for("update");
		if (!row) return;
		await tx
			.update(ghaConnection)
			.set({
				processed: mergeProcessed(row.processed, entries),
				lastActivityAt: new Date(),
			})
			.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
	});
};

export const touchConnectionActivity = async (ghaConnectionId: string) => {
	await db
		.update(ghaConnection)
		.set({ lastActivityAt: new Date() })
		.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
};

export interface ReleaseInput {
	ghaConnectionId: string;
	manifestReleaseId: string;
	sha: string;
	runId: number;
	runAttempt: number;
	delivery: "pull" | "push";
	status: GhaReleaseStatus;
	githubDeploymentId: number | null;
	images: Array<{ name: string; composeService: string; ref: string }>;
	digests: string[];
}

/** One history row per (connection, run, attempt); a repeat changes nothing. */
export const recordRelease = async (
	input: ReleaseInput,
	executor: Pick<typeof db, "insert"> = db,
) => {
	await executor
		.insert(ghaRelease)
		.values({
			...input,
			settledAt: input.status === "accepted" ? null : new Date(),
		})
		.onConflictDoNothing({
			target: [
				ghaRelease.ghaConnectionId,
				ghaRelease.runId,
				ghaRelease.runAttempt,
			],
		});
};

export const findReleaseByDeployment = async (
	ghaConnectionId: string,
	githubDeploymentId: number,
) => {
	const [row] = await db
		.select()
		.from(ghaRelease)
		.where(
			and(
				eq(ghaRelease.ghaConnectionId, ghaConnectionId),
				eq(ghaRelease.githubDeploymentId, githubDeploymentId),
			),
		);
	return row ?? null;
};

/**
 * A Dokploy deployment ended: settle the release row and, when it succeeded,
 * make it the deployed release of the connection. Safe to repeat.
 */
export const settleRelease = async (
	ghaConnectionId: string,
	githubDeploymentId: number,
	outcome: "deployed" | "failed",
) => {
	await db.transaction(async (tx) => {
		const [release] = await tx
			.select()
			.from(ghaRelease)
			.where(
				and(
					eq(ghaRelease.ghaConnectionId, ghaConnectionId),
					eq(ghaRelease.githubDeploymentId, githubDeploymentId),
				),
			)
			.for("update");
		if (!release) return;
		await tx
			.update(ghaRelease)
			.set({ status: outcome, settledAt: new Date() })
			.where(eq(ghaRelease.releaseId, release.releaseId));
		if (outcome === "deployed") {
			await tx
				.update(ghaConnection)
				.set({
					deployedSha: release.sha,
					deployedRunId: release.runId,
					deployedRunAttempt: release.runAttempt,
					deployedDigests: release.digests,
					deployedAt: new Date(),
					lastActivityAt: new Date(),
				})
				.where(eq(ghaConnection.ghaConnectionId, ghaConnectionId));
		}
	});
};

/**
 * A release that needs no deploy was verified (a `push` release, or a `pull`
 * release that matches what runs): it advances the deployed commit like a
 * deploy would. The row is `noop` when the caller says so, else `verified`.
 */
export const recordVerifiedRelease = async (input: ReleaseInput) => {
	await db.transaction(async (tx) => {
		await recordRelease(
			{ ...input, status: input.status === "noop" ? "noop" : "verified" },
			tx,
		);
		await tx
			.update(ghaConnection)
			.set({
				deployedSha: input.sha,
				deployedRunId: input.runId,
				deployedRunAttempt: input.runAttempt,
				deployedDigests: input.digests,
				deployedAt: new Date(),
				lastActivityAt: new Date(),
			})
			.where(eq(ghaConnection.ghaConnectionId, input.ghaConnectionId));
	});
};

export const listReleases = async (ghaConnectionId: string, limit = 10) =>
	db
		.select()
		.from(ghaRelease)
		.where(eq(ghaRelease.ghaConnectionId, ghaConnectionId))
		.orderBy(desc(ghaRelease.createdAt))
		.limit(limit);
```

**`packages/server/src/services/gha-connect/present.ts`**

```ts
import { describeState } from "./state-machine";

/**
 * What the API and the MCP tools return for a connection. Built field by
 * field: the stored row carries the previous source settings and the list of
 * handled runs, which are not for callers.
 */

export interface PresentableConnection {
	ghaConnectionId: string;
	serviceType: string;
	serviceId: string;
	githubConnectionId: string;
	repoId: number;
	repoFullName: string;
	workflowPath: string;
	trackedBranch: string;
	environment: string;
	serviceKey: string;
	protectionMode: string;
	registryHost: string | null;
	gateMode: string;
	state: string;
	stateDetail: string | null;
	stateSince: Date;
	expectedSha: string | null;
	deployedSha: string | null;
	deployedRunId: number | null;
	deployedAt: Date | null;
	previousSource: unknown;
	lastActivityAt: Date | null;
	lastError: string | null;
	createdAt: Date;
}

export const presentGhaConnection = (
	row: PresentableConnection,
	now: Date = new Date(),
) => ({
	ghaConnectionId: row.ghaConnectionId,
	serviceType: row.serviceType,
	serviceId: row.serviceId,
	githubConnectionId: row.githubConnectionId,
	repository: row.repoFullName,
	repoId: row.repoId,
	workflowPath: row.workflowPath,
	trackedBranch: row.trackedBranch,
	environment: row.environment,
	serviceKey: row.serviceKey,
	protectionMode: row.protectionMode,
	registryHost: row.registryHost,
	gateMode: row.gateMode,
	state: row.state,
	stateSince: row.stateSince,
	/** The sentence the service shows, from the design's state table. */
	statusText: describeState(
		{
			state: row.state as Parameters<typeof describeState>[0]["state"],
			detail: row.stateDetail,
		},
		{
			expectedSha: row.expectedSha,
			deployedSha: row.deployedSha,
			lastReleaseAt: row.deployedAt,
			lastReleaseSha: row.deployedSha,
			now,
		},
	),
	deployedSha: row.deployedSha,
	deployedRunId: row.deployedRunId,
	deployedAt: row.deployedAt,
	hasPreviousSource: row.previousSource !== null && row.previousSource !== undefined,
	lastActivityAt: row.lastActivityAt,
	lastError: row.lastError,
	createdAt: row.createdAt,
});

export type PresentedGhaConnection = ReturnType<typeof presentGhaConnection>;
```

- [ ] **Step 2: Write the barrel**

Create `packages/server/src/services/gha-connect/index.ts` with the modules that exist in this PR (later PRs append their own lines):

```ts
export * from "./actions-api";
export * from "./connect";
export * from "./connect-service";
export * from "./environment-policy";
export * from "./flip";
export * from "./namespace";
export * from "./ordering";
export * from "./present";
export * from "./processed";
export * from "./state-machine";
export * from "./store";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r run typecheck`
Expected: no errors. The store is covered by the typecheck here and by the manual proof, because the repository has no database-backed unit tests.

- [ ] **Step 4: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect
git add packages/server/src/services/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: gha_connection store and presenter (T-13719)"
```

### Task 2.8: The token scope change

`read:packages` is dropped (prod never holds a GHCR token for a connected service) and `public_repo` or `repo` is added, chosen when the user starts the device flow. A connection created with the old scopes keeps working for #577 watches and must be re-authorized to be used for a GitHub Actions connection; Connect says so in plain words (`scopeProblem`). `loadGhcrCredentials` returns null for a connection without `read:packages`, so a connected service never logs in to GHCR.

- [ ] **Step 1: Update the existing tests first (they pin the old scope)**

In `apps/dokploy/__test__/github-deployments/device-flow.test.ts` replace

```ts
		expect(body.get("scope")).toBe("repo_deployment read:packages");
		expect(body.get("scope")).toBe(GITHUB_DEVICE_SCOPE);
```

with

```ts
		expect(body.get("scope")).toBe("repo_deployment public_repo");
		expect(body.get("scope")).toBe(GITHUB_DEVICE_SCOPE);
```

and add after that test:

```ts
	it("asks for the repo scope when the caller names it", async () => {
		const { fetch, calls } = scriptedFetch([{ json: started }]);
		await startDeviceFlow({
			fetch,
			now: () => T0,
			scope: GITHUB_DEVICE_SCOPE_PRIVATE,
		});
		const body = new URLSearchParams(calls[0]?.body);
		expect(body.get("scope")).toBe("repo_deployment repo");
	});
```

adding `GITHUB_DEVICE_SCOPE_PRIVATE` to that file's import from the schema module next to `GITHUB_DEVICE_SCOPE`.

In `apps/dokploy/__test__/github-deployments/store.test.ts` change the connection row of the existing ghcr test to carry its scopes, and add the new case:

```ts
describe("the ghcr credentials", () => {
	it("name the watch and its owner, which scope the login", async () => {
		// findGithubWatch, then the connection row
		mocks.selectQueue = [
			[existing()],
			[
				{
					githubLogin: "amin",
					accessToken: "gho_x",
					status: "active",
					scopes: "repo_deployment,read:packages",
				},
			],
		];
		const credentials = await loadGhcrCredentials("application", "app-1");
		expect(credentials).toMatchObject({
			watchId: "w1",
			owner: "DevinoSolutions",
			registryUrl: "ghcr.io",
			username: "amin",
		});
	});

	it("are null for a connection without read:packages, so prod holds no GHCR token", async () => {
		mocks.selectQueue = [
			[existing()],
			[
				{
					githubLogin: "amin",
					accessToken: "gho_x",
					status: "active",
					scopes: "repo_deployment,public_repo",
				},
			],
		];
		expect(await loadGhcrCredentials("application", "app-1")).toBeNull();
	});
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/github-deployments/device-flow.test.ts __test__/github-deployments/store.test.ts`
Expected: FAIL (old constant, no `scope` dependency, credentials returned without the scope).

- [ ] **Step 3: Implement**

In `packages/server/src/db/schema/github-deployment.ts`:

```ts
/** Scopes asked for in the device flow. `public_repo` reads public repositories; `repo` is needed for private ones. */
export const GITHUB_DEVICE_SCOPE = "repo_deployment public_repo";
export const GITHUB_DEVICE_SCOPE_PRIVATE = "repo_deployment repo";
```

and, next to the other input schemas:

```ts
export const apiGithubDeploymentStartConnect = z.object({
	repositoryAccess: z
		.enum(["public", "private"])
		.default("public")
		.describe(
			"public asks GitHub for the public_repo scope, private for the broader repo scope that private repositories need. Classic OAuth has no read-only Actions scope.",
		),
});
```

In `packages/server/src/services/github-deployments/device-flow.ts` change the `startDeviceFlow` dependency type and body:

```ts
export const startDeviceFlow = async (deps: {
	fetch: FetchLike;
	now: () => number;
	clientId?: string;
	scope?: string;
}): Promise<StartResult> => {
	let response: Awaited<ReturnType<FetchLike>>;
	try {
		response = await deps.fetch(DEVICE_CODE_URL, {
			method: "POST",
			headers: GITHUB_HEADERS,
			body: formBody({
				client_id: deps.clientId ?? getDeviceClientId(),
				scope: deps.scope ?? GITHUB_DEVICE_SCOPE,
			}),
		});
```

In `packages/server/src/services/github-deployments/connect-flow.ts` let `beginGithubConnect` take the scope:

```ts
export const beginGithubConnect = async (
	deps: ConnectDeps,
	owner: { organizationId: string; userId: string },
	options: { scope?: string } = {},
) => {
	prune(deps.now());
	const started = await startDeviceFlow({
		...deps,
		...(options.scope ? { scope: options.scope } : {}),
	});
```

In `packages/server/src/services/github-deployments/store.ts` (`loadGhcrCredentials`) select the scopes and return null without `read:packages`:

```ts
	const [row] = await db
		.select({
			githubLogin: githubDeploymentConnection.githubLogin,
			accessToken: githubDeploymentConnection.accessToken,
			status: githubDeploymentConnection.status,
			scopes: githubDeploymentConnection.scopes,
		})
		.from(githubDeploymentConnection)
		.where(eq(githubDeploymentConnection.connectionId, watch.connectionId));
	if (!row || row.status !== "active" || !row.accessToken) return null;
	// Only a connection that was authorized for packages may log in to GHCR.
	// A GitHub Actions connection never asks for it: prod holds no GHCR token.
	if (!row.scopes.split(",").includes("read:packages")) return null;
```

In `apps/dokploy/server/api/routers/github-deployment.ts` give `startConnect` the optional input and use it (import `GITHUB_DEVICE_SCOPE_PRIVATE` from `@dokploy/server/db/schema` and `apiGithubDeploymentStartConnect` from `@/server/db/schema`):

```ts
		.input(apiGithubDeploymentStartConnect.optional())
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			const started = await beginGithubConnect(
				deps(),
				{
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
				},
				input?.repositoryAccess === "private"
					? { scope: GITHUB_DEVICE_SCOPE_PRIVATE }
					: {},
			);
```

and change the tool description to say "scopes repo_deployment and public_repo (or repo with repositoryAccess private)". In `apps/dokploy/components/dashboard/settings/git/github-deployments-connection.tsx` replace the sentence "Only the repo_deployment and read:packages scopes are requested." with "Only the repo_deployment and public_repo scopes are requested; private repositories need the broader repo scope, which you choose when you connect." and pass the choice to `startConnect` (a checkbox "This account's repositories are private" mapped to `{ repositoryAccess: "private" }`).

- [ ] **Step 4: Run the tests**

Expected: PASS. Also run `pnpm exec vitest run --config __test__/vitest.config.ts __test__/github-deployments` to confirm the rest of #577's tests still pass.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages apps/dokploy/server apps/dokploy/components apps/dokploy/__test__/github-deployments
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: GitHub connection asks public_repo or repo, drops read:packages (T-13719)"
```

### Task 2.9: The `ghaConnection` router and MCP tools

Procedures: `one` (read), `connect`, `disconnect` and `checkNow`. Each mirrors the permission shape of the `githubDeployment` router: `withPermission("gitProviders", ...)` plus `checkServicePermissionAndAccess` on the service. The saved source and the handled-run list never appear in any output. Cloud is refused for `connect`. `disconnect` puts an application back on its saved source unless asked not to, removes the watch and the connection row, and deletes the watch's GHCR config directories. Wiring: typechecked, then proved by hand (no router test, because the order and messages are tested in Task 2.5 and the permission shape is the one #577's router test covers).

- [ ] **Step 1: Write the router**

**`apps/dokploy/server/api/routers/gha-connection.ts`**

```ts
import {
	deleteGithubWatch,
	findApplicationById,
	findComposeById,
	findGithubConnectionInOrganization,
	findGithubWatch,
	IS_CLOUD,
	loadConnectionToken,
	removeGhcrWatchConfigDirs,
	upsertGithubWatch,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { applications } from "@dokploy/server/db/schema";
import {
	applyConnectionEvent,
	type ConnectPlan,
	type ConnectReads,
	type ConnectServiceError,
	type ConnectServiceInput,
	connectGhaService,
	createGhaConnection,
	deleteGhaConnection,
	findGhaConnection,
	getBranchHead,
	getEnvironmentPolicy,
	getRepositoryByName,
	listReleases,
	presentGhaConnection,
	type ServiceFacts,
	touchConnectionActivity,
} from "@dokploy/server/services/gha-connect";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createTRPCRouter, withPermission } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiGhaCheckNow,
	apiGhaConnect,
	apiGhaConnectionOne,
	apiGhaDisconnect,
} from "@/server/db/schema";

/**
 * "Build on GitHub Actions", connected natively (T-13719). The GitHub token is
 * never returned by any procedure here, nor the saved source settings or the
 * list of handled runs. See docs/superpowers/specs/2026-11-03-gha-native-connect-design.md.
 */

const assertSelfHosted = () => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "Functionality not available in cloud version",
		});
	}
};

const apiDeps = {
	fetch: (url: string, init?: Parameters<typeof fetch>[1]) =>
		fetch(url, init as RequestInit),
	now: () => Date.now(),
};

const githubReads = (
	token: string,
	owner: string,
	repo: string,
): ConnectReads => ({
	repository: () => getRepositoryByName(apiDeps, token, { owner, repo }),
	branchHead: (branch) =>
		getBranchHead(apiDeps, token, { owner, repo }, branch),
	environmentPolicy: (environment) =>
		getEnvironmentPolicy(apiDeps, token, { owner, repo }, environment),
});

const loadServiceFacts = async (
	type: "application" | "compose",
	id: string,
	organizationId: string,
): Promise<ServiceFacts | null> => {
	if (type === "application") {
		const app = await findApplicationById(id).catch(() => null);
		if (!app || app.environment.project.organizationId !== organizationId) {
			return null;
		}
		return {
			kind: "application",
			sourceType: app.sourceType,
			owner: app.owner,
			repository: app.repository,
			fields: app as unknown as Record<string, unknown>,
		};
	}
	const stack = await findComposeById(id).catch(() => null);
	if (!stack || stack.environment.project.organizationId !== organizationId) {
		return null;
	}
	return { kind: "compose", sourceType: stack.sourceType };
};

const isUniqueViolation = (error: unknown): boolean => {
	const code = (error as { code?: string } | null)?.code;
	const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
	return code === "23505" || cause === "23505";
};

const persistConnection = async (
	organizationId: string,
	plan: ConnectPlan,
	input: ConnectServiceInput,
) => {
	// The watch is #577's: it carries the cursor, the ETag and the in-flight
	// mark. It starts with no cursor, so the first poll baselines and the
	// backlog of old Deployments never runs.
	await upsertGithubWatch({
		organizationId,
		serviceType: input.serviceType,
		serviceId: input.serviceId,
		connectionId: input.githubConnectionId,
		owner: input.owner,
		repo: input.repo,
		environment: input.environment,
		enabled: true,
	});
	try {
		return await db.transaction(async (tx) => {
			if (plan.serviceUpdate && input.serviceType === "application") {
				await tx
					.update(applications)
					.set(plan.serviceUpdate)
					.where(eq(applications.applicationId, input.serviceId));
			}
			return createGhaConnection(
				{
					organizationId,
					serviceType: input.serviceType,
					serviceId: input.serviceId,
					githubConnectionId: input.githubConnectionId,
					repoId: plan.repoId,
					repoFullName: plan.repoFullName,
					workflowPath: input.workflowPath,
					trackedBranch: input.trackedBranch,
					environment: input.environment,
					serviceKey: input.serviceKey,
					protectionMode: input.protectionMode,
					registryHost: input.registryHost,
					gateMode: input.gateMode,
					state: "waiting",
					expectedSha: plan.expectedSha,
					previousSource: plan.previousSource,
				},
				tx,
			);
		});
	} catch (error) {
		await deleteGithubWatch(input.serviceType, input.serviceId).catch(
			() => undefined,
		);
		throw error;
	}
};

const trpcCode = (code: ConnectServiceError["code"]) =>
	code === "not-found"
		? "NOT_FOUND"
		: code === "conflict"
			? "CONFLICT"
			: code === "github"
				? "BAD_GATEWAY"
				: "BAD_REQUEST";

export const ghaConnectionRouter = createTRPCRouter({
	one: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/ghaConnection.one",
				description:
					"Read how an application or compose stack follows GitHub Actions releases, or null when it does not: repository, workflow file, tracked branch, environment, service key, state (waiting, connected, stale, blocked, disconnected), the sentence the dashboard shows, the commit and run deployed, the last activity and error, and the last five releases (commit, run, attempt, delivery, status). The GitHub token, the saved source settings and the list of handled runs are never returned.",
			},
		})
		.input(apiGhaConnectionOne)
		.query(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["read"],
			});
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
				return null;
			}
			const releases = await listReleases(row.ghaConnectionId, 5);
			return {
				...presentGhaConnection(row),
				releases: releases.map((release) => ({
					releaseId: release.releaseId,
					sha: release.sha,
					runId: release.runId,
					runAttempt: release.runAttempt,
					delivery: release.delivery,
					status: release.status,
					createdAt: release.createdAt,
					settledAt: release.settledAt,
				})),
			};
		}),

	connect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.connect",
				description:
					"Make an application or compose stack follow the GitHub Actions releases of a repository. Dokploy never receives a call from GitHub: it polls GitHub for GitHub Deployments whose task is dokploy:<serviceKey>, reads the run artifact dokploy-release, checks it against the run, the registry and the environment's deployment branch policy, and deploys the image digest. Needs the service's create access, a GitHub connection (githubDeployment-connections) authorized with repo_deployment plus public_repo (public repositories) or repo (private ones), and a GitHub environment whose deployment branches allow only the tracked branch. An application built from git keeps its settings and has git autodeploy turned off now; it moves to the image at the first release. The workflow file is not created: copy the one the dashboard shows. Refuses a service that already follows GitHub Deployments.",
			},
		})
		.input(apiGhaConnect)
		.mutation(async ({ ctx, input }) => {
			assertSelfHosted();
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const organizationId = ctx.session.activeOrganizationId;
			const result = await connectGhaService(input, {
				githubConnection: async (id) => {
					const account = await findGithubConnectionInOrganization(
						id,
						organizationId,
					);
					return account
						? { scopes: account.scopes, status: account.status }
						: null;
				},
				token: loadConnectionToken,
				service: (type, id) => loadServiceFacts(type, id, organizationId),
				existing: async (type, id) => ({
					connection: (await findGhaConnection(type, id)) !== null,
					plainWatch: (await findGithubWatch(type, id)) !== null,
				}),
				reads: githubReads,
				persist: (plan, request) =>
					persistConnection(organizationId, plan, request),
				isUniqueViolation,
			});
			if (!result.ok) {
				throw new TRPCError({
					code: trpcCode(result.code),
					message: result.message,
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: `GitHub Actions: ${result.plan.repoFullName}`,
			});
			return presentGhaConnection(result.saved);
		}),

	disconnect: withPermission("gitProviders", "create")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.disconnect",
				description:
					"Stop a service from following GitHub Actions releases. By default an application goes back to the git source it had before it was connected (restoreSource false leaves it on its current image). The service keeps running its current deployment. Removes the connection, its release history and its watch.",
			},
		})
		.input(apiGhaDisconnect)
		.mutation(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["create"],
				deployment: ["create"],
			});
			const organizationId = ctx.session.activeOrganizationId;
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== organizationId) return true;
			const watch = await findGithubWatch(input.serviceType, input.serviceId);
			if (
				input.restoreSource &&
				input.serviceType === "application" &&
				row.previousSource
			) {
				await db
					.update(applications)
					.set(
						row.previousSource as Partial<typeof applications.$inferInsert>,
					)
					.where(eq(applications.applicationId, input.serviceId));
			}
			await deleteGhaConnection(input.serviceType, input.serviceId);
			await deleteGithubWatch(input.serviceType, input.serviceId);
			if (watch) {
				await removeGhcrWatchConfigDirs([watch.watchId], organizationId);
			}
			await audit(ctx, {
				action: "update",
				resourceType: input.serviceType,
				resourceId: input.serviceId,
				resourceName: "GitHub Actions: disconnected",
			});
			return true;
		}),

	checkNow: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "POST",
				path: "/ghaConnection.checkNow",
				description:
					"Ask Dokploy to look at GitHub for this service now: resets the idle slow-down, and retries a blocked connection.",
			},
		})
		.input(apiGhaCheckNow)
		.mutation(async ({ ctx, input }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				service: ["read"],
			});
			const row = await findGhaConnection(input.serviceType, input.serviceId);
			if (!row || row.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This service does not follow GitHub Actions",
				});
			}
			await touchConnectionActivity(row.ghaConnectionId);
			if (row.state === "blocked") {
				await applyConnectionEvent(
					row.ghaConnectionId,
					{ type: "unblock", hasRelease: row.deployedSha !== null },
					null,
				);
			}
			return true;
		}),
});
```

- [ ] **Step 2: Register the router**

In `apps/dokploy/server/api/root.ts` add next to the `githubDeployment` lines:

```ts
import { ghaConnectionRouter } from "./routers/gha-connection";
```

and in the `appRouter` object:

```ts
	ghaConnection: ghaConnectionRouter,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r run typecheck`
Expected: no errors.

- [ ] **Step 4: Update the MCP scope snapshot**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/mcp/scopes-snapshot.test.ts -u`
Review `git diff` of the snapshot: only four added lines, `ghaConnection-checkNow`, `ghaConnection-connect`, `ghaConnection-disconnect` and `ghaConnection-one`, with `dokploy:read` for `one` and `dokploy:admin` for the three mutations (the same split as `githubDeployment-*`). Anything else in the diff is a mistake.

- [ ] **Step 5: Run the whole gha-connect and github-deployments suites**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect __test__/github-deployments __test__/mcp __test__/db`
Expected: PASS.

- [ ] **Step 6: Commit, push, open the PR**

```bash
pnpm exec biome check --write apps/dokploy/server packages/server/src
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: ghaConnection router and MCP tools (T-13719)"
git push -u origin feat/gha-connect-tables
gh pr create --repo DevinoSolutions/dokploy-community --base canary --title "feat: GitHub Actions connection tables, token scope and Connect API (T-13719)" --body "Phase 1 PR 2 of the native GitHub Actions connect (spec docs/superpowers/specs/2026-11-03-gha-native-connect-design.md). Adds gha_connection and gha_release (migration 0229), the repo_deployment + public_repo/repo token scope, the Connect checks and the ghaConnection API. Nothing polls yet."
```

- [ ] **Step 7: Review gate**

One review of the PR head (opus5-worker at high effort). Check: the migration is idempotent and its `when` is above 0228's; no output carries the token, the saved source or the handled-run list; every GitHub read error refuses Connect; the environment policy is never treated as passing on error; the scope change does not break existing #577 watches.

- [ ] **Step 8: Manual proof for the lead**

On a test instance with this build: disconnect and reconnect GitHub through Settings, Git, choosing a public repository; in the MCP or the API call `ghaConnection.connect` for the voicekit web `dev` service with the repository, tracked branch and environment `dev`. Expected: the call succeeds, `ghaConnection.one` returns state `waiting` with the sentence "Waiting for GitHub Actions to publish <sha>. Git autodeploy is off.", the application's git autodeploy is off, and a connect with a wider environment policy is refused with the environment message. Then `ghaConnection.disconnect` and confirm the application is back on its git source with autodeploy as it was.

## PR 3: The acceptance engine

**Branch:** `feat/gha-connect-acceptance` from the PR 2 branch (or from canary once PR 2 merged). **Migration:** none. **Depends on:** PR 1 merged and tagged `v1.0.0` (the fixtures come from it) and PR 2 (actions API, ordering, environment policy, state machine).

This is the whole of the spec's "Trust model": given a run id and attempt and what is known about the connection, decide `accepted`, `noop`, `ignored`, `refused` (blocking or not, to re-check later or not), `pending` or `retry`. It is pure over two injected objects, the GitHub API of the repository and a registry probe, so nothing in it touches a network in tests. It changes no runtime behavior: nothing calls it until PR 4.

The order of the checks inside `acceptRelease` is part of the security design. A run, its artifact and the manifest are verified before anything that could block a connection, so a stranger who can only create a GitHub Deployment cannot put a service in the Blocked state: an unverified claim is `ignored`.

1. Run attempt: `path` equals the connection's workflow path, `head_branch` equals the tracked branch, `event` is `push` or `workflow_dispatch` (never `pull_request`, never `workflow_run`), repository and head repository ids equal the connection's repository id. A run still going is `pending`; a completed run that is not a success is `refused` (`run-failed`).
2. Artifact: named `dokploy-release`, not expired, bound to the run and to the repository id. Download is size-limited and read with the dependency-free zip reader (no zip64, no encryption, bounded output, crc32 checked).
3. Manifest: `parseReleaseManifest` (schema major 1, no tags next to digests, `migrations` must be null) and the manifest `sha` equals the run's `head_sha`; the service key is one the manifest names.
4. Registry: each digest sits in an allowed namespace, equals the repository the service runs after the first release, and answers `HEAD /v2/<name>/manifests/<digest>` with the same `Docker-Content-Digest`.
5. Environment branch policy re-read now: only the tracked branch. A read error, a missing environment or a wider policy refuses and blocks (skipped only in repository-secret mode).
6. Ordering against the deployed release and the branch head.

### Task 3.1: Vendor the release fixtures

The manifest contract lives in the action repository. The fork copies its fixtures and pins them with a hash, so changing a vendored file by hand fails a test, and a contract change in the action repository arrives here as a visible diff.

**Files:**
- Create: `scripts/vendor-gha-fixtures.mjs`
- Create (generated): `apps/dokploy/__test__/gha-connect/fixtures/**`

- [ ] **Step 1: Write the vendoring script**

**`scripts/vendor-gha-fixtures.mjs`**

```js
#!/usr/bin/env node
// Copies the release-manifest fixtures of DevinoSolutions/dokploy-release into
// the fork's tests and pins them with a hash.
//
//   node scripts/vendor-gha-fixtures.mjs <path to a checkout of dokploy-release>
//
// The hash algorithm is the one apps/dokploy/__test__/gha-connect/manifest.test.ts
// recomputes, so a hand edit of a vendored fixture fails that test.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
	console.error("usage: vendor-gha-fixtures.mjs <dokploy-release checkout>");
	process.exit(2);
}
const from = resolve(source, "fixtures");
const to = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"apps/dokploy/__test__/gha-connect/fixtures",
);

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const read = (file) => readFileSync(join(to, file), "utf8");
const index = JSON.parse(read("index.json"));
const hash = createHash("sha256");
for (const entry of [...index].sort((a, b) => a.file.localeCompare(b.file))) {
	hash.update(entry.file).update("\0").update(read(entry.file)).update("\0");
}
hash.update(read("index.json"));

let commit = null;
try {
	commit = execFileSync("git", ["-C", resolve(source), "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	// Not a git checkout: the hash still pins the content.
}
writeFileSync(
	join(to, "SOURCE.json"),
	`${JSON.stringify({ repository: "DevinoSolutions/dokploy-release", commit, sha256: hash.digest("hex") }, null, 2)}\n`,
);
console.log(`vendored ${index.length} fixtures from ${from}`);
```

- [ ] **Step 2: Vendor from the tagged action repository**

```bash
git -C C:/wt/dokploy-release fetch --tags
git -C C:/wt/dokploy-release checkout v1.0.0
node scripts/vendor-gha-fixtures.mjs C:/wt/dokploy-release
```

Expected: `apps/dokploy/__test__/gha-connect/fixtures/` holds `index.json`, `valid/*.json`, `invalid/*.json` and `SOURCE.json` (the action repository commit and the sha256 over the files). Commit all of it.

- [ ] **Step 3: Commit**

```bash
git add scripts/vendor-gha-fixtures.mjs apps/dokploy/__test__/gha-connect/fixtures
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "test: vendor the dokploy-release fixtures and pin them (T-13719)"
```

### Task 3.2: The manifest parser

`parseReleaseManifest` returns `{ok: true, manifest}` or `{ok: false, code, message}` with code `manifest-invalid`, `unknown-schema` or `migrations-unsupported`. It refuses a body over 64 KiB, an unknown schema major, a non-null `migrations`, a tag next to a digest, duplicate compose services, and a compose path that leaves the repository. It tolerates unknown fields and minor versions. Every vendored fixture is an expected-result test, driven by `fixtures/index.json`.

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/manifest.test.ts`**

```ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	MANIFEST_MAX_BYTES,
	parseReleaseManifest,
} from "@dokploy/server/services/gha-connect/manifest";
import { describe, expect, it } from "vitest";

const dir = path.resolve(__dirname, "fixtures");
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const index = JSON.parse(read("index.json")) as Array<{
	file: string;
	ok: boolean;
	code?: string;
}>;

describe("vendored fixtures from DevinoSolutions/dokploy-release", () => {
	it("lists every fixture file and no other", () => {
		const onDisk = ["valid", "invalid"]
			.flatMap((sub) =>
				readdirSync(path.join(dir, sub)).map((f) => `${sub}/${f}`),
			)
			.sort();
		expect(index.map((e) => e.file).sort()).toEqual(onDisk);
	});

	it("matches the pinned hash in SOURCE.json (re-vendor on purpose, never edit)", () => {
		const source = JSON.parse(read("SOURCE.json")) as { sha256: string };
		const hash = createHash("sha256");
		for (const entry of [...index].sort((a, b) => a.file.localeCompare(b.file))) {
			hash.update(entry.file).update("\0").update(read(entry.file)).update("\0");
		}
		hash.update(read("index.json"));
		expect(hash.digest("hex")).toBe(source.sha256);
	});

	it.each(index.map((e) => [e.file, e] as const))("%s", (_file, entry) => {
		const result = parseReleaseManifest(read(entry.file));
		if (entry.ok) {
			expect(result.ok).toBe(true);
		} else {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe(entry.code);
		}
	});
});

describe("parseReleaseManifest", () => {
	const valid = () => JSON.parse(read("valid/multi-service-pull.json"));

	it("returns the services with their images split into repository and digest", () => {
		const result = parseReleaseManifest(valid());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.releaseId).toBe("gh-9876543210.1");
		expect(result.manifest.source.runAttempt).toBe(1);
		const web = result.manifest.services.find((s) => s.key === "web");
		expect(web?.composePath).toBe("docker-compose.prod.yml");
		expect(web?.images[0]).toEqual({
			name: "web",
			composeService: "web",
			ref: `registry.example.com/acme/shop/web@sha256:${"e".repeat(64)}`,
			repository: "registry.example.com/acme/shop/web",
			digest: `sha256:${"e".repeat(64)}`,
		});
	});

	it("accepts a manifest object as well as its text", () => {
		expect(parseReleaseManifest(valid()).ok).toBe(true);
		expect(parseReleaseManifest(JSON.stringify(valid())).ok).toBe(true);
	});

	it("refuses text that is not JSON", () => {
		const result = parseReleaseManifest("{nope");
		expect(result).toMatchObject({ ok: false, code: "invalid-json" });
	});

	it("refuses a manifest above the size limit before parsing it", () => {
		const result = parseReleaseManifest(" ".repeat(MANIFEST_MAX_BYTES + 1));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
	});

	it("refuses migrations only when a service really asks for one", () => {
		const manifest = valid();
		manifest.services[0].migrations = null;
		expect(parseReleaseManifest(manifest).ok).toBe(true);
		delete manifest.services[0].migrations;
		expect(parseReleaseManifest(manifest).ok).toBe(true);
		manifest.services[0].migrations = { command: "x" };
		expect(parseReleaseManifest(manifest)).toMatchObject({
			ok: false,
			code: "migrations-unsupported",
		});
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect/manifest.test.ts`
Expected: FAIL, `manifest` does not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/manifest.ts`**

```ts
import { parsePinnedImage } from "../github-deployments/payload";

/**
 * The release manifest (`dokploy.release/v1`): a small JSON file that the
 * `DevinoSolutions/dokploy-release` action uploads as the run artifact
 * `dokploy-release`. The schema and its fixtures live with the action; this
 * parser is the fork's copy of the contract (the fixtures are vendored under
 * apps/dokploy/__test__/gha-connect/fixtures and a test fails when the two
 * drift). Pure: no I/O.
 *
 * Unknown minor fields are ignored. An unknown major version is refused.
 * Phase 1 refuses every manifest that asks for a migration command.
 */

export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MANIFEST_ARTIFACT_NAME = "dokploy-release";

const SCHEMA = /^dokploy\.release\/v(\d+)(?:\.\d+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_ID = /^[0-9]{1,18}$/;
const COMPOSE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMPOSE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;

export interface ManifestImage {
	name: string;
	composeService: string;
	/** `<repository>@sha256:<64 hex>`, never a tag. */
	ref: string;
	repository: string;
	digest: string;
}

export interface ManifestService {
	key: string;
	images: ManifestImage[];
	composePath: string | null;
}

export interface ReleaseManifest {
	schema: string;
	sha: string;
	delivery: "pull" | "push";
	releaseId: string;
	releaseServices: string[];
	source: { forge: "github"; ref: string; runId: string; runAttempt: number };
	environment: string;
	services: ManifestService[];
}

export type ManifestFailure =
	| "invalid-json"
	| "unknown-schema"
	| "invalid"
	| "migrations-unsupported";

export type ManifestParse =
	| { ok: true; manifest: ReleaseManifest }
	| { ok: false; code: ManifestFailure; message: string };

const fail = (code: ManifestFailure, message: string): ManifestParse => ({
	ok: false,
	code,
	message,
});

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const asString = (value: unknown, pattern: RegExp): string | null =>
	typeof value === "string" && pattern.test(value) ? value : null;

const parseImage = (
	value: unknown,
	where: string,
): ManifestImage | string => {
	const image = asObject(value);
	if (!image) return `${where} must be an object`;
	const name = asString(image.name, COMPOSE_SERVICE);
	if (!name) return `${where}.name is missing or malformed`;
	const composeService = asString(image.composeService, COMPOSE_SERVICE);
	if (!composeService) return `${where}.composeService is missing or malformed`;
	const pinned = parsePinnedImage(image.ref);
	if (!pinned) {
		return `${where}.ref must be <repository>@sha256:<64 hex>; an image that is not pinned by digest is never deployed`;
	}
	// A tag next to the digest is dropped by parsePinnedImage; the manifest
	// contract is stricter: the ref must already be in canonical form.
	if (pinned.image !== image.ref) {
		return `${where}.ref must not carry a tag`;
	}
	return {
		name,
		composeService,
		ref: pinned.image,
		repository: pinned.repository,
		digest: pinned.digest,
	};
};

export const parseReleaseManifest = (input: string | unknown): ManifestParse => {
	let raw: unknown = input;
	if (typeof input === "string") {
		if (Buffer.byteLength(input, "utf8") > MANIFEST_MAX_BYTES) {
			return fail("invalid", "The manifest is larger than 64 KiB");
		}
		try {
			raw = JSON.parse(input);
		} catch {
			return fail("invalid-json", "The manifest is not valid JSON");
		}
	}
	const root = asObject(raw);
	if (!root) return fail("invalid", "The manifest must be a JSON object");

	if (typeof root.schema !== "string") {
		return fail("unknown-schema", "The manifest has no schema field");
	}
	const schema = SCHEMA.exec(root.schema);
	if (!schema || schema[1] !== "1") {
		return fail(
			"unknown-schema",
			`Unsupported manifest schema ${root.schema.slice(0, 40)}; this Dokploy reads dokploy.release/v1`,
		);
	}

	const sha = asString(root.sha, SHA);
	if (!sha) return fail("invalid", "sha must be a 40 character lowercase hex");
	if (root.delivery !== "pull" && root.delivery !== "push") {
		return fail("invalid", 'delivery must be "pull" or "push"');
	}
	const delivery = root.delivery;

	const release = asObject(root.release);
	const releaseId = asString(release?.id, RELEASE_ID);
	if (!release || !releaseId) {
		return fail("invalid", "release.id is missing or malformed");
	}
	if (!Array.isArray(release.services) || release.services.length === 0) {
		return fail("invalid", "release.services must list at least one key");
	}
	const releaseServices: string[] = [];
	for (const key of release.services) {
		const valid = asString(key, KEY);
		if (!valid) return fail("invalid", "release.services has a malformed key");
		if (releaseServices.includes(valid)) {
			return fail("invalid", `release.services repeats ${valid}`);
		}
		releaseServices.push(valid);
	}

	const source = asObject(root.source);
	if (
		!source ||
		source.forge !== "github" ||
		typeof source.ref !== "string" ||
		!source.ref.startsWith("refs/heads/") ||
		source.ref.length > 300
	) {
		return fail("invalid", "source must name forge github and a branch ref");
	}
	const runId = asString(source.runId, RUN_ID);
	if (!runId) return fail("invalid", "source.runId must be a decimal string");
	const runAttempt = source.runAttempt;
	if (
		typeof runAttempt !== "number" ||
		!Number.isSafeInteger(runAttempt) ||
		runAttempt < 1
	) {
		return fail("invalid", "source.runAttempt must be a positive integer");
	}

	if (
		typeof root.environment !== "string" ||
		root.environment.length === 0 ||
		root.environment.length > 255
	) {
		return fail("invalid", "environment is missing or too long");
	}

	if (!Array.isArray(root.services) || root.services.length === 0) {
		return fail("invalid", "services must list at least one service");
	}
	const services: ManifestService[] = [];
	for (const [index, entry] of root.services.entries()) {
		const where = `services[${index}]`;
		const service = asObject(entry);
		if (!service) return fail("invalid", `${where} must be an object`);
		const key = asString(service.key, KEY);
		if (!key) return fail("invalid", `${where}.key is missing or malformed`);
		if (services.some((s) => s.key === key)) {
			return fail("invalid", `${where}.key ${key} appears twice`);
		}
		if (service.migrations !== undefined && service.migrations !== null) {
			return fail(
				"migrations-unsupported",
				`${where} asks for a migration command; this Dokploy does not run migrations yet`,
			);
		}
		if (!Array.isArray(service.images) || service.images.length === 0) {
			return fail("invalid", `${where}.images must list at least one image`);
		}
		const images: ManifestImage[] = [];
		for (const [imageIndex, imageValue] of service.images.entries()) {
			const parsed = parseImage(imageValue, `${where}.images[${imageIndex}]`);
			if (typeof parsed === "string") return fail("invalid", parsed);
			if (images.some((i) => i.composeService === parsed.composeService)) {
				return fail(
					"invalid",
					`${where} has two images for ${parsed.composeService}`,
				);
			}
			images.push(parsed);
		}
		let composePath: string | null = null;
		if (service.compose !== undefined && service.compose !== null) {
			const compose = asObject(service.compose);
			const path = asString(compose?.path, COMPOSE_PATH);
			if (!path || path.includes("..")) {
				return fail("invalid", `${where}.compose.path is malformed`);
			}
			composePath = path;
		}
		services.push({ key, images, composePath });
	}

	const listed = [...releaseServices].sort().join("\n");
	const present = services
		.map((s) => s.key)
		.sort()
		.join("\n");
	if (listed !== present) {
		return fail("invalid", "release.services and services[].key must match");
	}

	return {
		ok: true,
		manifest: {
			schema: root.schema,
			sha,
			delivery,
			releaseId,
			releaseServices,
			source: { forge: "github", ref: source.ref, runId, runAttempt },
			environment: root.environment,
			services,
		},
	};
};
```

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: parse and validate the release manifest (T-13719)"
```

### Task 3.3: The wake-up payload and the zip reader

A GitHub Deployment is a wake-up record. `parseDeploymentTask("dokploy:shop")` returns the key, or null for any other task (Actions' own environment Deployments are ignored). `parseWakePayload` reads `{schema: "dokploy.deployment/v1", run_id, run_attempt}` and nothing else from the Deployment: every digest comes from the artifact.

- [ ] **Step 1: Write the failing tests and the zip builder used by them**

**`apps/dokploy/__test__/gha-connect/zip-fixture.ts`**

```ts
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFile {
	name: string;
	data: string | Buffer;
	/** 0 = stored, 8 = deflated (default). */
	method?: 0 | 8;
	/** Overrides for building damaged archives. */
	crc?: number;
	declaredSize?: number;
	flags?: number;
}

/** Builds a real zip in memory (what actions/upload-artifact produces, in miniature). */
export const buildZip = (files: ZipFile[]): Buffer => {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
		const method = file.method ?? 8;
		const body = method === 8 ? deflateRawSync(data) : data;
		const name = Buffer.from(file.name);
		const crc = file.crc ?? crc32(data);
		const size = file.declaredSize ?? data.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(file.flags ?? 0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(file.flags ?? 0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
};
```

**`apps/dokploy/__test__/gha-connect/wake-payload.test.ts`**

```ts
import {
	parseDeploymentTask,
	parseWakePayload,
	WAKE_SCHEMA,
} from "@dokploy/server/services/gha-connect/wake-payload";
import { describe, expect, it } from "vitest";

const payload = (overrides: Record<string, unknown> = {}) => ({
	schema: WAKE_SCHEMA,
	run_id: 9876543210,
	run_attempt: 2,
	artifact: "dokploy-release",
	...overrides,
});

describe("parseDeploymentTask", () => {
	it("returns the key of a dokploy task", () => {
		expect(parseDeploymentTask("dokploy:web")).toBe("web");
		expect(parseDeploymentTask("dokploy:shorty-web.v2")).toBe("shorty-web.v2");
	});

	it.each([
		"deploy",
		"dokploy:",
		"dokploy:Web",
		"Dokploy:web",
		"dokploy:web;rm",
		"dokploy:a/b",
		undefined,
		null,
		42,
	])("ignores %s", (task) => {
		expect(parseDeploymentTask(task)).toBeNull();
	});
});

describe("parseWakePayload", () => {
	it("reads the run id and attempt", () => {
		expect(parseWakePayload(payload())).toEqual({
			ok: true,
			runId: 9876543210,
			runAttempt: 2,
		});
	});

	it("accepts the payload as a JSON string and ids as decimal strings", () => {
		expect(
			parseWakePayload(
				JSON.stringify(payload({ run_id: "9876543210", run_attempt: "3" })),
			),
		).toEqual({ ok: true, runId: 9876543210, runAttempt: 3 });
	});

	it("never takes an image or a service id from the payload", () => {
		const result = parseWakePayload(
			payload({ dokploy: { image: "evil@sha256:" + "a".repeat(64) } }),
		);
		expect(result).toEqual({ ok: true, runId: 9876543210, runAttempt: 2 });
	});

	it.each([
		["another schema", payload({ schema: "dokploy.deployment/v2" })],
		["another artifact", payload({ artifact: "something-else" })],
		["a zero run id", payload({ run_id: 0 })],
		["a fractional attempt", payload({ run_attempt: 1.5 })],
		["a negative attempt", payload({ run_attempt: -1 })],
		["a missing run id", payload({ run_id: undefined })],
		["an array", []],
		["a string that is not JSON", "nope"],
		["null", null],
	])("refuses %s", (_name, value) => {
		expect(parseWakePayload(value).ok).toBe(false);
	});
});
```

**`apps/dokploy/__test__/gha-connect/zip.test.ts`**

```ts
import { readZipEntry } from "@dokploy/server/services/gha-connect/zip";
import { describe, expect, it } from "vitest";
import { buildZip } from "./zip-fixture";

const NAME = "dokploy-release.json";
const text = (r: ReturnType<typeof readZipEntry>) =>
	r.ok ? r.bytes.toString("utf8") : null;

describe("readZipEntry", () => {
	it("reads a deflated entry", () => {
		const zip = buildZip([{ name: NAME, data: '{"a":1}'.repeat(50) }]);
		expect(text(readZipEntry(zip, NAME, 4096))).toBe('{"a":1}'.repeat(50));
	});

	it("reads a stored entry", () => {
		const zip = buildZip([{ name: NAME, data: '{"a":1}', method: 0 }]);
		expect(text(readZipEntry(zip, NAME, 4096))).toBe('{"a":1}');
	});

	it("finds the entry among others and matches the name exactly", () => {
		const zip = buildZip([
			{ name: "other.txt", data: "x" },
			{ name: `sub/${NAME}`, data: "nested" },
			{ name: NAME, data: "the one" },
		]);
		expect(text(readZipEntry(zip, NAME, 4096))).toBe("the one");
	});

	it("says so when the entry is missing", () => {
		const zip = buildZip([{ name: "other.txt", data: "x" }]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/no entry named/);
	});

	it("refuses an entry whose declared size is above the limit", () => {
		const zip = buildZip([{ name: NAME, data: "x".repeat(5000) }]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result).toMatchObject({ ok: false });
	});

	it("stops inflating at the limit when the declared size lies", () => {
		const zip = buildZip([
			{ name: NAME, data: "x".repeat(1_000_000), declaredSize: 10 },
		]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result).toMatchObject({ ok: false });
	});

	it("refuses a wrong checksum", () => {
		const zip = buildZip([{ name: NAME, data: "hello", crc: 1234 }]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toMatch(/checksum/);
	});

	it("refuses an encrypted entry", () => {
		const zip = buildZip([{ name: NAME, data: "hello", flags: 1 }]);
		expect(readZipEntry(zip, NAME, 4096)).toMatchObject({ ok: false });
	});

	it("refuses bytes that are not a zip, and a truncated zip", () => {
		expect(readZipEntry(new Uint8Array(10), NAME, 4096).ok).toBe(false);
		expect(readZipEntry(Buffer.from("x".repeat(100)), NAME, 4096).ok).toBe(false);
		const zip = buildZip([{ name: NAME, data: "hello" }]);
		expect(readZipEntry(zip.subarray(0, zip.length - 10), NAME, 4096).ok).toBe(false);
	});
});
```

- [ ] **Step 2: Run them and see them fail**

Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/wake-payload.ts`**

```ts
import { readDeploymentPayload } from "../github-deployments/payload";

/**
 * A GitHub Deployment is a wake-up record, never the source of truth: anyone
 * with write access can create one. All it may say is which run to look at.
 * The release itself is the run artifact (see manifest.ts and acceptance.ts).
 *
 *   task:    "dokploy:<service key>"
 *   payload: {"schema":"dokploy.deployment/v1","run_id":<id>,"run_attempt":<n>,"artifact":"dokploy-release"}
 */

export const WAKE_SCHEMA = "dokploy.deployment/v1";
export const TASK_PREFIX = "dokploy:";

const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/** The service key of a `dokploy:<key>` task; null for any other task. */
export const parseDeploymentTask = (task: unknown): string | null => {
	if (typeof task !== "string" || !task.startsWith(TASK_PREFIX)) return null;
	const key = task.slice(TASK_PREFIX.length);
	return KEY.test(key) ? key : null;
};

export type WakePayload =
	| { ok: true; runId: number; runAttempt: number }
	| { ok: false; reason: string };

const positiveInteger = (value: unknown): number | null => {
	const n =
		typeof value === "string" && /^[0-9]{1,18}$/.test(value)
			? Number(value)
			: value;
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : null;
};

export const parseWakePayload = (raw: unknown): WakePayload => {
	const payload = readDeploymentPayload(raw);
	if (!payload) return { ok: false, reason: "The payload is not a JSON object" };
	if (payload.schema !== WAKE_SCHEMA) {
		return { ok: false, reason: "The payload names another schema" };
	}
	if (payload.artifact !== "dokploy-release") {
		return { ok: false, reason: "The payload names another artifact" };
	}
	const runId = positiveInteger(payload.run_id);
	const runAttempt = positiveInteger(payload.run_attempt);
	if (runId === null || runAttempt === null) {
		return { ok: false, reason: "run_id and run_attempt must be positive integers" };
	}
	return { ok: true, runId, runAttempt };
};
```

**`packages/server/src/services/gha-connect/zip.ts`**

```ts
import { crc32, inflateRawSync } from "node:zlib";

/**
 * Reads ONE named entry out of a small zip (a GitHub Actions artifact holding
 * the release manifest). No dependency: the artifact is untrusted bytes, so
 * the reader is deliberately narrow.
 *
 * Refused: encrypted entries, zip64, entries larger than `maxBytes` (checked
 * against the declared size AND while inflating), a CRC that does not match,
 * a directory that points outside the buffer. Only an exact name match is read.
 */

export type ZipRead =
	| { ok: true; bytes: Buffer }
	| { ok: false; reason: string };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const fail = (reason: string): ZipRead => ({ ok: false, reason });

export const readZipEntry = (
	zip: Uint8Array,
	name: string,
	maxBytes: number,
): ZipRead => {
	const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
	if (buf.length < 22) return fail("The archive is too small to be a zip");

	let eocd = -1;
	const lowest = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= lowest; i -= 1) {
		if (buf.readUInt32LE(i) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return fail("The archive has no end-of-directory record");

	const entries = buf.readUInt16LE(eocd + 10);
	const directorySize = buf.readUInt32LE(eocd + 12);
	let pos = buf.readUInt32LE(eocd + 16);
	if (entries === 0xffff || directorySize === 0xffffffff || pos === 0xffffffff) {
		return fail("zip64 archives are not accepted");
	}
	if (pos + directorySize > eocd) return fail("The directory is out of range");

	for (let n = 0; n < entries; n += 1) {
		if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL) {
			return fail("The directory is damaged");
		}
		const flags = buf.readUInt16LE(pos + 8);
		const method = buf.readUInt16LE(pos + 10);
		const crc = buf.readUInt32LE(pos + 16);
		const compressed = buf.readUInt32LE(pos + 20);
		const size = buf.readUInt32LE(pos + 24);
		const nameLength = buf.readUInt16LE(pos + 28);
		const extraLength = buf.readUInt16LE(pos + 30);
		const commentLength = buf.readUInt16LE(pos + 32);
		const localOffset = buf.readUInt32LE(pos + 42);
		const entryName = buf.toString("utf8", pos + 46, pos + 46 + nameLength);
		pos += 46 + nameLength + extraLength + commentLength;
		if (entryName !== name) continue;

		if (flags & 0x1) return fail("Encrypted entries are not accepted");
		if (compressed === 0xffffffff || size === 0xffffffff) {
			return fail("zip64 entries are not accepted");
		}
		if (size > maxBytes) return fail("The entry is larger than allowed");
		if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) {
			return fail("The entry header is damaged");
		}
		const dataStart =
			localOffset +
			30 +
			buf.readUInt16LE(localOffset + 26) +
			buf.readUInt16LE(localOffset + 28);
		if (dataStart + compressed > buf.length) {
			return fail("The entry data is out of range");
		}
		const raw = buf.subarray(dataStart, dataStart + compressed);
		let bytes: Buffer;
		if (method === 0) {
			bytes = Buffer.from(raw);
		} else if (method === 8) {
			try {
				bytes = inflateRawSync(raw, { maxOutputLength: maxBytes });
			} catch {
				return fail("The entry could not be inflated within the size limit");
			}
		} else {
			return fail("The entry uses an unsupported compression method");
		}
		if (bytes.length !== size) return fail("The entry size does not match");
		if (crc32(bytes) !== crc) return fail("The entry checksum does not match");
		return { ok: true, bytes };
	}
	return fail(`The archive has no entry named ${name}`);
};
```

- [ ] **Step 4: Run the tests, then commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: wake-up payload and a bounded zip reader (T-13719)"
```

### Task 3.4: The registry probe

One `HEAD /v2/<name>/manifests/<digest>` per image, with the manifest media types a registry needs. On a 401 with a bearer challenge it fetches a token from the realm (refusing a plain-http realm that is not local) and repeats once. Registry credentials come from the organization's own registry logins through `loadAccess`; GHCR images are read anonymously, which is why phase 1 is limited to public GHCR images.

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/registry-probe.test.ts`**

```ts
import {
	createRegistryProbe,
	parseBearerChallenge,
} from "@dokploy/server/services/gha-connect/registry-probe";
import { describe, expect, it } from "vitest";
import { type Reply, routedFetch } from "./gha-helpers";

const DIGEST = `sha256:${"e".repeat(64)}`;
const INPUT = { host: "ghcr.io", name: "acme/shop/web", digest: DIGEST };

describe("parseBearerChallenge", () => {
	it("reads realm, service and scope", () => {
		expect(
			parseBearerChallenge(
				'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/shop/web:pull"',
			),
		).toEqual({
			realm: "https://ghcr.io/token",
			service: "ghcr.io",
			scope: "repository:acme/shop/web:pull",
		});
	});
	it("ignores other schemes and a challenge without a realm", () => {
		expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
		expect(parseBearerChallenge('Bearer service="x"')).toBeNull();
		expect(parseBearerChallenge(null)).toBeNull();
	});
});

describe("registry probe", () => {
	it("returns the digest a registry serves, using HEAD with manifest types", async () => {
		const { fetch, calls } = routedFetch([
			["/v2/", { headers: { "Docker-Content-Digest": DIGEST } }],
		]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		expect(await probe.headDigest(INPUT)).toEqual({ kind: "ok", digest: DIGEST });
		expect(calls[0]).toMatchObject({
			method: "HEAD",
			url: `https://ghcr.io/v2/acme/shop/web/manifests/${DIGEST}`,
		});
		expect(calls[0]?.headers.Accept).toContain("application/vnd.oci.image.index.v1+json");
	});

	it("follows the bearer challenge once, with the anonymous token of a public image", async () => {
		let heads = 0;
		const { fetch, calls } = routedFetch([
			["/token", { json: { token: "anon-token" } }],
			[
				"/v2/",
				(call): Reply => {
					heads += 1;
					return call.headers.Authorization === "Bearer anon-token"
						? { headers: { "Docker-Content-Digest": DIGEST } }
						: {
								status: 401,
								headers: {
									"WWW-Authenticate":
										'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
								},
							};
				},
			],
		]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		expect(await probe.headDigest(INPUT)).toEqual({ kind: "ok", digest: DIGEST });
		expect(heads).toBe(2);
		const tokenCall = calls.find((c) => c.url.includes("/token"));
		expect(tokenCall?.url).toContain("scope=repository%3Aacme%2Fshop%2Fweb%3Apull");
		expect(tokenCall?.headers.Authorization).toBeUndefined();
	});

	it("uses the credentials this Dokploy holds for a private registry", async () => {
		const { fetch, calls } = routedFetch([["/v2/", { headers: { "Docker-Content-Digest": DIGEST } }]]);
		const probe = createRegistryProbe({
			fetch,
			loadAccess: async (host) =>
				host === "registry.devino.ca"
					? { baseUrl: "https://registry.devino.ca/", username: "dokploy", password: "pw" }
					: null,
		});
		await probe.headDigest({ ...INPUT, host: "registry.devino.ca", name: "voicekit/web" });
		expect(calls[0]?.url).toBe(`https://registry.devino.ca/v2/voicekit/web/manifests/${DIGEST}`);
		expect(calls[0]?.headers.Authorization).toBe(
			`Basic ${Buffer.from("dokploy:pw").toString("base64")}`,
		);
	});

	it("does not send the registry password to a token endpoint on plain http", async () => {
		const { fetch, calls } = routedFetch([
			[
				"/v2/",
				{
					status: 401,
					headers: { "WWW-Authenticate": 'Bearer realm="http://evil.example/token"' },
				},
			],
		]);
		const probe = createRegistryProbe({
			fetch,
			loadAccess: async () => ({ baseUrl: "https://registry.devino.ca", username: "u", password: "p" }),
		});
		expect(await probe.headDigest({ ...INPUT, host: "registry.devino.ca" })).toEqual({
			kind: "unreachable",
			status: 401,
		});
		expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
	});

	it("maps 404, other statuses and a network failure", async () => {
		const missing = routedFetch([["/v2/", { status: 404 }]]);
		expect(
			await createRegistryProbe({ fetch: missing.fetch, loadAccess: async () => null }).headDigest(INPUT),
		).toEqual({ kind: "not-found" });
		const broken = routedFetch([["/v2/", { status: 503 }]]);
		expect(
			await createRegistryProbe({ fetch: broken.fetch, loadAccess: async () => null }).headDigest(INPUT),
		).toEqual({ kind: "unreachable", status: 503 });
		const down = createRegistryProbe({
			fetch: async () => {
				throw new Error("offline");
			},
			loadAccess: async () => null,
		});
		expect(await down.headDigest(INPUT)).toEqual({ kind: "unreachable", status: 0 });
	});

	it("reports a missing Docker-Content-Digest header as null (the caller refuses it)", async () => {
		const { fetch } = routedFetch([["/v2/", {}]]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		expect(await probe.headDigest(INPUT)).toEqual({ kind: "ok", digest: null });
	});

	it("refuses a malformed host, name or digest without any request", async () => {
		const { fetch, calls } = routedFetch([["/", {}]]);
		const probe = createRegistryProbe({ fetch, loadAccess: async () => null });
		for (const bad of [
			{ ...INPUT, host: "evil.com/x" },
			{ ...INPUT, name: "../etc" },
			{ ...INPUT, name: "A/B" },
			{ ...INPUT, digest: "sha256:short" },
		]) {
			expect(await probe.headDigest(bad)).toEqual({ kind: "not-found" });
		}
		expect(calls).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/registry-probe.ts`**

```ts
import type { ApiFetch, ApiResponse } from "./actions-api";

/**
 * Acceptance rule 4: every image digest of a release must be served by the
 * registry with the same `Docker-Content-Digest`. One `HEAD /v2/<name>/manifests/<digest>`
 * per image (plus a token request when the registry asks for one). The GitHub
 * Packages API is never used.
 */

export type ProbeResult =
	| { kind: "ok"; digest: string | null }
	| { kind: "not-found" }
	| { kind: "unreachable"; status: number };

export interface RegistryProbe {
	headDigest(input: {
		host: string;
		name: string;
		digest: string;
	}): Promise<ProbeResult>;
}

/** How to reach a registry host; null means anonymous HTTPS. */
export interface RegistryAccess {
	baseUrl: string;
	username: string;
	password: string;
}

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const NAME = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

const basic = (access: RegistryAccess | null): Record<string, string> =>
	access
		? {
				Authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString("base64")}`,
			}
		: {};

/** `Bearer realm="...",service="...",scope="..."` as a record; null for any other scheme. */
export const parseBearerChallenge = (
	header: string | null,
): Record<string, string> | null => {
	if (!header || !/^bearer\s/i.test(header)) return null;
	const out: Record<string, string> = {};
	for (const match of header.matchAll(/([a-z_]+)="([^"]*)"/gi)) {
		if (match[1] && match[2] !== undefined) out[match[1].toLowerCase()] = match[2];
	}
	return out.realm ? out : null;
};

export const createRegistryProbe = (deps: {
	fetch: ApiFetch;
	/** Credentials this Dokploy holds for a registry host (its Registry settings), or null. */
	loadAccess: (host: string) => Promise<RegistryAccess | null>;
}): RegistryProbe => ({
	async headDigest({ host, name, digest }) {
		if (!HOST.test(host) || !NAME.test(name) || !DIGEST.test(digest)) {
			return { kind: "not-found" };
		}
		const access = await deps.loadAccess(host);
		const base = (access?.baseUrl ?? `https://${host}`).replace(/\/+$/, "");
		const url = `${base}/v2/${name}/manifests/${digest}`;
		const head = (extra: Record<string, string>) =>
			deps.fetch(url, {
				method: "HEAD",
				headers: {
					Accept: MANIFEST_TYPES,
					"User-Agent": "dokploy-community",
					...extra,
				},
			});

		let response: ApiResponse;
		try {
			response = await head(basic(access));
			if (response.status === 401) {
				const challenge = parseBearerChallenge(
					response.headers.get("www-authenticate"),
				);
				if (challenge?.realm) {
					const realm = new URL(challenge.realm);
					// The token endpoint must be https (or the registry's own http base):
					// the credential is never sent to a plain-http foreign host.
					if (realm.protocol !== "https:" && !base.startsWith("http://")) {
						return { kind: "unreachable", status: 401 };
					}
					if (challenge.service) realm.searchParams.set("service", challenge.service);
					realm.searchParams.set("scope", challenge.scope ?? `repository:${name}:pull`);
					const tokenResponse = await deps.fetch(realm.toString(), {
						method: "GET",
						headers: { "User-Agent": "dokploy-community", ...basic(access) },
					});
					if (!tokenResponse.ok) {
						return { kind: "unreachable", status: tokenResponse.status };
					}
					const body = (await tokenResponse.json().catch(() => null)) as {
						token?: unknown;
						access_token?: unknown;
					} | null;
					const token =
						typeof body?.token === "string"
							? body.token
							: typeof body?.access_token === "string"
								? body.access_token
								: null;
					if (!token) return { kind: "unreachable", status: 401 };
					response = await head({ Authorization: `Bearer ${token}` });
				}
			}
		} catch {
			return { kind: "unreachable", status: 0 };
		}
		if (response.status === 404) return { kind: "not-found" };
		if (!response.ok) return { kind: "unreachable", status: response.status };
		return { kind: "ok", digest: response.headers.get("docker-content-digest") };
	},
});
```

- [ ] **Step 4: Run the test, then commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: registry manifest probe for release digests (T-13719)"
```

### Task 3.5: `acceptRelease`

- [ ] **Step 1: Write the failing test**

The test builds a scripted `ActionsApi` and probe and walks every rule: a happy pull release, a push release, each refusal code, ignored claims that must not block, `pending` for a running run, `retry` for GitHub errors, ordering (ancestor refused, same digests no-op, higher attempt wins), the namespace and preview refusal, and the policy re-check with a read error.

**`apps/dokploy/__test__/gha-connect/acceptance.test.ts`**

```ts
import type {
	ActionsApi,
	ApiResult,
	ArtifactInfo,
	RunInfo,
} from "@dokploy/server/services/gha-connect/actions-api";
import {
	type AcceptanceResult,
	acceptRelease,
	type ConnectionFacts,
	digestsOf,
} from "@dokploy/server/services/gha-connect/acceptance";
import type { EnvironmentPolicy } from "@dokploy/server/services/gha-connect/environment-policy";
import type { CompareStatus } from "@dokploy/server/services/gha-connect/ordering";
import type {
	ProbeResult,
	RegistryProbe,
} from "@dokploy/server/services/gha-connect/registry-probe";
import { describe, expect, it } from "vitest";
import { buildZip } from "./zip-fixture";

const SHA = "a".repeat(40);
const OLD_SHA = "c".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const RUN_ID = 9876543210;
const REPO_ID = 42;
const ok = <T>(value: T): ApiResult<T> => ({ kind: "ok", value, etag: null });

const manifest = (overrides: Record<string, unknown> = {}) => ({
	schema: "dokploy.release/v1",
	sha: SHA,
	delivery: "pull",
	release: { id: `gh-${RUN_ID}.1`, services: ["web"] },
	source: {
		forge: "github",
		ref: "refs/heads/dev",
		runId: String(RUN_ID),
		runAttempt: 1,
	},
	environment: "development",
	services: [
		{
			key: "web",
			images: [
				{
					name: "web",
					composeService: "web",
					ref: `registry.devino.ca/voicekit/web@${DIGEST}`,
				},
			],
		},
	],
	...overrides,
});

const facts = (overrides: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
	repoId: REPO_ID,
	workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "web",
	owner: "DevinoSolutions",
	repo: "voicekit",
	protectionMode: "environment",
	registryHost: "registry.devino.ca",
	deployed: null,
	currentRepositories: ["registry.devino.ca/voicekit/web"],
	...overrides,
});

/** A GitHub where everything is right; each test breaks one thing. */
const world = () => {
	const state = {
		run: {
			id: RUN_ID,
			attempt: 1,
			path: ".github/workflows/dokploy-web-build-deploy.yml",
			headBranch: "dev",
			headSha: SHA,
			event: "push",
			status: "completed",
			conclusion: "success",
			repositoryId: REPO_ID,
			headRepositoryId: REPO_ID,
			htmlUrl: `https://github.com/DevinoSolutions/voicekit/actions/runs/${RUN_ID}`,
			runStartedAt: null,
			updatedAt: null,
		} as RunInfo,
		runResult: null as ApiResult<RunInfo> | null,
		artifacts: [
			{
				id: 77,
				name: "dokploy-release",
				expired: false,
				sizeInBytes: 400,
				workflowRunId: RUN_ID,
				workflowRunRepositoryId: REPO_ID,
				workflowRunHeadRepositoryId: REPO_ID,
			},
		] as ArtifactInfo[],
		artifactsResult: null as ApiResult<ArtifactInfo[]> | null,
		zip: buildZip([
			{ name: "dokploy-release.json", data: JSON.stringify(manifest()) },
		]) as Uint8Array,
		policy: {
			customBranchPolicies: true,
			protectedBranches: false,
			policies: [{ name: "dev", type: "branch" }],
		} as EnvironmentPolicy,
		policyResult: null as ApiResult<EnvironmentPolicy> | null,
		head: SHA,
		compare: new Map<string, CompareStatus>(),
		probe: { kind: "ok", digest: DIGEST } as ProbeResult,
		calls: [] as string[],
	};
	const api: ActionsApi = {
		branchHead: async () => ok({ sha: state.head }),
		runAttempt: async () => state.runResult ?? ok(state.run),
		artifacts: async () => state.artifactsResult ?? ok(state.artifacts),
		downloadArtifact: async () => ok(state.zip),
		compare: async (base, head) => {
			state.calls.push(`compare ${base.slice(0, 1)}..${head.slice(0, 1)}`);
			const status = state.compare.get(`${base}...${head}`);
			return status ? ok(status) : { kind: "not-found" };
		},
		environmentPolicy: async () => state.policyResult ?? ok(state.policy),
	};
	const probe: RegistryProbe = {
		headDigest: async () => state.probe,
	};
	return { state, api, probe };
};

const run = (
	w: ReturnType<typeof world>,
	connection: ConnectionFacts = facts(),
	attempt = 1,
) =>
	acceptRelease(
		{ runId: RUN_ID, runAttempt: attempt, connection },
		{ api: w.api, probe: w.probe },
	);

const expectRefused = (
	result: AcceptanceResult,
	code: string,
	block: boolean,
) => {
	expect(result).toMatchObject({ kind: "refused", code, block });
};

const zipOf = (m: unknown) =>
	buildZip([{ name: "dokploy-release.json", data: JSON.stringify(m) }]);

describe("acceptRelease: the happy path", () => {
	it("accepts a clean release and returns only this service's images", async () => {
		const result = await run(world());
		expect(result.kind).toBe("accepted");
		if (result.kind !== "accepted") return;
		expect(result.release).toMatchObject({
			runId: RUN_ID,
			runAttempt: 1,
			sha: SHA,
			delivery: "pull",
			serviceKey: "web",
			environment: "development",
		});
		expect(digestsOf(result.release.images)).toEqual([DIGEST]);
	});

	it("skips the environment check only in confirmed repository-secret mode", async () => {
		const w = world();
		w.state.policy = { customBranchPolicies: false, protectedBranches: false, policies: [] };
		expectRefused(await run(w), "policy-wider", true);
		const relaxed = await run(w, facts({ protectionMode: "repository-secret" }));
		expect(relaxed.kind).toBe("accepted");
	});
});

describe("rule 1: the run", () => {
	it("refuses a run of another workflow file", async () => {
		const w = world();
		w.state.run = { ...w.state.run, path: ".github/workflows/evil.yml" };
		expectRefused(await run(w), "run-path", false);
	});
	it("refuses a run of another branch", async () => {
		const w = world();
		w.state.run = { ...w.state.run, headBranch: "feature/x" };
		expectRefused(await run(w), "run-branch", false);
	});
	it.each(["pull_request", "workflow_run", "schedule", "pull_request_target"])(
		"refuses a %s run",
		async (event) => {
			const w = world();
			w.state.run = { ...w.state.run, event };
			expectRefused(await run(w), "run-event", false);
		},
	);
	it("accepts a manual dispatch", async () => {
		const w = world();
		w.state.run = { ...w.state.run, event: "workflow_dispatch" };
		expect((await run(w)).kind).toBe("accepted");
	});
	it("refuses a run from a fork (another head repository) and a deleted fork", async () => {
		const w = world();
		w.state.run = { ...w.state.run, headRepositoryId: 999 };
		expectRefused(await run(w), "run-repository", false);
		w.state.run = { ...w.state.run, headRepositoryId: null };
		expectRefused(await run(w), "run-repository", false);
	});
	it("waits for a run that has not completed, without deciding", async () => {
		const w = world();
		w.state.run = { ...w.state.run, status: "in_progress", conclusion: null };
		expect(await run(w)).toMatchObject({ kind: "pending" });
	});
	it.each(["failure", "cancelled", "timed_out", null])(
		"refuses a run that concluded %s",
		async (conclusion) => {
			const w = world();
			w.state.run = { ...w.state.run, conclusion };
			expectRefused(await run(w), "run-failed", false);
		},
	);
	it("refuses a run GitHub does not know", async () => {
		const w = world();
		w.state.runResult = { kind: "not-found" };
		expectRefused(await run(w), "run-missing", false);
	});
});

describe("rule 2: the artifact", () => {
	it("refuses a run without the artifact", async () => {
		const w = world();
		w.state.artifacts = [];
		expectRefused(await run(w), "artifact-missing", false);
	});
	it("refuses an artifact with another name", async () => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, name: "other" }));
		expectRefused(await run(w), "artifact-missing", false);
	});
	it("refuses an expired artifact", async () => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, expired: true }));
		expectRefused(await run(w), "artifact-expired", false);
	});
	it.each([
		["another run", { workflowRunId: 1 }],
		["another repository", { workflowRunRepositoryId: 1 }],
		["another head repository", { workflowRunHeadRepositoryId: 1 }],
	])("refuses an artifact uploaded by %s", async (_name, patch) => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, ...patch }));
		expectRefused(await run(w), "artifact-binding", false);
	});
	it("uses the newest artifact when a re-run left two", async () => {
		const w = world();
		const first = w.state.artifacts[0] as ArtifactInfo;
		w.state.artifacts = [first, { ...first, id: 99, expired: true }];
		expectRefused(await run(w), "artifact-expired", false);
	});
	it("refuses an archive that is not a readable zip", async () => {
		const w = world();
		w.state.zip = new Uint8Array(40);
		expectRefused(await run(w), "artifact-unreadable", false);
	});
	it("refuses an oversize listing before downloading", async () => {
		const w = world();
		w.state.artifacts = w.state.artifacts.map((a) => ({ ...a, sizeInBytes: 10_000_000 }));
		expectRefused(await run(w), "artifact-unreadable", false);
	});
});

describe("rule 3: the manifest", () => {
	it("blocks on a manifest that does not parse", async () => {
		const w = world();
		w.state.zip = zipOf({ schema: "dokploy.release/v1" });
		expectRefused(await run(w), "manifest-invalid", true);
	});
	it("blocks on an unknown major schema", async () => {
		const w = world();
		w.state.zip = zipOf(manifest({ schema: "dokploy.release/v2" }));
		expectRefused(await run(w), "manifest-schema", true);
	});
	it("blocks on a migration request in phase 1", async () => {
		const w = world();
		const m = manifest();
		(m.services[0] as Record<string, unknown>).migrations = { command: "x" };
		w.state.zip = zipOf(m);
		expectRefused(await run(w), "manifest-migrations", true);
	});
	it.each([
		["a sha other than the run's head", manifest({ sha: "d".repeat(40) })],
		["another run id", manifest({ source: { forge: "github", ref: "refs/heads/dev", runId: "5", runAttempt: 1 } })],
		["another attempt", manifest({ source: { forge: "github", ref: "refs/heads/dev", runId: String(RUN_ID), runAttempt: 2 } })],
		["another branch", manifest({ source: { forge: "github", ref: "refs/heads/main", runId: String(RUN_ID), runAttempt: 1 } })],
		["another environment", manifest({ environment: "production" })],
	])("blocks on %s", async (_name, m) => {
		const w = world();
		w.state.zip = zipOf(m);
		expectRefused(await run(w), "manifest-binding", true);
	});
	it("ignores a release that does not include this service", async () => {
		const w = world();
		const m = manifest();
		m.release.services = ["worker"];
		(m.services[0] as { key: string }).key = "worker";
		w.state.zip = zipOf(m);
		expect(await run(w)).toMatchObject({ kind: "ignored" });
	});
});

describe("rule 4: the images", () => {
	const withRef = (ref: string) => {
		const m = manifest();
		(m.services[0] as { images: Array<{ ref: string }> }).images[0]!.ref = ref;
		return m;
	};
	it("blocks on an image outside the namespace", async () => {
		const w = world();
		w.state.zip = zipOf(withRef(`evil.example.com/voicekit/web@${DIGEST}`));
		expectRefused(await run(w), "image-namespace", true);
	});
	it("blocks on a preview image, even before the service runs anything", async () => {
		const w = world();
		w.state.zip = zipOf(withRef(`registry.devino.ca/voicekit/preview/pr-1/web@${DIGEST}`));
		expectRefused(await run(w, facts({ currentRepositories: [] })), "image-namespace", true);
	});
	it("blocks on a repository the service does not run", async () => {
		const w = world();
		w.state.zip = zipOf(withRef(`registry.devino.ca/voicekit/other@${DIGEST}`));
		expectRefused(await run(w), "image-repository", true);
	});
	it("blocks when the registry serves another digest, none, or nothing", async () => {
		for (const probe of [
			{ kind: "ok", digest: `sha256:${"1".repeat(64)}` },
			{ kind: "ok", digest: null },
			{ kind: "not-found" },
		] as ProbeResult[]) {
			const w = world();
			w.state.probe = probe;
			expectRefused(await run(w), "image-unverified", true);
		}
	});
	it("retries, without deciding, when the registry cannot be reached", async () => {
		const w = world();
		w.state.probe = { kind: "unreachable", status: 503 };
		expect(await run(w)).toMatchObject({ kind: "retry" });
	});
});

describe("rule 5: the environment policy", () => {
	it.each([
		["every branch", { customBranchPolicies: false, protectedBranches: false, policies: [] }],
		["a second branch", { customBranchPolicies: true, protectedBranches: false, policies: [{ name: "dev", type: "branch" }, { name: "main", type: "branch" }] }],
		["a wildcard", { customBranchPolicies: true, protectedBranches: false, policies: [{ name: "*", type: "branch" }] }],
	])("blocks, and asks again later, when it allows %s", async (_name, policy) => {
		const w = world();
		w.state.policy = policy;
		expect(await run(w)).toMatchObject({
			kind: "refused",
			code: "policy-wider",
			block: true,
			recheck: true,
		});
	});
	it("blocks when the environment does not exist or cannot be read", async () => {
		const missing = world();
		missing.state.policyResult = { kind: "not-found" };
		expect(await run(missing)).toMatchObject({ code: "policy-unreadable", block: true, recheck: true });
		const broken = world();
		broken.state.policyResult = { kind: "error", status: 500 };
		expect(await run(broken)).toMatchObject({ code: "policy-unreadable", block: true });
		const forbidden = world();
		forbidden.state.policyResult = { kind: "forbidden", message: "x" };
		expect(await run(forbidden)).toMatchObject({ code: "policy-unreadable", block: true });
	});
	it("retries, without blocking, on a rate limit or a dead token", async () => {
		const limited = world();
		limited.state.policyResult = { kind: "rate-limited", retryAt: 5 };
		expect(await run(limited)).toMatchObject({ kind: "retry" });
		const dead = world();
		dead.state.policyResult = { kind: "unauthorized" };
		expect(await run(dead)).toMatchObject({ kind: "retry", cause: { kind: "unauthorized" } });
	});
});

describe("rule 6: ordering", () => {
	const deployed = (sha: string, runId = 100) => ({
		sha,
		runId,
		attempt: 1,
		digests: [`sha256:${"9".repeat(64)}`],
	});

	it("refuses a commit that is not on the tracked branch", async () => {
		const w = world();
		w.state.head = "f".repeat(40);
		w.state.compare.set(`${SHA}...${"f".repeat(40)}`, "diverged");
		expectRefused(await run(w), "not-on-branch", false);
	});
	it("accepts an ancestor of the branch head", async () => {
		const w = world();
		w.state.head = "f".repeat(40);
		w.state.compare.set(`${SHA}...${"f".repeat(40)}`, "ahead");
		expect((await run(w)).kind).toBe("accepted");
	});
	it("refuses a release older than the deployed commit", async () => {
		const w = world();
		w.state.compare.set(`${OLD_SHA}...${SHA}`, "behind");
		expectRefused(await run(w, facts({ deployed: deployed(OLD_SHA) })), "ordering-behind", false);
	});
	it("accepts a release newer than the deployed commit", async () => {
		const w = world();
		w.state.compare.set(`${OLD_SHA}...${SHA}`, "ahead");
		expect((await run(w, facts({ deployed: deployed(OLD_SHA) }))).kind).toBe("accepted");
	});
	it("is a no-op when the same commit and digests are already deployed by an earlier run", async () => {
		const w = world();
		const same = { sha: SHA, runId: 100, attempt: 1, digests: [DIGEST] };
		expect((await run(w, facts({ deployed: same }))).kind).toBe("noop");
	});
	it("refuses an older run of the deployed commit", async () => {
		const w = world();
		const later = { sha: SHA, runId: RUN_ID + 1, attempt: 1, digests: [`sha256:${"9".repeat(64)}`] };
		expectRefused(await run(w, facts({ deployed: later })), "ordering-older-run", false);
	});
	it("allows going behind only for an explicit rollback", async () => {
		const w = world();
		w.state.compare.set(`${OLD_SHA}...${SHA}`, "behind");
		const result = await run(w, facts({ deployed: deployed(OLD_SHA), allowBehind: true }));
		expect(result.kind).toBe("accepted");
	});
	it("retries when GitHub cannot answer the compare", async () => {
		const w = world();
		w.api.compare = async () => ({ kind: "rate-limited", retryAt: 9 });
		expect(await run(w, facts({ deployed: deployed(OLD_SHA) }))).toMatchObject({
			kind: "retry",
		});
	});
});

describe("transient failures never decide", () => {
	it.each([
		["rate-limited", { kind: "rate-limited", retryAt: 5 }],
		["unauthorized", { kind: "unauthorized" }],
		["error", { kind: "error", status: 502 }],
	] as const)("a %s run lookup is a retry", async (_name, cause) => {
		const w = world();
		w.state.runResult = cause as ApiResult<RunInfo>;
		expect(await run(w)).toMatchObject({ kind: "retry", cause });
	});
	it("a failing artifact listing is a retry", async () => {
		const w = world();
		w.state.artifactsResult = { kind: "error", status: 500 };
		expect(await run(w)).toMatchObject({ kind: "retry" });
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, `acceptance` does not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/acceptance.ts`**

```ts
import type { ActionsApi, ApiFailure, ApiResult, RunInfo } from "./actions-api";
import { evaluateEnvironmentPolicy } from "./environment-policy";
import {
	MANIFEST_ARTIFACT_NAME,
	MANIFEST_MAX_BYTES,
	type ManifestImage,
	parseReleaseManifest,
} from "./manifest";
import {
	allowedNamespaces,
	checkImageRepository,
	splitRepository,
} from "./namespace";
import { decideOrdering, type ReleaseStamp } from "./ordering";
import type { RegistryProbe } from "./registry-probe";
import { readZipEntry } from "./zip";

/**
 * Should Dokploy deploy what GitHub says was released? The six rules of the
 * design (docs/superpowers/specs/2026-11-03-gha-native-connect-design.md,
 * "Trust model"), in order, over a candidate (run id, attempt) that a GitHub
 * Deployment or a run listing woke us up with:
 *
 *   1. the run: right workflow file, tracked branch, push or manual dispatch,
 *      from this repository, completed with success;
 *   2. the artifact `dokploy-release`: not expired, uploaded by that run;
 *   3. the manifest: parses, names this run and branch, `sha` = the run's head;
 *   4. every image: in the connection's namespace, a repository the service
 *      runs, and served by the registry under the same digest;
 *   5. the environment branch policy still allows only the tracked branch;
 *   6. ordering: on the branch, not older than what is deployed.
 *
 * Nothing in the Deployment itself (payload, creator, description) is trusted.
 * No side effects: the caller writes the result.
 */

export type DeployedStamp = ReleaseStamp;

export interface ConnectionFacts {
	repoId: number;
	workflowPath: string;
	trackedBranch: string;
	environment: string;
	serviceKey: string;
	owner: string;
	repo: string;
	protectionMode: "environment" | "repository-secret";
	registryHost: string | null;
	deployed: DeployedStamp | null;
	/** Repositories the service runs now (empty before its first image). */
	currentRepositories: string[];
	/** True only for an explicit rollback. */
	allowBehind?: boolean;
}

export interface AcceptedRelease {
	runId: number;
	runAttempt: number;
	runUrl: string;
	sha: string;
	releaseId: string;
	delivery: "pull" | "push";
	environment: string;
	serviceKey: string;
	images: ManifestImage[];
	composePath: string | null;
	releaseServices: string[];
}

export type RefusalCode =
	| "run-missing"
	| "run-path"
	| "run-branch"
	| "run-event"
	| "run-repository"
	| "run-failed"
	| "artifact-missing"
	| "artifact-expired"
	| "artifact-binding"
	| "artifact-unreadable"
	| "manifest-invalid"
	| "manifest-schema"
	| "manifest-migrations"
	| "manifest-binding"
	| "image-namespace"
	| "image-repository"
	| "image-unverified"
	| "policy-wider"
	| "policy-unreadable"
	| "not-on-branch"
	| "ordering-behind"
	| "ordering-lower-attempt"
	| "ordering-older-run";

/**
 * Refusals that happen only AFTER the run and its artifact are proven to be
 * this connection's own release run on the tracked branch. Those mean the
 * release itself is broken (or the setup drifted), so the service shows
 * Blocked. Everything before that point can be provoked by anyone who may
 * create a GitHub Deployment, so it is answered on the Deployment and logged,
 * and never blocks the service.
 */
const BLOCKING: ReadonlySet<RefusalCode> = new Set([
	"manifest-invalid",
	"manifest-schema",
	"manifest-migrations",
	"manifest-binding",
	"image-namespace",
	"image-repository",
	"image-unverified",
	"policy-wider",
	"policy-unreadable",
]);

export type AcceptanceResult =
	/** The run has not completed yet; ask again on a later tick. */
	| { kind: "pending"; reason: string }
	/** GitHub or the registry could not answer; nothing was decided. */
	| { kind: "retry"; cause: ApiFailure }
	/** The run is a release of other services only. */
	| { kind: "ignored"; reason: string }
	| {
			kind: "refused";
			code: RefusalCode;
			message: string;
			/** The service shows Blocked. */
			block: boolean;
			/** Fixing GitHub (not re-running) can clear it: the caller asks again later and does not record the run as handled. */
			recheck: boolean;
	  }
	/** Accepted, and it changes nothing (same digests as deployed). */
	| { kind: "noop"; release: AcceptedRelease }
	| { kind: "accepted"; release: AcceptedRelease };

const RECHECK: ReadonlySet<RefusalCode> = new Set([
	"policy-wider",
	"policy-unreadable",
]);

const refuse = (code: RefusalCode, message: string): AcceptanceResult => ({
	kind: "refused",
	code,
	message,
	block: BLOCKING.has(code),
	recheck: RECHECK.has(code),
});

type Step<T> = { ok: true; value: T } | { ok: false; result: AcceptanceResult };

const needs = <T>(
	result: ApiResult<T>,
	onMissing: AcceptanceResult,
): Step<T> => {
	if (result.kind === "ok") return { ok: true, value: result.value };
	if (result.kind === "not-found") return { ok: false, result: onMissing };
	return { ok: false, result: { kind: "retry", cause: result } };
};

export const digestsOf = (images: ManifestImage[]): string[] =>
	images.map((image) => image.digest).sort();

export const acceptRelease = async (
	input: {
		runId: number;
		runAttempt: number;
		connection: ConnectionFacts;
	},
	deps: { api: ActionsApi; probe: RegistryProbe },
): Promise<AcceptanceResult> => {
	const { runId, runAttempt, connection: c } = input;
	const { api, probe } = deps;

	// Rule 1: the run.
	const runStep = needs(
		await api.runAttempt(runId, runAttempt),
		refuse("run-missing", "GitHub has no such run attempt"),
	);
	if (!runStep.ok) return runStep.result;
	const run: RunInfo = runStep.value;
	if (run.path !== c.workflowPath) {
		return refuse("run-path", `The run belongs to ${run.path || "another workflow"}`);
	}
	if (run.headBranch !== c.trackedBranch) {
		return refuse("run-branch", "The run is not on the tracked branch");
	}
	if (run.event !== "push" && run.event !== "workflow_dispatch") {
		return refuse("run-event", `A ${run.event || "unknown"} run is never released`);
	}
	if (run.repositoryId !== c.repoId || run.headRepositoryId !== c.repoId) {
		return refuse("run-repository", "The run comes from another repository");
	}
	if (run.status !== "completed") {
		return { kind: "pending", reason: `The run is ${run.status}` };
	}
	if (run.conclusion !== "success") {
		return refuse("run-failed", `The run concluded ${run.conclusion ?? "without a result"}`);
	}

	// Rule 2: the artifact.
	const listing = needs(
		await api.artifacts(runId, MANIFEST_ARTIFACT_NAME),
		refuse("artifact-missing", "The run has no release artifact"),
	);
	if (!listing.ok) return listing.result;
	const artifact = listing.value
		.filter((a) => a.name === MANIFEST_ARTIFACT_NAME)
		.sort((a, b) => b.id - a.id)[0];
	if (!artifact) {
		return refuse("artifact-missing", "The run has no release artifact");
	}
	if (artifact.expired) {
		return refuse("artifact-expired", "The release artifact has expired");
	}
	if (
		artifact.workflowRunId !== runId ||
		artifact.workflowRunRepositoryId !== c.repoId ||
		artifact.workflowRunHeadRepositoryId !== c.repoId
	) {
		return refuse(
			"artifact-binding",
			"The release artifact was not uploaded by this run of this repository",
		);
	}
	if (artifact.sizeInBytes > 2 * MANIFEST_MAX_BYTES) {
		return refuse("artifact-unreadable", "The release artifact is too large");
	}
	const downloaded = needs(
		await api.downloadArtifact(artifact.id, 2 * MANIFEST_MAX_BYTES),
		refuse("artifact-expired", "The release artifact is gone"),
	);
	if (!downloaded.ok) return downloaded.result;
	const entry = readZipEntry(
		downloaded.value,
		`${MANIFEST_ARTIFACT_NAME}.json`,
		MANIFEST_MAX_BYTES,
	);
	if (!entry.ok) return refuse("artifact-unreadable", entry.reason);

	// Rule 3: the manifest.
	const parsed = parseReleaseManifest(entry.bytes.toString("utf8"));
	if (!parsed.ok) {
		return refuse(
			parsed.code === "unknown-schema"
				? "manifest-schema"
				: parsed.code === "migrations-unsupported"
					? "manifest-migrations"
					: "manifest-invalid",
			parsed.message,
		);
	}
	const manifest = parsed.manifest;
	if (
		manifest.sha !== run.headSha ||
		manifest.source.runId !== String(runId) ||
		manifest.source.runAttempt !== runAttempt ||
		manifest.source.ref !== `refs/heads/${c.trackedBranch}` ||
		manifest.environment !== c.environment
	) {
		return refuse(
			"manifest-binding",
			"The manifest does not describe this run, commit, branch and environment",
		);
	}
	const service = manifest.services.find((s) => s.key === c.serviceKey);
	if (!service) {
		return {
			kind: "ignored",
			reason: `The release does not include ${c.serviceKey}`,
		};
	}

	// Rule 4: the images.
	const namespaces = allowedNamespaces({
		owner: c.owner,
		repo: c.repo,
		registryHost: c.registryHost,
	});
	for (const image of service.images) {
		const checked = checkImageRepository({
			repository: image.repository,
			namespaces,
			currentRepositories: c.currentRepositories,
		});
		if (!checked.ok) return refuse(checked.code, checked.message);
	}
	for (const image of service.images) {
		const parts = splitRepository(image.repository);
		if (!parts) {
			return refuse("image-namespace", `${image.repository} has no registry host`);
		}
		const head = await probe.headDigest({
			host: parts.host,
			name: parts.name,
			digest: image.digest,
		});
		if (head.kind === "unreachable") {
			return {
				kind: "retry",
				cause: { kind: "error", status: head.status },
			};
		}
		if (head.kind === "not-found" || head.digest !== image.digest) {
			return refuse(
				"image-unverified",
				`The registry does not serve ${image.repository}@${image.digest.slice(0, 19)}`,
			);
		}
	}

	// Rule 5: the environment's deployment branch policy.
	if (c.protectionMode === "environment") {
		const policy = needs(
			await api.environmentPolicy(c.environment),
			refuse(
				"policy-unreadable",
				`The GitHub environment ${c.environment} does not exist`,
			),
		);
		if (!policy.ok) {
			// A read error is never a downgrade. GitHub being unable to answer at
			// all (rate limit, dead token) is a retry; any other failure refuses.
			const failed = policy.result;
			if (
				failed.kind === "retry" &&
				failed.cause.kind !== "rate-limited" &&
				failed.cause.kind !== "unauthorized"
			) {
				return refuse(
					"policy-unreadable",
					"GitHub would not show the deployment branch policy of the environment",
				);
			}
			return failed;
		}
		const verdict = evaluateEnvironmentPolicy(policy.value, c.trackedBranch);
		if (!verdict.ok) return refuse("policy-wider", verdict.message);
	}

	// Rule 6: ordering.
	const head = needs(
		await api.branchHead(c.trackedBranch),
		refuse("not-on-branch", "The tracked branch no longer exists"),
	);
	if (!head.ok) return head.result;
	let reachable = manifest.sha === head.value.sha;
	if (!reachable) {
		const toHead = needs(
			await api.compare(manifest.sha, head.value.sha),
			refuse("not-on-branch", "The release commit is unknown to GitHub"),
		);
		if (!toHead.ok) return toHead.result;
		reachable = toHead.value === "ahead" || toHead.value === "identical";
	}
	let deployedToCandidate = null;
	if (c.deployed && c.deployed.sha !== manifest.sha) {
		const compared = needs(
			await api.compare(c.deployed.sha, manifest.sha),
			refuse("not-on-branch", "The deployed commit is unknown to GitHub"),
		);
		if (!compared.ok) return compared.result;
		deployedToCandidate = compared.value;
	}
	const order = decideOrdering({
		deployed: c.deployed,
		candidate: {
			sha: manifest.sha,
			runId,
			attempt: runAttempt,
			digests: digestsOf(service.images),
		},
		deployedToCandidate,
		reachableFromBranch: reachable,
		allowBehind: c.allowBehind === true,
	});
	if (!order.accept) return refuse(order.code, order.message);

	const release: AcceptedRelease = {
		runId,
		runAttempt,
		runUrl: run.htmlUrl,
		sha: manifest.sha,
		releaseId: manifest.releaseId,
		delivery: manifest.delivery,
		environment: manifest.environment,
		serviceKey: c.serviceKey,
		images: service.images,
		composePath: service.composePath,
		releaseServices: manifest.releaseServices,
	};
	return order.noop ? { kind: "noop", release } : { kind: "accepted", release };
};
```

- [ ] **Step 4: Run the whole suite**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect`
Expected: PASS.

- [ ] **Step 5: Extend the barrel**

Append to `packages/server/src/services/gha-connect/index.ts`:

```ts
export * from "./acceptance";
export * from "./manifest";
export * from "./registry-probe";
export * from "./wake-payload";
export * from "./zip";
```

- [ ] **Step 6: Typecheck, commit, push, open the PR**

```bash
pnpm -r run typecheck
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: acceptance engine for GitHub Actions releases (T-13719)"
git push -u origin feat/gha-connect-acceptance
gh pr create --repo DevinoSolutions/dokploy-community --base canary --title "feat: acceptance engine for GitHub Actions releases (T-13719)" --body "Phase 1 PR 3 (spec docs/superpowers/specs/2026-11-03-gha-native-connect-design.md, Trust model). Pure: run, artifact, manifest, registry digest, environment policy and ordering checks, with the dokploy-release fixtures vendored and hash-pinned. Nothing calls it yet."
```

- [ ] **Step 7: Review gate**

One review of the PR head (opus5-worker at high effort), asked to try to break acceptance: a Deployment naming a run of a pull request, a fork's run, another repository's run, an expired or foreign artifact, a manifest sha that differs from the run, a digest in another namespace or under `preview/`, a registry that answers a different digest, a wider environment policy, an older commit, and a spammed Deployment that must not block the connection.

- [ ] **Step 8: Manual proof for the lead**

None: there is no runtime path yet. The fixtures and the rule tests are the proof; PR 4 exercises the engine against a real repository.

## PR 4: The poller

**Branch:** `feat/gha-connect-poller` from the PR 3 branch (or canary once PR 2 and PR 3 merged). **Migration:** none.

This is the PR that makes a connection do something. In order: the safety net first (#577's poll core refactored under its own 42 passing tests), the small pure helpers (stale, cadence, environment URL, multi-image pinning), the connection poll, the upkeep (rename, Stale, live runs), then the wiring in the app layer (release start with the source flip and multi-image pin, per-watch dispatch, status URLs, release settlement). The tick keeps #577's guarantees: one Deployment is started at most once (cursor and in-flight mark in one transaction), nothing is enqueued before the commit, and an enqueue failure puts everything back.

A connection's tick, in words: skip until due (20 seconds, 120 after a day idle); check the token (revoked means Disconnected, restored means back); upkeep at most every two minutes (repository by id, branch head, workflow runs, compare, workflow file) giving Stale or Fresh, a rename, and the queued or running runs for live rows; then #577's `prepareTick` (gates, in-flight, list, baseline). For each new Deployment: ignore any whose task is not `dokploy:<this key>`; mark unreadable payloads; skip runs already handled; verify at most 5 runs per tick, newest first, with `acceptRelease`; answer the Deployment (failure for a refusal, success for a verified push or an already-deployed release, `queued` text while waiting); start only the newest accepted pull release; older ones are superseded. Handled runs are saved before anything starts, so a crash replays nothing. A rejected pull release is not recorded as handled, so a failed start is retried.

**Files:**
- Modify: `packages/server/src/services/github-deployments/{poll-core,github-api,payload,service-image}.ts`
- Create: `packages/server/src/services/gha-connect/{stale,poll-cadence,environment-url,poll,upkeep}.ts`; modify `index.ts`
- Create: `apps/dokploy/server/queues/gha-connection-deps.ts`; modify `apps/dokploy/server/queues/github-deployments-poller.ts`, `apps/dokploy/server/api/routers/gha-connection.ts`
- Tests: `apps/dokploy/__test__/gha-connect/{pure-helpers,poll,upkeep,poller-release}.test.ts`; unchanged and still passing: `apps/dokploy/__test__/github-deployments/*`

### Task 4.1: Refactor #577's poll core under its own tests

`pollWatch` becomes three exported pieces with identical behavior: `prepareTick` (gates, the deployment on its way, the list, the baseline), `handleFresh` (answer every new Deployment, start the target) and the shared helpers `connectionKey`, `watchKey`, `postStatus` (now taking an optional environment URL and sending `auto_inactive: false` for connection watches), `reportEnd`, `EndState`. `WatchRow` gains an optional `ghaConnectionId`, `PollDeps` gains optional `environmentUrl` and `onDeployEnded` (called before GitHub is told, repeatable). Plain watches never set them, so nothing changes for #577's users.

- [ ] **Step 1: Confirm the safety net is green before touching anything**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/github-deployments`
Expected: PASS (#577's suites, 42 tests in `poll-core.test.ts`).

- [ ] **Step 2: Apply the poll core refactor**

The diff below is against #577 head `7a4c11d0`. If #577 moved during its review and `git apply` refuses it, make the same edits by hand: each hunk is one of the exports named in the paragraph above, and the safety net in step 3 shows whether you got it right.

**`packages/server/src/services/github-deployments/poll-core.ts`** (a diff against the #577 head, apply it with `git apply` or make the same edits)

```diff
--- a/packages/server/src/services/github-deployments/poll-core.ts
+++ b/packages/server/src/services/github-deployments/poll-core.ts
@@ -4,6 +4,7 @@
 	createDeploymentStatus,
 	type DeploymentState,
 	type GithubDeployment,
+	type ListResult,
 	listDeployments,
 } from "./github-api";
 import { type ParsedPayload, parseDeploymentPayload } from "./payload";
@@ -45,6 +46,8 @@
 	inflightStartedAt: Date | null;
 	/** Opt in to sending this Dokploy's dashboard link to GitHub as `log_url`. Off by default. */
 	postLogUrl: boolean;
+	/** Set when a gha_connection owns this watch (native GitHub Actions connection); absent for a plain watch. */
+	ghaConnectionId?: string | null;
 }
 
 export type DeployPayload = Extract<ParsedPayload, { kind: "deploy" }>;
@@ -103,14 +106,22 @@
 		payload: DeployPayload,
 	) => Promise<StartOutcome>;
 	inspectInflight: (watch: WatchRow) => Promise<InflightState>;
+	/** Connection watches only: the link GitHub shows on a successful deployment. */
+	environmentUrl?: (watch: WatchRow) => Promise<string | undefined>;
+	/**
+	 * Connection watches only: the Dokploy deployment ended. Called before
+	 * GitHub is told, and again when telling GitHub has to be retried, so it
+	 * must be safe to repeat.
+	 */
+	onDeployEnded?: (watch: WatchRow, end: EndState) => Promise<void>;
 	log: (message: string) => void;
 }
 
 const startAttempts = new Map<string, number>();
 const statusAttempts = new Map<string, number>();
 
-const connectionKey = (connectionId: string) => `connection:${connectionId}`;
-const watchKey = (watchId: string) => `watch:${watchId}`;
+export const connectionKey = (connectionId: string) => `connection:${connectionId}`;
+export const watchKey = (watchId: string) => `watch:${watchId}`;
 
 /** New deployments, oldest first: ids above lastSeen, in id order. */
 export const selectNewDeployments = (
@@ -168,6 +179,12 @@
 		"Superseded by a newer deployment; Dokploy deployed the newest only",
 	serviceGone:
 		"The Dokploy service was removed before this deployment finished",
+	// Native GitHub Actions connection (gha_connection): fixed text only, like the rest.
+	waiting: "Dokploy is waiting for the run to finish",
+	verifiedPush: "Dokploy verified this release; the workflow deployed it",
+	alreadyDeployed: "Dokploy already runs this release",
+	refused: "Dokploy refused this release; see the Dokploy dashboard",
+	runFailed: "The run did not succeed, so Dokploy released nothing",
 } as const;
 
 const statusRetryDelay = (attempts: number) =>
@@ -197,7 +214,7 @@
  *   backs off (30s, 60s, ... capped at 5 min) and after MAX_STATUS_ATTEMPTS the
  *   status is given up, so the watch is not stuck on it; `problem` says so.
  */
-const postStatus = async (
+export const postStatus = async (
 	deps: PollDeps,
 	watch: WatchRow,
 	token: string,
@@ -205,6 +222,7 @@
 	state: DeploymentState,
 	description: string,
 	logUrl?: string,
+	environmentUrl?: string,
 ): Promise<Settled> => {
 	const result = await createDeploymentStatus(deps, {
 		token,
@@ -215,6 +233,10 @@
 		description,
 		// Opt in per watch: the dashboard link is internal.
 		logUrl: watch.postLogUrl ? logUrl : undefined,
+		// A connection's statuses are the record of every release: a newer
+		// status must not flip an older deployment to inactive on its own.
+		...(watch.ghaConnectionId ? { autoInactive: false } : {}),
+		...(environmentUrl ? { environmentUrl } : {}),
 	});
 	const key = `${watch.watchId}:${deploymentId}:${state}`;
 	if (result.ok) {
@@ -244,13 +266,13 @@
 	return { settled: false };
 };
 
-type EndState =
+export type EndState =
 	| Exclude<InflightState, { state: "running" } | { state: "missing" }>
 	| { state: "timeout" }
 	| { state: "lost" };
 
 /** Report the end of a Dokploy deployment to GitHub. */
-const reportEnd = async (
+export const reportEnd = async (
 	deps: PollDeps,
 	watch: WatchRow,
 	token: string,
@@ -263,6 +285,10 @@
 		timeout: STATUS_TEXT.timeout,
 		lost: STATUS_TEXT.lost,
 	} as const;
+	const environmentUrl =
+		inflight.state === "done" && watch.ghaConnectionId
+			? await deps.environmentUrl?.(watch).catch(() => undefined)
+			: undefined;
 	return postStatus(
 		deps,
 		watch,
@@ -271,6 +297,7 @@
 		inflight.state === "done" ? "success" : "failure",
 		text[inflight.state],
 		"logUrl" in inflight ? inflight.logUrl : undefined,
+		environmentUrl,
 	);
 };
 
@@ -317,16 +344,31 @@
 	}
 };
 
-const pollWatchInner = async (
+/** What a tick has in hand once the gates, the in-flight deployment and the list are dealt with. */
+export interface TickInput {
+	token: string;
+	now: number;
+	listed: Extract<ListResult, { kind: "ok" }>;
+	/** The cursor, known by now: the first poll only baselines it. */
+	lastSeen: number;
+}
+
+/**
+ * Steps 1 to 3 of a tick, shared by every kind of watch: gates and back-off,
+ * the token, the deployment that is on its way (its end is reported to
+ * GitHub), the list of deployments and the first-poll baseline. Resolves to
+ * null when there is nothing more to do this tick.
+ */
+export const prepareTick = async (
 	watch: WatchRow,
 	deps: PollDeps,
-): Promise<void> => {
-	if (!watch.enabled) return;
+): Promise<TickInput | null> => {
+	if (!watch.enabled) return null;
 	const now = deps.now();
 	const watchBlock = deps.blockedUntil(watchKey(watch.watchId));
-	if (watchBlock !== undefined && watchBlock > now) return;
+	if (watchBlock !== undefined && watchBlock > now) return null;
 	const connBlock = deps.blockedUntil(connectionKey(watch.connectionId));
-	if (connBlock !== undefined && connBlock > now) return;
+	if (connBlock !== undefined && connBlock > now) return null;
 
 	const token = await deps.loadToken(watch.connectionId);
 	if (!token) {
@@ -335,7 +377,7 @@
 				"The GitHub connection is missing or was revoked. Connect GitHub again.",
 		});
 		deps.block(watchKey(watch.watchId), now + WATCH_ERROR_BACKOFF_MS);
-		return;
+		return null;
 	}
 
 	// 1. A deployment is on its way: report its end, and take nothing new meanwhile.
@@ -351,7 +393,8 @@
 		} else {
 			end = state;
 		}
-		if (!end) return;
+		if (!end) return null;
+		if (watch.ghaConnectionId) await deps.onDeployEnded?.(watch, end);
 		const reported = await reportEnd(deps, watch, token, end);
 		if (reported.settled) {
 			await deps.patchWatch(watch.watchId, {
@@ -360,7 +403,7 @@
 				lastError: reported.problem ?? null,
 			});
 		}
-		return;
+		return null;
 	}
 
 	// 2. Look for new deployments (a 304 costs no rate limit).
@@ -379,16 +422,16 @@
 				{ lastCheckedAt: new Date(now), lastError: null },
 				{ ifCursor: watch.lastSeenDeploymentId },
 			);
-			return;
+			return null;
 		case "rate-limited":
 			deps.block(connectionKey(watch.connectionId), listed.retryAt);
 			deps.log(
 				`github deployments: rate limited, pausing connection ${watch.connectionId} for ${Math.ceil((listed.retryAt - now) / 1000)}s`,
 			);
-			return;
+			return null;
 		case "unauthorized":
 			await deps.markRevoked(watch.connectionId);
-			return;
+			return null;
 		case "forbidden":
 		case "not-found":
 			await deps.patchWatch(watch.watchId, {
@@ -398,13 +441,13 @@
 						: listed.message,
 			});
 			deps.block(watchKey(watch.watchId), now + WATCH_ERROR_BACKOFF_MS);
-			return;
+			return null;
 		case "error":
 			await deps.patchWatch(watch.watchId, {
 				lastError: `GitHub answered with an error${listed.status ? ` (HTTP ${listed.status})` : ""}.`,
 			});
 			deps.block(watchKey(watch.watchId), now + POLL_INTERVAL_MS * 3);
-			return;
+			return null;
 		case "ok":
 			break;
 	}
@@ -421,30 +464,66 @@
 			},
 			{ ifCursor: null },
 		);
-		return;
+		return null;
 	}
+	return { token, now, listed, lastSeen: watch.lastSeenDeploymentId };
+};
 
-	// 4. New ones, oldest first. Only the NEWEST valid deployment for this
-	// service is deployed; every older valid one is answered as superseded so
-	// no workflow waits on it. Deployments of other services are left alone.
-	const fresh = selectNewDeployments(
-		listed.deployments,
-		watch.lastSeenDeploymentId,
-	);
-	const parsedById = new Map(
-		fresh.map((d) => [
-			d.id,
-			parseDeploymentPayload(d.payload, watch.serviceId),
-		]),
+/**
+ * What step 4 does with one new deployment.
+ * - ignore: not for this watch (never answered).
+ * - invalid: for this watch but refused; answered with a failure (`statusText` or the default).
+ * - deploy: a release to start.
+ * - superseded: valid, but a newer one is deployed instead; answered inactive.
+ * - hold: not decidable yet (a run still building); nothing at or after it moves this tick.
+ */
+export type Classified =
+	| { kind: "ignore"; reason: string }
+	| { kind: "invalid"; reason: string; statusText?: string }
+	| Extract<ParsedPayload, { kind: "deploy" }>
+	| { kind: "superseded" }
+	| { kind: "hold"; reason: string };
+
+const pollWatchInner = async (
+	watch: WatchRow,
+	deps: PollDeps,
+): Promise<void> => {
+	const tick = await prepareTick(watch, deps);
+	if (!tick) return;
+	const fresh = selectNewDeployments(tick.listed.deployments, tick.lastSeen);
+	const classified = new Map<number, Classified>(
+		fresh.map((d) => [d.id, parseDeploymentPayload(d.payload, watch.serviceId)]),
 	);
+
+	// Only the NEWEST valid deployment for this service is deployed; every older
+	// valid one is answered as superseded so no workflow waits on it.
+	// Deployments of other services are left alone.
 	let targetId: number | undefined;
 	for (const d of fresh) {
-		if (parsedById.get(d.id)?.kind === "deploy") targetId = d.id;
+		if (classified.get(d.id)?.kind === "deploy") targetId = d.id;
 	}
+	await handleFresh(watch, deps, tick, fresh, classified, targetId);
+};
+
+/**
+ * Step 4 of a tick: walk the new deployments oldest first, answer each one
+ * and start the target. Shared by plain watches (classified from the payload)
+ * and connection watches (classified by checking the run and its artifact).
+ */
+export const handleFresh = async (
+	watch: WatchRow,
+	deps: PollDeps,
+	tick: TickInput,
+	fresh: GithubDeployment[],
+	classified: Map<number, Classified>,
+	targetId: number | undefined,
+): Promise<void> => {
+	const { token, now, listed } = tick;
+	const parsedById = classified;
 	/** What the dashboard keeps showing from this pass, if anything. */
 	let problem: string | null = null;
 	/** Where the stored cursor stands in this pass (startDeploy checks it against the locked row). */
-	let cursor = watch.lastSeenDeploymentId;
+	let cursor: number | null = tick.lastSeen;
 	/**
 	 * Compare-and-set on the cursor this pass started from: false means the
 	 * watch was reset (disabled and enabled again, or repointed) since the poll
@@ -467,6 +546,13 @@
 			if (!(await advance(deployment.id))) return;
 			continue;
 		}
+		if (parsed.kind === "hold") {
+			await deps.patchWatch(watch.watchId, {
+				lastCheckedAt: new Date(now),
+				lastError: short(parsed.reason, 200),
+			});
+			return;
+		}
 		if (parsed.kind === "invalid") {
 			const answered = await postStatus(
 				deps,
@@ -474,14 +560,14 @@
 				token,
 				deployment.id,
 				"failure",
-				STATUS_TEXT.unreadable,
+				parsed.statusText ?? STATUS_TEXT.unreadable,
 			);
 			if (!answered.settled) return;
 			problem = `Deployment #${deployment.id}: ${short(parsed.reason, 200)}`;
 			if (!(await advance(deployment.id))) return;
 			continue;
 		}
-		if (deployment.id !== targetId) {
+		if (parsed.kind === "superseded" || deployment.id !== targetId) {
 			const answered = await postStatus(
 				deps,
 				watch,
@@ -501,7 +587,7 @@
 			outcome = await deps.startDeploy(
 				{ ...watch, lastSeenDeploymentId: cursor },
 				deployment,
-				parsed,
+				parsed as DeployPayload,
 			);
 		} catch (error) {
 			const attempts = (startAttempts.get(attemptKey) ?? 0) + 1;
```

- [ ] **Step 3: Re-run the safety net**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/github-deployments/poll-core.test.ts __test__/github-deployments/poller-wiring.test.ts`
Expected: PASS with no change to those test files. If one fails, the refactor changed behavior: fix the code, never the test.

- [ ] **Step 4: Apply the three small edits to #577's other files**

`createDeploymentStatus` can send `environment_url` and `auto_inactive: false`, and `GithubDeployment` carries `ref` and `task` (the wake-up filter reads the task). The deploy payload variant carries the extra images and the release context a connection start records.

**`packages/server/src/services/github-deployments/github-api.ts`** (a diff against the #577 head, apply it with `git apply` or make the same edits)

```diff
--- a/packages/server/src/services/github-deployments/github-api.ts
+++ b/packages/server/src/services/github-deployments/github-api.ts
@@ -18,6 +18,9 @@
 export interface GithubDeployment {
 	id: number;
 	sha?: string;
+	ref?: string;
+	/** `deploy` for a plain Deployment; `dokploy:<key>` for a release wake-up (native GitHub Actions connection). */
+	task?: string;
 	environment?: string;
 	payload?: unknown;
 	creator?: { login?: string } | null;
@@ -215,6 +218,10 @@
 		state: DeploymentState;
 		description: string;
 		logUrl?: string;
+		/** Shown by GitHub as the link of a successful deployment. */
+		environmentUrl?: string;
+		/** False keeps a newer status from flipping older deployments to inactive. */
+		autoInactive?: boolean;
 	},
 ): Promise<StatusResult> => {
 	if (isDotSegment(args.owner) || isDotSegment(args.repo)) {
@@ -230,6 +237,10 @@
 				state: args.state,
 				description: clampDescription(args.description),
 				...(args.logUrl ? { log_url: args.logUrl } : {}),
+				...(args.environmentUrl
+					? { environment_url: args.environmentUrl }
+					: {}),
+				...(args.autoInactive === false ? { auto_inactive: false } : {}),
 			}),
 		});
 	} catch {
```

**`packages/server/src/services/github-deployments/payload.ts`** (a diff against the #577 head, apply it with `git apply` or make the same edits)

```diff
--- a/packages/server/src/services/github-deployments/payload.ts
+++ b/packages/server/src/services/github-deployments/payload.ts
@@ -26,8 +26,25 @@
 			digest: string;
 			/** A github.com Actions run link, when the workflow sent a valid one. */
 			buildRunUrl?: string;
+			/** More images of the same release (a compose file with several built images). */
+			extraImages?: Array<{ repository: string; digest: string }>;
+			/** Set by a native GitHub Actions connection: the release this deploy is for. */
+			release?: ReleaseContext;
 	  };
 
+/** What a deploy started by a native GitHub Actions connection records about its release. */
+export interface ReleaseContext {
+	connectionId: string;
+	serviceKey: string;
+	/** `release.id` of the manifest. */
+	manifestReleaseId: string;
+	sha: string;
+	runId: number;
+	runAttempt: number;
+	delivery: "pull" | "push";
+	images: Array<{ name: string; composeService: string; ref: string }>;
+}
+
 const asObject = (value: unknown): Record<string, unknown> | null =>
 	value !== null && typeof value === "object" && !Array.isArray(value)
 		? (value as Record<string, unknown>)
```

**`packages/server/src/services/github-deployments/service-image.ts`** (a diff against the #577 head, apply it with `git apply` or make the same edits)

```diff
--- a/packages/server/src/services/github-deployments/service-image.ts
+++ b/packages/server/src/services/github-deployments/service-image.ts
@@ -111,3 +111,50 @@
 		changed: true,
 	};
 };
+
+/**
+ * Pin several images of one compose file (a release that built more than one
+ * image). Every repository must appear on exactly one `image:` line, as for
+ * `pinComposeImage`, and each repository may be named once.
+ */
+export const pinComposeImages = (
+	composeFile: string,
+	images: Array<{ repository: string; digest: string }>,
+): ComposePin => {
+	const seen = new Set<string>();
+	let file = composeFile;
+	let changed = false;
+	let previousDigest = "";
+	for (const image of images) {
+		const key = lower(image.repository);
+		if (seen.has(key)) {
+			return {
+				ok: false,
+				reason: `The release names ${image.repository} twice.`,
+			};
+		}
+		seen.add(key);
+		const pinned = pinComposeImage(file, image.repository, image.digest);
+		if (!pinned.ok) return pinned;
+		file = pinned.composeFile;
+		changed = changed || pinned.changed;
+		if (previousDigest === "") previousDigest = pinned.previousDigest;
+	}
+	return { ok: true, composeFile: file, previousDigest, changed };
+};
+
+/**
+ * The repositories a compose file pins by digest (`image: <repository>@sha256:...`),
+ * each once. Before the first release there are none.
+ */
+export const listPinnedComposeRepositories = (composeFile: string): string[] => {
+	const line =
+		/^[ \t]*(?:-[ \t]*)?image:[ \t]*["']?([^\s"'#@]+)@sha256:[0-9a-f]{64}(?=["'\s#]|$)/gm;
+	return [
+		...new Set(
+			[...composeFile.matchAll(line)].map((match) =>
+				repositoryOfReference(match[1] as string),
+			),
+		),
+	];
+};
```

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/github-deployments
git add packages/server/src/services/github-deployments
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "refactor: split the GitHub Deployments tick so a connection can reuse it (T-13719)"
```

### Task 4.2: Stale, cadence, environment URL and multi-image pinning (pure)

`evaluateStale` implements the spec's Stale rule: the head advanced, a run of the workflow exists for it, and no release arrived within the larger of 15 minutes and twice the median of the last five runs, counted from that run's end; a run queued over 30 minutes means no runner; a deleted or renamed branch, a deployed commit off the branch and a removed workflow file are Stale too; a push that triggers no run never is. `intervalFor` and `isDue` are the polling cadence. `pickEnvironmentUrl` chooses the link GitHub shows next to a successful Deployment. `pinComposeImages` and `listPinnedComposeRepositories` serve compose stacks with several built images.

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/pure-helpers.test.ts`**

```ts
import { pickEnvironmentUrl } from "@dokploy/server/services/gha-connect/environment-url";
import {
	ACTIVE_INTERVAL_MS,
	IDLE_AFTER_MS,
	IDLE_INTERVAL_MS,
	intervalFor,
	isDue,
} from "@dokploy/server/services/gha-connect/poll-cadence";
import {
	evaluateStale,
	STALE_MIN_TOLERANCE_MS,
	STALE_QUEUE_LIMIT_MS,
	type StaleInput,
	type StaleRun,
} from "@dokploy/server/services/gha-connect/stale";
import { createDeploymentStatus } from "@dokploy/server/services/github-deployments/github-api";
import {
	listPinnedComposeRepositories,
	pinComposeImages,
} from "@dokploy/server/services/github-deployments/service-image";
import { describe, expect, it } from "vitest";
import { routedFetch } from "./gha-helpers";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("pinComposeImages", () => {
	const compose = [
		"services:",
		"  web:",
		`    image: registry.devino.ca/shorty/web@${D("1")}`,
		"  docs:",
		`    image: "registry.devino.ca/shorty/docs@${D("2")}"`,
		"  db:",
		"    image: postgres:16",
		"",
	].join("\n");

	it("moves every named image to its new digest and touches nothing else", () => {
		const result = pinComposeImages(compose, [
			{ repository: "registry.devino.ca/shorty/web", digest: D("a") },
			{ repository: "registry.devino.ca/shorty/docs", digest: D("b") },
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.changed).toBe(true);
		expect(result.composeFile).toBe(
			compose.replace(D("1"), D("a")).replace(D("2"), D("b")),
		);
	});

	it("reports no change when the digests are already pinned", () => {
		const result = pinComposeImages(compose, [
			{ repository: "registry.devino.ca/shorty/web", digest: D("1") },
		]);
		expect(result).toMatchObject({ ok: true, changed: false });
	});

	it("refuses a repository the file does not pin, and a repository named twice", () => {
		expect(
			pinComposeImages(compose, [
				{ repository: "registry.devino.ca/shorty/other", digest: D("a") },
			]),
		).toMatchObject({ ok: false });
		expect(
			pinComposeImages(compose, [
				{ repository: "registry.devino.ca/shorty/web", digest: D("a") },
				{ repository: "Registry.Devino.CA/shorty/web", digest: D("b") },
			]),
		).toMatchObject({ ok: false, reason: expect.stringContaining("twice") });
	});
});

describe("listPinnedComposeRepositories", () => {
	it("lists each digest-pinned repository once and skips tags", () => {
		const compose = [
			"services:",
			"  web:",
			`    image: registry.devino.ca/shorty/web@${D("1")}`,
			"  worker:",
			`    image: "registry.devino.ca/shorty/web@${D("2")}"`,
			"  docs:",
			`  - image: registry.devino.ca/shorty/docs:v2@${D("3")}`,
			"  db:",
			"    image: postgres:16",
			"",
		].join("\n");
		expect(listPinnedComposeRepositories(compose)).toEqual([
			"registry.devino.ca/shorty/web",
			"registry.devino.ca/shorty/docs",
		]);
	});

	it("is empty for a file that pins nothing", () => {
		expect(listPinnedComposeRepositories("services:\n  a:\n    image: nginx\n")).toEqual([]);
	});
});

describe("pickEnvironmentUrl", () => {
	it("prefers an https domain and keeps a non-root path", () => {
		expect(
			pickEnvironmentUrl([
				{ host: "internal.example.com", https: false, path: "/" },
				{ host: "App.Example.com", https: true, path: "/dashboard" },
			]),
		).toBe("https://app.example.com/dashboard");
	});
	it("falls back to the first usable domain", () => {
		expect(pickEnvironmentUrl([{ host: "a.example.com", https: false, path: null }])).toBe(
			"http://a.example.com",
		);
	});
	it("returns nothing for no domain, a disabled one or a host that is not a name", () => {
		expect(pickEnvironmentUrl([])).toBeUndefined();
		expect(pickEnvironmentUrl([{ host: "a.example.com", https: true, path: "/", enabled: false }])).toBeUndefined();
		expect(pickEnvironmentUrl([{ host: "localhost", https: true, path: "/" }])).toBeUndefined();
		expect(pickEnvironmentUrl([{ host: "a.example.com/../x", https: true, path: "/" }])).toBeUndefined();
	});
	it("drops a path that could carry anything else", () => {
		expect(
			pickEnvironmentUrl([{ host: "a.example.com", https: true, path: "/a?b=c" }]),
		).toBe("https://a.example.com");
	});
});

describe("deployment status extras", () => {
	const send = async (extra: object) => {
		const { fetch, calls } = routedFetch([["/statuses", { status: 201 }]]);
		await createDeploymentStatus(
			{ fetch, now: () => 1 },
			{
				token: "t",
				owner: "acme",
				repo: "shop",
				deploymentId: 9,
				state: "success",
				description: "ok",
				...extra,
			},
		);
		return JSON.parse(calls[0]?.body ?? "{}");
	};
	it("adds environment_url and auto_inactive false only when asked", async () => {
		expect(await send({})).toEqual({ state: "success", description: "ok" });
		expect(
			await send({ environmentUrl: "https://app.example.com", autoInactive: false }),
		).toEqual({
			state: "success",
			description: "ok",
			environment_url: "https://app.example.com",
			auto_inactive: false,
		});
	});
});

describe("evaluateStale", () => {
	const NOW = 1_700_000_000_000;
	const HEAD = "b".repeat(40);
	const run = (overrides: Partial<StaleRun> = {}): StaleRun => ({
		status: "completed",
		conclusion: "success",
		createdAt: NOW - 3_600_000,
		startedAt: NOW - 3_500_000,
		endedAt: NOW - 3_400_000,
		...overrides,
	});
	const input = (overrides: Partial<StaleInput> = {}): StaleInput => ({
		now: NOW,
		trackedBranch: "main",
		branchExists: true,
		branchHead: HEAD,
		lastReleaseSha: "a".repeat(40),
		deployedOnBranch: true,
		workflowPresent: true,
		workflowFile: ".github/workflows/dokploy.yml",
		runsForHead: [],
		recentFinishedRuns: [],
		...overrides,
	});

	it("is not stale when the push triggered no run", () => {
		expect(evaluateStale(input())).toEqual({ stale: false });
	});
	it("is not stale when the branch head is the last release", () => {
		expect(evaluateStale(input({ lastReleaseSha: HEAD, runsForHead: [run()] }))).toEqual({ stale: false });
	});
	it("is stale when a successful run ended and no release followed within the tolerance", () => {
		expect(evaluateStale(input({ runsForHead: [run()] }))).toEqual({
			stale: true,
			reason: "GitHub Actions has not published commit bbbbbbb.",
		});
	});
	it("waits out the tolerance after the run ended", () => {
		expect(
			evaluateStale(
				input({ runsForHead: [run({ endedAt: NOW - STALE_MIN_TOLERANCE_MS + 60_000 })] }),
			),
		).toEqual({ stale: false });
	});
	it("scales the tolerance with twice the median of the last runs", () => {
		const slow = (minutes: number): StaleRun =>
			run({ startedAt: NOW - minutes * 60_000 * 2, endedAt: NOW - minutes * 60_000 });
		const recent = [slow(40), slow(40), slow(40), slow(40), slow(40)];
		// Median duration 40 minutes -> tolerance 80 minutes; the run ended 60 minutes ago.
		expect(
			evaluateStale(
				input({
					runsForHead: [run({ endedAt: NOW - 60 * 60_000 })],
					recentFinishedRuns: recent,
				}),
			),
		).toEqual({ stale: false });
	});
	it("does not call a failed run a missing release", () => {
		expect(evaluateStale(input({ runsForHead: [run({ conclusion: "failure" })] }))).toEqual({ stale: false });
	});
	it("says when a run waited too long for a runner, and not before", () => {
		const queued = (waitedMs: number): StaleRun =>
			run({ status: "queued", conclusion: null, startedAt: null, endedAt: null, createdAt: NOW - waitedMs });
		expect(evaluateStale(input({ runsForHead: [queued(STALE_QUEUE_LIMIT_MS + 600_000)] }))).toEqual({
			stale: true,
			reason: "Queued for 40 minutes, is a runner online?",
		});
		expect(evaluateStale(input({ runsForHead: [queued(60_000)] }))).toEqual({ stale: false });
	});
	it("names a deleted branch, a force push and a removed workflow", () => {
		expect(evaluateStale(input({ branchExists: false })).stale).toBe(true);
		expect(evaluateStale(input({ deployedOnBranch: false }))).toEqual({
			stale: true,
			reason: "The deployed commit is no longer on the branch.",
		});
		expect(evaluateStale(input({ workflowPresent: false }))).toEqual({
			stale: true,
			reason: "dokploy.yml was removed from main.",
		});
	});
});

describe("poll cadence", () => {
	const NOW = 1_700_000_000_000;
	it("polls every 20 seconds while anything happens and every 120 after a quiet day", () => {
		expect(intervalFor({ now: NOW, lastActivityAt: NOW - 1000, createdAt: 0 })).toBe(ACTIVE_INTERVAL_MS);
		expect(intervalFor({ now: NOW, lastActivityAt: NOW - IDLE_AFTER_MS - 1, createdAt: 0 })).toBe(IDLE_INTERVAL_MS);
	});
	it("counts a connection that never saw activity from its creation", () => {
		expect(intervalFor({ now: NOW, lastActivityAt: null, createdAt: NOW - 1000 })).toBe(ACTIVE_INTERVAL_MS);
		expect(intervalFor({ now: NOW, lastActivityAt: null, createdAt: NOW - IDLE_AFTER_MS - 1 })).toBe(IDLE_INTERVAL_MS);
	});
	it("is due when never polled or when the interval has passed", () => {
		const base = { now: NOW, lastActivityAt: NOW, createdAt: NOW };
		expect(isDue({ ...base, lastPolledAt: null })).toBe(true);
		expect(isDue({ ...base, lastPolledAt: NOW - 5_000 })).toBe(false);
		expect(isDue({ ...base, lastPolledAt: NOW - 19_500 })).toBe(true);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect/pure-helpers.test.ts`
Expected: FAIL, the three modules do not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/stale.ts`**

```ts
/**
 * "Stale": GitHub Actions has not published what the branch now holds.
 * Pure: the poller reads the branch and its recent runs and asks this.
 *
 * A push that triggers no run never makes a service stale. Otherwise the
 * tolerance after a run ends is the larger of 15 minutes and twice the median
 * duration of the last five runs. A run queued longer than the queue limit
 * means no runner picked it up.
 */

export const STALE_MIN_TOLERANCE_MS = 15 * 60 * 1000;
export const STALE_QUEUE_LIMIT_MS = 30 * 60 * 1000;

export interface StaleRun {
	status: string;
	conclusion: string | null;
	/** Epoch ms the run was created (queued). */
	createdAt: number;
	/** Epoch ms the run started, when it did. */
	startedAt: number | null;
	/** Epoch ms the run ended, when it did. */
	endedAt: number | null;
}

export interface StaleInput {
	now: number;
	trackedBranch: string;
	/** The branch exists on GitHub. */
	branchExists: boolean;
	branchHead: string | null;
	/** Commit of the last accepted release (deployed or verified), if any. */
	lastReleaseSha: string | null;
	/** The deployed commit is still an ancestor of (or equal to) the branch head; null = not checked. */
	deployedOnBranch: boolean | null;
	/** The workflow file exists on the tracked branch; null = not checked. */
	workflowPresent: boolean | null;
	workflowFile: string;
	/** Runs of the workflow on the tracked branch whose head is `branchHead`, newest first. */
	runsForHead: StaleRun[];
	/** The last five finished runs of the workflow (any commit), for the median. */
	recentFinishedRuns: StaleRun[];
}

export type StaleVerdict = { stale: false } | { stale: true; reason: string };

const median = (values: number[]): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

export const evaluateStale = (input: StaleInput): StaleVerdict => {
	if (!input.branchExists) {
		return {
			stale: true,
			reason: `Branch ${input.trackedBranch} was deleted or renamed.`,
		};
	}
	if (input.workflowPresent === false) {
		return {
			stale: true,
			reason: `${input.workflowFile.split("/").pop()} was removed from ${input.trackedBranch}.`,
		};
	}
	if (input.deployedOnBranch === false) {
		return { stale: true, reason: "The deployed commit is no longer on the branch." };
	}
	if (!input.branchHead || input.branchHead === input.lastReleaseSha) {
		return { stale: false };
	}

	const [newest] = input.runsForHead;
	if (!newest) return { stale: false };

	if (newest.status !== "completed") {
		const waiting = input.now - newest.createdAt;
		if (newest.startedAt === null && waiting > STALE_QUEUE_LIMIT_MS) {
			return {
				stale: true,
				reason: `Queued for ${minutes(waiting)} minutes, is a runner online?`,
			};
		}
		return { stale: false };
	}
	// A successful run is judged by the release it should have produced; a
	// failed one is the run's own news, not a missing release.
	if (newest.conclusion !== "success") return { stale: false };

	const durations = input.recentFinishedRuns
		.slice(0, 5)
		.filter((r) => r.startedAt !== null && r.endedAt !== null)
		.map((r) => (r.endedAt as number) - (r.startedAt as number));
	const tolerance = Math.max(STALE_MIN_TOLERANCE_MS, 2 * median(durations));
	const endedAt = newest.endedAt ?? newest.createdAt;
	if (input.now - endedAt > tolerance) {
		return {
			stale: true,
			reason: `GitHub Actions has not published commit ${short(input.branchHead)}.`,
		};
	}
	return { stale: false };
};
```

**`packages/server/src/services/gha-connect/poll-cadence.ts`**

```ts
/**
 * How often a connection is polled. 20 seconds while anything happens; after
 * 24 hours without a run or a release the interval grows to 120 seconds. A
 * webhook or the "Check now" action resets it (they clear `lastActivityAt`
 * to now). Pure.
 */

export const ACTIVE_INTERVAL_MS = 20_000;
export const IDLE_INTERVAL_MS = 120_000;
export const IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

export const intervalFor = (input: {
	now: number;
	/** Epoch ms of the last run seen or release handled; null = never (new connection). */
	lastActivityAt: number | null;
	createdAt: number;
}): number => {
	const last = input.lastActivityAt ?? input.createdAt;
	return input.now - last > IDLE_AFTER_MS ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS;
};

/** Whether a connection polled at `lastPolledAt` is due now. */
export const isDue = (input: {
	now: number;
	lastPolledAt: number | null;
	lastActivityAt: number | null;
	createdAt: number;
}): boolean =>
	input.lastPolledAt === null ||
	input.now - input.lastPolledAt >= intervalFor(input) - 1_000;
```

**`packages/server/src/services/gha-connect/environment-url.ts`**

```ts
/**
 * The link GitHub shows next to a successful deployment (`environment_url`).
 * Pure: the caller reads the service's domains.
 */

export interface DomainLike {
	host: string;
	https: boolean;
	path: string | null;
	/** Domains created for previews or other purposes are skipped by the caller. */
	enabled?: boolean;
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** The first domain served over https, else the first domain; undefined without a usable host. */
export const pickEnvironmentUrl = (
	domains: readonly DomainLike[],
): string | undefined => {
	const usable = domains.filter(
		(d) => d.enabled !== false && HOST.test(d.host.trim()),
	);
	const chosen = usable.find((d) => d.https) ?? usable[0];
	if (!chosen) return undefined;
	const path =
		chosen.path && chosen.path !== "/" && /^\/[A-Za-z0-9._~\-/]*$/.test(chosen.path)
			? chosen.path
			: "";
	return `${chosen.https ? "https" : "http"}://${chosen.host.trim().toLowerCase()}${path}`;
};
```

(`pinComposeImages`, `listPinnedComposeRepositories` and the `createDeploymentStatus` extras were added in Task 4.1.)

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: stale rule, polling cadence and environment URL for connections (T-13719)"
```

### Task 4.3: The connection poll

- [ ] **Step 1: Write the failing test**

It drives `pollConnectionWatch` with a scripted GitHub and a fake `accept`, and checks, among other things: Deployments of other tasks are ignored and never answered; a spammed run costs one verification; at most 5 verifications per tick and the rest held; a refusal that blocks reaches the state machine only after acceptance said the run was verified; a rate limit blocks the connection key; a verified push release is answered `success` and recorded without a start; an accepted pull release is handed to `startDeploy` with the release context; a failed start is retried next tick; and older accepted releases are superseded.

**`apps/dokploy/__test__/gha-connect/poll.test.ts`**

```ts
import type {
	AcceptanceResult,
	AcceptedRelease,
	ConnectionFacts,
} from "@dokploy/server/services/gha-connect/acceptance";
import {
	type ConnectionPollDeps,
	type ConnectionRecord,
	MAX_VERIFICATIONS_PER_TICK,
	pollConnectionWatch,
	RECHECK_BACKOFF_MS,
} from "@dokploy/server/services/gha-connect/poll";
import {
	mergeProcessed,
	PROCESSED_CAP,
	type ProcessedEntry,
} from "@dokploy/server/services/gha-connect/processed";
import { WAKE_SCHEMA } from "@dokploy/server/services/gha-connect/wake-payload";
import {
	resetPollState,
	STATUS_TEXT,
	type WatchPatch,
	type WatchRow,
} from "@dokploy/server/services/github-deployments/poll-core";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedFetch } from "../github-deployments/helpers";

const NOW = 1_700_000_000_000;
const DIGEST = `sha256:${"e".repeat(64)}`;

const watch = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org1",
	serviceType: "compose",
	serviceId: "svc1",
	connectionId: "gh1",
	owner: "DevinoSolutions",
	repo: "voicekit",
	environment: "development",
	enabled: true,
	lastSeenDeploymentId: 10,
	etag: 'W/"old"',
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	ghaConnectionId: "c1",
	...overrides,
});

const facts: ConnectionFacts = {
	repoId: 42,
	workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "web",
	owner: "DevinoSolutions",
	repo: "voicekit",
	protectionMode: "environment",
	registryHost: "registry.devino.ca",
	deployed: null,
	currentRepositories: ["registry.devino.ca/voicekit/web"],
};

const wake = (id: number, runId: number, attempt = 1, task = "dokploy:web") => ({
	id,
	task,
	payload: {
		schema: WAKE_SCHEMA,
		run_id: runId,
		run_attempt: attempt,
		artifact: "dokploy-release",
	},
});

const release = (runId: number, delivery: "pull" | "push" = "pull"): AcceptedRelease => ({
	runId,
	runAttempt: 1,
	runUrl: `https://github.com/DevinoSolutions/voicekit/actions/runs/${runId}`,
	sha: "a".repeat(40),
	releaseId: `gh-${runId}.1`,
	delivery,
	environment: "development",
	serviceKey: "web",
	images: [
		{
			name: "web",
			composeService: "web",
			ref: `registry.devino.ca/voicekit/web@${DIGEST}`,
			repository: "registry.devino.ca/voicekit/web",
			digest: DIGEST,
		},
	],
	composePath: null,
	releaseServices: ["web"],
});

const harness = (
	deployments: unknown[],
	results: Record<number, AcceptanceResult>,
	options: { processed?: ProcessedEntry[]; statusReplies?: Array<{ status: number }> } = {},
) => {
	const { fetch, calls } = scriptedFetch([
		{ json: deployments, headers: { etag: 'W/"new"' } },
		...(options.statusReplies ?? [{ status: 201 }]),
	]);
	const patches: WatchPatch[] = [];
	const blocks = new Map<string, number>();
	const accepted: number[] = [];
	const recorded: ProcessedEntry[][] = [];
	const events: string[] = [];
	const verifiedPush: number[] = [];
	const noops: number[] = [];
	const started: Array<{ id: number; payload: unknown }> = [];
	const record: ConnectionRecord = {
		connectionId: "c1",
		organizationId: "org1",
		facts,
		processed: options.processed ?? [],
	};
	const deps: ConnectionPollDeps = {
		fetch,
		now: () => NOW,
		loadToken: async () => "gho_secret",
		markRevoked: async (id) => {
			events.push(`revoked ${id}`);
		},
		blockedUntil: (key) => blocks.get(key),
		block: (key, until) => {
			blocks.set(key, until);
		},
		patchWatch: async (_id, patch) => {
			patches.push(patch);
			return true;
		},
		startDeploy: async (_watch, deployment, payload) => {
			started.push({ id: deployment.id, payload });
			return { kind: "started" };
		},
		inspectInflight: async () => ({ state: "running" }),
		log: () => {},
		loadConnection: async () => record,
		createApi: () => ({}) as never,
		createProbe: () => ({ headDigest: async () => ({ kind: "not-found" }) }),
		accept: async ({ runId }) => {
			accepted.push(runId);
			const result = results[runId];
			if (!result) throw new Error(`no scripted result for run ${runId}`);
			return result;
		},
		recordProcessed: async (_id, entries) => {
			recorded.push(entries);
		},
		applyEvent: async (_id, event) => {
			events.push(event.type);
		},
		recordVerifiedPush: async (_c, r, id) => {
			verifiedPush.push(id);
			expect(r.delivery).toBe("push");
		},
		recordNoop: async (_c, _r, id) => {
			noops.push(id);
		},
	};
	const statuses = () =>
		calls
			.filter((c) => c.method === "POST")
			.map((c) => ({
				deployment: Number(c.url.split("/deployments/")[1]?.split("/")[0]),
				...JSON.parse(c.body ?? "{}"),
			}));
	return { deps, calls, patches, blocks, accepted, recorded, events, verifiedPush, noops, started, statuses };
};

beforeEach(() => resetPollState());

describe("pollConnectionWatch", () => {
	it("ignores deployments that are not wake-ups for this service and never asks GitHub about them", async () => {
		const h = harness(
			[wake(13, 7, 1, "dokploy:worker"), { id: 12, task: "deploy", payload: {} }, { id: 11 }],
			{},
		);
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.statuses()).toEqual([]);
		// Everything new was handled: the etag is saved.
		expect(h.patches.at(-1)).toMatchObject({ etag: 'W/"new"' });
	});

	it("answers an unreadable wake-up with a failure", async () => {
		const h = harness([{ id: 11, task: "dokploy:web", payload: { schema: "nope" } }], {});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: STATUS_TEXT.unreadable },
		]);
	});

	it("starts the accepted release and tells GitHub it was accepted", async () => {
		const h = harness([wake(11, 100)], { 100: { kind: "accepted", release: release(100) } });
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([100]);
		expect(h.started).toHaveLength(1);
		expect(h.started[0]).toMatchObject({
			id: 11,
			payload: {
				kind: "deploy",
				image: `registry.devino.ca/voicekit/web@${DIGEST}`,
				repository: "registry.devino.ca/voicekit/web",
				digest: DIGEST,
				buildRunUrl: "https://github.com/DevinoSolutions/voicekit/actions/runs/100",
				release: { connectionId: "c1", serviceKey: "web", runId: 100, delivery: "pull" },
			},
		});
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "in_progress", auto_inactive: false },
		]);
		// The run is NOT recorded as handled: a failed start must be tried again.
		expect(h.recorded).toEqual([]);
	});

	it("carries every image of a multi-image release", async () => {
		const two = release(100);
		two.images.push({
			name: "docs",
			composeService: "docs",
			ref: `registry.devino.ca/voicekit/docs@${DIGEST}`,
			repository: "registry.devino.ca/voicekit/docs",
			digest: DIGEST,
		});
		const h = harness([wake(11, 100)], { 100: { kind: "accepted", release: two } });
		await pollConnectionWatch(watch(), h.deps);
		expect(h.started[0]?.payload).toMatchObject({
			extraImages: [{ repository: "registry.devino.ca/voicekit/docs", digest: DIGEST }],
		});
	});

	it("looks only at the newest runs first and supersedes the older ones without verifying them", async () => {
		const h = harness([wake(13, 102), wake(12, 101), wake(11, 100)], {
			102: { kind: "accepted", release: release(102) },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([102]);
		const posted = h.statuses();
		expect(posted).toMatchObject([
			{ deployment: 11, state: "inactive", description: STATUS_TEXT.superseded },
			{ deployment: 12, state: "inactive", description: STATUS_TEXT.superseded },
			{ deployment: 13, state: "in_progress" },
		]);
		expect(h.started.map((s) => s.id)).toEqual([13]);
	});

	it("blocks the service and answers a failure when the release itself is broken", async () => {
		const h = harness([wake(11, 100)], {
			100: {
				kind: "refused",
				code: "image-unverified",
				message: "The registry does not serve web",
				block: true,
				recheck: false,
			},
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.events).toEqual(["release-refused"]);
		expect(h.statuses()).toMatchObject([
			{ deployment: 11, state: "failure", description: STATUS_TEXT.refused },
		]);
		expect(h.recorded[0]).toMatchObject([{ runId: 100, attempt: 1, outcome: "image-unverified" }]);
		expect(h.started).toEqual([]);
	});

	it("answers a failed run with its own text and does not block", async () => {
		const h = harness([wake(11, 100)], {
			100: { kind: "refused", code: "run-failed", message: "x", block: false, recheck: false },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.events).toEqual([]);
		expect(h.statuses()).toMatchObject([{ state: "failure", description: STATUS_TEXT.runFailed }]);
	});

	it("falls back to the next older release when the newest is refused", async () => {
		const h = harness([wake(12, 101), wake(11, 100)], {
			101: { kind: "refused", code: "run-failed", message: "x", block: false, recheck: false },
			100: { kind: "accepted", release: release(100) },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([101, 100]);
		expect(h.started.map((s) => s.id)).toEqual([11]);
	});

	it("waits for a run that is still building: nothing answered, cursor and etag stay", async () => {
		const h = harness([wake(12, 101), wake(11, 100)], {
			101: { kind: "pending", reason: "The run is in_progress" },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([101]);
		expect(h.statuses()).toEqual([]);
		expect(h.started).toEqual([]);
		expect(h.patches.some((p) => p.etag !== undefined)).toBe(false);
		expect(h.patches.some((p) => p.lastSeenDeploymentId !== undefined)).toBe(false);
		expect(h.patches.at(-1)).toMatchObject({ lastError: "The run is in_progress" });
		expect(h.recorded).toEqual([]);
	});

	it("verifies at most five runs per tick and leaves the rest for the next one", async () => {
		const ids = [18, 17, 16, 15, 14, 13, 12];
		const results: Record<number, AcceptanceResult> = {};
		for (const id of ids) {
			results[100 + id] = { kind: "refused", code: "run-failed", message: "x", block: false, recheck: false };
		}
		const h = harness(ids.map((id) => wake(id, 100 + id)), results);
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toHaveLength(MAX_VERIFICATIONS_PER_TICK);
		expect(h.accepted).toEqual([118, 117, 116, 115, 114]);
		expect(h.recorded[0]).toHaveLength(5);
		// The two oldest wait; the cursor does not move past them and the etag is not saved.
		expect(h.patches.some((p) => p.etag !== undefined)).toBe(false);
	});

	it("does not look again at a run it already handled", async () => {
		const handled: ProcessedEntry[] = [{ runId: 100, attempt: 1, outcome: "run-failed", at: "x" }];
		const h = harness([wake(11, 100), wake(12, 100)], {}, { processed: handled });
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([]);
		expect(h.statuses()).toEqual([]);
	});

	it("verifies a run once even when several Deployments name it", async () => {
		const h = harness([wake(12, 100), wake(11, 100)], {
			100: { kind: "refused", code: "run-failed", message: "x", block: false, recheck: false },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.accepted).toEqual([100]);
	});

	it("verifies a pushed release without deploying it", async () => {
		const h = harness([wake(11, 100)], {
			100: { kind: "accepted", release: release(100, "push") },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.verifiedPush).toEqual([11]);
		expect(h.started).toEqual([]);
		expect(h.statuses()).toMatchObject([{ state: "success", description: STATUS_TEXT.verifiedPush }]);
		expect(h.recorded[0]).toMatchObject([{ outcome: "verified-push" }]);
	});

	it("a pull release that matches what runs deploys nothing and connects the service", async () => {
		const h = harness([wake(11, 100)], { 100: { kind: "noop", release: release(100) } });
		await pollConnectionWatch(watch(), h.deps);
		expect(h.noops).toEqual([11]);
		expect(h.events).toEqual(["release-deployed"]);
		expect(h.started).toEqual([]);
		expect(h.statuses()).toMatchObject([{ state: "success", description: STATUS_TEXT.alreadyDeployed }]);
	});

	it("pauses the connection on a rate limit and records nothing", async () => {
		const h = harness([wake(11, 100)], {
			100: { kind: "retry", cause: { kind: "rate-limited", retryAt: NOW + 90_000 } },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.blocks.get("connection:gh1")).toBe(NOW + 90_000);
		expect(h.statuses()).toEqual([]);
		expect(h.recorded).toEqual([]);
	});

	it("marks the GitHub connection revoked when the token is dead", async () => {
		const h = harness([wake(11, 100)], {
			100: { kind: "retry", cause: { kind: "unauthorized" } },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.events).toContain("revoked gh1");
	});

	it("a refusal that a fix on GitHub clears blocks the service, asks again later and posts nothing", async () => {
		const h = harness([wake(11, 100)], {
			100: {
				kind: "refused",
				code: "policy-wider",
				message: "The environment allows every branch",
				block: true,
				recheck: true,
			},
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.events).toEqual(["release-refused"]);
		expect(h.statuses()).toEqual([]);
		expect(h.recorded).toEqual([]);
		expect(h.blocks.get("watch:w1")).toBe(NOW + RECHECK_BACKOFF_MS);
	});

	it("does not record a run as handled when its status could not be posted", async () => {
		const h = harness(
			[wake(11, 100)],
			{ 100: { kind: "refused", code: "run-failed", message: "x", block: false, recheck: false } },
			{ statusReplies: [{ status: 500 }] },
		);
		await pollConnectionWatch(watch(), h.deps);
		expect(h.recorded).toEqual([]);
	});

	it("ignores a release that is not for this service and remembers it", async () => {
		const h = harness([wake(11, 100)], {
			100: { kind: "ignored", reason: "The release does not include web" },
		});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.recorded[0]).toMatchObject([{ outcome: "ignored" }]);
		expect(h.statuses()).toEqual([]);
	});

	it("never throws: a failing acceptance backs the watch off", async () => {
		const h = harness([wake(11, 100)], {});
		await pollConnectionWatch(watch(), h.deps);
		expect(h.blocks.get("watch:w1")).toBeGreaterThan(NOW);
		expect(h.patches.at(-1)).toMatchObject({ lastError: expect.stringContaining("no scripted result") });
	});
});

describe("mergeProcessed", () => {
	it("keeps the newest first and drops the oldest beyond the cap", () => {
		const old = Array.from({ length: PROCESSED_CAP }, (_, i) => ({
			runId: i,
			attempt: 1,
			outcome: "x",
			at: "t",
		}));
		const merged = mergeProcessed(old, [{ runId: 999, attempt: 1, outcome: "y", at: "t" }]);
		expect(merged).toHaveLength(PROCESSED_CAP);
		expect(merged[0]?.runId).toBe(999);
		expect(merged.at(-1)?.runId).toBe(PROCESSED_CAP - 2);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, `poll` does not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/poll.ts`**

```ts
import type { GithubDeployment } from "../github-deployments/github-api";
import {
	type Classified,
	connectionKey,
	describeError,
	handleFresh,
	type PollDeps,
	postStatus,
	prepareTick,
	STATUS_TEXT,
	selectNewDeployments,
	WATCH_ERROR_BACKOFF_MS,
	type WatchRow,
	watchKey,
} from "../github-deployments/poll-core";
import {
	type AcceptanceResult,
	type AcceptedRelease,
	acceptRelease,
	type ConnectionFacts,
} from "./acceptance";
import type { ActionsApi } from "./actions-api";
import { type ProcessedEntry, wasProcessed } from "./processed";
import type { RegistryProbe } from "./registry-probe";
import type { ConnectionEvent } from "./state-machine";
import { parseDeploymentTask, parseWakePayload } from "./wake-payload";

/**
 * One tick of a watch that a gha_connection owns. The shared start of a tick
 * (gates, the deployment on its way, the list, the baseline) and the shared
 * end (answer every new deployment, start the target) are poll-core's
 * `prepareTick` and `handleFresh`. What is specific is in between: which of
 * the new GitHub Deployments are wake-ups for this service, and whether the
 * run behind each one is a release Dokploy accepts (acceptance.ts).
 */

/** At most this many runs are verified per tick and repository; the rest wait for the next tick. */
export const MAX_VERIFICATIONS_PER_TICK = 5;
/** A refusal that GitHub-side changes can clear is asked again no sooner than this. */
export const RECHECK_BACKOFF_MS = 5 * 60 * 1000;

export interface ConnectionRecord {
	connectionId: string;
	organizationId: string;
	/** Everything acceptance needs, including what the service runs now. */
	facts: ConnectionFacts;
	processed: ProcessedEntry[];
}

export interface ConnectionPollDeps extends PollDeps {
	/** The connection that owns this watch. */
	loadConnection: (watch: WatchRow) => Promise<ConnectionRecord | null>;
	createApi: (token: string, record: ConnectionRecord) => ActionsApi;
	/** The registry reader of an organization (it uses that organization's registry logins). */
	createProbe: (organizationId: string) => RegistryProbe;
	/** Test seam; production uses acceptRelease. */
	accept?: typeof acceptRelease;
	recordProcessed: (
		connectionId: string,
		entries: ProcessedEntry[],
	) => Promise<void>;
	applyEvent: (
		connectionId: string,
		event: ConnectionEvent,
		note?: string | null,
	) => Promise<void>;
	/** A `push` release was verified: advance the deployed commit and keep the history row. */
	recordVerifiedPush: (
		connectionId: string,
		release: AcceptedRelease,
		githubDeploymentId: number,
	) => Promise<void>;
	/** A `pull` release matched what already runs: history row only. */
	recordNoop: (
		connectionId: string,
		release: AcceptedRelease,
		githubDeploymentId: number,
	) => Promise<void>;
}

/** One tick for one connection watch. Never throws: a tick must not stop the others. */
export const pollConnectionWatch = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
): Promise<void> => {
	try {
		await pollConnectionInner(watch, deps);
	} catch (error) {
		const message = describeError(error);
		deps.log(`gha connection: watch ${watch.watchId} failed: ${message}`);
		await deps
			.patchWatch(watch.watchId, { lastError: message })
			.catch(() => {});
		deps.block(watchKey(watch.watchId), deps.now() + WATCH_ERROR_BACKOFF_MS);
	}
};

interface Candidate {
	deployment: GithubDeployment;
	runId: number;
	attempt: number;
}

const toDeployPayload = (
	record: ConnectionRecord,
	release: AcceptedRelease,
): Extract<Classified, { kind: "deploy" }> => {
	const [primary, ...rest] = release.images;
	if (!primary) throw new Error("A release without images was accepted");
	return {
		kind: "deploy",
		image: primary.ref,
		repository: primary.repository,
		digest: primary.digest,
		buildRunUrl: release.runUrl,
		...(rest.length > 0
			? {
					extraImages: rest.map((i) => ({
						repository: i.repository,
						digest: i.digest,
					})),
				}
			: {}),
		release: {
			connectionId: record.connectionId,
			serviceKey: release.serviceKey,
			manifestReleaseId: release.releaseId,
			sha: release.sha,
			runId: release.runId,
			runAttempt: release.runAttempt,
			delivery: release.delivery,
			images: release.images.map((i) => ({
				name: i.name,
				composeService: i.composeService,
				ref: i.ref,
			})),
		},
	};
};

const pollConnectionInner = async (
	watch: WatchRow,
	deps: ConnectionPollDeps,
): Promise<void> => {
	const tick = await prepareTick(watch, deps);
	if (!tick) return;
	const record = await deps.loadConnection(watch);
	if (!record) return;
	const { token, now } = tick;
	const accept = deps.accept ?? acceptRelease;
	const api = deps.createApi(token, record);

	const fresh = selectNewDeployments(tick.listed.deployments, tick.lastSeen);
	const classified = new Map<number, Classified>();

	// Cheap, local decisions first: whose wake-up is it, is it readable, is it a repeat?
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	for (const deployment of fresh) {
		const key = parseDeploymentTask(deployment.task);
		if (key === null || key !== record.facts.serviceKey) {
			classified.set(deployment.id, {
				kind: "ignore",
				reason: "not a release of this service",
			});
			continue;
		}
		const wake = parseWakePayload(deployment.payload);
		if (!wake.ok) {
			classified.set(deployment.id, {
				kind: "invalid",
				reason: wake.reason,
				statusText: STATUS_TEXT.unreadable,
			});
			continue;
		}
		const pair = `${wake.runId}:${wake.runAttempt}`;
		if (seen.has(pair) || wasProcessed(record.processed, wake.runId, wake.runAttempt)) {
			classified.set(deployment.id, { kind: "ignore", reason: "already handled" });
			continue;
		}
		seen.add(pair);
		candidates.push({ deployment, runId: wake.runId, attempt: wake.runAttempt });
	}

	// Newest first, at most MAX_VERIFICATIONS_PER_TICK runs looked at.
	candidates.sort((a, b) => b.deployment.id - a.deployment.id);
	const handled: ProcessedEntry[] = [];
	const stamp = (c: Candidate, outcome: string): ProcessedEntry => ({
		runId: c.runId,
		attempt: c.attempt,
		outcome,
		at: new Date(now).toISOString(),
	});
	let verified = 0;
	let targetId: number | undefined;
	let settled = false;
	let held: string | null = null;

	for (const candidate of candidates) {
		if (settled) {
			// Older than a release that is deployed (or already running): superseded, never verified.
			classified.set(candidate.deployment.id, { kind: "superseded" });
			continue;
		}
		if (held !== null) {
			classified.set(candidate.deployment.id, { kind: "hold", reason: held });
			continue;
		}
		if (verified >= MAX_VERIFICATIONS_PER_TICK) {
			held = "More runs are waiting to be checked; the rest are checked on the next tick.";
			classified.set(candidate.deployment.id, { kind: "hold", reason: held });
			continue;
		}
		verified += 1;
		const result: AcceptanceResult = await accept(
			{
				runId: candidate.runId,
				runAttempt: candidate.attempt,
				connection: record.facts,
			},
			{ api, probe: deps.createProbe(record.organizationId) },
		);
		const id = candidate.deployment.id;

		switch (result.kind) {
			case "pending": {
				held = result.reason;
				classified.set(id, { kind: "hold", reason: held });
				break;
			}
			case "retry": {
				held = "GitHub could not be asked; trying again soon.";
				if (result.cause.kind === "rate-limited") {
					deps.block(connectionKey(watch.connectionId), result.cause.retryAt);
				} else if (result.cause.kind === "unauthorized") {
					await deps.markRevoked(watch.connectionId);
				} else {
					deps.block(watchKey(watch.watchId), now + 3 * 20_000);
				}
				classified.set(id, { kind: "hold", reason: held });
				break;
			}
			case "ignored": {
				handled.push(stamp(candidate, "ignored"));
				classified.set(id, { kind: "ignore", reason: result.reason });
				break;
			}
			case "refused": {
				if (result.block) {
					await deps.applyEvent(record.connectionId, {
						type: "release-refused",
						message: result.message,
						block: true,
					});
				}
				if (result.recheck) {
					// GitHub-side changes can clear this one: ask again later, do not record the run as handled.
					deps.block(watchKey(watch.watchId), now + RECHECK_BACKOFF_MS);
					held = result.message;
					classified.set(id, { kind: "hold", reason: held });
					break;
				}
				const answered = await postStatus(
					deps,
					watch,
					token,
					id,
					"failure",
					result.code === "run-failed" ? STATUS_TEXT.runFailed : STATUS_TEXT.refused,
				);
				if (!answered.settled) {
					held = "The status could not be posted yet.";
					classified.set(id, { kind: "hold", reason: held });
					break;
				}
				handled.push(stamp(candidate, result.code));
				classified.set(id, {
					kind: "ignore",
					reason: result.message,
				});
				break;
			}
			case "noop": {
				const answered = await postStatus(
					deps,
					watch,
					token,
					id,
					"success",
					STATUS_TEXT.alreadyDeployed,
				);
				if (!answered.settled) {
					held = "The status could not be posted yet.";
					classified.set(id, { kind: "hold", reason: held });
					break;
				}
				await deps.recordNoop(record.connectionId, result.release, id);
				if (result.release.delivery === "pull") {
					await deps.applyEvent(record.connectionId, { type: "release-deployed" });
				}
				handled.push(stamp(candidate, "noop"));
				classified.set(id, { kind: "ignore", reason: "already deployed" });
				settled = true;
				break;
			}
			case "accepted": {
				if (result.release.delivery === "push") {
					const answered = await postStatus(
						deps,
						watch,
						token,
						id,
						"success",
						STATUS_TEXT.verifiedPush,
					);
					if (!answered.settled) {
						held = "The status could not be posted yet.";
						classified.set(id, { kind: "hold", reason: held });
						break;
					}
					await deps.recordVerifiedPush(record.connectionId, result.release, id);
					handled.push(stamp(candidate, "verified-push"));
					classified.set(id, { kind: "ignore", reason: "verified" });
					settled = true;
					break;
				}
				targetId = id;
				classified.set(id, toDeployPayload(record, result.release));
				settled = true;
				break;
			}
		}
	}

	// Remembered before anything starts: a crash after this point replays nothing.
	if (handled.length > 0) {
		await deps.recordProcessed(record.connectionId, handled);
	}
	await handleFresh(watch, deps, tick, fresh, classified, targetId);
};
```

- [ ] **Step 4: Run the test**

Expected: PASS (21 tests).

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: poll a GitHub Actions connection through the Deployments tick (T-13719)"
```

### Task 4.4: Upkeep (rename, Stale, live runs)

`runUpkeep` makes five reads (repository by id, branch head, workflow runs, compare, workflow file), and returns events for the state machine, a rename, the runs to show as live rows and the newest run id. A read that fails makes the whole result "incomplete": no event is produced, because GitHub being unreachable is never "stale".

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/upkeep.test.ts`**

```ts
import type {
	ApiResult,
	RepositoryInfo,
	RunInfo,
} from "@dokploy/server/services/gha-connect/actions-api";
import {
	runUpkeep,
	type UpkeepInput,
	type UpkeepReads,
} from "@dokploy/server/services/gha-connect/upkeep";
import { describe, expect, it } from "vitest";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const A = "a".repeat(40);
const B = "b".repeat(40);

const ok = <T>(value: T): ApiResult<T> => ({ kind: "ok", value, etag: null });

const repo = (fullName = "acme/shop"): RepositoryInfo => ({
	id: 7,
	owner: "acme",
	name: "shop",
	fullName,
	defaultBranch: "main",
	isPrivate: false,
});

const run = (over: Partial<RunInfo> = {}): RunInfo => ({
	id: 100,
	attempt: 1,
	path: ".github/workflows/dokploy.yml",
	headBranch: "main",
	headSha: B,
	event: "push",
	status: "completed",
	conclusion: "success",
	repositoryId: 7,
	headRepositoryId: 7,
	htmlUrl: "https://github.com/acme/shop/actions/runs/100",
	runStartedAt: "2026-11-03T10:00:00Z",
	updatedAt: "2026-11-03T10:05:00Z",
	...over,
});

const input = (over: Partial<UpkeepInput> = {}): UpkeepInput => ({
	now: NOW,
	state: "connected",
	repoId: 7,
	repoFullName: "acme/shop",
	trackedBranch: "main",
	workflowPath: ".github/workflows/dokploy.yml",
	deployedSha: A,
	...over,
});

const reads = (over: Partial<UpkeepReads> = {}): UpkeepReads => ({
	repository: async () => ok(repo()),
	branchHead: async () => ok({ sha: B }),
	workflowRuns: async () => ok([run()]),
	compare: async () => ok("ahead"),
	workflowFile: async () => ok("name: dokploy"),
	...over,
});

describe("runUpkeep", () => {
	it("reports a rename without touching the state", async () => {
		const result = await runUpkeep(
			input(),
			reads({ repository: async () => ok(repo("acme/shop-v2")) }),
		);
		expect(result.renamedTo).toBe("acme/shop-v2");
		expect(result.complete).toBe(true);
	});

	it("goes stale when a finished run for the head published nothing within the tolerance", async () => {
		const result = await runUpkeep(input(), reads());
		expect(result.events).toEqual([
			{ type: "stale", reason: "GitHub Actions has not published commit bbbbbbb." },
		]);
	});

	it("is not stale when the head is the deployed commit", async () => {
		const result = await runUpkeep(
			input({ deployedSha: B }),
			reads({ compare: async () => ok("identical") }),
		);
		expect(result.events).toEqual([]);
	});

	it("is not stale when no run exists for the head (a push that triggered nothing)", async () => {
		const result = await runUpkeep(
			input(),
			reads({ workflowRuns: async () => ok([run({ headSha: A })]) }),
		);
		expect(result.events).toEqual([]);
	});

	it("returns to fresh from stale once the head is the deployed commit", async () => {
		const result = await runUpkeep(
			input({ state: "stale", deployedSha: B }),
			reads({ compare: async () => ok("identical") }),
		);
		expect(result.events).toEqual([{ type: "fresh", hasRelease: true }]);
	});

	it("treats a deployed commit that left the branch as stale", async () => {
		const result = await runUpkeep(
			input(),
			reads({ compare: async () => ok("diverged") }),
		);
		expect(result.events).toEqual([
			{ type: "stale", reason: "The deployed commit is no longer on the branch." },
		]);
	});

	it("treats a deleted branch as stale", async () => {
		const result = await runUpkeep(
			input(),
			reads({ branchHead: async () => ({ kind: "not-found" }) }),
		);
		expect(result.events[0]).toEqual({
			type: "stale",
			reason: "Branch main was deleted or renamed.",
		});
	});

	it("treats a removed workflow file as stale", async () => {
		const result = await runUpkeep(
			input(),
			reads({ workflowFile: async () => ({ kind: "not-found" }) }),
		);
		expect(result.events[0]).toEqual({
			type: "stale",
			reason: "dokploy.yml was removed from main.",
		});
	});

	it("says a run queued for too long has no runner", async () => {
		const queued = run({
			id: 101,
			status: "queued",
			conclusion: null,
			runStartedAt: "2026-11-03T11:00:00Z",
			updatedAt: "2026-11-03T11:00:00Z",
		});
		const result = await runUpkeep(
			input(),
			reads({ workflowRuns: async () => ok([queued]) }),
		);
		expect(result.events).toEqual([
			{ type: "stale", reason: "Queued for 60 minutes, is a runner online?" },
		]);
		expect(result.liveRuns.map((r) => r.id)).toEqual([101]);
	});

	it("lists only same-repository push or dispatch runs of the tracked branch as live", async () => {
		const running = (over: Partial<RunInfo>) =>
			run({ status: "in_progress", conclusion: null, ...over });
		const result = await runUpkeep(
			input({ state: "waiting", deployedSha: null }),
			reads({
				workflowRuns: async () =>
					ok([
						running({ id: 1 }),
						running({ id: 2, event: "pull_request" }),
						running({ id: 3, headBranch: "feature" }),
						running({ id: 4, headRepositoryId: 99 }),
						running({ id: 5, event: "workflow_dispatch" }),
					]),
			}),
		);
		expect(result.liveRuns.map((r) => r.id)).toEqual([1, 5]);
		expect(result.newestRunId).toBe(5);
	});

	it("asks again later, and never reports stale, when GitHub could not be read", async () => {
		const result = await runUpkeep(
			input(),
			reads({ workflowRuns: async () => ({ kind: "error", status: 502 }) }),
		);
		expect(result.complete).toBe(false);
		expect(result.events).toEqual([]);
	});

	it("reports a missing repository only for a watched state", async () => {
		const gone = reads({ repository: async () => ({ kind: "not-found" }) });
		expect((await runUpkeep(input(), gone)).events).toHaveLength(1);
		expect((await runUpkeep(input({ state: "blocked" }), gone)).events).toEqual([]);
	});

	it("does nothing for a state that is not watched", async () => {
		const result = await runUpkeep(input({ state: "blocked" }), reads());
		expect(result.events).toEqual([]);
		expect(result.complete).toBe(true);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Expected: FAIL, `upkeep` does not exist.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/upkeep.ts`**

```ts
import type { ApiResult, RepositoryInfo, RunInfo } from "./actions-api";
import type { CompareStatus } from "./ordering";
import type { ConnectionEvent, ConnectionState } from "./state-machine";
import { evaluateStale, type StaleRun } from "./stale";

/**
 * What a connection looks at on GitHub between releases: is the repository
 * still there (and under which name), is GitHub Actions behind the branch
 * (Stale), and which runs are building right now (live rows). Pure
 * orchestration over injected reads, so the rules are tested without GitHub.
 */

export interface UpkeepReads {
	repository(): Promise<ApiResult<RepositoryInfo>>;
	branchHead(): Promise<ApiResult<{ sha: string }>>;
	workflowRuns(): Promise<ApiResult<RunInfo[]>>;
	compare(base: string, head: string): Promise<ApiResult<CompareStatus>>;
	workflowFile(): Promise<ApiResult<string>>;
}

export interface UpkeepInput {
	now: number;
	state: ConnectionState;
	repoId: number;
	repoFullName: string;
	trackedBranch: string;
	workflowPath: string;
	/** Commit Dokploy runs now (deployed or last verified); null before the first release. */
	deployedSha: string | null;
}

export interface UpkeepResult {
	/** The repository answers to another name now; store it. */
	renamedTo: string | null;
	events: ConnectionEvent[];
	/** Runs of the release workflow that are queued or running on the tracked branch. */
	liveRuns: RunInfo[];
	/** Highest run id seen, for the stored cursor; null when none were read. */
	newestRunId: number | null;
	/** Every read worked; false means "ask again next tick", never "stale". */
	complete: boolean;
}

const RUNNING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const WATCHED_STATES: ConnectionState[] = ["waiting", "connected", "stale"];

const time = (value: string | null) => {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
};

const toStaleRun = (run: RunInfo): StaleRun => {
	const started = time(run.runStartedAt);
	const updated = time(run.updatedAt);
	return {
		status: run.status,
		conclusion: run.conclusion,
		createdAt: started ?? updated ?? 0,
		startedAt: run.status === "queued" ? null : started,
		endedAt: run.status === "completed" ? updated : null,
	};
};

export const runUpkeep = async (
	input: UpkeepInput,
	reads: UpkeepReads,
): Promise<UpkeepResult> => {
	const result: UpkeepResult = {
		renamedTo: null,
		events: [],
		liveRuns: [],
		newestRunId: null,
		complete: false,
	};

	const repository = await reads.repository();
	if (repository.kind === "ok") {
		if (repository.value.fullName !== input.repoFullName) {
			result.renamedTo = repository.value.fullName;
		}
	} else if (repository.kind === "not-found") {
		if (WATCHED_STATES.includes(input.state)) {
			result.events.push({
				type: "stale",
				reason: "The repository was not found. Was it deleted, or was access lost?",
			});
		}
		return result;
	} else {
		return result;
	}

	const head = await reads.branchHead();
	if (head.kind !== "ok" && head.kind !== "not-found") return result;
	const branchExists = head.kind === "ok";
	const branchHead = head.kind === "ok" ? head.value.sha : null;

	const runs = await reads.workflowRuns();
	if (runs.kind !== "ok") return result;
	const allRuns = runs.value;
	result.newestRunId = allRuns.reduce<number | null>(
		(max, run) => (max === null || run.id > max ? run.id : max),
		null,
	);
	result.liveRuns = allRuns.filter(
		(run) =>
			RUNNING.has(run.status) &&
			run.headBranch === input.trackedBranch &&
			(run.event === "push" || run.event === "workflow_dispatch") &&
			run.repositoryId === input.repoId &&
			run.headRepositoryId === input.repoId,
	);

	let deployedOnBranch: boolean | null = null;
	if (branchExists && branchHead && input.deployedSha) {
		const compared = await reads.compare(input.deployedSha, branchHead);
		if (compared.kind === "ok") {
			deployedOnBranch =
				compared.value === "ahead" || compared.value === "identical";
		} else if (compared.kind === "not-found") {
			deployedOnBranch = false;
		} else {
			return result;
		}
	}

	let workflowPresent: boolean | null = null;
	if (branchExists) {
		const file = await reads.workflowFile();
		if (file.kind === "ok") workflowPresent = true;
		else if (file.kind === "not-found") workflowPresent = false;
	}

	result.complete = true;
	if (!WATCHED_STATES.includes(input.state)) return result;

	const onBranch = allRuns.filter(
		(run) => run.headBranch === input.trackedBranch,
	);
	const verdict = evaluateStale({
		now: input.now,
		trackedBranch: input.trackedBranch,
		branchExists,
		branchHead,
		lastReleaseSha: input.deployedSha,
		deployedOnBranch,
		workflowPresent,
		workflowFile: input.workflowPath,
		runsForHead: onBranch
			.filter((run) => run.headSha === branchHead)
			.map(toStaleRun),
		recentFinishedRuns: onBranch
			.filter((run) => run.status === "completed")
			.slice(0, 5)
			.map(toStaleRun),
	});
	if (verdict.stale) {
		result.events.push({ type: "stale", reason: verdict.reason });
	} else if (input.state === "stale") {
		result.events.push({ type: "fresh", hasRelease: input.deployedSha !== null });
	}
	return result;
};
```

- [ ] **Step 4: Run the test, extend the barrel, run everything pure**

Append to `packages/server/src/services/gha-connect/index.ts`:

```ts
export * from "./environment-url";
export * from "./poll";
export * from "./poll-cadence";
export * from "./stale";
export * from "./upkeep";
```

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect __test__/github-deployments && cd ../.. && pnpm -r run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: connection upkeep for rename, stale and live runs (T-13719)"
```

### Task 4.5: Wire the connection into the app layer

Everything below touches the database, the queue or GitHub, so it is typechecked and proved by a test with the repository's existing mocking style plus the manual proof. The rules it applies are the tested ones above.

**Step order:** write the new test (it fails), write `gha-connection-deps.ts`, rework the poller, run.

- [ ] **Step 1: Write the failing test for the release start**

The harness copies `poller-wiring.test.ts` and gives the transaction a queue of locked rows (the watch row, then the connection row), plus `insert` and `delete`, so the start of a release can be observed: what it writes, in which transaction, and what the undo puts back.

**`apps/dokploy/__test__/gha-connect/poller-release.test.ts`**

```ts
import {
	applications,
	compose,
	ghaConnection,
	ghaRelease,
	githubDeploymentWatch,
} from "@dokploy/server/db/schema";
import type { WatchRow } from "@dokploy/server/services/github-deployments";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	events: [] as string[],
	updates: [] as Array<{ tx: number; table: unknown; values: Record<string, unknown> }>,
	inserts: [] as Array<{ tx: number; table: unknown; values: Record<string, unknown> }>,
	deletes: [] as Array<{ tx: number; table: unknown }>,
	txCount: 0,
	/** Rows the locked selects answer in turn: the watch row, then the connection row. */
	lockedQueue: [] as Array<Record<string, unknown> | null>,
	queueAdd: vi.fn(),
	getJobs: vi.fn(),
	findApplicationById: vi.fn(),
	findComposeById: vi.fn(),
	getDokployUrl: vi.fn(),
	registerExternalBuild: vi.fn(),
	listEnabledGithubWatches: vi.fn(),
	deleteGithubWatch: vi.fn(),
	removeGhcrWatchConfigDirs: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	findApplicationById: mocks.findApplicationById,
	findComposeById: mocks.findComposeById,
	getDokployUrl: mocks.getDokployUrl,
	registerExternalBuild: mocks.registerExternalBuild,
}));

vi.mock("@dokploy/server/db", () => {
	const makeTx = (id: number) => ({
		select: () => ({
			from: () => ({
				where: () => ({
					for: async () => {
						const next = mocks.lockedQueue.shift();
						return next ? [next] : [];
					},
				}),
			}),
		}),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					mocks.updates.push({ tx: id, table, values });
					mocks.events.push(`tx${id}:write`);
				},
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => ({
				onConflictDoNothing: async () => {
					mocks.inserts.push({ tx: id, table, values });
					mocks.events.push(`tx${id}:insert`);
				},
			}),
		}),
		delete: (table: unknown) => ({
			where: async () => {
				mocks.deletes.push({ tx: id, table });
				mocks.events.push(`tx${id}:delete`);
			},
		}),
	});
	return {
		db: {
			transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
				mocks.txCount += 1;
				const id = mocks.txCount;
				mocks.events.push(`tx${id}:begin`);
				const result = await fn(makeTx(id));
				mocks.events.push(`tx${id}:commit`);
				return result;
			},
			select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
			query: { applications: { findFirst: vi.fn() }, compose: { findFirst: vi.fn() } },
		},
	};
});

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: async (...args: unknown[]) => {
			mocks.events.push("queue:add");
			return mocks.queueAdd(...args);
		},
		getJobs: mocks.getJobs,
	},
}));

vi.mock("@dokploy/server/utils/process/background", () => ({
	runBackgroundJob: async (_name: string, fn: () => Promise<void>) => fn(),
}));

vi.mock("@dokploy/server/services/github-deployments", async (importOriginal) => ({
	...(await importOriginal<object>()),
	listEnabledGithubWatches: mocks.listEnabledGithubWatches,
	deleteGithubWatch: mocks.deleteGithubWatch,
	removeGhcrWatchConfigDirs: mocks.removeGhcrWatchConfigDirs,
}));

const poller = await import("@/server/queues/github-deployments-poller");

const OLD = `sha256:${"a".repeat(64)}`;
const NEW = `sha256:${"b".repeat(64)}`;
const NEW2 = `sha256:${"c".repeat(64)}`;
const WEB = "registry.devino.ca/shop/web";
const DOCS = "registry.devino.ca/shop/docs";
const deployment = { id: 120 };

const releaseContext = {
	connectionId: "gc-1",
	serviceKey: "shop",
	manifestReleaseId: "gh-555.1",
	sha: "d".repeat(40),
	runId: 555,
	runAttempt: 1,
	delivery: "pull" as const,
	images: [{ name: "web", composeService: "web", ref: `${WEB}@${NEW}` }],
};
const payload = (extra: Array<{ repository: string; digest: string }> = []) => ({
	kind: "deploy" as const,
	image: `${WEB}@${NEW}`,
	repository: WEB,
	digest: NEW,
	buildRunUrl: "https://github.com/acme/shop/actions/runs/555",
	...(extra.length > 0 ? { extraImages: extra } : {}),
	release: releaseContext,
});

const watchRow = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	connectionId: "conn-1",
	owner: "acme",
	repo: "shop",
	environment: "production",
	enabled: true,
	lastSeenDeploymentId: 100,
	etag: null,
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	ghaConnectionId: "gc-1",
	...overrides,
});
const lockedWatch = (watch: WatchRow) => ({
	watchId: watch.watchId,
	enabled: true,
	inflightDeploymentId: null,
	owner: watch.owner,
	repo: watch.repo,
	environment: watch.environment,
	connectionId: watch.connectionId,
	lastSeenDeploymentId: watch.lastSeenDeploymentId,
});
const connectionRow = (overrides: Record<string, unknown> = {}) => ({
	ghaConnectionId: "gc-1",
	organizationId: "org-a",
	serviceType: "application",
	serviceId: "app-1",
	state: "waiting",
	previousSource: null,
	...overrides,
});
const org = { projectId: "proj-1", project: { organizationId: "org-a" } };
const gitApp = {
	applicationId: "app-1",
	sourceType: "github",
	owner: "acme",
	repository: "shop",
	branch: "main",
	autoDeploy: false,
	dockerImage: null,
	serverId: null,
	environmentId: "env-1",
	environment: org,
};
const stack = {
	composeId: "c-1",
	sourceType: "raw",
	composeFile: `services:\n  web:\n    image: ${WEB}@${OLD}\n  docs:\n    image: ${DOCS}@${OLD}\n`,
	serverId: null,
	environmentId: "env-1",
	environment: org,
};

const deps = () => poller.createGithubDeploymentsPollDeps();

beforeEach(() => {
	vi.clearAllMocks();
	mocks.events = [];
	mocks.updates = [];
	mocks.inserts = [];
	mocks.deletes = [];
	mocks.txCount = 0;
	mocks.lockedQueue = [];
	mocks.queueAdd.mockResolvedValue({ id: "job-1" });
	mocks.getJobs.mockResolvedValue([]);
	mocks.getDokployUrl.mockResolvedValue("https://dokploy.example");
	mocks.registerExternalBuild.mockResolvedValue({ deploymentId: "dep-live", created: true });
	mocks.findApplicationById.mockResolvedValue(gitApp);
	mocks.findComposeById.mockResolvedValue(stack);
});

describe("startDeploy: a release of a GitHub Actions connection", () => {
	it("flips a git application to the image, keeps its old source and records the release, in one transaction", async () => {
		const watch = watchRow();
		mocks.lockedQueue = [lockedWatch(watch), connectionRow()];
		const outcome = await deps().startDeploy(watch, deployment, payload());

		expect(outcome.kind).toBe("started");
		expect(mocks.events.indexOf("queue:add")).toBeGreaterThan(mocks.events.indexOf("tx1:commit"));
		expect(mocks.updates.every((u) => u.tx === 1)).toBe(true);
		expect(mocks.updates.find((u) => u.table === githubDeploymentWatch)?.values).toMatchObject({
			lastSeenDeploymentId: 120,
			inflightDeploymentId: 120,
		});
		expect(mocks.updates.find((u) => u.table === applications)?.values).toMatchObject({
			sourceType: "docker",
			dockerImage: `${WEB}@${NEW}`,
			autoDeploy: false,
		});
		expect(mocks.updates.find((u) => u.table === ghaConnection)?.values).toMatchObject({
			previousSource: expect.objectContaining({ sourceType: "github", branch: "main" }),
		});
		expect(mocks.inserts.find((i) => i.table === ghaRelease)?.values).toMatchObject({
			ghaConnectionId: "gc-1",
			runId: 555,
			runAttempt: 1,
			status: "accepted",
			githubDeploymentId: 120,
			digests: [NEW],
		});
		// The job continues the live GitHub Actions row.
		expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({
			applicationId: "app-1",
			buildOrigin: "github-actions",
			deploymentId: "dep-live",
		});
	});

	it("keeps the source saved at Connect instead of overwriting it", async () => {
		const watch = watchRow();
		const saved = { sourceType: "github", autoDeploy: true, branch: "main" };
		mocks.lockedQueue = [lockedWatch(watch), connectionRow({ previousSource: saved })];
		await deps().startDeploy(watch, deployment, payload());
		expect(mocks.updates.find((u) => u.table === ghaConnection)).toBeUndefined();
	});

	it("pins every image of a compose release and records it", async () => {
		const watch = watchRow({ serviceType: "compose", serviceId: "c-1" });
		mocks.lockedQueue = [
			lockedWatch(watch),
			connectionRow({ serviceType: "compose", serviceId: "c-1" }),
		];
		const outcome = await deps().startDeploy(
			watch,
			deployment,
			payload([{ repository: DOCS, digest: NEW2 }]),
		);
		expect(outcome.kind).toBe("started");
		const file = mocks.updates.find((u) => u.table === compose)?.values.composeFile as string;
		expect(file).toContain(`${WEB}@${NEW}`);
		expect(file).toContain(`${DOCS}@${NEW2}`);
		expect(file).not.toContain(OLD);
		expect(mocks.inserts.find((i) => i.table === ghaRelease)?.values).toMatchObject({
			digests: [NEW, NEW2].sort(),
		});
		expect(mocks.queueAdd.mock.calls[0]?.[1]).toMatchObject({ composeId: "c-1" });
	});

	it("rejects when the connection is gone, writing and enqueuing nothing", async () => {
		const watch = watchRow();
		mocks.lockedQueue = [lockedWatch(watch), null];
		const outcome = await deps().startDeploy(watch, deployment, payload());
		expect(outcome.kind).toBe("rejected");
		expect(mocks.updates).toEqual([]);
		expect(mocks.inserts).toEqual([]);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects several images for an application", async () => {
		const watch = watchRow();
		mocks.lockedQueue = [lockedWatch(watch), connectionRow()];
		const outcome = await deps().startDeploy(
			watch,
			deployment,
			payload([{ repository: DOCS, digest: NEW2 }]),
		);
		expect(outcome).toMatchObject({ kind: "rejected", reason: expect.stringContaining("one image") });
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects an image of another repository on an application that runs one", async () => {
		const watch = watchRow();
		mocks.findApplicationById.mockResolvedValue({
			...gitApp,
			sourceType: "docker",
			dockerImage: `registry.devino.ca/other/app@${OLD}`,
		});
		mocks.lockedQueue = [lockedWatch(watch), connectionRow()];
		const outcome = await deps().startDeploy(watch, deployment, payload());
		expect(outcome.kind).toBe("rejected");
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("puts the source, the cursor and the release row back when the enqueue fails", async () => {
		mocks.queueAdd.mockRejectedValue(new Error("queue closed"));
		const watch = watchRow();
		mocks.lockedQueue = [lockedWatch(watch), connectionRow()];
		await expect(deps().startDeploy(watch, deployment, payload())).rejects.toThrow("queue closed");

		const undo = mocks.updates.filter((u) => u.tx === 2);
		expect(undo.find((u) => u.table === githubDeploymentWatch)?.values).toEqual({
			lastSeenDeploymentId: 100,
			inflightDeploymentId: null,
			inflightStartedAt: null,
		});
		expect(undo.find((u) => u.table === applications)?.values).toMatchObject({
			sourceType: "github",
			dockerImage: null,
		});
		expect(mocks.deletes.some((d) => d.tx === 2 && d.table === ghaRelease)).toBe(true);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect/poller-release.test.ts`
Expected: FAIL, `payload.release` is ignored by the current `startDeploy` (the image is rejected as "not a Docker application").

- [ ] **Step 3: Write the connection dependencies**

`createGhaConnectionPollDeps(base)` adds to #577's deps everything `pollConnectionWatch` needs. `runConnectionUpkeep` is throttled to once per two minutes per connection (the polling budget), registers live rows for queued or running runs (a service Dokploy builds itself refuses, which is fine), and applies renames and state events. `pollGhaConnection` is the per-tick entry point.

**`apps/dokploy/server/queues/gha-connection-deps.ts`**

```ts
import {
	findApplicationById,
	findComposeById,
	registerExternalBuild,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	domains,
	ghaConnection,
	githubDeploymentWatch,
	registry,
} from "@dokploy/server/db/schema";
import {
	type AcceptedRelease,
	applyConnectionEvent,
	compareCommits,
	type ConnectionPollDeps,
	createActionsApi,
	createRegistryProbe,
	digestsOf,
	findGhaConnectionById,
	type GhaConnectionRow,
	getBranchHead,
	getFileText,
	getRepositoryById,
	listWorkflowRuns,
	pickEnvironmentUrl,
	pollConnectionWatch,
	type ReleaseInput,
	type RunInfo,
	recordProcessedRuns,
	recordVerifiedRelease,
	runUpkeep,
	settleRelease,
} from "@dokploy/server/services/gha-connect";
import {
	listPinnedComposeRepositories,
	type PollDeps,
	repositoryOfReference,
	type WatchRow,
} from "@dokploy/server/services/github-deployments";
import { and, eq } from "drizzle-orm";

/**
 * The real database and GitHub behind a GitHub Actions connection's tick. The
 * rules are in packages/server/src/services/gha-connect; this file only wires
 * them to this process.
 */

const apiDeps = {
	fetch: (url: string, init?: Parameters<typeof fetch>[1]) =>
		fetch(url, init as RequestInit),
	now: () => Date.now(),
};

/** Upkeep (five GitHub reads) at most this often per connection: the polling budget. */
export const UPKEEP_INTERVAL_MS = 120_000;
const lastUpkeepAt = new Map<string, number>();

/** "Check now": the next tick runs the upkeep again. */
export const wakeGhaConnection = (ghaConnectionId: string) => {
	lastUpkeepAt.delete(ghaConnectionId);
};

const hostOf = (url: string) =>
	url
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");

/** The login this organization saved for a registry host (Settings, Registry), or null. */
const loadRegistryAccess = async (organizationId: string, host: string) => {
	const rows = await db
		.select({
			registryUrl: registry.registryUrl,
			username: registry.username,
			password: registry.password,
		})
		.from(registry)
		.where(eq(registry.organizationId, organizationId));
	const hit = rows.find((row) => hostOf(row.registryUrl) === host.toLowerCase());
	return hit
		? {
				baseUrl: `https://${hostOf(hit.registryUrl)}`,
				username: hit.username,
				password: hit.password,
			}
		: null;
};

/** Repositories the service runs now: empty before its first image. */
const currentRepositories = async (row: GhaConnectionRow): Promise<string[]> => {
	if (row.serviceType === "application") {
		const app = await findApplicationById(row.serviceId).catch(() => null);
		const image = app?.sourceType === "docker" ? app.dockerImage?.trim() : null;
		return image ? [repositoryOfReference(image)] : [];
	}
	const stack = await findComposeById(row.serviceId).catch(() => null);
	return stack ? listPinnedComposeRepositories(stack.composeFile) : [];
};

const releaseInput = (
	ghaConnectionId: string,
	release: AcceptedRelease,
	githubDeploymentId: number,
	status: "verified" | "noop",
): ReleaseInput => ({
	ghaConnectionId,
	manifestReleaseId: release.releaseId,
	sha: release.sha,
	runId: release.runId,
	runAttempt: release.runAttempt,
	delivery: release.delivery,
	status,
	githubDeploymentId,
	images: release.images.map((image) => ({
		name: image.name,
		composeService: image.composeService,
		ref: image.ref,
	})),
	digests: digestsOf(release.images),
});

export const createGhaConnectionPollDeps = (
	base: PollDeps,
): ConnectionPollDeps => ({
	...base,
	loadConnection: async (watch) => {
		const row = watch.ghaConnectionId
			? await findGhaConnectionById(watch.ghaConnectionId)
			: null;
		if (!row) return null;
		return {
			connectionId: row.ghaConnectionId,
			organizationId: row.organizationId,
			processed: row.processed,
			facts: {
				repoId: row.repoId,
				workflowPath: row.workflowPath,
				trackedBranch: row.trackedBranch,
				environment: row.environment,
				serviceKey: row.serviceKey,
				owner: watch.owner,
				repo: watch.repo,
				protectionMode: row.protectionMode,
				registryHost: row.registryHost,
				deployed:
					row.deployedSha &&
					row.deployedRunId !== null &&
					row.deployedRunAttempt !== null
						? {
								sha: row.deployedSha,
								runId: row.deployedRunId,
								attempt: row.deployedRunAttempt,
								digests: [...(row.deployedDigests ?? [])].sort(),
							}
						: null,
				currentRepositories: await currentRepositories(row),
			},
		};
	},
	createApi: (token, record) =>
		createActionsApi(apiDeps, token, {
			owner: record.facts.owner,
			repo: record.facts.repo,
		}),
	createProbe: (organizationId) =>
		createRegistryProbe({
			fetch: apiDeps.fetch,
			loadAccess: (host) => loadRegistryAccess(organizationId, host),
		}),
	recordProcessed: recordProcessedRuns,
	applyEvent: async (connectionId, event, note) => {
		await applyConnectionEvent(connectionId, event, note);
	},
	recordVerifiedPush: (connectionId, release, githubDeploymentId) =>
		recordVerifiedRelease(
			releaseInput(connectionId, release, githubDeploymentId, "verified"),
		),
	recordNoop: (connectionId, release, githubDeploymentId) =>
		recordVerifiedRelease(
			releaseInput(connectionId, release, githubDeploymentId, "noop"),
		),
	environmentUrl: async (watch) => {
		const rows = await db
			.select({ host: domains.host, https: domains.https, path: domains.path })
			.from(domains)
			.where(
				watch.serviceType === "application"
					? eq(domains.applicationId, watch.serviceId)
					: eq(domains.composeId, watch.serviceId),
			);
		return pickEnvironmentUrl(rows);
	},
	onDeployEnded: async (watch, end) => {
		if (!watch.ghaConnectionId || watch.inflightDeploymentId === null) return;
		await settleRelease(
			watch.ghaConnectionId,
			watch.inflightDeploymentId,
			end.state === "done" ? "deployed" : "failed",
		);
		if (end.state === "done") {
			await applyConnectionEvent(
				watch.ghaConnectionId,
				{ type: "release-deployed" },
				null,
			);
		}
	},
});

/** A queued or running run shows as a live GitHub Actions row, when the service can have one. */
const registerLiveRow = async (
	row: GhaConnectionRow,
	watch: WatchRow,
	run: RunInfo,
) => {
	try {
		await registerExternalBuild({
			...(row.serviceType === "application"
				? { applicationId: row.serviceId }
				: { composeId: row.serviceId }),
			buildOrigin: "github-actions",
			buildRunUrl: run.htmlUrl,
			buildRunId: String(run.id),
			buildRepository: `${watch.owner}/${watch.repo}`,
			buildCommitSha: run.headSha,
			title: `GHA run #${run.id}`,
			description: `${watch.owner}/${watch.repo} ${run.headSha.slice(0, 7)} (${row.trackedBranch})`,
		});
	} catch {
		// A service Dokploy builds itself, or a link it cannot take: the first
		// deploy of the release still gets its own row.
	}
};

const runConnectionUpkeep = async (
	watch: WatchRow,
	row: GhaConnectionRow,
	token: string,
	now: number,
) => {
	const last = lastUpkeepAt.get(row.ghaConnectionId);
	if (last !== undefined && now - last < UPKEEP_INTERVAL_MS) return;
	lastUpkeepAt.set(row.ghaConnectionId, now);

	const ref = { owner: watch.owner, repo: watch.repo };
	const workflowFile = row.workflowPath.split("/").pop() ?? "";
	const result = await runUpkeep(
		{
			now,
			state: row.state,
			repoId: row.repoId,
			repoFullName: row.repoFullName,
			trackedBranch: row.trackedBranch,
			workflowPath: row.workflowPath,
			deployedSha: row.deployedSha,
		},
		{
			repository: () => getRepositoryById(apiDeps, token, row.repoId),
			branchHead: () => getBranchHead(apiDeps, token, ref, row.trackedBranch),
			workflowRuns: () =>
				listWorkflowRuns(apiDeps, token, ref, workflowFile, row.trackedBranch),
			compare: (base, head) => compareCommits(apiDeps, token, ref, base, head),
			workflowFile: () =>
				getFileText(apiDeps, token, ref, row.workflowPath, row.trackedBranch),
		},
	);

	if (result.renamedTo) {
		const [owner, repo] = result.renamedTo.split("/");
		if (owner && repo) {
			await db
				.update(ghaConnection)
				.set({ repoFullName: result.renamedTo })
				.where(eq(ghaConnection.ghaConnectionId, row.ghaConnectionId));
			await db
				.update(githubDeploymentWatch)
				.set({ owner, repo })
				.where(
					and(
						eq(githubDeploymentWatch.serviceType, row.serviceType),
						eq(githubDeploymentWatch.serviceId, row.serviceId),
					),
				);
			// The rest of this tick polls under the new name.
			watch.owner = owner;
			watch.repo = repo;
		}
	}
	for (const event of result.events) {
		await applyConnectionEvent(row.ghaConnectionId, event, null);
	}
	for (const run of result.liveRuns) await registerLiveRow(row, watch, run);
	if (
		result.newestRunId !== null &&
		result.newestRunId > (row.lastRunSeenId ?? 0)
	) {
		await db
			.update(ghaConnection)
			.set({ lastRunSeenId: result.newestRunId, lastActivityAt: new Date() })
			.where(eq(ghaConnection.ghaConnectionId, row.ghaConnectionId));
	}
};

/** One tick for one connection: token state, upkeep, then the Deployments poll. */
export const pollGhaConnection = async (
	watch: WatchRow,
	row: GhaConnectionRow,
	deps: ConnectionPollDeps,
) => {
	const token = await deps.loadToken(watch.connectionId);
	if (!token) {
		await applyConnectionEvent(row.ghaConnectionId, { type: "token-revoked" });
		return;
	}
	if (row.state === "disconnected") {
		await applyConnectionEvent(row.ghaConnectionId, {
			type: "token-restored",
			hasRelease: row.deployedSha !== null,
		});
	}
	try {
		await runConnectionUpkeep(watch, row, token, deps.now());
	} catch (error) {
		deps.log(
			`gha connection ${row.ghaConnectionId}: upkeep failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	await pollConnectionWatch(watch, deps);
};
```

- [ ] **Step 4: Rework the poller**

Edit `apps/dokploy/server/queues/github-deployments-poller.ts`. Four changes.

(a) Imports. Add to the existing import groups:

```ts
import {
	findApplicationById,
	findComposeById,
	getDokployUrl,
	IS_CLOUD,
	type RegisterExternalBuildInput,
	registerExternalBuild,
} from "@dokploy/server";
```

```ts
import {
	deleteGhaConnection,
	isDue,
	listGhaConnections,
	planApplicationFlip,
	recordRelease,
} from "@dokploy/server/services/gha-connect";
```

```ts
import {
	// ...the existing names, plus:
	pinComposeImages,
	repositoryOfReference,
	type DeployPayload,
} from "@dokploy/server/services/github-deployments";
```

and add `ghaConnection`, `ghaRelease` to the `@dokploy/server/db/schema` import, plus

```ts
import {
	createGhaConnectionPollDeps,
	pollGhaConnection,
} from "./gha-connection-deps";
```

(b) Split `startDeploy`. Move the body of the existing `db.transaction(async (tx: Tx) => { ... })` callback, unchanged except that its first lines use the shared stale check, into a named function, and move everything after the transaction into `finishStart`. The existing code between `const [row] = await tx.select()...` and the `if (...) return { kind: "stale" }` becomes:

```ts
type Prepared =
	| { kind: "stale" }
	| { kind: "rejected"; reason: string }
	| {
			kind: "prepared";
			job: DeploymentJob;
			undo: (tx: Tx) => Promise<void>;
			/** The live GitHub Actions row this deploy continues, registered after the commit. */
			liveRow?: RegisterExternalBuildInput;
	  };

/**
 * The tick decided on a snapshot of the watch. If the watch was repointed,
 * turned off and on, or advanced since, that decision no longer applies.
 */
const watchChangedSinceTick = (
	row: typeof githubDeploymentWatch.$inferSelect | undefined,
	watch: WatchRow,
	deployment: GithubDeployment,
) =>
	!row?.enabled ||
	row.inflightDeploymentId !== null ||
	row.owner !== watch.owner ||
	row.repo !== watch.repo ||
	row.environment !== watch.environment ||
	row.connectionId !== watch.connectionId ||
	row.lastSeenDeploymentId === null ||
	row.lastSeenDeploymentId >= deployment.id ||
	row.lastSeenDeploymentId !== watch.lastSeenDeploymentId;

const preparePlainDeploy = async (
	tx: Tx,
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: DeployPayload,
): Promise<Prepared> => {
	const [row] = await tx
		.select()
		.from(githubDeploymentWatch)
		.where(eq(githubDeploymentWatch.watchId, watch.watchId))
		.for("update");
	if (watchChangedSinceTick(row, watch, deployment)) {
		return { kind: "stale" };
	}
	// Everything that followed in #577's callback goes here unchanged: from
	// `const title = githubDeploymentTitle(deployment.id);` down to and including
	// the last `return { kind: "prepared", job, undo: ... } as const;` of the compose
	// branch. Only the type of the function changes.
};
```

The moved code is mechanical: no line of it changes except that its `as const` returns now satisfy `Prepared`.

`finishStart` is the existing code after the transaction, with one addition (the live row):

```ts
const finishStart = async (
	watch: WatchRow,
	deployment: GithubDeployment,
	prepared: Prepared,
): Promise<StartOutcome> => {
	if (prepared.kind !== "prepared") return prepared;
	let job = prepared.job;
	if (prepared.liveRow) {
		// After the commit, before the enqueue: the job continues this row.
		const live = await registerExternalBuild(prepared.liveRow).catch(() => null);
		if (live) job = { ...job, deploymentId: live.deploymentId } as DeploymentJob;
	}
	try {
		await myQueue.add("deployments", job, {
			removeOnComplete: true,
			removeOnFail: true,
		});
	} catch (error) {
		// Nothing is running for this deployment: put back what the commit wrote.
		// (#577's catch block, unchanged: the second transaction that restores the
		// cursor and the in-flight mark, then `await prepared.undo(tx)`, then the
		// console.warn if that fails.)
		throw error;
	}
	return {
		kind: "started",
		logUrl: watch.postLogUrl
			? await serviceLink(watch).catch(() => undefined)
			: undefined,
	};
};

const startDeploy = async (
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: DeployPayload,
): Promise<StartOutcome> => {
	const release = payload.release;
	const prepared = await db.transaction((tx: Tx) =>
		release
			? prepareReleaseDeploy(tx, watch, deployment, payload, release)
			: preparePlainDeploy(tx, watch, deployment, payload),
	);
	return finishStart(watch, deployment, prepared);
};
```

Run `pnpm exec vitest run --config __test__/vitest.config.ts __test__/github-deployments/poller-wiring.test.ts` now (with `prepareReleaseDeploy` stubbed to throw): #577's tests must still pass. That proves the split changed nothing for plain watches.

(c) Add the release start next to `claim`:

```ts
type ReleaseContext = NonNullable<DeployPayload["release"]>;

/**
 * Start a release a GitHub Actions connection accepted. As for a plain
 * deployment, everything in the database is one transaction with the watch
 * row locked first; the connection row is locked second. Application: a Docker
 * source gets the new digest of the repository it runs; a git source is
 * flipped to the image (its settings were saved at Connect and are kept).
 * Compose: every image of the release is pinned in the stored file. The
 * release row is inserted in the same transaction, so a release either has its
 * deploy or does not exist.
 */
const prepareReleaseDeploy = async (
	tx: Tx,
	watch: WatchRow,
	deployment: GithubDeployment,
	payload: DeployPayload,
	release: ReleaseContext,
): Promise<Prepared> => {
	const [row] = await tx
		.select()
		.from(githubDeploymentWatch)
		.where(eq(githubDeploymentWatch.watchId, watch.watchId))
		.for("update");
	if (watchChangedSinceTick(row, watch, deployment)) return { kind: "stale" };

	const [connection] = await tx
		.select()
		.from(ghaConnection)
		.where(eq(ghaConnection.ghaConnectionId, release.connectionId))
		.for("update");
	if (
		!connection ||
		connection.organizationId !== watch.organizationId ||
		connection.serviceType !== watch.serviceType ||
		connection.serviceId !== watch.serviceId ||
		connection.state === "disconnected"
	) {
		return {
			kind: "rejected",
			reason: "The GitHub Actions connection of this service is gone.",
		};
	}

	const images = [
		{ repository: payload.repository, digest: payload.digest },
		...(payload.extraImages ?? []),
	];
	const title = githubDeploymentTitle(deployment.id);
	const description =
		`${watch.owner}/${watch.repo} (${watch.environment}) ${release.sha.slice(0, 7)} ${payload.buildRunUrl ?? ""}`.trim();
	const origin = {
		buildOrigin: "github-actions",
		...(payload.buildRunUrl ? { buildRunUrl: payload.buildRunUrl } : {}),
	};
	const releaseRow = {
		ghaConnectionId: connection.ghaConnectionId,
		manifestReleaseId: release.manifestReleaseId,
		sha: release.sha,
		runId: release.runId,
		runAttempt: release.runAttempt,
		delivery: release.delivery,
		status: "accepted" as const,
		githubDeploymentId: deployment.id,
		images: release.images,
		digests: images.map((image) => image.digest).sort(),
	};
	const forgetRelease = (tx2: Tx) =>
		tx2
			.delete(ghaRelease)
			.where(
				and(
					eq(ghaRelease.ghaConnectionId, connection.ghaConnectionId),
					eq(ghaRelease.githubDeploymentId, deployment.id),
					eq(ghaRelease.status, "accepted"),
				),
			);
	const liveRow = (kind: "applicationId" | "composeId", serviceId: string) =>
		payload.buildRunUrl
			? ({
					[kind]: serviceId,
					buildOrigin: "github-actions",
					buildRunUrl: payload.buildRunUrl,
					buildRunId: String(release.runId),
					buildRepository: `${watch.owner}/${watch.repo}`,
					buildCommitSha: release.sha,
					title,
					description,
				} as RegisterExternalBuildInput)
			: undefined;

	if (watch.serviceType === "application") {
		const app = await findApplicationById(watch.serviceId).catch(() => null);
		if (!app) {
			return { kind: "rejected", reason: "The application no longer exists." };
		}
		if (app.environment.project.organizationId !== watch.organizationId) {
			return {
				kind: "rejected",
				reason: "The application belongs to another organization.",
			};
		}
		if (images.length > 1) {
			return {
				kind: "rejected",
				reason:
					"An application takes one image and this release has several. Connect a compose stack instead.",
			};
		}
		let update: Record<string, unknown> = { dockerImage: payload.image };
		let savedSource = connection.previousSource;
		if (app.sourceType === "docker") {
			const current = app.dockerImage?.trim();
			if (
				current &&
				repositoryOfReference(current).toLowerCase() !==
					payload.repository.toLowerCase()
			) {
				return {
					kind: "rejected",
					reason: `The image repository ${payload.repository} is not the one this application runs (${repositoryOfReference(current)}).`,
				};
			}
		} else {
			const flip = planApplicationFlip(
				app as unknown as Record<string, unknown>,
				payload.image,
			);
			if (!flip.flip) {
				return {
					kind: "rejected",
					reason: "This application cannot move to an image.",
				};
			}
			update = flip.update;
			// The settings saved at Connect predate the autodeploy change; keep them.
			savedSource = connection.previousSource ?? flip.previousSource;
		}
		const before = Object.fromEntries(
			Object.keys(update).map((key) => [
				key,
				(app as unknown as Record<string, unknown>)[key] ?? null,
			]),
		);
		await tx
			.update(githubDeploymentWatch)
			.set(claim(deployment.id))
			.where(eq(githubDeploymentWatch.watchId, watch.watchId));
		await tx
			.update(applications)
			.set(update)
			.where(eq(applications.applicationId, app.applicationId));
		if (savedSource !== connection.previousSource) {
			await tx
				.update(ghaConnection)
				.set({ previousSource: savedSource })
				.where(eq(ghaConnection.ghaConnectionId, connection.ghaConnectionId));
		}
		await recordRelease(releaseRow, tx);
		const job = {
			applicationId: app.applicationId,
			titleLog: title,
			descriptionLog: description,
			type: "deploy",
			applicationType: "application",
			server: !!app.serverId,
			serverId: app.serverId ?? undefined,
			...origin,
		} as DeploymentJob;
		return {
			kind: "prepared",
			job,
			liveRow: liveRow("applicationId", app.applicationId),
			undo: async (tx2: Tx) => {
				await tx2
					.update(applications)
					.set(before)
					.where(
						and(
							eq(applications.applicationId, app.applicationId),
							eq(applications.dockerImage, payload.image),
						),
					);
				await forgetRelease(tx2);
			},
		};
	}

	const stack = await findComposeById(watch.serviceId).catch(() => null);
	if (!stack) {
		return { kind: "rejected", reason: "The compose stack no longer exists." };
	}
	if (stack.environment.project.organizationId !== watch.organizationId) {
		return {
			kind: "rejected",
			reason: "The compose stack belongs to another organization.",
		};
	}
	if (stack.sourceType !== "raw") {
		return {
			kind: "rejected",
			reason:
				"Only compose stacks whose file is stored in Dokploy can follow GitHub Actions releases.",
		};
	}
	const pinned = pinComposeImages(stack.composeFile, images);
	if (!pinned.ok) return { kind: "rejected", reason: pinned.reason };
	await tx
		.update(githubDeploymentWatch)
		.set(claim(deployment.id))
		.where(eq(githubDeploymentWatch.watchId, watch.watchId));
	if (pinned.changed) {
		await tx
			.update(compose)
			.set({ composeFile: pinned.composeFile })
			.where(eq(compose.composeId, stack.composeId));
	}
	await recordRelease(releaseRow, tx);
	const job = {
		composeId: stack.composeId,
		titleLog: title,
		descriptionLog: description,
		type: "deploy",
		applicationType: "compose",
		server: !!stack.serverId,
		serverId: stack.serverId ?? undefined,
		...origin,
	} as DeploymentJob;
	return {
		kind: "prepared",
		job,
		liveRow: liveRow("composeId", stack.composeId),
		undo: async (tx2: Tx) => {
			if (pinned.changed) {
				await tx2
					.update(compose)
					.set({ composeFile: stack.composeFile })
					.where(
						and(
							eq(compose.composeId, stack.composeId),
							eq(compose.composeFile, pinned.composeFile),
						),
					);
			}
			await forgetRelease(tx2);
		},
	};
};
```

(d) Dispatch per watch. In `runGithubDeploymentsTick`, build the connection dependencies and the map once, set `ghaConnectionId` on a watch that a connection owns, and remove a connection with its service:

```ts
export const runGithubDeploymentsTick = async (
	deps: PollDeps = createGithubDeploymentsPollDeps(),
	shouldStop: () => boolean = () => false,
): Promise<void> => {
	const watches = await listEnabledGithubWatches();
	const connections = new Map(
		(await listGhaConnections()).map((row) => [
			`${row.serviceType}:${row.serviceId}`,
			row,
		]),
	);
	const connectionDeps = createGhaConnectionPollDeps(deps);
	for (const record of watches) {
		if (shouldStop()) return;
		const gha = connections.get(`${record.serviceType}:${record.serviceId}`);
		const watch: WatchRow = {
			// ...the existing fields, plus:
			ghaConnectionId: gha?.ghaConnectionId ?? null,
		};
		if (!(await serviceExists(watch))) {
			await reportServiceGone(watch, deps);
			await deleteGithubWatch(watch.serviceType, watch.serviceId);
			if (gha) await deleteGhaConnection(watch.serviceType, watch.serviceId);
			await removeGhcrWatchConfigDirs(
				[watch.watchId],
				watch.organizationId,
			).catch(() => {});
			continue;
		}
		if (!gha) {
			await pollWatch(watch, deps);
			continue;
		}
		const due = isDue({
			now: Date.now(),
			lastPolledAt: record.lastCheckedAt?.getTime() ?? null,
			lastActivityAt: gha.lastActivityAt?.getTime() ?? null,
			createdAt: gha.createdAt.getTime(),
		});
		if (due) await pollGhaConnection(watch, gha, connectionDeps);
	}
};
```

- [ ] **Step 5: Wake the poller from "Check now"**

In `apps/dokploy/server/api/routers/gha-connection.ts` import `wakeGhaConnection` from `@/server/queues/gha-connection-deps` and, in `checkNow`, call `wakeGhaConnection(row.ghaConnectionId);` after `touchConnectionActivity`.

- [ ] **Step 6: Run the tests and the typecheck**

```bash
cd apps/dokploy
pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect __test__/github-deployments __test__/mcp __test__/db
cd ../.. && pnpm -r run typecheck
```

Expected: PASS everywhere, including `poller-release.test.ts` (7 tests) and #577's `poller-wiring.test.ts` unchanged. If the mock harness of `poller-release.test.ts` and the code disagree on a call shape (for example the order of the two locked selects), fix the code to match the transaction order written above, not the test.

- [ ] **Step 7: Commit, push, open the PR**

```bash
pnpm exec biome check --write apps/dokploy/server apps/dokploy/__test__ packages/server/src
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: poll GitHub Actions connections, start releases with the flip, live rows and status URLs (T-13719)"
git push -u origin feat/gha-connect-poller
gh pr create --repo DevinoSolutions/dokploy-community --base canary --title "feat: GitHub Actions connection poller, release start and state upkeep (T-13719)" --body "Phase 1 PR 4 (spec docs/superpowers/specs/2026-11-03-gha-native-connect-design.md). Splits #577's tick so a connection reuses its cursor, in-flight and status code; adds the connection poll (dedupe, 5 verifications per tick), upkeep (rename, Stale, live runs), the release start with the git-to-image flip and multi-image pin, and release settlement. A push release is verified and recorded, never deployed."
```

- [ ] **Step 8: Review gate**

One review of the PR head (opus5-worker at high effort). Ask it to check: plain watches behave exactly as before (the refactor is covered by #577's unchanged tests); the cursor, in-flight mark, source flip, release row and image pin are one transaction and the undo restores them; nothing is enqueued before the commit; only `pull` releases deploy; a refusal blocks the service only after the run and artifact are verified; the poll count stays inside the budget (Deployments list every 20 seconds, upkeep every two minutes, at most 5 verifications per tick); and no log line or output carries a token.

- [ ] **Step 9: Manual proof for the lead (voicekit web, `dev`)**

On a test instance with this build, using the connection made in PR 2's proof:
1. In the action repository's self-test or a scratch repository, publish a `delivery: push` release for the service key. Expected within one minute: the GitHub Deployment gets a `success` status "Verified, not deployed" and `ghaConnection.one` shows the new deployed commit, still without a deploy.
2. Publish a `delivery: pull` release whose digest equals what runs. Expected: `success` "Already deployed", state Connected, no deploy.
3. Publish a `pull` release with a new digest. Expected: a live GitHub Actions row while the run builds, then one Dokploy deployment that continues that row, the application moved from git to the image (its old source saved), a `success` Deployment status carrying the service's domain as `environment_url`, and state Connected with the sentence "Deployed from GitHub Actions."
4. Re-run an older run. Expected: refused ("older than the deployed commit"), the service does not change.
5. Push a commit that triggers no run of the workflow. Expected: the service never turns Stale.

## PR 5: Copy-the-file connect UI and the status panel

**Branch:** `feat/gha-connect-ui` from the PR 4 branch. **Migration:** none. **Depends on:** PR 2 (router) and PR 4 (the state it displays).

One panel, **Build on GitHub Actions**, placed on the application and compose pages next to #577's "Deploy from GitHub Deployments" panel (the one touch point in the page files). Not connected: a form (GitHub account, repository, tracked branch, environment, service key, the id of the user's build job and its image output, delivery) with the workflow job to paste, a Copy button, and Connect. Connected: the state sentence from the spec's state table, repository, branch, environment, key, the deployed commit, the last releases, the last error, and **Check now** and **Disconnect**. Phase 1 shows the sentence and the run link; the GitHub Actions row and the run modal from c45 and c46 already display the live rows this connection registers.

The snippet text is generated on the server (`buildPublishSnippet`, pure, tested), so the UI cannot drift from what Dokploy accepts: the generated job takes the image from an output of the user's own build job in the same run, declares the GitHub environment, requests only `contents: read` and `deployments: write`, and names the action by its release tag (`v1`).

**Files:**
- Create: `packages/server/src/services/gha-connect/workflow-snippet.ts`; modify `index.ts`
- Modify: `apps/dokploy/server/api/routers/gha-connection.ts`, `apps/dokploy/__test__/mcp/__snapshots__/scopes-snapshot.test.ts.snap`
- Create: `apps/dokploy/components/dashboard/shared/gha-connection-panel.tsx`
- Modify: the application and compose service pages (one import and one element each)
- Test: `apps/dokploy/__test__/gha-connect/workflow-snippet.test.ts`

### Task 5.1: The publish snippet (pure)

- [ ] **Step 1: Write the failing test**

**`apps/dokploy/__test__/gha-connect/workflow-snippet.test.ts`**

```ts
import { buildPublishSnippet } from "@dokploy/server/services/gha-connect/workflow-snippet";
import { describe, expect, it } from "vitest";

describe("buildPublishSnippet", () => {
	const base = {
		branch: "dev",
		environment: "development",
		serviceKey: "web",
		buildJob: "compose",
		imageOutput: "image",
		actionRef: "v1",
		delivery: "push" as const,
	};
	it("renders one job that publishes the release from the build job's output", () => {
		const result = buildPublishSnippet(base);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.yaml).toContain("needs: compose");
		expect(result.yaml).toContain("if: github.ref == 'refs/heads/dev'");
		expect(result.yaml).toContain("environment: development");
		expect(result.yaml).toContain("uses: DevinoSolutions/dokploy-release@v1");
		expect(result.yaml).toContain("existing-image: ${{ needs.compose.outputs.image }}");
		expect(result.yaml).toContain("delivery: push");
		expect(result.yaml).not.toMatch(/DOKPLOY_(API_KEY|URL)/);
	});
	it.each([
		["branch", { branch: "dev; rm -rf /" }],
		["environment", { environment: "prod uction" }],
		["service key", { serviceKey: "Web" }],
		["build job", { buildJob: "1bad" }],
		["output", { imageOutput: "a b" }],
		["action ref", { actionRef: "v1 # x" }],
	])("refuses a %s that could change the workflow", (_name, patch) => {
		expect(buildPublishSnippet({ ...base, ...patch }).ok).toBe(false);
	});
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/gha-connect/workflow-snippet.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

**`packages/server/src/services/gha-connect/workflow-snippet.ts`**

```ts
/**
 * The text the "Copy the file" step of the Connect panel offers. In phase 1
 * the user's own workflow builds and pushes the image; this snippet adds the
 * one job that publishes the release for Dokploy, from an output of the
 * build job in the same run. Pure.
 */

export interface SnippetInput {
	/** Branch the release workflow runs on. */
	branch: string;
	/** GitHub Environment of the build (its deployment branch policy allows only `branch`). */
	environment: string;
	/** Service key (the Deployment task is `dokploy:<key>`). */
	serviceKey: string;
	/** Id of the job in the user's workflow that builds and pushes the image. */
	buildJob: string;
	/** Name of that job's output holding `repository@sha256:<digest>`. */
	imageOutput: string;
	/** Released tag of the action. */
	actionRef: string;
	/** `pull` once Dokploy deploys, `push` while the workflow still calls the Dokploy API. */
	delivery: "pull" | "push";
}

const SAFE = /^[A-Za-z0-9._/-]+$/;
const JOB = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export type SnippetResult = { ok: true; yaml: string } | { ok: false; error: string };

export const buildPublishSnippet = (input: SnippetInput): SnippetResult => {
	if (!SAFE.test(input.branch)) return { ok: false, error: "The branch name has characters a workflow cannot take." };
	if (!SAFE.test(input.environment)) return { ok: false, error: "The environment name has characters a workflow cannot take." };
	if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.serviceKey)) return { ok: false, error: "The service key must be lowercase letters, digits, dots, dashes or underscores." };
	if (!JOB.test(input.buildJob)) return { ok: false, error: "The build job id is not a valid job id." };
	if (!JOB.test(input.imageOutput)) return { ok: false, error: "The output name is not a valid output name." };
	if (!/^[A-Za-z0-9._/-]+$/.test(input.actionRef)) return { ok: false, error: "The action reference is not valid." };

	const yaml = [
		"  # Added for Dokploy: publishes the release. It needs no Dokploy address and no API key.",
		"  dokploy-release:",
		`    needs: ${input.buildJob}`,
		`    if: github.ref == 'refs/heads/${input.branch}'`,
		"    runs-on: ubuntu-latest",
		`    environment: ${input.environment}`,
		"    permissions:",
		"      contents: read",
		"      deployments: write",
		"    steps:",
		`      - uses: DevinoSolutions/dokploy-release@${input.actionRef}`,
		"        with:",
		`          service: ${input.serviceKey}`,
		`          environment: ${input.environment}`,
		`          delivery: ${input.delivery}`,
		`          existing-image: \${{ needs.${input.buildJob}.outputs.${input.imageOutput} }}`,
		"",
	].join("\n");
	return { ok: true, yaml };
};
```

- [ ] **Step 4: Run the test, extend the barrel, commit**

Append `export * from "./workflow-snippet";` to `packages/server/src/services/gha-connect/index.ts`.

```bash
pnpm exec biome check --write packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git add packages/server/src/services/gha-connect apps/dokploy/__test__/gha-connect
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: workflow job the user pastes to publish a release (T-13719)"
```

### Task 5.2: The `snippet` procedure

`apiGhaSnippet` and the type of its fields are already in the PR 2 schema file. The procedure needs no GitHub access and no service permission beyond reading git providers; it returns text only.

- [ ] **Step 1: Add the procedure to `apps/dokploy/server/api/routers/gha-connection.ts`**

Add `buildPublishSnippet` to the `@dokploy/server/services/gha-connect` import and `apiGhaSnippet` to the `@/server/db/schema` import, then add inside `createTRPCRouter({ ... })`:

```ts
	snippet: withPermission("gitProviders", "read")
		.meta({
			openapi: {
				method: "GET",
				path: "/ghaConnection.snippet",
				description:
					"The GitHub Actions job to paste into the workflow that builds the image, so a release is published for this service: it takes the image from an output of the build job in the same run, declares the GitHub environment and asks only for contents read and deployments write. Returns the YAML text. Nothing is written to the repository.",
			},
		})
		.input(apiGhaSnippet)
		.query(({ input }) => {
			const snippet = buildPublishSnippet({
				branch: input.trackedBranch,
				environment: input.environment,
				serviceKey: input.serviceKey,
				buildJob: input.buildJob,
				imageOutput: input.imageOutput,
				actionRef: "v1",
				delivery: input.delivery,
			});
			if (!snippet.ok) {
				throw new TRPCError({ code: "BAD_REQUEST", message: snippet.error });
			}
			return { yaml: snippet.yaml };
		}),
```

- [ ] **Step 2: Update the MCP scope snapshot**

Run: `cd apps/dokploy && pnpm exec vitest run --config __test__/vitest.config.ts __test__/mcp/scopes-snapshot.test.ts -u` and check that the diff is one added line, `ghaConnection-snippet`, with `dokploy:read`.

- [ ] **Step 3: Typecheck and commit**

```bash
pnpm -r run typecheck
pnpm exec biome check --write apps/dokploy/server
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: ghaConnection.snippet returns the job to paste (T-13719)"
```

### Task 5.3: The panel

Wiring (React): typechecked and proved by hand, like #577's `GithubDeploymentsWatch`, whose structure and primitives it copies.

- [ ] **Step 1: Write the component**

**`apps/dokploy/components/dashboard/shared/gha-connection-panel.tsx`**

```tsx
import { Copy, Loader2, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

interface Props {
	id: string;
	type: "application" | "compose";
}

const REPO = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const JOB = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const keyFromRepo = (repo: string) =>
	repo
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 63);

const STATE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	connected: "default",
	waiting: "secondary",
	stale: "outline",
	blocked: "destructive",
	disconnected: "destructive",
};

/**
 * "Build on GitHub Actions": the service follows the releases a repository's
 * workflow publishes. Dokploy only makes outbound calls to GitHub.
 * Self-hosted only.
 */
export const GhaConnectionPanel = ({ id, type }: Props) => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const enabled = isCloud === false && !!permissions?.gitProviders.read;
	const { data: accounts } = api.githubDeployment.connections.useQuery(
		undefined,
		{ enabled },
	);
	const { data: connection, isPending } = api.ghaConnection.one.useQuery(
		{ serviceType: type, serviceId: id },
		{ enabled: enabled && !!id, refetchInterval: 15_000 },
	);
	const connect = api.ghaConnection.connect.useMutation();
	const disconnect = api.ghaConnection.disconnect.useMutation();
	const checkNow = api.ghaConnection.checkNow.useMutation();

	const [githubConnectionId, setGithubConnectionId] = useState("");
	const [repository, setRepository] = useState("");
	const [trackedBranch, setTrackedBranch] = useState("main");
	const [environment, setEnvironment] = useState("production");
	const [serviceKey, setServiceKey] = useState("");
	const [buildJob, setBuildJob] = useState("build");
	const [imageOutput, setImageOutput] = useState("image");
	const [delivery, setDelivery] = useState<"pull" | "push">("pull");

	const parsed = REPO.exec(repository.trim());
	const key = serviceKey || (parsed ? keyFromRepo(parsed[2] as string) : "");
	const validSnippet =
		KEY.test(key) &&
		JOB.test(buildJob) &&
		JOB.test(imageOutput) &&
		trackedBranch.trim().length > 0 &&
		environment.trim().length > 0;
	const { data: snippet } = api.ghaConnection.snippet.useQuery(
		{
			serviceKey: key,
			trackedBranch: trackedBranch.trim(),
			environment: environment.trim(),
			buildJob,
			imageOutput,
			delivery,
		},
		{ enabled: enabled && !connection && validSnippet },
	);

	if (!enabled) return null;

	const refresh = () => utils.ghaConnection.one.invalidate();

	const onConnect = async () => {
		if (!parsed || !githubConnectionId || !validSnippet) return;
		try {
			await connect.mutateAsync({
				serviceType: type,
				serviceId: id,
				githubConnectionId,
				owner: parsed[1] as string,
				repo: parsed[2] as string,
				workflowPath: ".github/workflows/dokploy.yml",
				trackedBranch: trackedBranch.trim(),
				environment: environment.trim(),
				serviceKey: key,
				registryHost: null,
				protectionMode: "environment",
				gateMode: "image",
			});
			await refresh();
			toast.success("Connected. Dokploy now waits for the first release.");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Error connecting");
		}
	};

	const onCopy = async () => {
		if (!snippet) return;
		await navigator.clipboard.writeText(snippet.yaml);
		toast.success("Copied. Paste it under jobs: in your workflow file.");
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex flex-row items-center gap-2">
					<Workflow className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">Build on GitHub Actions</CardTitle>
						<CardDescription>
							Your workflow builds the image and publishes a release. Dokploy
							asks GitHub for it, checks it against the run, and deploys the
							image digest. Nothing connects to Dokploy from outside, and no
							Dokploy key is stored in the repository.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-4">
				{isPending ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading...
					</div>
				) : connection ? (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant={STATE_VARIANT[connection.state] ?? "secondary"}>
								{connection.state}
							</Badge>
							<span className="text-sm">{connection.statusText}</span>
						</div>
						<dl className="grid grid-cols-2 gap-2 text-sm">
							<dt className="text-muted-foreground">Repository</dt>
							<dd>{connection.repository}</dd>
							<dt className="text-muted-foreground">Branch and environment</dt>
							<dd>
								{connection.trackedBranch} / {connection.environment}
							</dd>
							<dt className="text-muted-foreground">Service key</dt>
							<dd>{connection.serviceKey}</dd>
							<dt className="text-muted-foreground">Deployed commit</dt>
							<dd>{connection.deployedSha?.slice(0, 7) ?? "none yet"}</dd>
						</dl>
						{connection.lastError ? (
							<p className="text-sm text-destructive">{connection.lastError}</p>
						) : null}
						{connection.releases.length > 0 ? (
							<ul className="space-y-1 text-sm">
								{connection.releases.map((release) => (
									<li key={release.releaseId} className="flex gap-2">
										<code>{release.sha.slice(0, 7)}</code>
										<span className="text-muted-foreground">
											run {release.runId}.{release.runAttempt}, {release.delivery}
										</span>
										<Badge variant="outline">{release.status}</Badge>
									</li>
								))}
							</ul>
						) : null}
						<div className="flex gap-2">
							<Button
								variant="secondary"
								isLoading={checkNow.isPending}
								onClick={async () => {
									await checkNow.mutateAsync({ serviceType: type, serviceId: id });
									await refresh();
									toast.success("Checking GitHub now");
								}}
							>
								Check now
							</Button>
							<DialogAction
								title="Disconnect from GitHub Actions?"
								description="The service keeps running. An application goes back to the git source it had before it was connected."
								type="destructive"
								onClick={async () => {
									await disconnect.mutateAsync({
										serviceType: type,
										serviceId: id,
										restoreSource: true,
									});
									await refresh();
									toast.success("Disconnected");
								}}
							>
								<Button variant="destructive" isLoading={disconnect.isPending}>
									Disconnect
								</Button>
							</DialogAction>
						</div>
					</>
				) : (
					<>
						<div className="grid gap-3 md:grid-cols-2">
							<div className="space-y-1">
								<Label>GitHub account</Label>
								<Select
									value={githubConnectionId}
									onValueChange={setGithubConnectionId}
								>
									<SelectTrigger>
										<SelectValue placeholder="Choose an account" />
									</SelectTrigger>
									<SelectContent>
										{(accounts ?? []).map((account) => (
											<SelectItem
												key={account.connectionId}
												value={account.connectionId}
											>
												{account.githubLogin}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label>Repository (owner/name)</Label>
								<Input
									value={repository}
									onChange={(e) => setRepository(e.target.value)}
									placeholder="acme/shop"
								/>
							</div>
							<div className="space-y-1">
								<Label>Tracked branch</Label>
								<Input
									value={trackedBranch}
									onChange={(e) => setTrackedBranch(e.target.value)}
								/>
							</div>
							<div className="space-y-1">
								<Label>GitHub environment</Label>
								<Input
									value={environment}
									onChange={(e) => setEnvironment(e.target.value)}
								/>
							</div>
							<div className="space-y-1">
								<Label>Service key</Label>
								<Input
									value={serviceKey}
									onChange={(e) => setServiceKey(e.target.value)}
									placeholder={key}
								/>
							</div>
							<div className="space-y-1">
								<Label>Delivery</Label>
								<Select
									value={delivery}
									onValueChange={(v) => setDelivery(v as "pull" | "push")}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="pull">Dokploy deploys the release</SelectItem>
										<SelectItem value="push">
											My workflow still deploys; Dokploy only verifies
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1">
								<Label>Id of your build job</Label>
								<Input value={buildJob} onChange={(e) => setBuildJob(e.target.value)} />
							</div>
							<div className="space-y-1">
								<Label>Output holding repository@sha256:digest</Label>
								<Input
									value={imageOutput}
									onChange={(e) => setImageOutput(e.target.value)}
								/>
							</div>
						</div>
						<p className="text-sm text-muted-foreground">
							Create the GitHub environment {environment || "..."} first, limit
							its deployment branches to {trackedBranch || "..."} only, and
							keep your secrets there. Dokploy never sees their values, and
							refuses to connect while the environment allows other branches.
						</p>
						{snippet ? (
							<div className="space-y-2">
								<Label>Add this job to your workflow</Label>
								<Textarea
									readOnly
									className="font-mono text-xs"
									rows={16}
									value={snippet.yaml}
								/>
								<Button variant="secondary" onClick={onCopy}>
									<Copy className="mr-2 size-4" /> Copy
								</Button>
							</div>
						) : null}
						<Button
							isLoading={connect.isPending}
							disabled={!parsed || !githubConnectionId || !validSnippet}
							onClick={onConnect}
						>
							Connect
						</Button>
						<p className="text-xs text-muted-foreground">
							Connecting turns git auto deploy off for an application built from
							git, so only one thing deploys it. Without the job above, no
							release ever arrives.
						</p>
					</>
				)}
			</CardContent>
		</Card>
	);
};
```

- [ ] **Step 2: Add it to the two service pages**

In `apps/dokploy/pages/dashboard/project/[projectId]/environment/[environmentId]/services/application/[applicationId].tsx` add the import next to the `GithubDeploymentsWatch` import

```tsx
import { GhaConnectionPanel } from "@/components/dashboard/shared/gha-connection-panel";
```

and the element right after `<GithubDeploymentsWatch id={applicationId} type="application" />`:

```tsx
												<GhaConnectionPanel id={applicationId} type="application" />
```

In the compose page (`.../services/compose/[composeId].tsx`) the same, after `<GithubDeploymentsWatch id={composeId} type="compose" />`:

```tsx
												<GhaConnectionPanel id={composeId} type="compose" />
```

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm -r run typecheck && pnpm exec biome check --write apps/dokploy/components apps/dokploy/pages`
Expected: no errors. If `Button` has no `isLoading` prop in this repository's version, use the `disabled` prop with a spinner as #577's panel does.

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: Build on GitHub Actions panel with Copy-the-file connect (T-13719)"
git push -u origin feat/gha-connect-ui
gh pr create --repo DevinoSolutions/dokploy-community --base canary --title "feat: Build on GitHub Actions panel (Copy the file) (T-13719)" --body "Phase 1 PR 5 (spec docs/superpowers/specs/2026-11-03-gha-native-connect-design.md, Wizard UX reduced to Copy the file). Connect form, the job to paste, state sentence, releases, Check now and Disconnect."
```

- [ ] **Step 5: Review gate**

One review of the PR head (opus5-worker at high effort). Check that nothing in the panel can send a token, a key or an address to the repository, that Connect is disabled while the form is invalid, and that every message states what is wrong and what to do.

- [ ] **Step 6: Manual proof for the lead**

On a test instance, open the voicekit web `dev` service page in a headed browser. Expected: the panel shows the form; fill in the repository, `dev` environment and branch; the YAML appears and Copy puts it on the clipboard; Connect with a wider environment policy shows the environment message as a toast; after fixing the environment, Connect succeeds and the panel shows "Waiting for GitHub Actions to publish <sha>. Git autodeploy is off.", then (after a release) "Deployed from GitHub Actions." Screenshot each state onto the PR.

## PR 6: The shared workflow wrapper and the cutovers (`DevinoSolutions/.github`)

**Repo:** `DevinoSolutions/.github`. **Branch:** `feat/dokploy-compose-release` from its default branch. **Depends on:** PR 1 tagged `v1.0.0`; PRs 2 to 4 deployed to the instance whose service is cut over.

`dokploy-compose.yml` already builds every image once, mirrors each one by digest to our registry through the SSH tunnel, renders the compose file with the digests and hands it to Dokploy with the API. This PR makes the same workflow also publish the release (artifact and Deployment) and lets a repository stop calling the Dokploy API without editing its own file.

Both deployers are never active at once: Dokploy deploys only `pull` manifests, and the wrapper makes the Dokploy API call only while `push_deploy` is true. A repository moves in three steps, each reversible:

1. **Publish only (today's behavior plus a record).** `push-deploy` stays true. The wrapper still deploys through the API and also publishes a `delivery: push` manifest. Dokploy verifies it and advances its record of the deployed commit; it deploys nothing.
2. **First pull release.** Set the repository variable `DOKPLOY_PUSH_DEPLOY` to `false`. The wrapper skips the Dokploy API call and publishes `delivery: pull`. Dokploy deploys the release; when its digest equals what already runs it is an already-deployed no-op and the service becomes Connected.
3. **Steady state.** Nothing more to do. Setting the variable back to `true` (or deleting it) returns to API deploys at once.

The wrapper reads the variable through the `vars` context, which a called workflow sees from its caller's repository, so the cutover to step 2 needs no file edit.

**Files:**
- Modify: `.github/workflows/dokploy-compose.yml`, the header comment of the same file, the README section "Deploy a compose project to Dokploy with GitHub Actions"
- Modify: `.github/workflows/selftest-dokploy-compose.yml` (one case)

### Task 6.1: Wrapper inputs, publish step and the push gate

- [ ] **Step 1: Resolve the action sha**

```bash
gh api repos/DevinoSolutions/dokploy-release/commits/v1.0.0 --jq .sha
```

Use the printed sha, with `# v1.0.0` after it, wherever `<RELEASE_SHA>` appears below (the repository pins third-party and sibling actions by sha, and the wrapper header explains why).

- [ ] **Step 2: Add the two inputs** under `on.workflow_call.inputs` in `dokploy-compose.yml`

```yaml
      push-deploy:
        description: >-
          true (default): this workflow deploys through the Dokploy API as before, and also publishes a delivery=push release that Dokploy only
          verifies. false: this workflow makes no Dokploy call; Dokploy deploys the published release (delivery=pull). A repository variable
          DOKPLOY_PUSH_DEPLOY set to 'false' switches an existing caller to false without editing its file.
        type: boolean
        required: false
        default: true
      release-key:
        description: >-
          Service key of the Dokploy connection (the GitHub Deployment task is dokploy:<key>). Empty = the repository name.
          'none' = publish no release.
        type: string
        required: false
        default: ''
```

- [ ] **Step 3: Add the publish steps** in the `deploy` job, after the mirror step (the one with `id: mirror`) and before `Check out the compose file`

```yaml
      # Phase 1 of the native GitHub Actions connection (T-13719): publish the release Dokploy reads. The images are the mirrored
      # ones the rendered compose uses, by digest, so what Dokploy verifies in its registry is exactly what it will run.
      - name: List the mirrored images for the release
        id: release-images
        if: ${{ inputs.release-key != 'none' }}
        env:
          DIGESTS: ${{ steps.collect.outputs.digests }}
          PREFIX: ${{ steps.mirror.outputs.image-prefix }}
          RELEASE_KEY: ${{ inputs.release-key || github.event.repository.name }}
        run: |
          set -euo pipefail
          key=$(printf '%s' "$RELEASE_KEY" | tr 'A-Z' 'a-z')
          {
            echo "key=${key}"
            echo 'lines<<EOF_RELEASE_IMAGES'
            jq -r --arg key "$key" --arg prefix "$PREFIX" 'to_entries[] | "\($key)/\(.key)=\($prefix)/\(.key)@\(.value)"' <<<"$DIGESTS"
            echo 'EOF_RELEASE_IMAGES'
          } >> "$GITHUB_OUTPUT"

      - name: Publish the release for Dokploy
        if: ${{ inputs.release-key != 'none' }}
        # In push mode a failure to publish only warns (the action says so); the deploy below is unaffected.
        uses: DevinoSolutions/dokploy-release@<RELEASE_SHA> # v1.0.0
        with:
          service: ${{ steps.release-images.outputs.key }}
          environment: ${{ inputs.github-environment || 'production' }}
          delivery: ${{ (inputs.push-deploy && vars.DOKPLOY_PUSH_DEPLOY != 'false') && 'push' || 'pull' }}
          existing-image: ${{ steps.release-images.outputs.lines }}
          compose: ${{ inputs.compose-file }}
```

- [ ] **Step 4: Gate the Dokploy API call** on the same expression. On the existing step `Render the compose and deploy it` (`id: deploy`) add

```yaml
        if: ${{ inputs.mirror-only || (inputs.push-deploy && vars.DOKPLOY_PUSH_DEPLOY != 'false') }}
```

and give the job output a value when the step is skipped:

```yaml
    outputs:
      digests: ${{ steps.collect.outputs.digests }}
      result: ${{ steps.deploy.outputs.result || (steps.deploy.outcome == 'skipped' && 'published' || '') }}
```

Document the new value in the header comment: `deploy-result` is now `deployed | skipped | dry-run | rendered | published` (`published` = the release was handed to Dokploy, which deploys it).

- [ ] **Step 5: Do not register live rows from the workflow in pull mode**

Dokploy registers the live row itself once a connection exists. Find every use of the register action:

```bash
grep -n "dokploy-register-build" .github/workflows/dokploy-compose.yml
```

and, on each of those steps (the build legs' register step and the closing `mode: finish` steps), AND the existing `if:` condition with `&& inputs.push-deploy && vars.DOKPLOY_PUSH_DEPLOY != 'false'`. A step with no `if:` gets `if: ${{ inputs.push-deploy && vars.DOKPLOY_PUSH_DEPLOY != 'false' }}`.

- [ ] **Step 6: Update the header comment and the README**

In the header comment of `dokploy-compose.yml` add a section "THE RELEASE (Dokploy Community 'Build on GitHub Actions')" that states: what is published (artifact `dokploy-release` and one Deployment with task `dokploy:<release-key>`), the two inputs, the variable, the three-step migration above, and that the callers need `contents: read`, `deployments: write` and `packages: write` (and `actions: read` when the caller declares a `permissions:` block). Copy the same text into the README section.

- [ ] **Step 7: Add one case to the self-test**

In `selftest-dokploy-compose.yml` add a case that calls the wrapper with `mirror-only: true` and `release-key: none`, and asserts that the job summary and `deploy-result` are `rendered` as before. This protects every existing caller: with `mirror-only` or the default `push-deploy`, the behavior is unchanged.

- [ ] **Step 8: Validate the YAML**

Run: `npx --yes yaml-lint .github/workflows/dokploy-compose.yml .github/workflows/selftest-dokploy-compose.yml` and the repository's own workflow lint (`python-ci.yml` or `ci-lint.yml` run on the pull request).
Expected: no errors; the lint that restricts runner labels and action pins passes (the new action is pinned by sha).

- [ ] **Step 9: Commit, push, open the PR**

```bash
git add -A
git -c user.name=AminDhouib -c user.email=amin@devino.ca commit -m "feat: dokploy-compose publishes a Dokploy release and can stop calling the Dokploy API (T-13719)"
git push -u origin feat/dokploy-compose-release
gh pr create --repo DevinoSolutions/.github --base main --title "feat: dokploy-compose publishes a release for Dokploy (push-deploy, release-key) (T-13719)" --body "Phase 1 PR 6 of the native GitHub Actions connect (spec in DevinoSolutions/dokploy-community docs/superpowers/specs/2026-11-03-gha-native-connect-design.md). Adds push-deploy and release-key. Default behavior is unchanged; a repository variable DOKPLOY_PUSH_DEPLOY=false hands deploys to Dokploy."
```

- [ ] **Step 10: Review gate**

One review of the PR head (opus5-worker at high effort). Check: with the defaults a caller behaves exactly as before plus one non-blocking publish step; `existing-image` carries digests only (no tag); the job still holds no extra secret; the live-row registration is off in pull mode; every sibling action is pinned by sha.

### Task 6.2: Cut over voicekit web (the proof adopter)

Voicekit calls the shared `dokploy-compose.yml` for its web and engine files, and its `dev` environment limits deployment branches to one branch. Cut over `web` on `dev` first.

- [ ] **Step 1: Sha bump (the lane that owns voicekit does this PR)**

In voicekit's `web` caller change the `uses: DevinoSolutions/.github/.github/workflows/dokploy-compose.yml@<old sha>` to the sha of the merged PR 6. Nothing else changes. Check `permissions:` of the caller includes `contents: read`, `deployments: write`, `packages: write` and `actions: read`.

- [ ] **Step 2: Create the GitHub environment values**

The `dev` environment must exist with Deployment branches set to the one tracked branch. No secret is added.

- [ ] **Step 3: Manual proof for the lead, in order**

1. Merge the sha bump. A push to the tracked branch publishes a `delivery: push` release. Expected: the run shows the artifact `dokploy-release` and a Deployment `dokploy:voicekit-web`; the Dokploy deployment still happens through the API as before; `ghaConnection.one` shows the deployed commit advance and the state unchanged. Nothing deployed twice.
2. Connect the service in the dashboard (PR 5 panel) using the service key printed by the run. Expected: "Waiting for GitHub Actions to publish <sha>. Git autodeploy is off." (or Connected on the next release).
3. Set the repository variable `DOKPLOY_PUSH_DEPLOY` to `false` and push. Expected: the run makes no Dokploy API call (`deploy-result` is `published`); Dokploy deploys the release; the service becomes Connected; the Deployment shows `success` with the service URL. If the wrapper still calls the Dokploy API, the `vars` context is not visible inside the called workflow: have the caller pass `push-deploy: ${{ vars.DOKPLOY_PUSH_DEPLOY != 'false' }}` instead (a one-time file edit in that repository) and keep the wrapper's own check as a second guard.
4. Set the variable back to `true` and push. Expected: the API deploy returns, and Dokploy only verifies. This is the rollback.

### Task 6.3: The other nine repositories

Each cutover is its own pull request, owned by the repository's lane (the wizard never edits workflows). Per repository, the order is the three steps above.

| Shape | Repositories | What the lane changes |
|---|---|---|
| Calls the shared `dokploy-compose.yml@sha` | SnapVisor, Shorty, Notifly, Uptimely, Demofy, voicekit engine | Sha bump only; set `DOKPLOY_PUSH_DEPLOY` at step 2 |
| Own workflow with `dokploy-deploy` and `dokploy-register-build` | SuperBooks, upAPI, Caly | Add the job from the Connect panel (it takes the image from the build job's output), keep the API deploy while `delivery: push`, then remove the API deploy at step 2. Review checks the cache trust rule: the build job uses `cache: gha` or an environment-scoped credential, never a registry cache written with a repository-wide credential |
| Own `build-deploy.yml`, no shared action found | Postify | Same as the row above, on Postify's workflow, through its own lane (postify-65) |

SuperBooks and Caly use `workflow_run` on CI. That trigger is never accepted, so they move to a push trigger plus the deploy gate "workflows: CI", which is phase 3 (T-13720); until then they stay on API deploys. A key with no connected service is published and ignored, which is today's dry run.

---

## Where the deploy gate lands (T-13720)

The spec puts the deploy gate in phase 3, PR 10, not in phase 1. Phase 1 stores the setting (`gate_mode`, default `image`) and acts on `image` only: a release is deployed as soon as it is accepted. The gate will reuse `evaluateRequiredChecks` from `packages/server/src/services/build-policy/required-checks.ts`, evaluate the expected check set for the release commit between acceptance and the start of the deploy, post a `queued` status "Waiting for CI" while pending, block on a failing latest attempt, and exclude the release run and Dokploy's own statuses. The seam is already in place: the connection poll hands an accepted release to `startDeploy` through one call, so the gate becomes a step before that call, with its start time in the already-created `gateStartedAt` column. Nothing in this plan needs to change when it lands.

## Self-review against the spec

**Spec coverage (phase 1 items):**

| Spec item | Where |
|---|---|
| Release manifest artifact `dokploy-release` read via the Actions API | PR 1 (publish), PR 2 (`actions-api`), PR 3 (`manifest`, `zip`, `acceptance`) |
| Poller extension on #577, wake-up Deployments, dedupe, 5 verifications per tick per repository | PR 4 (`poll`, refactored `poll-core`) |
| `gha_connection` keyed on repo id with workflow path, tracked branch, environment, gate mode, state, processed pairs, gate start | PR 2 (schema, migration 0229) |
| Acceptance rules 1 to 6 including ancestor refusal and branch-policy re-check | PR 3 (`acceptRelease`), PR 2 (`ordering`, `environment-policy`, `namespace`) |
| State machine with persistence and boot reconcile | PR 2 (`state-machine`, `store`), PR 4 (`upkeep`; on boot the first tick reads GitHub, and `processed` is persisted so nothing replays) |
| Deployment statuses as the record, with environment URL | PR 4 (`postStatus`, `environmentUrl`) |
| `delivery: push|pull` guard | PR 1 (`cli`), PR 3 (manifest `delivery`), PR 4 (`poll`: push verified and recorded, never deployed), PR 6 |
| Phase 1 token is #577's device-flow token, scope change, no registry credential | PR 2 Task 2.8 |
| Limited to tunnel adopters and public GHCR | PR 3 `registry-probe` (anonymous GHCR, saved login for our registry), PR 2 Task 2.8 (`read:packages` dropped) |
| The action repository skeleton | PR 1 |
| One-adopter proof | voicekit web `dev`, PR 6 Task 6.2 |
| Flip at first release with `previousSource`, git autodeploy off at Connect | PR 2 (`planConnect`), PR 4 (`prepareReleaseDeploy`) |
| Stale, polling budget, idle slow-down, rename safety | PR 4 (`stale`, `poll-cadence`, `upkeep`) |
| Live rows | PR 4 (`registerLiveRow`, job `deploymentId`) |
| Copy-the-file connect UI | PR 5 |
| Wrapper with `push_deploy` and `delivery`, ten cutovers | PR 6 |
| Deploy gate (T-13720) | Phase 3, see above |

**Not in phase 1 by the spec's own split:** the GitHub App and wizard (PR 6 to 9 of the spec), migrations, retention and GC, previews, local build once, multi-instance guard, drift protection, the registry token service. This plan does not touch them.

**Names used in more than one task** (checked for agreement): `acceptRelease`, `AcceptedRelease`, `ConnectionFacts`, `ConnectionRecord` (with `organizationId`), `ConnectionPollDeps` (with `createProbe`), `pollConnectionWatch`, `runUpkeep`, `planConnect`, `connectGhaService`, `planApplicationFlip`, `recordRelease`, `recordVerifiedRelease`, `settleRelease`, `applyConnectionEvent`, `presentGhaConnection`, `pinComposeImages`, `listPinnedComposeRepositories`, `pickEnvironmentUrl`, `buildPublishSnippet`, `wakeGhaConnection`, `ReleaseContext`.

**Placeholder scan:** the plan contains no unfinished-work markers and no "similar to". The three places that move existing #577 code (Task 4.5 step 4, parts b) name the exact first and last statement of the moved block and are checked by #577's own unchanged `poller-wiring.test.ts`. Values that must be read at execution time are marked and come with the command that prints them: the action pins in Task 1.6 and `<RELEASE_SHA>` in Task 6.1.
