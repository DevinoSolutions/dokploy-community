# Network Management — Implementation Plan

**Date:** 2026-04-24
**Branch:** `feat/network-management` (off our fork's canary)
**Target:** bring Docker network management into the fork, aligned with the upstream maintainer's stated direction, while fixing the critical correctness gaps.

---

## 1. Landscape: two upstream PRs

### [PR #3774](https://github.com/Dokploy/dokploy/pull/3774) — "Add Network Management"
- **Author:** Siumauricio (upstream maintainer)
- **State:** OPEN, mergeable, last active 2026-04-18
- **Size:** ~9.6k additions, 23 files
- **Approach:** non-breaking; new `network` table + `networkIds` columns on all resource tables
- **Known bugs** (flagged by Greptile 2/5):
  1. `removeNetwork()` only deletes the DB row — orphans the actual Docker network
  2. `updateNetwork()` only writes DB — does not touch Docker runtime
  3. Missing braces in `IS_CLOUD` conditional cause wrong validation branch to run
  4. No delete function in the UI (only edit is wired)

### [PR #2811](https://github.com/Dokploy/dokploy/pull/2811) — "Custom Networks, replaces Isolated Deployments"
- **Author:** chichi13 (community)
- **State:** OPEN, **CONFLICTING** with canary, stale since 2026-02-27
- **Size:** ~14.4k additions, 100+ files
- **Approach:** **breaking** — removes `isolatedDeployment` field; richer IPAM; overlay + encryption; has tests
- **Reception:** 54 comments of substantive discussion, 0 formal approvals

### Signal
Siumauricio opened #3774 *after* #2811 existed. That's the maintainer's quiet vote against the breaking approach. Same pattern as concurrency (#2127 community → #3744 maintainer), where we chose the maintainer's direction and got a clean local landing. We do the same here.

### Maintainer's actual engagement on #3774
- No substantive author/maintainer comments on the PR since open (2026-02-22)
- Last activity is a community "Up please" bump on 2026-04-18
- Automated Greptile review surfaced the 4 critical bugs; author hasn't addressed them publicly
- One community commenter (Hraph) asked why the PR reinvents #2811 — 3 "confused" reactions, no maintainer answer

**Implication:** PR #3774 is stalled. We're not racing an active merge; we're filling a genuine fork-worthy gap. Our landing adds value even if upstream eventually merges, because the community won't need to wait.

---

## 2. Recommended approach: Option A

**Base:** PR #3774 as the foundation.
**Polish:** fix the 4 Greptile-flagged bugs.
**Borrow from #2811:** test patterns (unit tests for the network service + schema validation) — not the breaking `isolatedDeployment` removal.
**Do NOT:** remove `isolatedDeployment`. Keep it intact for backward compat; networks are additive.

**Why not pure #2811?**
- Breaking change → blocks upstream merge of future upstream sync
- 14k-line PR is out of scope for a fork branch we want to keep in sync with canary
- The maintainer already signalled the preferred direction

**Why not pure #3774?**
- Ships with known correctness bugs (orphaned Docker networks on delete)
- No UI delete path → unusable for operators

---

## 3. Scope for our fork branch

### 3.1 Core (from #3774, with fixes, aligned to Dokploy style)

**Schema** — `packages/server/src/db/schema/network.ts`
- `pgTable("network", ...)` with `networkId` (nanoid PK), `name`, `driver`, `subnet`, `gateway`, `ipRange`, `ipv6`, `encrypted`, `dockerNetworkId` (runtime ID for sync), `organizationId` FK cascade, `createdAt`
- `createInsertSchema` from `drizzle-zod` → derive `apiCreateNetwork`, `apiUpdateNetwork`, `apiFindOneNetwork`, `apiRemoveNetwork` via `.pick({...}).required()` (same as `destination.ts`)
- `relations()` block pointing back to `organization`
- Export from `schema/index.ts`
- Add `networkIds: text("networkIds").array()` column to: `application`, `compose`, `mariadb`, `mongo`, `mysql`, `postgres`, `redis`, `server`

**Migration** — `apps/dokploy/drizzle/NNNN_network_management.sql` + snapshot + `_journal.json` entry (next free slot after our `0167`)

**Service** — `packages/server/src/services/network.ts`, naming follows `{verb}Network{ById?}` pattern:
- `createNetwork(input: z.infer<typeof apiCreateNetwork>, organizationId: string)`  — insert DB row, then `docker network create --driver X --subnet ... name`; on Docker failure, rollback the DB row; store Docker's returned network ID on the row
- `findNetworkById(networkId: string)` — standard find-or-404 via `TRPCError { code: "NOT_FOUND" }`
- `updateNetworkById(networkId: string, data: Partial<Network>)` — Docker networks are mostly immutable after creation; for immutable fields (driver, subnet, ipam) require drop-and-recreate; for mutable (name label, description-only), update DB + Docker labels
- `removeNetworkById(networkId: string, organizationId: string)` — refuse if any resource still references the network; call `docker network rm <dockerNetworkId>` **first**, then delete DB row; surface Docker's "network is in use" error cleanly
- `findNetworksByOrganizationId(organizationId: string)` — list helper

**tRPC router** — `apps/dokploy/server/api/routers/network.ts`
- Matches `destination.ts` / `ssh-key.ts` exactly:
  - Use `withPermission("network", "create|read|update|delete")` — **NOT `adminProcedure`**
  - Every mutation ends with `await audit(ctx, { action, resourceType: "network", resourceId, resourceName })`
  - Every `remove`/`update` checks `resource.organizationId === ctx.session.activeOrganizationId` → `TRPCError UNAUTHORIZED` if mismatched
  - Wrap errors: `throw new TRPCError({ code: "BAD_REQUEST", message: "Error creating the network", cause: error })`

**Permission system** — `packages/server/src/...` (wherever `withPermission` resource slots live)
- Add `network` as a valid resource key with `create | read | update | delete` verbs
- Thread through existing permission UI if needed (likely auto-picked up)

**Router registration** — `apps/dokploy/server/api/root.ts`
- Import `networkRouter` from `./routers/network`
- Add to `appRouter` map alongside other routers

**UI** — same structure as #3774 but with delete wired:
- `apps/dokploy/pages/dashboard/networks.tsx` — page wrapper
- `apps/dokploy/components/dashboard/networks/show-networks.tsx` — list with **create button + delete button + edit button** per row (confirm dialog on delete)
- `apps/dokploy/components/dashboard/networks/handle-network.tsx` — create/edit modal shared form

**Sidebar** — `apps/dokploy/components/layouts/side.tsx`
- Add entry under Docker/Infrastructure group
- Visibility via `permissions?.network.read` (same pattern as other permission-gated entries), not hardcoded admin check

### 3.2 Correctness fixes layered on #3774
- [ ] `removeNetwork()` actually deletes the Docker network (not just the row)
- [ ] `updateNetwork()` surfaces "recreate required" for immutable changes; for name-only edits, allow via Docker network update (or a label patch)
- [ ] Fix `IS_CLOUD` conditional braces in network router validation
- [ ] Wire a delete button into `show-networks.tsx` (confirm dialog → mutation → refetch)

### 3.3 Borrowed test patterns from #2811
- [ ] `apps/dokploy/__test__/network/network-service.test.ts` — unit tests for create/update/delete and Docker interaction (mocked)
- [ ] `apps/dokploy/__test__/network/schema.test.ts` — Zod validation for subnet/gateway/IP range
- [ ] One integration-ish smoke: spin up a docker network via the service in CI against a real docker daemon if available, otherwise mock

### 3.4 Out of scope for v1 (follow-up if users ask)
- Resource-assignment UI (attaching an app to a custom network from the app's settings page). #3774 adds the column but doesn't wire the UI; #2811 does. We ship the backend column + the networks page. Resource-level assignment can be a separate branch once the core lands.
- Overlay driver encryption option
- Per-project networks tab
- Breaking removal of `isolatedDeployment`

---

## 4. Branching & workflow

- Base: `canary` (upstream-synced)
- Branch name: `feat/network-management`
- Do NOT branch off `feat/concurrent-deployments` — keep features independent
- Commits structured the same way we did concurrency:
  - `feat(networks): scaffold network table + service + CRUD router` (port of #3774 core)
  - `fix(networks): remove Docker network on delete, not just DB row`
  - `fix(networks): recreate network on immutable-field update`
  - `fix(networks): correct IS_CLOUD conditional braces`
  - `feat(networks): add delete button + confirm dialog`
  - `test(networks): service + schema coverage borrowed from #2811`
  - `docs(readme): note network management is live in fork`

---

## 5. Phased implementation sequence

### Phase 1 — scaffold from #3774 (compile green, UI visible)
1. Port the schema files (`network.ts`, columns on resource tables)
2. Port the drizzle migration + renumber it to our next slot
3. Port service + router + root registration
4. Port the 3 UI files + sidebar
5. `pnpm i && pnpm --filter @dokploy/server build && pnpm --filter ./apps/dokploy build` — must compile

### Phase 2 — correctness fixes
1. Rewrite `removeNetwork()` with actual Docker removal + referential-integrity guard
2. Rewrite `updateNetwork()` with immutable-field handling
3. Fix `IS_CLOUD` braces
4. Add delete UI + confirm dialog

### Phase 3 — tests
1. Mock-docker service tests
2. Schema validation tests
3. Run test suite locally until green

### Phase 4 — smoke test locally
1. Start dev server (our current approach in WSL)
2. Navigate to `/dashboard/networks`
3. Create network → verify `docker network ls` shows it
4. Edit name → verify it's reflected
5. Delete network → verify it's gone from both DB and `docker network ls`
6. Try to delete while an app references it → verify refusal

### Phase 5 — build + push to Hetzner (same flow as concurrency)
1. Docker build in WSL
2. Save + rsync tar
3. `docker load` + `docker service update --force`
4. Chrome MCP verification pass on live instance

### Phase 6 — commit + force-push
1. Commits on `feat/network-management`
2. Push to `origin/feat/network-management`

---

## 6. Risks & open questions

- **Drizzle migration conflicts.** Our branch may land a migration number that collides with an in-flight upstream migration. We're already at `0167_local_deployment_concurrency.sql`. #3774 uses `0166_pale_multiple_man.sql` — we'll pick the next free slot after our current max. Safe because we control our own migration numbering within the fork.
- **Docker network deletion vs swarm services.** If a network is attached to a running swarm service, Docker refuses to remove it. Our guard must detach/shut first or surface the error.
- **`networkIds` array column on 7 resource tables.** Every existing table gets a schema change. Write migration carefully. Backfill: empty array default.
- **Overlap with #3774 being updated upstream.** If Siumauricio pushes more commits to #3774 while we port it, we'll need to re-sync. Mitigation: pin to a specific PR SHA, note it in the commit message, refresh when stable.
- **Permission system.** Use `withPermission("network", "...")` to match existing CRUD routers (destination, ssh-key, etc.). Requires adding `network` as a resource slot. #3774's "admin-only" approach is inconsistent with Dokploy's permission model — we diverge from #3774 here on purpose.

---

## 7. Go/no-go for each PR as a base

| Base | Verdict | Reason |
|------|---------|--------|
| #3774 | ✅ **Use as base** | Maintainer-authored, mergeable, small surface, aligns with fork principle of "non-breaking extensions" |
| #2811 | ❌ Do not use as base | Breaking, conflicting with canary, stale; but mine its test infrastructure |
| Greenfield | ❌ Not worth the reinvention | #3774's scaffolding is 80% right; we just fix the 20% that's buggy |

---

## 8. Next action

Wait for user approval on this plan before scaffolding Phase 1.
