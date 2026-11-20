# Deploy queue status: the contract for the GitHub Actions deploy action

`deployment.queueStatus` tells a client where one service's deploy is in the
Dokploy deploy queue. It exists for the deploy step of a GitHub Actions workflow
(the `DevinoSolutions/dokploy-release` action), which used to put one clock on
"waiting for a slot" and "running": a deploy that waited behind a build backlog
for two hours was reported as a failed run. See
[deploy-queue-priority.md](deploy-queue-priority.md) for the lanes the queue
runs.

This repository only provides the read endpoint and states the contract. The
action itself lives in its own repository and is changed there.

## The call

`GET /api/deployment.queueStatus` (tRPC `deployment.queueStatus`, MCP
`deployment-queueStatus`, scope `dokploy:read`).

| Input          | Meaning |
| -------------- | ------- |
| `applicationId` or `composeId` | Exactly one. The service whose deploy to describe. |
| `deploymentId` | The deployment you registered with `deployment.registerExternalBuild`. Send it: then the answer is always about the deploy that continues that row, whatever else the service has in the queue. Without it the answer is about the service's current deploy, which may not be yours (see `queuedBehind`). |

The caller needs `deployment:read` on the service (and the service on their
access list), like reading its deployments. The answer describes that one
service only.

| Field | Meaning |
| ----- | ------- |
| `state` | `queued` (waiting for a slot), `running` (holds a slot), `none` (not in the queue: not started yet, finished or removed). |
| `lane` | `pull` for a deploy of a prebuilt image (own slots, does not wait behind builds), `build` otherwise; `null` when `none`. Not final while `queued`: a deploy is read again just before it starts and moves from `pull` to `build` if its service changed. |
| `position`, `ahead` | `queued` only. The deploy's place in the list of jobs waiting in the same lane on the same server, and how many are listed before it. This is list order, not a forecast: a prioritized deploy can start before position 1, and a job ahead whose service is busy can start after you. |
| `queuedBehind` | `running` only. How many deploys of the same service wait behind the running one. Above 0 the running deploy is not necessarily yours: one service never runs two deploys at once, so a newer deploy waits for the older one. |
| `waitingSinceMs` | How long the deploy waited: so far when `queued`, in total when `running`. |
| `startedAt` | Epoch milliseconds the deploy started; `running` only. |
| `heldReason` | `intake-closed-for-update` while Dokploy is updating: the deploy starts after the restart. |
| `restoring` | `true` right after Dokploy started, while waiting deploys are still being read back. A `none` is not final until this is `false`. |

`none` says nothing about the outcome. Read the deployment itself
(`deployment.allByType`, or the one you registered) for `done` or `error`.

## What the action should do

1. Register the deployment and send the deploy as today.
2. Poll `deployment.queueStatus` for the service and pass the `deploymentId`.
   Without it, a `running` answer with `queuedBehind` above 0 means "not
   necessarily yours": keep waiting under the queued limit and do not start the
   run clock on its `startedAt`.
3. While `state` is `queued`, wait under a separate, long limit. Suggested: 6
   hours. Log the `position` and `lane` when they change. Warn (do not fail) when
   the lane is `pull` and the position has not moved for 15 minutes: a pull deploy
   should not wait long, so the pull slots are full or the queue is held.
4. Start the run limit (the 7200 second clock) at `running`, or at `startedAt`,
   only for an answer that is yours: one given for your `deploymentId`, or one
   with `queuedBehind` of 0.
5. Treat `none` as "the deploy left the queue" only when `restoring` is `false`
   and the deployment row has an outcome; otherwise poll again.
6. While `heldReason` is set, keep waiting and say why; do not count it against
   the queued limit more than any other wait.

A deploy that continues a registered row also marks that row: `deployQueuedAt` is
set when the deploy is accepted and `deployStartedAt` when a slot takes it over
(`status` stays `running` throughout). `queueStatus` is the one read endpoint for
clients that do not want to infer the state from those columns, and it also covers
a deploy that has no registered row.
