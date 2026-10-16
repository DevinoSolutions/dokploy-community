# Deploy queue priority lane

Design note for GetItDone T-2557. User-facing instructions are in
[docs/deploy-queue-priority.md](../deploy-queue-priority.md).

## Problem

The deploy queue (`apps/dokploy/server/queues/in-memory-queue.ts`) is strict
arrival order within a lane. A lane is the deploy target, `job.serverId ??
LOCAL_PARTITION`; nearly everything is in the local lane, capped by
`webServerSettings.buildsConcurrency`. Two jobs of one application or compose
(`getGroup`: `application:<id>` / `compose:<id>`) never run together. There are
no priorities and no reserved slots. A maintenance deploy that must start now
(the Sentry self-host upgrade) waits behind every job that arrived before it.

## Options

1. **Stored per-service flag** (a column on application/compose). Needs a
   migration, and a permanent flag outlives the maintenance it was set for.
2. **Reserved slot / second queue.** Adds a slot, so the build cap is no longer
   the cap. Rejected: the cap is the safety limit.
3. **Per-job flag, picked ahead of the waiting FIFO (chosen).** `priority: true`
   on deploy/redeploy, plus an action that flags a job that is already waiting.
   Both live in the job payload, so no migration.

## Chosen design

- `DeploymentJob.priority?: true` and `priorityBy?: string` (requester **user
  id**) are payload fields. The id, not the email, because `deployment.queueList`
  returns payloads; the deployment note resolves the email when it is written. The journal already stores the whole payload.
- Scheduling (`drainPartition`) is unchanged except for the pick. Slot count
  (`active.length < concurrency`), the group exclusion and FIFO among everything
  else are untouched. When a slot is free, the pick is:
  - the first waiting job whose group is not running, as today; unless
  - a priority-flagged job further down the list whose group is not running is
    allowed to **jump**, in which case that job is picked instead. A flagged job
    is eligible only when **no earlier waiting job shares its group**.
- A jump is allowed only when, in that lane:
  - no job that jumped is still running, and
  - the last job started in the lane was not itself a jump (cooldown).
  The cooldown makes at least every second start in a lane a plain FIFO start,
  so a stream of priority deploys cannot starve the normal lane, including on a
  lane with `buildsConcurrency = 1` or 2. It resets when the waiting list drains
  or when a jumped job ends cancelled or failed (it did not hold the slot for a
  completed run, so a retry is not penalised). Consequence, accepted: priority
  jobs that keep failing or being cancelled can follow each other without a plain
  start in between. It is bounded by the number of flagged jobs (each flagged job
  runs once), the cap still holds, and a completed run restores the cooldown.
- A flagged job never passes an older waiting job of its own service. Deploy-hook
  jobs carry `pinnedImage` (the digest to deploy) and compose jobs carry
  `freshVolumes`; running the newer job first would leave production on the
  older job's state once it ran. The check is made at enqueue/flag time (reason
  `older-same-service`, flag kept) and again on every pick, so a flagged job
  becomes eligible once its older sibling has started.
- If a jump is not allowed right now, the job keeps its flag and jumps as soon
  as it is allowed; it never loses its place in the normal order.
- No-op when nothing waits: if the lane's waiting list is empty at enqueue (or
  the job to bump is first), no flag is stored and the response says so.
- A priority job started because it was already first is not a jump and does
  not use the "one ahead" allowance.
- The outcome reported at enqueue/flag time is the prediction of that pick:
  `wentAheadOf` counts the waiting jobs ahead of it that could start (their group
  is not running) minus the free slots they would take anyway (the lane's last
  seen cap minus the running jobs, 0 while the queue is paused), so a job that is
  about to start on a free slot is reported as not applied (`first-in-line`).
  Waiting jobs blocked by their own running service are not counted. Reasons:
  `nothing-waiting`, `first-in-line`, `older-same-service`, `priority-busy`,
  plus `not-queued` from the API layer. The deployment note uses the same count
  at the moment of the pick.

### Entry points

- `application.deploy`, `application.redeploy`, `compose.deploy`,
  `compose.redeploy` get `priority?: boolean`. The result gains
  `priority: { requested, applied, wentAheadOf, reason? }` when requested. On
  Cloud with a server the deploy runs directly (no queue): the flag is not sent
  to the deploy server, the answer is `reason: "not-queued"` and the request is
  audited, so it is never silently ignored.
- `deployment.prioritizeQueued({ jobId })` flags a job already waiting (the id
  from `deployment.queueList`). Same result shape.
- The deployment's description records `Deployed ahead of N waiting job(s)
  (priority, requested by <email>)` when the job actually jumps, so the deploy
  log in the UI says it. `N` is the number of waiting jobs in the lane that were
  ahead of it at that moment.

### MCP

Tools are generated from the tRPC router (`server/mcp/registry.ts`), so
`priority` appears on the four deploy tools and `deployment-prioritizeQueued` is
new. The MCP scope is `dokploy:deploy` for all of them (an override is added for
the new tool, whose name does not match the deploy pattern). The scope is only a
ceiling for the token; the real gate is the permission below.

## Permission model

New action `deployment: ["priority"]` in `access-control.ts`.

- Granted to the owner and admin roles. Not granted to `member`, which keeps
  `["read", "create", "cancel"]` only. Custom roles (enterprise) can be given it
  in the role editor.
- Checked in addition to `deployment:create` and the usual service access, only
  when priority is asked for. A caller without it gets `FORBIDDEN` and nothing is
  queued; a flag is never silently ignored.
- Why not any deployer: priority displaces other teams' jobs, so it is an
  operator action. A dedicated action lets an org grant it to a maintenance role
  without making that role an admin.

## Audit

`audit(ctx, { action: "prioritize", ... })` with resource type `application` or
`compose`, the service id and name, and metadata `{ via, jobId, applied,
wentAheadOf, reason }`. It is written next to the normal deploy entry. The audit
log only records for licensed organizations (existing behaviour of
`createAuditLog`), so a console line `[queue-priority] ...` is always written as
well, and the requester is in the deployment description.

## Invariants

1. Concurrency cap per lane is never exceeded: only the pick changes.
2. One job per service at a time: the group check is applied before any flag.
3. At most one jumped job runs per lane; consecutive jumps are separated by a
   plain FIFO start.
4. Priority state is derived from the queue (`active` jobs and the last start),
   not from a separate token, so there is nothing to leak.
5. Non-flagged jobs keep their relative FIFO order.

## Cancel and the release step (T-2458)

T-2458 made a compose cancel (`compose.killBuild`, `deployment.killProcess`,
`cancelBuildServerDeployment` with `releaseHost`, `runReleaseScript`) hold the
job, and so its queue slot, until the release script's cleanup trap has
finished. Because a jumped job's "one ahead" status is a property of the job
while it is in `active`, it is held for exactly as long as the slot is and freed
at the same moment, in `runJob`'s `finally`. There is no second place to release,
so cancel and release cannot collide.

- Waiting flagged job cancelled (`cleanQueues`, `clearWaiting`, `remove`): it is
  removed like any waiting job, the journal row is settled, nothing else to free.
- Running jumped job cancelled or failed: `processDeploymentJob` reports
  `cancelled` / `failed` to the queue, which clears the cooldown so a retried
  priority deploy can jump again.
- The rolling replace in the release step runs inside the job, so a second
  priority job cannot start on top of it.

## Replay

`priority` and `priorityBy` are in the journaled payload, so a restored job keeps
its flag (replay is opt-in, #389). A job flagged after it was enqueued (the
bump action) needs the stored payload updated: a new `updateQueueJobPayload`
(plain UPDATE of the existing `payload` column, serialised on the journal's
write chain). No migration. Restored jobs go to the front of their lane and a
flagged one jumps within that, subject to the same rules. A payload where
`priority` is not exactly `true` is treated as not flagged.

## Tests

`in-memory-queue-priority.test.ts`: ordering, one ahead, cooldown, same-service
exclusion, cap, cancel of waiting and running priority job, no-op when empty,
bump, journal update, restore keeps the flag. Router tests: permission denial,
audit call, result shape, `priority` passed to the queue. MCP scope test for
`deployment.prioritizeQueued` and the schema carrying `priority`. Access-control
test: member lacks `deployment:priority`, owner/admin have it.
