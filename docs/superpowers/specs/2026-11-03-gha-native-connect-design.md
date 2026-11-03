# Build on GitHub Actions, connected natively (T-13719, gate T-13720)

Status: design, 2026-11-03. Builds on c42 to c46 (provenance pill, live GitHub Actions rows, run modal, `github-run-poller`) and on open PR #577 (GitHub Deployments pull, device flow, poller; head 7a4c11d0). Nothing here is implemented.

## Goal
A user turns any GitHub-sourced application or compose into a GitHub Actions-built service from the dashboard. The repository gets one short, hand-written-looking workflow. The workflow holds no Dokploy credential and no Dokploy address. It builds, pushes by digest and publishes a release manifest. Dokploy fetches it and deploys.

## Non-goals
- No rewrite of existing workflows, ever. No Dokploy API key, URL or resolve hack in a repository.
- No other forge in this work. The manifest is forge-neutral so GitLab, Gitea and Bitbucket adapters can follow.
- No change to push-based deploys for Dokploys GitHub can reach (the legacy action keeps working).

## Architecture
```
 repo: .github/workflows/dokploy.yml  (static, ~12 lines)
   uses DevinoSolutions/dokploy-release@v1
     build -> push ghcr by digest -> [attest] -> create GitHub Deployment, payload = manifest
                                   |
 GitHub: Deployment + statuses <---+---> Actions runs, check-runs, statuses
                                   |
 Dokploy (outbound only): poller (#577, 20 s, ETag) ----> verify (creator, run, digest, registry)
   run discovery (new)  -> live row            -> gate (checks / workflows) -> migrations
   App token (per repo) -> PR, check-runs      -> mirror digest to org registry -> deploy by digest
                        -> Deployment status + environment_url -> row: GitHub Actions
```
Components:
- **Release manifest** (`dokploy.release/v1`): the contract, lives with the action, not in this fork.
- **Action** `DevinoSolutions/dokploy-release@v1`: public repo, composite, pinned third-party actions.
- **GitHub App**: the existing per-instance App provider (manifest flow in `add-github-provider.tsx`) with extra permissions. Device flow stays for sign-in and GHCR pulls.
- **Poller**: #577 extended. It also discovers live rows by listing runs of the pinned workflow on the tracked branch, so the row appears when the run starts, with no call from the workflow.
- **Connection record**: table `gha_connection` (service, repo, branch, environments, workflow path, state, expected sha, gate, retention, `previousSource` snapshot). Not added to `application` (100-argument cap). Release history: table `gha_release`.

## Release manifest
One GitHub Deployment per service per release, `task: dokploy:<key>`, `environment: <env>`, statuses with `auto_inactive: false`. Payload is `{"release": <manifest>}`: few top-level keys, compact, inline manifest under 2 KiB (compose goes by `path`, read at the commit). PR 1 measures GitHub's real payload limits before the schema freezes.
```json
{
  "schema": "dokploy.release/v1",
  "release": { "id": "gh-9876543210.1", "services": ["web", "worker"] },
  "source": { "forge": "github", "repository": "acme/shop", "commit": "3f9c2a1e...40hex",
              "ref": "refs/heads/main", "runId": "9876543210", "runAttempt": 1,
              "workflow": ".github/workflows/dokploy.yml" },
  "environment": "production",
  "services": [{
    "key": "web",
    "images": [{ "name": "web", "composeService": "web",
                 "ref": "ghcr.io/acme/shop-web@sha256:e31c...64hex", "attested": false }],
    "compose": { "path": "docker-compose.prod.yml" },
    "migrations": { "command": ["pnpm", "db:migrate"], "timeoutSeconds": 900, "destructive": false },
    "preview": null
  }]
}
```
The GitHub transport keeps only the addressed service in `services` and the full key list in `release.services`, so Dokploy knows when a multi-service release is complete. Unknown minor fields are ignored; unknown `schema` majors are refused with a row message. #577's `{dokploy:{serviceId,image}}` payload is still accepted.

## GitHub App permissions (repository, minimal)
| Permission | Why |
|---|---|
| metadata read | mandatory |
| contents write | branch `dokploy/connect`, read Dockerfile, compose and workflow names at a sha |
| workflows write | required by GitHub to touch `.github/workflows/` |
| pull_requests write | open the PR (already requested) |
| deployments write | read Deployments, write statuses with environment URLs |
| checks read, statuses read | deploy gate |
| actions write | runs, jobs, logs (live rows); dispatch for "Test connection" |
| packages read | confirm a digest exists |
| attestations read | optional verification |

Account: emails read (sign-in, existing). Events: push, pull_request, plus deployment, workflow_run, check_run. Webhooks are an accelerator for instances with a public URL. Polling is the default transport and always runs. No secrets, administration or environments permission is requested. Existing providers must accept the new permissions on GitHub; until then the wizard shows exactly which are missing and offers "Copy file" instead of "Open pull request".

## Generated workflow
```yaml
name: Dokploy
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency: { group: dokploy-production, cancel-in-progress: false }
permissions: { contents: read, packages: write, deployments: write }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DevinoSolutions/dokploy-release@v1
        with: { environments: "main=production", service: web, dockerfile: Dockerfile, secrets: NPM_TOKEN }
        env: { NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" }
```
Action refs are pinned by full sha with a version comment when the repository already pins. A second instance following another branch adds one `environments` pair through a user-started delta PR. The file never changes otherwise; updates ship as action versions on the `v1` tag, and a Dependabot bump is the user's choice. Without Dokploy the user keeps the images, the Deployments and a plain build workflow.

## Action inputs and outputs
| Input | Meaning |
|---|---|
| `environments` | `branch=environment` pairs, default `main=production` |
| `service` / `services` | one key, or a YAML list for several images (compose `build:` entries expand to it) |
| `image`, `context`, `dockerfile`, `target`, `builder` | build; `builder` is dockerfile, nixpacks or railpack; image defaults to `ghcr.io/<repo>[-key]` |
| `secrets`, `build-args` | secret names, read from the step's `env` and mounted as BuildKit secrets; plain args |
| `existing-image` | tag template of an image the user's own workflow pushes; the action waits, resolves the digest and builds nothing |
| `cache` | `registry` (default), `gha`, `none` |
| `compose`, `migrations` | compose path; one-off command |
| `mode` | `release` (default), `preview`, `build-only` |
| `wait` | poll the Deployment status for N minutes so the run mirrors the deploy; default off |

Outputs: `digest`, `image`, `release-id`, `deployment-ids`. By default the action reads the runner's Docker daemon mirrors and hands them to buildx as a generated buildkitd config, so the pool's pull-through cache applies with no input. It fails early, naming the empty secret, when a listed secret is missing.

## Wizard UX
Service header: **Build on GitHub Actions** (github source only).
1. **Access check.** "Dokploy can open pull requests in acme/shop: yes." Missing permissions are listed with an Update permissions link.
2. **Detect.** "We found Dockerfile at ./Dockerfile." If several candidates (Dockerfile, compose, nixpacks, railpack) exist, a pick-list asks; nothing is guessed.
3. **Build secrets.** "Your Dockerfile asks for NPM_TOKEN and SENTRY_TOKEN. Add them as repository secrets. Dokploy never sees the values."
4. **Existing automation (advisory).** A fixed-string scan of workflow files (`docker/build-push-action`, `docker push`, `/api/deploy/`, `application.deploy`, `compose.deploy`, `DOKPLOY_URL`, our action name). It reports file names and line numbers only, stores nothing, edits nothing. An existing build+push offers "Use my existing image" or "Let Dokploy build". An existing Dokploy API or webhook deploy blocks the connection: "Two deployers racing is unsafe. Remove it, then scan again."
5. **Options.** Environment, tracked branch, runner label, deploy gate, and "Also wait for my workflow `ci`" (adds `workflow_run`).
6. **Review.** YAML preview. **Open pull request**, **Copy file**, or **I'll wire it myself** ("No pull request is made. You must add the workflow, or releases never arrive."). An existing `dokploy.yml` is diffed: "Already connected" or a delta PR. Hard cases (monorepo per-app workflows, protected environments for build args, custom runner labels) show the file with "Edit it yourself" and a warning.
7. **Progress.** The service's GitHub Actions row and run modal show the first run live.

## Connection state machine
| State | Enters when | Row text |
|---|---|---|
| Proposed | PR open | "Waiting for you to merge pull request #12." |
| Detected | our action, reusable workflow or Deployments call found on the default branch | "Workflow found. Waiting for a release." |
| Waiting for first release | Detected; expected sha is the branch head; service stays Dokploy-built or paused by choice | "Waiting for GitHub Actions to publish 3f9c2a1." |
| Connected | first release for a commit on the tracked branch (sha equals head or is its ancestor) arrives, passes verification, and the image pulls | "Deployed from GitHub Actions." |
| Stale | head advanced, a run of the workflow exists for it, no release within tolerance (the larger of 15 minutes and twice the median of the last five runs, counted from that run's end) | "GitHub Actions has not published commit 3f9c2a1. Last release 8d41b07, 2 days ago." |
| Blocked | gate failing, migration failed, or verification refused | the reason, with Deploy anyway or Retry |

Only the move to **Connected** flips the service, in the proven order: fresh backup or dump, `saveDockerProvider` at the first release digest, disconnect git, autoDeploy off, deploy by digest. The old git settings are kept in `previousSource`. "Test connection" dispatches the workflow if it has `workflow_dispatch`, else says "Push a commit to main." A push that triggers no run never makes a service Stale.

## Deploy gate (T-13720)
Per-service Dokploy setting, no workflow edit: **Deploy when** `image built` (default), `all checks on the commit pass`, or `these workflows pass`.
- Source is check-runs plus the combined status for `source.commit`, latest attempt per name. `success`, `neutral` and `skipped` pass. "Workflows" matches workflow-run names.
- Always excluded: the release run itself and Dokploy's own statuses, so the gate cannot wait on itself.
- A pending gate posts a `queued` status ("Waiting for CI"), re-evaluated on every tick and on `check_run` webhooks. A failure fails fast with the failing names. Timeout 60 minutes, then Blocked. A newer release for the same service supersedes a waiting one. Deploy anyway is audited.
- This reuses buildPolicy `requiredChecks` evaluation (`evaluateRequiredChecks`, `github-checks.ts`), which gates Dokploy-built deploys today.
- SuperBooks maps directly: its `workflow_run` on CI plus `SB_DIGEST_APPS_*` lists becomes a push trigger with gate "workflows: CI". A key with no connected service is published and ignored, which is today's dry run.

## Other behavior
- **Migrations.** Dokploy runs the one-off command from the manifest in a container with the service's env, before the swap, after a backup when a backup policy covers its database. Failure leaves the old release running and shows "Migration failed". While waiting: "Migration pending". `destructive: true` needs a click.
- **Rollback and retention.** Each release stores its digests in `gha_release`. Rollback uses buildPolicy `rollbackToDigest`. Per-service retention keeps the last N releases (default 10) plus pinned ones. Dokploy mirrors each digest into the organization registry server-side (replacing the SSH-tunnel copy in CI) and registry GC prunes outside retention. GHCR is never pruned by us; a digest gone there shows "image no longer in registry".
- **Outage escape hatch.** "Build once on Dokploy" runs through `allowLocalBuildOnce` from `previousSource` without changing the service source. The deployment is marked off-path in provenance and the next release supersedes it.
- **PR previews.** `mode: preview` on non-fork pull requests publishes a transient environment `preview/pr-<n>`. Compose previews (#189) consume the same manifest and report the preview URL; closing the PR removes it.
- **Build cost.** Registry cache by default, self-hosted runner label in the wizard, daemon-advertised mirrors in buildkitd.
- **Drift.** For GHA-owned services the image and compose are read-only in the UI and rejected by the API, with banner "Managed by GitHub Actions." Env vars stay editable. **Take over locally** restores `previousSource` and is audited.
- **Multi-instance.** The manifest carries the environment. Each instance subscribes to the pairs it owns. Statuses carry the instance id, and Connect refuses a pair that another instance wrote to in the last 30 days.
- **Upstream divergence.** The schema, action and fixtures live in the action repo. The fork holds a parser module with vendored schema tests, the poller extension and new UI files, with one touch point in the Provider tab.

## Security model
- Accept a Deployment only if: the creator is the `github-actions` bot (app id 15368) for that exact repository; `ref` is the tracked branch (or `preview/` for previews); the payload run id resolves via the App token to a run of that repository, with `head_sha` equal to the Deployment sha, the pinned workflow path, an allowed event, and no fork head.
- Every digest must exist in a trusted registry: the user's GHCR namespace or a configured registry, same repository as the service runs after the first release. A mismatch is refused.
- Optional attestation check (GitHub artifact attestations or cosign): the subject digest, repository and workflow path must match. Default off, because private repositories on some plans cannot create attestations.
- Tokens are per installation and per repository. Dokploy holds no build secret. The PR is never auto-merged and branch protection is respected.
- Residual risk: anyone who can merge to the tracked branch can ship, as with autodeploy today. The `@v1` tag moving is the user's trade-off; SHA pinning is supported.

## Migration path for the 9 adopters
The final shared workflow `dokploy-compose.yml` release becomes a wrapper over the new action, with the same inputs. Each adopter re-pins once. The cutover lanes do it, not the wizard, because the wizard never modifies workflows.
| Shape | Adopters | Change |
|---|---|---|
| Calls shared `dokploy-compose.yml@sha` | SnapVisor, Shorty, Notifly, Uptimely, Demofy, voicekit (web, engine) | one sha bump; `DOKPLOY_API_KEY` and `DOKPLOY_URL` deleted afterwards |
| Own workflow with `dokploy-deploy` and `dokploy-register-build` | SuperBooks, upAPI, Caly (`deploy-prod.yml`, `workflow_run`) | the two steps become one `existing-image` call; triggers and lists stay; the tunnel mirror step is deleted |
| Own `build-deploy.yml`, no shared action found | Postify | same as the row above |

Dokploy marks each already-image-sourced service Detected and then Connected on its first manifest.

## Open questions
1. **GHCR pull credential.** Installation tokens do not log in to ghcr.io (to verify in phase 2). Recommend the #577 device-flow token from a dedicated machine GitHub user, plus the server-side registry mirror.
2. **Action namespace.** `dokploy-community` is an existing GitHub organization we do not control. Recommend `DevinoSolutions/dokploy-release`, public, and a move only if the namespace is secured.
3. **Per-instance App or one shared App.** Recommend per-instance (no shared private key); a shared App could be added later for hosted use.
4. **Attestations.** Recommend advisory by default, required only when the repository is public or the user opts in.
5. **Gate default.** Recommend `image built` for existing adopters and `all checks` for services created through the wizard.

## Phased delivery
**Phase 1: manifest, poller, action** (on #577).
- PR 1 (action repo): action, schema, fixtures, payload-limit measurement.
- PR 2: manifest parser, verification (creator, run, digest, registry), `gha_release`.
- PR 3: run discovery for live rows; Deployment statuses with environment URLs.
- PR 4 (.github): final `dokploy-compose.yml` wrapper; adopter re-pins.

**Phase 2: App and wizard.**
- PR 5: manifest permissions, permission-upgrade banner, token minting per repo.
- PR 6: scan, detection and secret-name listing.
- PR 7: PR creation, `gha_connection` state machine, flip, `previousSource`, take over.
- PR 8: wizard UI, rows and Stale text.

**Phase 3: gate, migrations, previews.**
- PR 9: deploy gate (T-13720).
- PR 10: migrations, retention, registry mirror and GC.
- PR 11: previews on compose, local build once, multi-instance guard.
