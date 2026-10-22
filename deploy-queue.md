---
title: "Dokploy Deploy Queue Controls"
description: "Deploy ahead of waiting jobs with a priority lane, remove one waiting deploy, and clean duplicate queued deploys in Dokploy Community Edition."
permalink: /deploy-queue/
---

# Deploy queue controls

Dokploy runs deploys in arrival order, limited by the builds concurrency setting. Upstream Dokploy v0.30.8 lets you list the queue and clean all of an application's or Compose service's waiting jobs. Dokploy Community Edition adds finer controls: a **priority lane**, **removing a single waiting job**, a **keep-oldest clean** that only drops duplicates, and, with enforced remote builds, **coalescing** of repeated manual Compose deploys.

Related guides: [enforced remote builds](https://dokploy-community.devino.ca/build-policy/), the [MCP server](https://dokploy-community.devino.ca/mcp-server/), the [FAQ](https://dokploy-community.devino.ca/faq/) and the [home page](https://dokploy-community.devino.ca/).

## Look at the queue first

The queue table shows what is running and what is waiting. The same data is available from the API as `deployment.queueList` and over MCP as `deployment-queueList`. Queue job ids are valid only for the current Dokploy process and change after a restart.

## Deploy with priority

Use this for a maintenance deploy that must start now instead of behind everything that arrived earlier. It is opt-in per deploy and nothing is stored on the service.

```bash
curl -sS -X POST "https://<your-dokploy-host>/api/application.deploy" \
  -H "x-api-key: $DOKPLOY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"applicationId":"<applicationId>","priority":true,"title":"Maintenance"}'
```

`application.redeploy`, `compose.deploy` and `compose.redeploy` take the same `priority` field, and the MCP tools `application-deploy`, `application-redeploy`, `compose-deploy` and `compose-redeploy` accept it too. A deploy that is already waiting can be bumped with `deployment.prioritizeQueued` (MCP `deployment-prioritizeQueued`) using its queue job id.

The rules:

- The deploy goes ahead of the **waiting** jobs in the same lane. For almost every service the lane is the local queue.
- It takes the **next free build slot**. It never adds a slot, so the builds concurrency limit still holds. It never interrupts a running job.
- It never starts while a deploy of the **same service** is running, and it never passes an older waiting deploy of its own service.
- **At most one** priority deploy runs ahead in a lane at a time, and one normal job starts between two priority deploys.
- If nothing is waiting, it is just queued normally.

The answer includes a `priority` object with `requested`, `applied`, `wentAheadOf` and, when it was not applied, a `reason` such as `nothing-waiting`, `first-in-line`, `older-same-service` or `priority-busy`. Every use is written to the audit log, and the deployment description records how many jobs it went ahead of and who asked.

Who can use it: the `deployment:priority` permission, which owners and admins have. The member role does not, and a caller without it gets `403` and nothing is queued. Over MCP the tools are in the `dokploy:deploy` scope and the user behind the connection still needs that permission.

## Remove one waiting deploy

`deployment.removeQueued` (MCP `deployment-removeQueued`) drops a single waiting job without clearing the whole queue. It takes the queue job id and the id of the service the queue row names. In the queue table each waiting row has a Remove button behind a confirmation.

- It needs the `deployment:cancel` permission on that service.
- It only removes a **waiting** job. A running build is stopped with the usual cancel or kill actions.
- A missing job, a job you cannot access and a job that already started all answer the same `404`.
- The removal is written to the cancel trail and, for licensed organizations, to the audit log.
- Self-hosted only. Dokploy Cloud has no local queue.

## Clean only the duplicates

`application.cleanQueues` and `compose.cleanQueues` take a `mode`. `all` is the default and removes every waiting job of the service. `keepOldest` keeps the earliest waiting job in each group of duplicate deploys and removes the later ones, and returns which jobs were kept and removed. Running jobs and pull request previews are never touched, and jobs that differ in fresh volumes, pinned image or priority are not treated as duplicates.

## Repeated manual Compose deploys coalesce

When [remote builds are enforced](https://dokploy-community.devino.ca/build-policy/), clicking Deploy or Redeploy on a Compose service several times, or calling the API repeatedly, no longer piles up identical waiting jobs. A request is folded into the oldest waiting job of the same kind, which keeps its place in the queue and takes the new title and description. A redeploy is never merged with a deploy, previews are never touched, and priority requests skip it. With the policy off, nothing changes.

## Limits

- Priority changes the order of **waiting** jobs only. With a builds concurrency of 1 a priority deploy still waits for the running job to finish.
- Priority deploys that keep failing can follow each other, because a failed or cancelled priority deploy gives its allowance back. The builds limit still holds.
- Queue ids reset when Dokploy restarts. If queue replay is enabled, the priority flag survives a restart.
- Displacing other people's jobs is a social action. Look at the queue first and tell the team.

## Source

- [Deploy queue priority guide](https://github.com/DevinoSolutions/dokploy-community/blob/canary/docs/deploy-queue-priority.md) with the full answer format and runbook
- [Design notes](https://github.com/DevinoSolutions/dokploy-community/blob/canary/docs/design/deploy-queue-priority.md)
