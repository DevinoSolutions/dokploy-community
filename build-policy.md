---
title: "Dokploy Enforced Remote Builds"
description: "Build once on a build server, push to your registry, deploy by digest, gate on CI checks and roll back by digest with Dokploy Community Edition's build policy."
permalink: /build-policy/
---

# Enforced remote builds and deploy by digest

Dokploy can already point an application at a build server and a registry. Dokploy Community Edition adds an organization-wide **build policy** on top: one setting that makes Dokploy the only builder for your GitHub-sourced applications. The build runs on your build server, the image is pushed to your registry, and the swarm service is updated **by digest**, so CI can wait for that exact image instead of building a second copy. Upstream Dokploy v0.30.8 has no build policy. The fork adds it, and it is off by default.

See also the [home page](https://dokploy-community.devino.ca/), the [FAQ](https://dokploy-community.devino.ca/faq/) and the related [deploy queue controls](https://dokploy-community.devino.ca/deploy-queue/).

## What it does

With enforcement on:

1. A GitHub-sourced application builds on the organization's default build server. There is no silent fallback to a local build.
2. The image is pushed to the organization's default registry as `<repository>:<sha>`.
3. Dokploy reads back the image digest and updates the service by that digest. If no digest is published, the deploy fails instead of deploying a mutable tag.
4. The digest and tag are stored on the deployment, so a later rollback can reuse them.
5. Pull request previews follow the same path.

The other parts of the policy are separate, opt-in controls:

- **Exclusions** keep chosen applications on a local build.
- **Break-glass** lets one deploy build locally once, with a recorded reason.
- **Required checks** make a deploy wait for named GitHub check runs or commit statuses on the commit.
- **Coalescing** folds a burst of pushes into one waiting deploy.
- **Rollback to a digest** redeploys a past image without building.

## Set it up

You need a server of type build, a registry, and an admin account.

1. Add the build server and the registry in Dokploy as usual.
2. Open **Settings, Server** and find the **Build Policy** card.
3. Choose the **Default Build Server** and **Default Registry**.
4. Set **Required Checks Timeout (minutes)** if you plan to use required checks (1 to 720, default 5).
5. Turn on **Enforce Remote Builds** and save.

Read the next section before step 5.

## What changes when you turn it on

- **Derived watch paths start filtering pushes.** An application with a build path and no explicit watch paths now only deploys for changes under that build path. In a monorepo, a push that only touches shared code stops at the webhook and creates no deployment. Set explicit watch paths first. Each skipped push is written to the audit trail with the paths involved.
- **Every GitHub-sourced application moves to the build server.** Add exclusions for anything that must keep building where it is before you flip the switch.
- **Queued deploys coalesce.** A burst of pushes leaves one waiting build at the earliest position, carrying the newest commit. Previews are never coalesced.
- **A `[skip deploy]` marker in a commit message is honored** on push-triggered deploys (not on tag pushes or previews).
- **A deploy-hook body with an image is no longer ignored.** On an application it is validated and must name the application's own repository.

With enforcement off, none of this applies and deploys behave as in upstream Dokploy.

## Exclusions and break-glass

An admin can exclude an application from enforcement under **Settings, Server** (Build Policy Exclusions), with an optional reason. Compose builds are never moved to the build server by this policy, so exclusions apply to applications only.

For a one-off local build, the `buildPolicy-allowLocalBuildOnce` API and MCP tool records a grant with a required reason. The next deploy of that application consumes the grant, and both events are written to the audit trail.

## Required checks

On an application, the **Required Checks** card on the Advanced tab takes the names of checks that must pass on the commit before the build starts. A Compose service takes the same list through the `requiredChecks` field of the Compose update API. Names are matched against both GitHub check runs and legacy commit statuses. If a check fails or the timeout passes, the deploy fails and says which.

Limit: the wait occupies a deployment slot. A self-hosted instance has the **builds concurrency** setting of them (default 1), so one unit waiting on a check that never arrives queues every other deploy behind it. Raise the build concurrency before raising the timeout.

## Roll back by digest

`buildPolicy-rollbackToDigest` takes a past deployment id and redeploys the image that deployment stored, with a pull and a service update and no build. It does not re-run required checks. A deployment from before enforcement has no stored digest and is refused.

## Audit trail

Admins can read the policy audit trail, which records settings changes, exclusions, break-glass grants and use, enforced builds, skipped and coalesced deploys, failed or timed-out checks, and deploys by digest.

## Limits

- Enforcement covers GitHub-sourced applications. Required checks also apply to Compose services.
- Admin access is required to change settings, exclusions and grants and to read the audit trail.
- Build servers, registries and the registry cleanup are yours to run. The policy does not garbage-collect the registry.

## Source

- [Build policy module](https://github.com/DevinoSolutions/dokploy-community/tree/canary/packages/server/src/services/build-policy) and its [README](https://github.com/DevinoSolutions/dokploy-community/blob/canary/packages/server/src/services/build-policy/README.md)
- [Changelog entry](https://github.com/DevinoSolutions/dokploy-community/blob/canary/CHANGELOG.md) (build once, deploy by digest, PR 209)
