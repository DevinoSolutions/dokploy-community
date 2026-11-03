# Build on GitHub Actions, connected natively (T-13719, gate T-13720)

Status: design, revision 4, 2026-11-03. Builds on c42 to c46 (provenance pill, live GitHub Actions rows, run modal, `github-run-poller`) and on open PR #577 (GitHub Deployments pull, device flow, poller; head 7a4c11d0). Nothing here is implemented.

## Goal
A user turns any GitHub-sourced application or compose into a GitHub Actions-built service from the dashboard. The repository gets one short workflow. It holds no Dokploy API key and no Dokploy address. It builds, pushes by digest and uploads a release manifest as a run artifact. Dokploy reads that artifact and deploys. Until phase 3 a workflow may hold up to two secrets for us: a push-only registry credential scoped to that repository (from phase 2) and the SSH-tunnel key of the existing mirror step (adopters, until the server-side mirror lands). Both live in a GitHub Environment limited to the tracked branch where the plan supports environments.

## Non-goals
- No edit of existing workflows, ever. No Dokploy API key, URL or resolve hack in a repository.
- No other forge now. The manifest is forge-neutral so GitLab, Gitea and Bitbucket adapters can follow.
- Push-based deploys for Dokploys GitHub can reach keep working, but only through the migration guard below.

## Architecture
```
 repo: .github/workflows/dokploy.yml  (static, 20 lines)
   uses DevinoSolutions/dokploy-release@v1
     build -> push by digest -> upload artifact "dokploy-release" -> create GitHub Deployment (wake-up record)
                                   |
 GitHub: run + artifact + Deployment + check-runs
                                   |
 Dokploy (outbound only): poller (#577, conditional requests)
   discover run (workflow runs list) / wake on Deployment
   -> accept (run fields + artifact + registry HEAD + ordering) -> gate -> deploy by digest
   -> Deployment status + environment_url -> row: GitHub Actions
```
- **Release manifest** (`dokploy.release/v1`): the contract; lives with the action, not in this fork.
- **Action** `DevinoSolutions/dokploy-release@v1`: public repository, composite, third-party actions pinned.
- **Credential.** Phase 1 uses the #577 device-flow token. Phase 2 uses the GitHub App (below). Polling is the default transport; webhooks only accelerate it.
- **`gha_connection`** (table, phase 1): service id and type, repo id (never the name, so renames are safe), workflow path, tracked branch, environment, gate mode, state, deployed commit, last processed (run id, attempt) pairs, gate start. Each tick resolves the repo id to owner/name. #577's watch row is created from it. Release history is table `gha_release`. Nothing is added to `application` (100-argument cap).

## Trust model: the artifact, not the Deployment
The GitHub Deployment is the user-visible record and a wake-up signal only. Anyone with write access can create one. The authoritative manifest is the run artifact `dokploy-release` (JSON, tiny, retention 7 days). Only the run itself can upload its own artifacts, so the artifact binds digests to the run without attestations, on private Free and Team plans too.

Dokploy accepts a release only when all of these hold:
1. Run (`GET /repos/{o}/{r}/actions/runs/{run_id}`): `path` equals `.github/workflows/dokploy.yml` (or the connection's recorded path, any `@ref` suffix removed); `head_branch` equals the tracked branch; `event` is `push` or `workflow_dispatch`, never `pull_request` and never `workflow_run`; `status` is `completed` and `conclusion` is `success`.
2. Artifact (`GET .../runs/{run_id}/artifacts`): named `dokploy-release`, `expired` false, `workflow_run.id` equals the run, `workflow_run.repository_id` and `head_repository_id` equal the connection's repo id.
3. The manifest's `sha` equals the run's `head_sha`.
4. Each image digest answers a registry v2 `HEAD /v2/<name>/manifests/<digest>` with the same `Docker-Content-Digest`. The Packages API is never used. The repository must sit in the connection's registry namespace (`<repo>/*` on our registry, or the owner's public GHCR), and after the first release must equal the repository the service runs. Repositories under `<repo>/preview/*` are always refused here, including for the first release.
5. The connection's GitHub Environment branch policy still allows only the tracked branch. It is re-read at every acceptance, not only at Connect. A read error, a missing environment or a wider policy refuses the release and sets the connection Blocked. This rule is skipped only in confirmed repository-secret mode (see poisoning controls).
6. Ordering (below).

`workflow_run` is not accepted at all. In a `workflow_run` run `github.sha` is the default-branch tip, which can be a newer commit than the one CI tested, and CI runs of fork pull requests can trigger it. The deploy gate is the supported way to wait for CI.

Optional on top: a Sigstore attestation (certificate workflow ref and run id) shows an "attested" badge. It never blocks.

**Ordering and replay.** After Connected, a release whose commit is an ancestor of the deployed commit is refused (`compare` status `behind` or `identical`) unless the user triggers Rollback explicitly. A candidate must also be reachable from the tracked branch head. For two releases of one commit, the higher `run_attempt` wins, an identical digest set is a no-op, and a lower attempt is refused; between different runs of one commit the later run id wins. Re-running an old run therefore cannot regress prod.

## Deployment contract
One Deployment per service per release: `ref` is the 40-character sha, `required_contexts: []`, `auto_merge: false`, `environment` is the environment name, `task: dokploy:<key>`, `transient_environment: true` for previews, `payload` is `{"schema","run_id","run_attempt","artifact":"dokploy-release"}` (under 2 KiB). Statuses use `auto_inactive: false`; `description` and `log_url` carry the instance id. A Deployment whose run fails the rules above is ignored and logged on the row. Deployments are wake-ups, so spam is bounded: they are deduplicated by (run id, attempt), a pair already processed costs no request, and at most 5 verifications run per poll tick per repository, newest first, the rest deferred to the next tick.

## Release manifest (artifact)
```json
{
  "schema": "dokploy.release/v1",
  "sha": "3f9c2a1e...40hex",
  "delivery": "pull",
  "release": { "id": "gh-9876543210.1", "services": ["web", "worker"] },
  "source": { "forge": "github", "ref": "refs/heads/main", "runId": "9876543210", "runAttempt": 1 },
  "environment": "production",
  "services": [{
    "key": "web",
    "images": [{ "name": "web", "composeService": "web", "ref": "registry.example.com/acme/shop/web@sha256:e31c...64hex" }],
    "compose": { "path": "docker-compose.prod.yml" },
    "migrations": null
  }]
}
```
`delivery` is `pull` or `push`; Dokploy deploys only `pull` and merely verifies `push` (migration guard). A verified `push` release still advances the recorded deployed commit and `gha_release`, so the first `pull` release is ordered against what really runs. Unknown minor fields are ignored; an unknown major is refused with a row message. **Phase 1 refuses any manifest with `migrations`**, with an explicit row error. A multi-service release is complete when every key in `release.services` has been seen; a missing Deployment times out after 15 minutes (configurable) and the release is Blocked.

**Second source: the release job's log (added with PR 3).** GitHub Free's Actions storage quota can be used up, which blocks every artifact upload of the organization. The action therefore also prints the manifest on one line of its own, `::dokploy-release::<standard base64 of the manifest JSON>`, and creates the Deployments even when the upload failed (the upload step only warns). Acceptance reads the artifact first; when it is missing, expired, unreadable or its download fails, it reads the log of a job of the SAME run and attempt that ran the action (jobs are listed per attempt, completed with success, on the run's head sha, named by the connection's release job name when it has one, otherwise a job or step whose name mentions dokploy; at most three logs, 16 MiB each) and takes the one marker line that starts a log line after GitHub's timestamp. Two different markers, or one that is not valid base64, refuse the release and block the service. Both sources then pass the SAME rules (run id and attempt, `sha` = the run's head sha, schema, namespace, registry digest, environment policy, ordering), and `gha_release.manifestSource` records which one was used. A rate limit or a dead token never falls back: it is retried. An artifact bound to another run or repository is an anomaly and is refused without a fallback.

## Credentials and permissions
**Phase 1, no App change.** The #577 device-flow token. Its scopes change from `repo_deployment read:packages` to `repo_deployment` plus `public_repo` (public repositories) or `repo` (private ones). Classic OAuth has no read-only Actions scope, so `repo` is broader than the calls made (runs, artifacts, branch compare, check-runs, Deployments read and write). `read:packages` is dropped. Existing connections re-authorize through the device flow.

**Phase 2, GitHub App** (existing per-instance manifest flow, extended):
| Permission | Why |
|---|---|
| metadata read | mandatory |
| actions read | runs, jobs, artifacts, logs (write only if "Test connection" dispatch is enabled) |
| deployments write | read Deployments, write statuses with environment URLs |
| checks read, statuses read | deploy gate |
| contents write, workflows write | push branch `dokploy/connect-<service>` (GitHub requires `workflows` for `.github/workflows/`) |
| pull_requests write | open the PR (already requested) |
| secrets write | write ITS OWN registry credential as an environment secret |
| attestations read | optional badge |

Webhook events: push, pull_request, plus deployment, check_run and workflow_run (wake-up only; acceptance never uses a `workflow_run` run). No administration or environments permission. Pull access to GHCR is not requested: prod never holds a GHCR token.

**Blast radius.** Dokploy pushes only to `dokploy/connect-<service>` and opens a PR; it never writes the default branch. If the installation key or a token leaked, an attacker holding `contents` and `workflows` write could push a hostile workflow to any unprotected branch and, with `secrets: write`, replace repository secrets. Recommend branch protection with required review on the default branch and tracked branch. **Copy the file** needs no write permission and is the default whenever the installation lacks it. Existing providers must accept new permissions on GitHub; the wizard lists exactly which are missing.

## Registry
**Phase 1 provisions no registry credential.** It serves adopters that already use the SSH-tunnel mirror step, plus public GHCR images. **Phase 2** adds a small token service in Dokploy (PR 7) that issues a per-repository, push-only credential for our registry, scoped to `<repo>/*` repositories, and writes it as an environment secret through the App. The workflow then pushes straight to our registry. A registry without token auth (plain htpasswd) cannot scope credentials; the wizard says so and offers GHCR with public images only. The tunnel key goes away when the server-side mirror lands (phase 3).

## Poisoning controls
A branch or same-repo pull request run can run any code the repository allows. Four controls keep it from influencing what the tracked-branch run publishes:
1. **Credential in an environment.** The registry credential and the tunnel key live in a GitHub Environment whose deployment branch policy allows only the tracked branch. The generated build job declares `environment: <env>` (an expression chain when several branches map to several environments). Copy-the-file mode instructs the same. Dokploy reads `GET /repos/{o}/{r}/environments/{env}` and its deployment-branch-policies (repository read access; `actions: read` for the App) and refuses Connect while the policy allows more than the tracked branch. Jobs that start an environment make Actions create its own Deployment; Dokploy ignores any Deployment whose `task` does not start with `dokploy:`.
2. **Digest from the same run.** `existing-image` takes `name@sha256:<digest>` from an output of a job in the same run. The action refuses a tag.
3. **Cache scope.** `cache: gha` is the default. A branch's GitHub cache cannot write the default branch's scope. `cache: registry` is opt-in, needs the environment-scoped credential, and the action refuses it with the repository-wide `GITHUB_TOKEN` on GHCR. `existing-image` mode inherits the cache trust of the user's own build job, which Dokploy cannot see. The advisory scan therefore requires, and the cutover lanes require for own-workflow adopters (SuperBooks, upAPI, Caly, Postify), that the build job uses `cache: gha` or an environment-scoped credential; a registry cache written with a repository-wide credential is refused in the wizard and in cutover review.
4. **Namespace and order.** Digests must sit in the connection's namespace and arrive in commit order.

**Fail closed.** Repository-secret mode exists only for repositories where GitHub explicitly reports environments unavailable (a plan limit) and the user confirms in the wizard, in plain words, what then protects the build: controls 2 to 4 hold, `cache: registry` is refused, and acceptance rule 5 is skipped. A read error, a missing environment or a policy wider than the tracked branch is never a downgrade: Connect stays blocked and acceptance refuses.

## Generated workflow
```yaml
name: Dokploy
on:
  push:
    branches: [main]
    paths: [apps/web/**, packages/**, pnpm-lock.yaml]
  workflow_dispatch:
concurrency:
  group: dokploy-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false
permissions: { contents: read, packages: write, deployments: write, actions: read }
jobs:
  release:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: DevinoSolutions/dokploy-release@v1
        with: { environments: "main=production", service: web, dockerfile: apps/web/Dockerfile, secrets: NPM_TOKEN }
        env: { NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" }
```
20 lines; 19 without the `paths:` filter, which is generated from the build context only for monorepos. A registry push adds `registry:` and one `env` secret. Action refs are pinned by sha when the repository already pins. The file is static after the first PR, with one exception: adding an environment edits `on.push.branches`, `environment:` and `environments` through a user-started delta PR. Updates ship as action versions on `v1`; a Dependabot bump is the user's choice. Without Dokploy the user keeps the images, the Deployments and a plain build workflow.

## Action inputs and outputs
| Input | Meaning |
|---|---|
| `environments` | `branch=environment` pairs |
| `service` / `services` | one key, or a YAML list (compose `build:` entries expand to it) |
| `image`, `registry`, `context`, `dockerfile`, `target`, `builder` | build; `builder` is dockerfile, nixpacks or railpack |
| `secrets`, `build-args` | secret names read from the step's `env`, mounted as BuildKit secrets; plain args |
| `existing-image` | `name@sha256:<digest>` taken from an output of a job in the same run (`needs.<job>.outputs.image`); a tag is refused; builds nothing |
| `cache` | `gha` (default), `registry` (opt-in, see poisoning controls), `none` |
| `compose`, `migrations` | compose path; one-off command (phase 3) |
| `mode` | `release` (default), `preview`, `build-only` |
| `delivery` | `pull` (default) or `push` (migration) |

Outputs: `digest`, `image`, `release-id`. There is no `wait` input: Dokploy accepts a release only after the run concludes, so a run cannot wait for the deploy; the result appears as Deployment statuses afterwards. The action reads the runner's Docker mirrors and gives them to buildx as a generated buildkitd config. It fails early, naming the empty secret.

## Wizard UX
Service header: **Build on GitHub Actions**. Nothing below changes the service until the user confirms Connect (step 7).
1. **Access.** "Dokploy can open pull requests in acme/shop: yes." Otherwise the mode is Copy the file.
2. **Detect.** "We found Dockerfile at ./Dockerfile." A pick-list appears only when several candidates exist (Dockerfile, compose, nixpacks, railpack).
3. **Environment and secrets.** "Create the GitHub environment `production`, set Deployment branches to `main`, and add your secrets there. Your Dockerfile asks for NPM_TOKEN. Dokploy never sees the value." Dokploy checks the branch policy and blocks Connect until it matches (see poisoning controls).
4. **Existing automation (advisory).** A fixed-string scan (`docker/build-push-action`, `docker push`, `/api/deploy/`, `application.deploy`, `compose.deploy`, `DOKPLOY_URL`, our action name). It reports file names and line numbers only, stores nothing, edits nothing. Build+push found: "Let Dokploy build", or "Use my existing image". The second shows a snippet to paste into the user's own build workflow (a job with `needs:` on their build job and `existing-image` from its output) and records that workflow's path; Dokploy never edits it. A Dokploy API or webhook deploy found: blocked, "Two deployers racing is unsafe. Remove it, then scan again." (adopters use the guard below instead.)
5. **Options.** Environment, tracked branch, runner label, deploy gate. Waiting for CI is the gate's job, not a trigger.
6. **Review.** YAML preview. **Open pull request**, **Copy file**, or **I'll wire it myself** ("No pull request is made. Without the workflow no release ever arrives."). An existing `dokploy.yml` is diffed: "Already connected" or a delta PR. Hard cases (monorepo per-app workflows, protected environments for build args, custom runner labels) show the file with "Edit it yourself" and a warning.
7. **Connect.** The moment the user confirms, git autodeploy is turned off for the service, so only one deployer can fire. The deployed commit is recorded. The first run shows live in the GitHub Actions row and modal.

## Connection state machine
| State | Enters when | Row text |
|---|---|---|
| Not connected | start; PR closed unmerged | none |
| Proposed | PR open | "Waiting for you to merge pull request #12." |
| Detected | our action or reusable workflow found on the tracked branch (fixed-string search) | "Workflow found. Waiting for a release." |
| Waiting | user confirmed Connect; expected sha = branch head | "Waiting for GitHub Actions to publish 3f9c2a1. Git autodeploy is off." |
| Connected | first accepted release arrives, its image pulls | "Deployed from GitHub Actions." |
| Stale | see below | "GitHub Actions has not published commit 3f9c2a1. Last release 8d41b07, 2 days ago." |
| Blocked | gate failing, verification refused, release incomplete | the reason, with Retry or Deploy anyway |
| Disconnected | token revoked or App uninstalled | "GitHub access was lost. Reconnect." |

Only the move to Connected flips the service, in the proven order: fresh backup or dump, `saveDockerProvider` at the first release digest, disconnect git, update. The old git settings are kept in `previousSource`. A first release whose commit is an ancestor of the deployed one is refused with that message.

Other transitions:
- **Stale:** head advanced, a run of the workflow exists for it, no release within tolerance (larger of 15 minutes and twice the median of the last five runs, counted from that run's end). A run queued over 30 minutes (configurable): "queued for 40 minutes, is a runner online?". Branch deleted or renamed. Force-push leaving the deployed commit off the branch: "deployed commit no longer on branch". Workflow file removed: "dokploy.yml was removed from main". A push that triggers no run never makes a service Stale.
- **Blocked exits:** a successful re-run, a gate mode change, or a manual override, which is logged.
- The repo key is its id; rename changes nothing.
- Gate start, supersede state and processed (run id, attempt) pairs are persisted. On boot Dokploy reconciles from GitHub and replays nothing twice.
- "Test connection" dispatches the workflow if it has `workflow_dispatch` (needs `actions: write`), else says "Push a commit to main."

## Deploy gate (T-13720)
Per-service setting, no workflow edit: **Deploy when** `image built` (default for existing adopters), `all checks on the commit pass` (default for wizard-created services), or `these workflows pass`.
- **Expected check set**, first that applies: branch-protection required checks or ruleset required checks (`GET /repos/{o}/{r}/rules/branches/{branch}`, and `protection.required_status_checks` of `GET .../branches/{branch}`; skipped if unreadable); else the check-run names of the last green commit among the last ten on the branch; else the fallback: wait until at least one check-run or commit status exists on the commit and none is queued, in progress or pending. Repositories with only commit statuses (check-runs `total_count` 0) use the fallback.
- **Latest attempt per name decides.** `success`, `neutral`, `skipped` pass. A failing latest attempt makes the release Blocked; a successful re-run un-Blocks it automatically. A name that never reports within the timeout (default 60 minutes, configurable) blocks with "check X never reported".
- `these workflows pass` matches workflow-run names for the commit.
- The release run and Dokploy's own statuses are excluded. A pending gate posts `queued` ("Waiting for CI"). A newer release supersedes a waiting one. Deploy anyway is audited.
- Evaluation reuses buildPolicy `requiredChecks` (`evaluateRequiredChecks`, `github-checks.ts`).
- SuperBooks and Caly use `workflow_run` on CI. That trigger is not accepted, so they move to a push trigger plus gate "workflows: CI". A key with no connected service is published and ignored, which is today's dry run.

## Other behavior
- **Migrations (phase 3).** Dokploy runs the manifest's one-off command with the service's env before the swap, after a backup when a policy covers its database. Failure keeps the old release running: "Migration failed". Waiting shows "Migration pending". `destructive: true` needs a click.
- **Rollback and retention.** `gha_release` keeps each release's digests. Rollback uses buildPolicy `rollbackToDigest`. Retention keeps the last N releases (default 10) plus pinned ones. Registry GC reference-counts shared and pinned digests before deleting. A digest gone from the registry shows "image no longer in registry".
- **Outage escape hatch.** "Build once on Dokploy" uses `allowLocalBuildOnce` from `previousSource` without changing the service source, is marked off-path in provenance, and the next release supersedes it.
- **PR previews (phase 3).** Separate acceptance, never touching the service: event `pull_request`, head repository id equals the repo id (no forks), preview enabled on the service, deploys only into compose preview deployments (#189). The preview job uses its own GitHub Environment (`preview`) and never receives the service's secrets: its credential is scoped to `<repo>/preview/*` repositories, which production acceptance rejects. `preview/pr-<n>` is just an environment name. Closing the PR removes the preview.
- **Build cost.** GitHub cache by default, runner label in the wizard, daemon-advertised mirrors in buildkitd.
- **Drift.** For GHA-owned services the image and compose are read-only in the UI and rejected by the API ("Managed by GitHub Actions"). Env vars stay editable. **Take over locally** restores `previousSource` and is audited.
- **Multi-instance.** The manifest carries the environment; each instance follows its own pairs. Connect refuses a pair another instance wrote statuses for in the last 30 days.
- **Polling budget.** Per repository at 20 s: 180 Deployment-list and 180 run-list requests an hour, 360 worst case with no conditional benefit. A release costs about 15 more. A 304 to a conditional request does not count against the limit. A 5000-an-hour token therefore fits 13 repositories even unconditionally, and many more with ETags. After 24 hours without a run or release a repository's interval grows to 120 s; a webhook or a manual action resets it.
- **Upstream divergence.** Schema, action and fixtures live in the action repository. The fork holds a parser module with vendored-schema tests, the poller extension and new UI files, with one touch point in the Provider tab.

## Security summary
The acceptance rules and the four poisoning controls are the control. To ship an image, an attacker needs all of: merge rights on the tracked branch (the run's `head_branch`); a build job that passes the environment's deployment branch policy, so the registry credential and tunnel key are unreachable from other branches and pull requests (where the plan has environments); and a build cache scope other branches cannot write. Without environments the second condition is absent, and the digest-from-output rule plus the `gha` cache default carry the protection. Digests are limited to the connection's namespace and arrive in commit order. The `@v1` tag moving is the user's trade-off; sha pinning works. No build secret ever reaches Dokploy. Pull requests are never auto-merged.

## Migration path: 10 repositories
The final `dokploy-compose.yml` becomes a wrapper over the action with the same inputs. `DOKPLOY_API_KEY` and `DOKPLOY_URL` stay optional secrets and inputs. Callers with a `permissions:` block add `contents: read`, `deployments: write`, `actions: read`, and `packages: write` if GHCR. The wrapper's default cache becomes `gha`; a caller keeps `registry` only with an environment-scoped credential. The cutover lanes do the sha bump; the wizard never edits workflows.
| Shape | Repositories |
|---|---|
| Calls shared `dokploy-compose.yml@sha` | SnapVisor, Shorty, Notifly, Uptimely, Demofy, voicekit (web and engine files) |
| Own workflow with `dokploy-deploy` and `dokploy-register-build` | SuperBooks, upAPI, Caly |
| Own `build-deploy.yml`, no shared action found | Postify |

Per repository:
1. Bump to the wrapper with `push_deploy: true` (today's behavior) and manifest publishing on (`delivery: push`). Dokploy verifies the manifest, advances the recorded deployed commit, and does not deploy.
2. The instance reaches Connected on a real release (the digest equals what the push deploy ran: no-op).
3. Set `push_deploy: false`, through a repository variable the wrapper reads so no file edit is needed. Manifests become `delivery: pull`.
For SuperBooks, upAPI, Caly and Postify, review of the cutover PR checks the cache trust rule from the poisoning controls.
Both deployers are never active at once: Dokploy deploys only `pull` manifests, and the wrapper makes the API call only while `push_deploy` is true.

## Open questions
1. **Scoped registry credentials.** Our registry needs token auth to scope push to `<repo>/*`, and GitHub-hosted runners must reach it. Recommend the Dokploy token service (PR 7), with self-hosted runners for private networks. It could also issue credentials by exchanging the run's GitHub OIDC token, so no secret is stored and private repositories without environments are covered. Store a secret (decided) or exchange OIDC (recommended once the service exists)?
2. **Action namespace.** `dokploy-community` is an existing organization we do not control. Recommend `DevinoSolutions/dokploy-release`, public.
3. **App model.** Per-instance App (no shared private key) or one shared official App. Recommend per-instance.
4. **Phase 1 token breadth.** Accept the `repo` scope as an interim until the App, or hold phase 1 for the App? Recommend accept, with the scope shown in the connect dialog.

## Phased delivery
**Phase 1: manifest, acceptance, connection** (on #577, no App change). Limited to adopters already on the SSH-tunnel mirror and to public GHCR images; no registry credential is provisioned.
- PR 1 (action repo): action, schema, fixtures, artifact upload, Deployment creation.
- PR 2: `gha_connection`, `gha_release`, scope change, router and MCP.
- PR 3: acceptance engine (run, artifact, registry HEAD, ordering), migrations refusal.
- PR 4: state machine (Detected to Connected, Stale), flip, run discovery for live rows, statuses with URLs, polling budget, Copy-the-file connect UI.
- PR 5 (`.github`): wrapper with `push_deploy` and `delivery`; the ten per-repository cutovers.

**Phase 2: App and wizard.**
- PR 6: manifest permissions, upgrade banner, per-repo tokens.
- PR 7: registry token service (per-repo push-only credentials, environment secret write via `secrets: write`).
- PR 8: scan, detection, environment-policy check, secret-name listing.
- PR 9: branch and PR creation, delta PRs, wizard UI, take over locally.

**Phase 3: gate, migrations, previews.**
- PR 10: deploy gate (T-13720).
- PR 11: migrations, retention, reference-counted GC, server-side mirror of public GHCR digests (retires the tunnel key).
- PR 12: previews, local build once, multi-instance guard.
