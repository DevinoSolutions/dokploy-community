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
        |                                                                    ?environment=production&per_page=30 (older pages
        |                                                                    until a handled id, max 5 pages)
        |                                                                    If-None-Match: <etag>
        |                                --------------------------->    200 (new) or 304 (free)
        |                                                                ids > lastSeen, ascending:
        |                                                                  payload names this service?
        |                                                                  image pinned by digest?
        |                                                                  older valid ones: status inactive
        |                                                                  the NEWEST valid one only:
        |                                                                  same repository as the service runs?
        |                                                                transaction:
        |                                                                  lastSeen = 123, inflight = 123,
        |                                                                  set image
        |                                                                after the commit: enqueue the deploy
        |                                <---------------------------    POST .../deployments/123/statuses
        |                                   state: in_progress             (fixed text; log_url only if opted in)
        |                                                                normal Dokploy deploy runs
        |                                <---------------------------    POST .../deployments/123/statuses
 sees success / failure                    state: success | failure        (description: fixed text)
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
   `scope=repo_deployment public_repo` (`repo_deployment repo` when the user says
   the repositories are private; `read:packages` is added only when the user
   ticks "also pull private GHCR packages", T-13719).
   GitHub answers `device_code`,
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
   helper that protects other provider secrets). The connection is **its
   owner's**, the member who ran the flow (`createdByUserId`): see "Who may use
   a connection" below. It shows the GitHub login and the granted scopes, and has
   a Disconnect button. Disconnect deletes the row, and with it every watch that
   used it. (GitHub's side of the grant can only be revoked by the user, under
   Settings > Applications, because revoking needs the client secret the app does
   not have.)

The token is never part of any tRPC output, so never part of an MCP tool result.
`presentGithubConnection` is the only shape that leaves the server.

### Who may use a connection

The token can pull its owner's private GHCR packages, so a connection is not an
organization-wide resource: letting any member with `gitProviders.create` bind
any connection of the organization to a service they can deploy would let them
spend another member's token (a confused deputy). The model is the one Git
providers have (`routers/git-provider.ts`, `getAccessibleGitProviderIds`),
implemented as pure functions in `github-deployments/connection-access.ts`:

| | owner of the connection | other member | organization owner / admin |
| --- | --- | --- | --- |
| see it in `connections` | yes | only if shared | all of them |
| bind it with `watchSet` | yes | only if shared | yes |
| remove it with `disconnect` | yes | no | yes |
| share it with `toggleShare` | yes | no | no (only the owner) |

`sharedWithOrganization` (column on the connection, default false) is the
owner's switch for letting every member bind it. `watchSet` checks the
connection on every call, also when the watch already uses it: being allowed to
deploy a service is not being allowed to spend another member's token. Reconnecting
the same GitHub account (the same `githubUserId`) makes the member who ran the
flow its owner, and leaves the sharing switch as it was. A connection with no
recorded owner (none exist today) belongs to nobody and is usable by owners and
admins only.

## 2. Watch per service

New table `github_deployment_watch` (nothing is added to `application` or
`compose`: the application table is at the Drizzle / Postgres 100-argument cap,
error 54023).

| column                  | meaning                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `serviceType`, `serviceId` | `application` or `compose`, and its id (unique together)   |
| `connectionId`          | which GitHub account to use (one the caller may use)          |
| `owner`, `repo`         | the repository to follow                                      |
| `environment`           | GitHub environment name, default `production`                 |
| `enabled`               | switch                                                        |
| `postLogUrl`            | opt in to sending the Dokploy link to GitHub as `log_url`; default off |
| `lastSeenDeploymentId`  | highest GitHub deployment id handled                          |
| `etag`                  | ETag of the last fully handled list response                  |
| `inflightDeploymentId`, `inflightStartedAt` | the deployment being deployed now         |
| `lastCheckedAt`, `lastError` | status for the UI                                        |

`github_deployment_connection` holds the encrypted token, the login, the scopes
and a `status` (`active`, or `revoked` after GitHub answers 401).

Migration `0228_github_deployment_watch` is additive and idempotent
(`CREATE TABLE IF NOT EXISTS`, constraints in `DO $$ ... EXCEPTION` blocks), so it
passes `__test__/db/migration-idempotency.test.ts`. Constraint names are kept
within Postgres's 63 bytes (the watch's foreign key to the connection is named by
hand: `github_deployment_watch_connectionId_fk`). Canary already uses 0225 to 0227
(PR #576 and later); if the merge order differs, renumber (the file name, the journal entry
and the snapshot).

Changing the repository, environment or account, or turning a disabled watch
back on, resets the cursor (`lastSeen`, `etag`, in flight): the next poll
baselines at the then-newest deployment, so what piled up in the meantime never
runs. `lastSeen` only ever moves forward (every write is `WHERE lastSeen IS NULL
OR lastSeen < id`); only that reset sets it back. The poll's own writes are also
compare-and-set on the cursor the tick started from (`ifCursor`): a tick that read
the watch before it was disabled and enabled again cannot write its stale cursor,
ETag or progress over the reset, and stops its pass. Owner and repository names
may not be `.` or `..` (they would walk out of `/repos/` in the API URL).

The columns `postLogUrl` and `sharedWithOrganization` are part of migration 0228
(the PR is unmerged, so the migration is edited in place; an
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` makes it safe on a database that already
ran an earlier 0226 of this branch).

**One deployer per service.** The dokploy-deploy action (T-12149) also deploys a
service by pushing to Dokploy. A service that both the action and a watch deploy
has two writers of its image. `watchSet` therefore refuses with a conflict when
the service has a deployment of the last 24 hours that the action sent (a live row
registered while GitHub builds, or build origin `github-actions`), other than the
ones the poller itself started (titles ending `[deployment #<id>]`). Send
`override: true` to go on anyway; it is not stored. The check does not run for a
watch that is already on (it is the pull deployer itself) or for one being turned
off, and does run again when a disabled watch is turned back on.

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
   - the Dokploy deployment (found by the `[deployment #<id>]` ending of its title)
     is `done` -> `success`; `error` -> `failure`; `cancelled` -> `failure`;
   - still running or waiting in the queue -> wait;
   - running for more than 90 minutes -> `failure` ("did not finish in time");
   - no row and not in the queue for 10 minutes -> `failure` ("no record").
   The status carries a fixed `description` (see "What GitHub is told") and,
   only when the watch opted in with `postLogUrl`, `log_url` (the service's
   Deployments tab). Nothing new is taken until this one ends, so deploys of one
   service never overlap.
   A refused status is retried with back-off (30 s, 60 s, 2 min, 4 min); after 5
   attempts it is given up, the deployment is cleared and `lastError` says GitHub
   did not accept it. A rate limit pauses the connection and is not an attempt.
   A `401` marks the connection `revoked` and keeps the deployment, so the end is
   reported after the user reconnects.
3. **List**: `GET /repos/{owner}/{repo}/deployments?environment=<env>&per_page=30`
   with `If-None-Match: <etag>` on the first page. A `304` costs no rate limit.
   When there is a cursor the walk continues to older pages until a page reaches
   an id already handled, at most 5 pages (150 deployments), so a burst is not
   cut off at five.
4. **First poll** (no `lastSeen`): remember the highest id and the ETag, deploy
   nothing. Deployments that existed before the watch was enabled never run.
5. **New deployments**: ids above `lastSeen`. Only the **newest valid**
   deployment for this service is deployed; the others are answered so no
   workflow waits on them. In ascending order:
   - payload has no `dokploy` key, or names another `serviceId`: skip silently
     (another watch, or a human). `lastSeen` moves past it.
   - names this service but the image is not `<repository>@sha256:<64 hex>`:
     answer `failure` and move past it.
   - names this service with a valid image but a newer valid one exists: answer
     `inactive` ("Superseded by a newer deployment") and move past it.
   - the newest valid one: **start** it. One database transaction takes a row
     lock on the watch and checks the row still matches what the tick decided on
     (owner, repo, environment, connection and `lastSeen`, and nothing in flight),
     sets `lastSeen = id` and the in-flight marker and writes the image into the
     service. After the commit the deploy is enqueued; then POST `in_progress`.
     Deployments newer than the one started wait for it to end.
   Every answer goes through the bounded status posting of step 2; one that
   cannot be posted yet stops the pass where it is and is retried on a later tick.
6. **ETag** is saved only after every new deployment in a response was handled
   (answered or skipped). While a started deployment leaves others waiting, the
   stored ETag stays old so the next list returns `200`, not a `304` that would
   hide them.

### What GitHub is told

The statuses of a deployment are readable by everyone who can see the repository,
so they carry **fixed text only**: "Dokploy accepted the deployment", "Deployed by
Dokploy", "Dokploy deployment failed; see the Dokploy dashboard", "Dokploy
rejected this deployment; see the Dokploy dashboard", "Superseded by a newer
deployment", and a few like them (`STATUS_TEXT` in `poll-core.ts`). Never an error
message, a deployment log line, a database error or an image name from the
service. `log_url` (the Dokploy dashboard link, an internal address) is sent only
for a watch with `postLogUrl` on, which is off by default.

What went wrong stays in Dokploy: the watch's `lastError` keeps a short, one-line,
secret-redacted account (`describeError`: a database error becomes "A database
error occurred", never the statement or its parameters).

### How the deploy runs

It is the normal Dokploy deploy, not a special path.

- **Application** (Docker source): `dockerImage` is set to the digest reference
  in the same transaction as the claim, then a regular `deploy` job goes on the
  deployment queue. (The queue's `pinnedImage` was not used: it deploys through
  the build-policy path, which does not persist `dockerImage`, waits for required
  checks and takes registry credentials from the organization's registries, and it
  does not exist for compose.) The job title is
  `GHA <environment> <sha8> [deployment #<id>]`, the shape the action uses
  (`GHA <env> <sha8> ...`), so the GitHub Actions pill and the run modal read the
  environment and the commit from it (`parseGithubActionsTitle`). The poller finds
  its deployment by the trailing `[deployment #<id>]` handle alone, so the rest of
  the title is free to change.
- **Compose** (file stored in Dokploy): the digest on the single
  `image: <repository>@sha256:...` line is replaced and nothing else changes
  (`pinComposeImage`, the rule of `deploy.sh`'s `render`: exactly one pinned line
  for that repository, the old reference occurring exactly once), written in the
  same transaction, then a regular `deploy` job.
- **Build origin** (T-12149): the job also carries `buildOrigin:
  "github-actions"` and `buildRunUrl`, built with `buildOriginJobFields` like the
  deploy API's. The run link comes from `payload.dokploy.runUrl`, is checked with
  the same `normalizeBuildRunUrl`, and must be a run of the **watched**
  `owner/repo` (case-insensitive); a link to any other repository is dropped, so
  a deployment cannot put a foreign run in the history as the build of this image.
- **Private GHCR images**: the watch's connection supplies the login (username =
  the GitHub login, password = the token), read at pull time, for images under
  `ghcr.io/<watched owner>/` only. An application's swarm service is created with
  that auth config (`getAuthConfig`); its host pull and a compose's `up` use a
  `docker login ghcr.io --password-stdin` into **a Docker config directory of the
  watch's own**, `<base>/docker-config/ghcr-<watchId>`, and only that service's
  `docker --config <dir> pull` / the `DOCKER_CONFIG=<dir>` of that deploy's docker
  commands (compose, and the rolling replace's pull and up) read it. Because
  that directory replaces the default config for the deploy, it is **seeded from
  `$HOME/.docker` before each login**: `config.json` is copied under `umask 077`
  and `cli-plugins` is linked, so the build-server registry login, Docker Hub and
  other private-registry logins and `docker compose` itself keep working, and the
  ghcr.io login is then added to the copy. The default config is only read, never
  written, so no other organization or service on that host can reuse the token,
  and nothing outlives the watch. A credential helper cannot be isolated (with one,
  `docker login` would give the ghcr token to the host's shared store), so
  `credsStore` / `credHelpers` are renamed to inert keys in the copy: logins a host
  keeps in a helper are not visible to a watched deploy. Hosts set up by Dokploy
  have none. **Residency of the token on the host:** the directory is deleted as
  soon as the pull (application) or the pull / up (compose, in a `finally`, so a
  failed deploy too) that used it has ended, on the host that made it. Only a crash
  between the login and that cleanup leaves it, and then it is deleted by the
  fallback: when the connection is removed, the watch is removed or turned off, or
  its service is deleted (on this host and on every server of the organization,
  best effort). The token is not stored on the service and never put in argv or a
  log (`runDockerLogin` feeds it on stdin and redacts failures). Docker has no
  per-repository credentials: a compose stack that also runs another ghcr.io image
  of the same owner pulls it with the same login, and a stack with no image of the
  watched owner gets no login at all.

### Idempotency

The cursor claim (`lastSeenDeploymentId` plus the in-flight marker) and the image
write are **one database transaction** under a row lock, so a failure or a failed
commit leaves neither a moved cursor nor the new digest behind. The deploy is
enqueued **after** the commit, so a job can never start against an image that is
not committed yet. If the enqueue throws, a second transaction restores the image
(or compose file), the cursor and clears the in-flight mark (each only if it still
holds what the first one wrote) and the next tick retries; three attempts, then a
`failure` status and the deployment is skipped, so a poison deployment cannot
loop. A restart reads `lastSeen` and starts after it, so a deployment is never
deployed twice by a restart. The one window left is a crash between the commit and
the enqueue: the deployment is in flight with no job, it is reported to GitHub as
lost after 10 minutes and the new image stays on the service for its next deploy.

### Shutdown

`startGithubDeploymentsPoller()` returns a stop handle. `server.ts` keeps it and
registers it first on `SIGTERM` (`process.prependListener`), ahead of the queue's
own shutdown handler: no new tick starts, and a tick in progress stops before its
next watch, so nothing is enqueued into a queue that is draining.

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
- A failed status POST backs the watch off (30 s doubling to 5 min) and is given
  up after 5 attempts; a `404`/`410`/`422` (deployment deleted) clears it at once.
  A `401` revokes the connection. See step 2.

## 4. API and MCP

New `githubDeployment` tRPC router; the MCP tools are generated from it, with
descriptions from `.meta({ openapi: { description } })`.

| tool | scope | does |
| ---- | ----- | ---- |
| `githubDeployment-connections` | read | the connections you may use (yours, shared, all for an owner/admin): login, scopes, `sharedWithOrganization`, `isOwner`, status, last error. Never the token |
| `githubDeployment-toggleShare` | admin | share a connection with the organization, or take it back (its owner only) |
| `githubDeployment-startConnect` | admin | begin the device flow: `flowId`, `userCode`, `verificationUri` |
| `githubDeployment-completeConnect` | admin | poll it: `pending`, `connected`, `expired`, `denied`, `failed` |
| `githubDeployment-disconnect` | admin | delete the connection and its token (its owner, or an owner/admin) |
| `githubDeployment-watches` | read | the watches of the organization (a member only sees the services they have access to) |
| `githubDeployment-watchOne` | read | one service's watch |
| `githubDeployment-watchSet` | admin | create / change / disable a watch (with a connection you may use; `override` to proceed past a second deployer) |
| `githubDeployment-watchRemove` | admin | stop following |

Connect and disconnect use the existing `gitProviders` permissions. Setting or
removing a watch needs `gitProviders.create` (read access to git providers is not
enough: a watch lets a repository drive a deploy with that GitHub account's
token), `deployment.create` and `service.create` on the service. The `watches`
list is filtered by the member's `accessedServices` like the other service lists.
Connections and watches are checked against the caller's organization, and a
connection also against the caller (see "Who may use a connection").
Disconnecting also deletes the docker login of every watch that used the
connection. Every request to GitHub (the device flow, the poll, the status posts)
is cut off after 15 seconds.

## Security model

- **Scopes (not narrow, and said so).** `repo_deployment` (read and write
  deployment statuses and create deployments) plus `public_repo`, which GitHub
  grants as **read and write** on the account's public repositories, or `repo`
  for private repositories: **full control of the account's private repositories,
  including their code**. Classic OAuth has no narrower scope for either.
  `read:packages` (pull private GHCR packages) is opt-in since T-13719, a
  checkbox on the settings card; without it `loadGhcrCredentials` is null and a
  private GHCR image fails to pull, with a log line that names the missing scope.
  Connections made before the change keep their scopes. A reconnect replaces a
  connection's scopes with the ones chosen then.
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
- **The login serves one owner.** The token is offered only for images under
  `ghcr.io/<watched owner>/`, never for any other ghcr.io image a service runs,
  and only through the watch's own Docker config directory (see "How the deploy
  runs").
- **Whose token.** A member can bind only a connection they own, or one its
  owner shared; owners and admins any. Binding is checked on every `watchSet`.
  A shared connection lets every member act as the account with the scopes
  above, so share only an account the whole organization may use that way.
- **Token handling.** Encrypted at rest; never returned by tRPC or MCP, never in
  a log line, argv, status or URL (tests assert it). Read only by the poller, the
  GHCR pull and the `docker login` helper. Disconnect deletes it.
- **Blast radius of a leaked token.** `repo_deployment` + `public_repo` (or
  `repo`) of one GitHub account: it can post deployment statuses and read and
  write the repositories that scope reaches (public ones for `public_repo`). `repo` is GitHub's classic
  full-control scope for private repositories (it includes reading and writing
  their code), so a leaked token of a private-repository connection is far more
  sensitive than a `public_repo` one. It cannot reach Dokploy.
- **Self-hosted only.** The poller, the connect flow and the watch mutation are
  refused on Dokploy Cloud.

## Failure modes

| situation | result |
| --------- | ------ |
| Dokploy offline when the deployment is created | picked up when it is back, if it is still among the newest 150 of that environment (5 pages of 30); the workflow's wait times out meanwhile |
| several deployments waiting | only the newest valid one for the service is deployed; the older ones get `inactive`, so no workflow hangs |
| more than 150 deployments since the last poll, or a deployment with a lower id that becomes visible only after the cursor passed it | never seen, so never answered: its workflow waits until its own timeout. Known residual of the page cap and of an id-ordered cursor |
| a manual Deploy while a GitHub-started job still waits | the queue folds it into that job and the job takes the manual title; the end is then found as the first deployment of the service after the claim (or the service's waiting job), so GitHub still gets the result |
| GitHub keeps refusing a status | backs off, gives up after 5 attempts, clears the deployment and records it in `lastError` |
| Dokploy restarts mid-deploy | the queue journal resumes the job; `inflight` survives, so the end is still reported |
| GitHub unreachable | the tick records an error and retries; nothing is lost |
| token revoked or expired | `401`: connection `revoked`, UI asks to reconnect, watches pause |
| repository renamed, deleted, or account lost access | `404`: error shown on the watch, retried every 5 minutes |
| service deleted | a deployment in flight is answered `failure`, then the watch and its docker login are removed on the next tick |
| one watch's database or service lookup fails | logged, that watch is skipped for this tick; the other watches are still polled |
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

- Migration number: 0228 follows canary's 0227 (0223 is unused in
  canary). Renumber if the order changes.
- The poller deploys at most one GitHub deployment per service at a time and in id
  order; a burst is deployed one after another rather than collapsed to the
  newest. Collapsing (answer older ones `inactive`) would be a small follow-up.
- Compose is limited to stacks whose file is stored in Dokploy (`sourceType:
  raw`). Git-sourced compose files have no Dokploy-owned digest line to move.
- The `docker login` for compose writes the token to the host's Docker config,
  like every registry login in Dokploy. A per-deploy throwaway config directory
  would avoid that, at the cost of changing how compose is run.
