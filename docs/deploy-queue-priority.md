# Deploy queue priority lane

Dokploy runs deploys in arrival order. A maintenance deploy that has to start
now, such as the Sentry self-host upgrade, would otherwise start behind every
job that arrived before it. This lets one deploy go ahead of the jobs that are
waiting, without raising the build limit and without letting priority jobs crowd
out everyone else.

Design and the reasons behind each rule:
[docs/design/deploy-queue-priority.md](design/deploy-queue-priority.md).

## What it does

- Opt-in, per deploy. Nothing is stored on the service; once the deploy has
  started, the service is back to normal.
- The deploy goes ahead of the **waiting** jobs in the same queue lane. A lane is
  the server the service deploys to; almost everything is in the local lane,
  which is capped by the builds concurrency setting.
- It takes the **next free build slot**. It never adds a slot, so the build
  concurrency limit still holds.
- It never starts while a deploy of the **same service** is running, exactly as a
  normal deploy would not.
- **At most one** priority deploy runs ahead in a lane at a time, and a priority
  deploy is never followed directly by another: one normal job starts in between.
  A second priority request made meanwhile keeps its flag and goes ahead as soon
  as that is allowed.
- It does nothing when nothing is waiting (the deploy is just queued, and no flag
  is stored).
- It **never goes ahead of an older waiting deploy of its own service**. Older
  work of one service always runs first (a deploy-hook job carries the image
  digest it must deploy, and a compose redeploy may reset its volumes, so running
  the newer one first would leave the service on the older state). A flagged job
  in that position keeps its flag and may go ahead of other services' jobs once
  the older deploy has run.

Cancelling works as usual. A waiting priority deploy is removed from the queue
like any other. A running one that is cancelled (or fails) gives its allowance
back as soon as it has finished stopping, including the cleanup of a rolling
replace, so a retried priority deploy can go ahead again. The allowance is
returned on failure on purpose (a retry should not be penalised), so several
priority deploys that keep failing can follow each other without a normal job in
between. That is bounded by the number of flagged jobs, and the build limit still
holds.

## Who can use it

The `deployment:priority` permission. Owners and admins have it. The member role
does not. On an enterprise licence a custom role can be given it (Roles, Deployment, Priority).
A caller without it gets `403 FORBIDDEN` and nothing is queued; the flag is never
silently ignored.

For an MCP connection the tools below are in the `dokploy:deploy` scope, and the
user behind the connection still needs the permission above.

## Before you use this

- [ ] You are the right person: this displaces other people's jobs. Say so in
      the team channel if it will delay them.
- [ ] Look at the queue first: `GET /api/deployment.queueList` (MCP
      `deployment-queueList`). Check what is running and what is waiting, and
      that the service you are deploying is not already running a deploy (yours
      would wait for it).
- [ ] Check the build limit for the lane (Settings, builds concurrency; for a
      remote server, the server's setting). With a limit of 1 the priority deploy
      still waits for the running job to finish.
- [ ] You know what is running ahead of you and that it will not be interrupted:
      priority never cancels a running job.
- [ ] After sending it, read the `priority` object in the answer (below) and the
      deployment's description in the UI.

## Deploy with priority

REST (replace the host, the key and the id):

```bash
curl -sS -X POST "https://<dokploy-host>/api/application.deploy" \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"applicationId":"<applicationId>","priority":true,"title":"Sentry upgrade","description":"Approved maintenance"}'
```

For a compose service:

```bash
curl -sS -X POST "https://<dokploy-host>/api/compose.deploy" \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"composeId":"<composeId>","priority":true,"title":"Sentry upgrade"}'
```

`application.redeploy` and `compose.redeploy` take the same `priority` field.

MCP, the same call as a tool:

```json
{ "name": "compose-deploy",
  "arguments": { "composeId": "<composeId>", "priority": true, "title": "Sentry upgrade" } }
```

Tool names: `application-deploy`, `application-redeploy`, `compose-deploy`,
`compose-redeploy`.

### The answer

```json
{
  "success": true,
  "message": "Deployment queued",
  "composeId": "<composeId>",
  "priority": {
    "requested": true,
    "applied": true,
    "wentAheadOf": 46,
    "message": "Queued ahead of 46 waiting jobs; it starts as soon as a build slot is free."
  }
}
```

`application.deploy` and `application.redeploy` return this object only when
`priority` was requested (they return nothing otherwise, as before; on Cloud with
a server they return `true` as before when no priority was requested).

`wentAheadOf` counts the waiting jobs ahead of it that could have started (their
service is not running) and would not simply have taken a free slot first.
Waiting jobs that are blocked behind a running job of their own service are not
counted: they would not have started before it either.

| `applied` | `reason` | Meaning |
|---|---|---|
| `true` | | It is ahead of `wentAheadOf` waiting jobs and starts when a slot is free. |
| `false` | `nothing-waiting` | Nothing else was waiting in the lane; queued normally, no flag stored. |
| `false` | `first-in-line` | Nothing ahead of it could start before it (the jobs ahead are blocked by a running job of their own service, or will take the free slots anyway). It is next, so there was nothing to go ahead of. |
| `false` | `older-same-service` | An older deploy of the same service is still waiting, and a priority deploy never passes its own service's older work. The flag is kept; once the older deploy has run it may go ahead of other services' jobs. |
| `false` | `priority-busy` | Another priority deploy is running or has just started in this lane. This one keeps its flag and goes ahead when allowed. |
| `false` | `not-queued` | The deploy does not go through a queue (Dokploy Cloud runs a deploy to a remote server straight away), so there was nothing to go ahead of. Nothing is flagged and the request is audited. |

When the job starts, its deployment description reads `... - Deployed ahead of 46
waiting jobs (priority, requested by <your email>)`. `wentAheadOf` there is
counted the same way, at the moment it starts. The queue list (`queueList`)
shows the payload of each job, so it carries your user id (`priorityBy`), never
your email; the email is looked up only when the deployment description is
written.

## Bump a deploy that is already waiting

If the deploy is already queued (for example by a webhook), flag it instead of
deploying again. Get its id from the queue list (`id`, state `waiting`, for
example `job-123`):

```bash
curl -sS "https://<dokploy-host>/api/deployment.queueList" -H "x-api-key: $DOKPLOY_API_KEY"

curl -sS -X POST "https://<dokploy-host>/api/deployment.prioritizeQueued" \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"job-123"}'
```

MCP: `deployment-prioritizeQueued` with `{ "jobId": "job-123" }`. The answer is
`{ "success": true, "jobId": "job-123", "priority": { ... } }` as above. A job
that is not waiting any more (it started, finished, was cancelled, or is not one
you can deploy) answers `404`. Queue ids are only valid for the current process;
they change after a restart.

## Audit and replay

Every use writes an audit entry with the action `prioritize` (Deployed with
priority in the audit log filter): who, the service, and `{ via, jobId, applied,
wentAheadOf, reason }`. Audit entries are kept for licensed organizations, like
all audit entries; a `[queue-priority]` line is always written to the server log,
and the requester's email is in the deployment description. A request on Cloud
(no queue) is audited too, with `reason: "not-queued"`.

The flag is part of the job in the queue journal, so with queue replay enabled a
restart keeps it.

## Maintenance runbook, short form

1. `deployment-queueList`: note what is running and waiting.
2. `compose-deploy` (or `application-deploy`) with `"priority": true`.
3. Check `priority.applied` and `wentAheadOf` in the answer.
4. Watch the deployment; cancel it the usual way if it has to stop
   (`compose-killBuild` or `deployment-killProcess`).
