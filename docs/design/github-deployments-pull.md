# Deploy from GitHub Deployments (pull)

Design note for GetItDone T-12166.

## Why

A Dokploy instance that sits behind Tailscale or a private network cannot be
called by GitHub Actions: the hosted runners have no route to its API, so the
`dokploy-deploy` action (which POSTs `application.deploy` / `compose.deploy`)
cannot reach it. The usual workarounds are all worse: a self-hosted runner on the
tailnet per repository, a public tunnel to the Dokploy API, or an API key stored
in GitHub that is valid for the whole instance.

The fix is to reverse the direction. Dokploy makes only outbound HTTPS calls, to
`api.github.com`. GitHub Actions records the intent as a **GitHub Deployment**;
Dokploy sees it, deploys, and reports the result back as a **deployment status**
that the workflow can wait on.

A self-hoster should be able to turn this on with one click and no GitHub App.
Connecting uses the OAuth **device flow** of a public OAuth App, "Dokploy
Community". There is no client secret and nothing to paste.

Not goals: replacing the push flow (it stays for reachable Dokploys), building
images (Dokploy never builds here), or deploying anything that is not pinned by
digest.

## Flow

```
 GitHub Actions                         GitHub                         Dokploy (private network)
 --------------                         ------                         -------------------------
 build + push image
   ghcr.io/o/app@sha256:...
 POST /repos/o/r/deployments  ------->  Deployment #123 created
   environment: production              payload {dokploy:{serviceId,image}}
   required_contexts: []
   auto_merge: false
 poll .../deployments/123/statuses
        |                                                                every 20s, per watch:
        |                                <---------------------------    GET /repos/o/r/deployments
        |                                                                    ?environment=production&per_page=5
        |                                                                    If-None-Match: <etag>
        |                                --------------------------->    200 (new) or 304 (free)
        |                                                                for each id > lastSeen, ascending:
        |                                                                  payload names this service?
        |                                                                  image pinned by digest?
        |                                                                  same repository as the service runs?
        |                                                                transaction:
        |                                                                  lastSeen = 123, inflight = 123,
        |                                                                  set image, enqueue the deploy
        |                                <---------------------------    POST .../deployments/123/statuses
        |                                   state: in_progress             (log_url -> Dokploy deployment page)
        |                                                                normal Dokploy deploy runs
        |                                <---------------------------    POST .../deployments/123/statuses
 sees success / failure                    state: success | failure        (description: short result)
```

Three parts, each independent:

1. **Connect GitHub** (Settings > Git Providers): one OAuth token per
   organization account, encrypted.
2. **Watch per service** (Advanced tab of an application or compose): which
   repository, environment and connection the service follows.
3. **Poller**: one loop in the Dokploy server process.

## 1. Connect GitHub (device flow)

OAuth App "Dokploy Community", client id `Ov23liBkg97sIGx9nKb6`. The id is
public, so it is a constant in code, overridable with the environment variable
`DOKPLOY_GITHUB_DEVICE_CLIENT_ID` (a fork or a self-hoster's own OAuth App). The
app has no client secret and its tokens do not expire.

1. `POST https://github.com/login/device/code` with `client_id` and
   `scope=repo_deployment read:packages`. GitHub answers `device_code`,
   `user_code`, `verification_uri`, `expires_in`, `interval`.
2. The UI shows `user_code` and a link to `verification_uri`. The `device_code`
   never leaves the server: the browser holds only an opaque `flowId`.
3. Dokploy polls `POST https://github.com/login/oauth/access_token`
   (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) no faster than
   `interval`. The browser polls `githubDeployment.completeConnect`; the server
   enforces the interval itself, so a fast browser cannot cause a `slow_down`.

   | GitHub answer           | Dokploy does                                          |
   | ----------------------- | ----------------------------------------------------- |
   | `authorization_pending` | wait one more interval                                |
   | `slow_down`             | interval += 5 s (or the `interval` GitHub names)      |
   | `expired_token`         | stop; "the code expired, start again"                 |
   | `access_denied`         | stop; "authorization was denied"                      |
   | `device_flow_disabled`, `incorrect_*` | stop with a message                     |
   | network error / 5xx     | keep waiting                                          |
   | `access_token`          | `GET /user` for the login, store the token, done      |

4. The token is stored in `github_deployment_connection.accessToken`, an
   `encryptedText` column (AES-256-GCM through `lib/encryption.ts`, the same
   helper that protects other provider secrets). The connection belongs to the
   organization, shows the GitHub login and the granted scopes, and has a
   Disconnect button. Disconnect deletes the row, and with it every watch that
   used it. (GitHub's side of the grant can only be revoked by the user, under
   Settings > Applications, because revoking needs the client secret the app does
   not have.)

The token is never part of any tRPC output, so never part of an MCP tool result.
`presentGithubConnection` is the only shape that leaves the server.

## 2. Watch per service

New table `github_deployment_watch` (nothing is added to `application` or
`compose`: the application table is at the Drizzle / Postgres 100-argument cap,
error 54023).

| column                  | meaning                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `serviceType`, `serviceId` | `application` or `compose`, and its id (unique together)   |
| `connectionId`          | which GitHub account to use                                   |
| `owner`, `repo`         | the repository to follow                                      |
| `environment`           | GitHub environment name, default `production`                 |
| `enabled`               | switch                                                        |
| `lastSeenDeploymentId`  | highest GitHub deployment id handled                          |
| `etag`                  | ETag of the last fully handled list response                  |
| `inflightDeploymentId`, `inflightStartedAt` | the deployment being deployed now         |
| `lastCheckedAt`, `lastError` | status for the UI                                        |

`github_deployment_connection` holds the encrypted token, the login, the scopes
and a `status` (`active`, or `revoked` after GitHub answers 401).

Migration `0226_github_deployment_watch` is additive and idempotent
(`CREATE TABLE IF NOT EXISTS`, constraints in `DO $$ ... EXCEPTION` blocks), so it
passes `__test__/db/migration-idempotency.test.ts`. PR #576 (T-12149) already
uses 0225; if the merge order differs, renumber (the file name, the journal entry
and the snapshot).

Changing the repository, environment or account resets the cursor (`lastSeen`,
`etag`, in flight) so the next poll starts fresh.

## 3. The poller

Runs in the Dokploy server process, self-hosted only (`IS_CLOUD` skips it),
started from `server.ts` next to the deployment watchdog and after the queue
restore, with the same pattern: one `setInterval` (unref'd), one tick at a time,
run through `runBackgroundJob` so a rejection is logged instead of reaching the
process-wide handler. A slow tick is skipped over, never stacked.

The rules are in `packages/server/src/services/github-deployments/poll-core.ts`
behind an injected `PollDeps` (GitHub, clock, database, queue), so they are unit
tested without any of them. `apps/dokploy/server/queues/github-deployments-poller.ts`
is the wiring.

Per enabled watch, every 20 seconds:

1. **Skip** if the watch or its connection is backed off (below), or the token is
   missing or revoked.
2. **In flight?** If a GitHub deployment is being deployed, look only at that:
   - the Dokploy deployment (found by its title `GHA GitHub deployment #<id>`)
     is `done` -> `success`; `error` -> `failure`; `cancelled` -> `failure`;
   - still running or waiting in the queue -> wait;
   - running for more than 90 minutes -> `failure` ("did not finish in time");
   - no row and not in the queue for 10 minutes -> `failure` ("no record").
   The status carries `log_url` (the service's Deployments tab) and a short
   `description`. Nothing new is taken until this one ends, so deploys of one
   service never overlap and arrive in order.
3. **List**: `GET /repos/{owner}/{repo}/deployments?environment=<env>&per_page=5`
   with `If-None-Match: <etag>`. A `304` costs no rate limit.
4. **First poll** (no `lastSeen`): remember the highest id and the ETag, deploy
   nothing. Deployments that existed before the watch was enabled never run.
5. **New deployments**: ids above `lastSeen`, ascending. For each:
   - payload has no `dokploy` key, or names another `serviceId`: skip silently
     (another watch, or a human). `lastSeen` moves past it.
   - names this service but the image is not `<repository>@sha256:<64 hex>`:
     answer `failure` ("must be pinned by digest") so the workflow stops waiting,
     and move past it.
   - otherwise **start**: one database transaction takes a row lock on the watch,
     checks nothing else took this id, sets `lastSeen = id` and the in-flight
     marker, writes the image into the service and enqueues the deploy; then POST
     status `in_progress`. Only one deployment is started per tick.
6. **ETag** is saved only after every new deployment in a response was handled
   (answered or skipped). While a started deployment leaves others waiting, the
   stored ETag stays old so the next list returns `200`, not a `304` that would
   hide them.

### How the deploy runs

It is the normal Dokploy deploy, not a special path.

- **Application** (Docker source): `updateApplication({ dockerImage })` with the
  digest reference, then a regular `deploy` job on the deployment queue. Same as
  `application.deploy` with a `dockerImage`, and as the `dokploy-deploy` action's
  `deploy.sh` does. The job title is `GHA GitHub deployment #<id>` (the `GHA `
  prefix is what Dokploy already reads as "built by GitHub Actions").
- **Compose** (file stored in Dokploy): the digest on the single
  `image: <repository>@sha256:...` line is replaced and nothing else changes
  (`pinComposeImage`, the rule of `deploy.sh`'s `render`: exactly one pinned line
  for that repository, the old reference occurring exactly once), then a regular
  `deploy` job.
- **Build origin** (PR #576, T-12149): the job also carries `buildOrigin:
  "github-actions"` and `buildRunUrl` (from `payload.dokploy.runUrl` when it is a
  valid `https://github.com/<o>/<r>/actions/runs/<id>` link). Until #576 is
  merged the queue ignores those two fields (`TODO(T-12149)` in the poller), and
  the `GHA ` title already lets Dokploy infer the origin.
- **Private GHCR images**: `getAuthConfig` (application) and a `docker login
  ghcr.io --password-stdin` before `compose up` (compose) use the watch's
  connection: username = the GitHub login, password = the token, read at pull
  time. The token is not stored on the service and never put in argv or a log
  (`runDockerLogin` feeds it on stdin and redacts failures). The compose login
  persists in the host's Docker config like any `docker login`.

### Idempotency

The cursor claim (`lastSeenDeploymentId` plus the in-flight marker) is taken in a
transaction under a row lock, and the image write and the enqueue run inside that
transaction's scope, in that order: if either throws, the claim rolls back. (The
image write and the queue are not part of the database transaction themselves;
repeating them is harmless because both are idempotent for one digest.) A restart reads `lastSeen` and starts after it, so a
deployment is never deployed twice by a restart. If enqueue or the image write
throws, the transaction rolls back and the next tick retries (three attempts, then
a `failure` status and the deployment is skipped, so a poison deployment cannot
loop). The one window left is a crash between the journaled enqueue and the
commit: the queue journal replays the job and the poller starts the same
deployment again, which deploys the same digest a second time. That is a repeat,
not a wrong deploy.

### Rate limits

- `304` answers are free; a watch costs at most 3 authenticated requests a minute
  when nothing changes, and `GET`s of several watches on one repository do not
  share an ETag (each watch has its own).
- `403` or `429` with `Retry-After`, or with `x-ratelimit-remaining: 0` (wait for
  `x-ratelimit-reset`), or a "rate limit" / "abuse" body: the whole connection is
  paused until then (capped at one hour). Any other `403` is a permission error:
  recorded on the watch, retried after 5 minutes.
- `401`: the connection is marked `revoked`, polling for it stops, the UI says
  "Reconnect".
- A failed status POST is retried on the next tick while the deployment is in
  flight; a `404`/`410`/`422` (deployment deleted) clears it.

## 4. API and MCP

New `githubDeployment` tRPC router; the MCP tools are generated from it, with
descriptions from `.meta({ openapi: { description } })`.

| tool | scope | does |
| ---- | ----- | ---- |
| `githubDeployment-connections` | read | login, scopes, status, last error. Never the token |
| `githubDeployment-startConnect` | admin | begin the device flow: `flowId`, `userCode`, `verificationUri` |
| `githubDeployment-completeConnect` | admin | poll it: `pending`, `connected`, `expired`, `denied`, `failed` |
| `githubDeployment-disconnect` | admin | delete the connection and its token |
| `githubDeployment-watches` | read | every watch of the organization |
| `githubDeployment-watchOne` | read | one service's watch |
| `githubDeployment-watchSet` | admin | create / change / disable a watch |
| `githubDeployment-watchRemove` | admin | stop following |

Connect and disconnect use the existing `gitProviders` permissions; setting a
watch needs `service.create` on the service and `gitProviders.read`. Connections
and watches are checked against the caller's organization.

## Security model

- **Narrow scopes.** `repo_deployment` (read and write deployment statuses and
  create deployments, no code access) and `read:packages` (pull private GHCR
  images). Nothing else is requested; the OAuth App cannot read code.
- **No Dokploy credential in GitHub.** The old flow keeps a Dokploy API key as a
  GitHub secret. Here GitHub holds nothing that can reach Dokploy; Dokploy only
  makes outbound calls.
- **Who can trigger a deploy.** Whoever can create a deployment in the watched
  repository (write access; the same people who can already change what CI
  builds). They can deploy only **the service whose watch points at that
  repository**: the payload's `serviceId` must equal the watch's, and a payload
  for any other id is ignored. They cannot choose any service or any image.
- **Digest required.** `image` must be `<repository>@sha256:<64 hex>`; a tag, a
  short digest or anything with a shell character is refused. The digest cannot
  be re-pointed after the fact.
- **Same repository only.** The image repository must equal the one the service
  already runs (application: the current `dockerImage`; compose: the one pinned
  `image:` line). A service with no image yet accepts only
  `ghcr.io/<owner>/...` of the watched repository's owner. So a deployment can
  move a service to another build of its own image, not to an arbitrary image.
- **Environment protection is not applied by the API.** GitHub enforces required
  reviewers only for jobs that reference the environment. A deployment created
  from a job with `environment: production` has passed that gate; one created
  from a job without it has not. The workflow in the next section uses the
  environment on purpose.
- **Token handling.** Encrypted at rest; never returned by tRPC or MCP, never in
  a log line, argv, status or URL (tests assert it). Read only by the poller, the
  GHCR pull and the `docker login` helper. Disconnect deletes it.
- **Blast radius of a leaked token.** `repo_deployment` + `read:packages` of one
  GitHub account: it can post deployment statuses and read packages that account
  can read. It cannot read code or reach Dokploy.
- **Self-hosted only.** The poller, the connect flow and the watch mutation are
  refused on Dokploy Cloud.

## Failure modes

| situation | result |
| --------- | ------ |
| Dokploy offline when the deployment is created | picked up when it is back, if it is still among the newest 5 of that environment; the workflow's wait times out meanwhile |
| more than 5 deployments in 20 s | the older ones fall outside `per_page=5` and are never seen; one watch per service, so unlikely |
| Dokploy restarts mid-deploy | the queue journal resumes the job; `inflight` survives, so the end is still reported |
| GitHub unreachable | the tick records an error and retries; nothing is lost |
| token revoked or expired | `401`: connection `revoked`, UI asks to reconnect, watches pause |
| repository renamed, deleted, or account lost access | `404`: error shown on the watch, retried every 5 minutes |
| service deleted | its watch is removed on the next tick |
| payload for another service | ignored, no status |
| unpinned / foreign image for this service | `failure` status with the reason |
| deploy fails or is cancelled in Dokploy | `failure` status with the log link |
| GitHub rejects the status POST | retried while in flight |
| two Dokploy servers watch one repository | each acts only on its own `serviceId` |
| the same instance restarted at the commit window | at most one repeated deploy of the same digest |

## GitHub Actions side

The reusable workflow in `DevinoSolutions/.github` that wraps this is a separate
PR; this section is its specification.

### Creating the deployment

The job must be able to write deployments and reference the environment (so its
protection rules apply):

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: build            # outputs.image = ghcr.io/o/app@sha256:...
    environment: production
    permissions:
      deployments: write
      contents: read
    steps:
      - name: Create the GitHub deployment Dokploy pulls
        id: create
        uses: actions/github-script@v7
        env:
          IMAGE: ${{ needs.build.outputs.image }}
          SERVICE_ID: ${{ vars.DOKPLOY_SERVICE_ID }}
        with:
          script: |
            const { data } = await github.rest.repos.createDeployment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: context.sha,
              environment: 'production',
              required_contexts: [],      // do not wait for commit statuses
              auto_merge: false,          // never merge the default branch in
              transient_environment: false,
              production_environment: true,
              description: `Deploy ${context.sha.slice(0, 7)}`,
              payload: {
                dokploy: {
                  serviceId: process.env.SERVICE_ID,
                  image: process.env.IMAGE, // <repository>@sha256:<64 hex>, required
                  runUrl: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
                },
              },
            });
            if (!data.id) throw new Error('GitHub did not create a deployment');
            core.setOutput('id', data.id);
```

The same with `gh api` (a JSON body keeps the empty `required_contexts` list and
the nested payload exact):

```bash
jq -n --arg sha "$GITHUB_SHA" --arg service "$SERVICE_ID" --arg image "$IMAGE" \
     --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" '{
  ref: $sha, environment: "production", required_contexts: [], auto_merge: false,
  description: ("Deploy " + $sha[0:7]),
  payload: { dokploy: { serviceId: $service, image: $image, runUrl: $run } }
}' | gh api -X POST "repos/$GITHUB_REPOSITORY/deployments" --input - --jq .id
```

### Waiting for the result

Dokploy posts `in_progress`, then `success` or `failure` (or `error`). The
workflow polls the statuses, newest first, and fails on anything but `success`:

```yaml
      - name: Wait for Dokploy
        env:
          GH_TOKEN: ${{ github.token }}
          DEPLOYMENT_ID: ${{ steps.create.outputs.id }}
        run: |
          deadline=$((SECONDS + 1800))        # Dokploy gives up on its own at 90 min
          while [ "$SECONDS" -lt "$deadline" ]; do
            read -r state url < <(gh api "repos/$GITHUB_REPOSITORY/deployments/$DEPLOYMENT_ID/statuses?per_page=1" \
              --jq '.[0] | "\(.state // "none") \(.log_url // "-")"')
            case "$state" in
              success) echo "Deployed. Log: $url"; exit 0 ;;
              failure|error|inactive) echo "::error::Dokploy reported $state. Log: $url"; exit 1 ;;
            esac
            sleep 15
          done
          echo "::error::Dokploy did not answer within 30 minutes (is it running, and is the service watching this repository?)"
          exit 1
```

Statuses are read with the job's own `GITHUB_TOKEN` (`deployments: read` is
implied by `write`). Polling the statuses endpoint costs one request per 15 s per
run.

### Specification for the reusable workflow

Inputs: `service-id`, `image` (digest reference, required), `environment`
(default `production`), `wait-timeout-minutes` (default 30). Behaviour:

1. refuse an `image` that does not match `^[^@\s]+@sha256:[0-9a-f]{64}$`;
2. create the deployment as above, with `runUrl`;
3. wait as above, write the Dokploy log link to the job summary, fail the job on
   `failure`/`error` or timeout;
4. offer `mode: push | pull`, so a repository can keep the old `dokploy-deploy`
   push for reachable instances and use this for private ones.

## Setup, for a self-hoster

1. Settings > Git Providers > GitHub Deployments > **Connect GitHub**; open the
   link, type the code, approve.
2. On the service: Advanced > **Deploy from GitHub Deployments**; pick the
   account, type `owner/repo`, keep `production`, Save. The service id is shown
   on the card; put it in the repository variable `DOKPLOY_SERVICE_ID`.
3. Pin the service's image by digest once (a compose `image:` line, or the
   application's Docker image), so the repository is known.
4. Add the workflow step above.

## Open questions

- Migration number: 0226 assumes PR #576 lands first as 0225 (0223 is unused in
  canary). Renumber if the order changes.
- The poller deploys at most one GitHub deployment per service at a time and in id
  order; a burst is deployed one after another rather than collapsed to the
  newest. Collapsing (answer older ones `inactive`) would be a small follow-up.
- Compose is limited to stacks whose file is stored in Dokploy (`sourceType:
  raw`). Git-sourced compose files have no Dokploy-owned digest line to move.
- The `docker login` for compose writes the token to the host's Docker config,
  like every registry login in Dokploy. A per-deploy throwaway config directory
  would avoid that, at the cost of changing how compose is run.
