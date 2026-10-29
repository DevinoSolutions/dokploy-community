---
title: "Dokploy Compose Rolling Replace"
description: "Opt-in rolling replace for Docker Compose services in Dokploy Community Edition: start the new replica, wait for its healthcheck, then stop the old container."
permalink: /compose-rolling-replace/
---

# Rolling replace for Docker Compose services

A normal Compose redeploy stops and removes the old container and only then starts the new one, so a changed service has a window with no backend. **Rolling replace** is an opt-in setting of Dokploy Community Edition that changes the order for the services you select: the new replica must pass its healthcheck before the old container is stopped. Upstream Dokploy v0.30.8 has no such option. It is off by default and nothing changes until you turn it on for a service.

See also the [home page](https://dokploy-community.devino.ca/), the [FAQ](https://dokploy-community.devino.ca/faq/) and the [deploy queue controls](https://dokploy-community.devino.ca/deploy-queue/).

## What happens on a deploy

For each selected service:

1. The new image is built or pulled first. Nothing running is touched.
2. New replicas start from the new release next to the old ones: one for a single-container service, N for a service with `deploy.replicas: N`.
3. Dokploy waits until every new replica is healthy, up to the health timeout.
4. The old containers are taken out of rotation and, after the drain delay, stopped and removed by id.

If a new replica never becomes healthy, all new replicas are removed and the old containers, which were never touched, keep serving. The deployment is marked as an error and the usual failure notification is sent. Services you did not select are deployed as before. A selected service whose configuration and image did not change is left running.

## Turn it on

Open the Compose service, go to the **Advanced** tab and find the **Rolling replace** card.

1. Enable it.
2. Pick the services to roll. The list shows which services are eligible and why a service is not. You pick services explicitly; there is no "all".
3. Optionally set the **health timeout** (10 to 900 seconds, default 120). Dokploy raises it at deploy time when the service's healthcheck needs longer, up to 900.
4. Optionally set the **drain delay** (0 to 120 seconds, default 5), the wait between "new replica healthy" and "stop the old container".

It applies to `docker-compose` type services without a custom command, and not to fresh-volumes deploys. Compose previews never roll.

## Which services are eligible

A service is refused when it:

- sets `container_name`, or publishes a fixed host port (`expose` and Traefik-only access are fine). A host port range such as `"54000-54003:3000"` is fine when it holds at least 2 x replicas ports, because old and new replicas run side by side;
- uses `network_mode` host, `service:` or `container:`, a static IP or MAC address, or a `scale` or `deploy.replicas` that is not a whole number from 1 to 10;
- is referenced by another service through `network_mode`, `pid`, `ipc` or `volumes_from`;
- has no healthcheck in the compose file, or has it disabled. A healthcheck that only exists in the image is not visible to Dokploy;
- looks like a datastore such as Postgres, MySQL, MongoDB or Redis, or has a healthcheck that cannot settle within 900 seconds.

Variables such as `deploy.replicas: ${WEB_REPLICAS:-1}` are resolved first, with the variables Dokploy writes to the deploy's `.env`; the deployed compose file is not changed. When a value cannot be known (an unset `:?` variable, a vault reference that cannot be resolved, no **Create env file**), the service is judged on the file as written and the deploy log says so.

Eligibility is checked when you save and again at every deploy. If a selected service stops being eligible, it is recreated the normal way with a note in the deploy log, and the deploy is not failed for that.

## Things only you can check

During the overlap two copies of the service run. Decide first whether that is safe for the service:

- queue consumers and cron runners will run twice;
- migrations at container start run while the old version still serves, so they must be backward compatible;
- services that hold an exclusive lock on a volume, such as SQLite, or on a device such as a GPU, can collide.

Container-to-container traffic by service name can reach both replicas during the overlap.

## Cancel and failure behavior

Cancelling a rolling deploy removes the replicas that were not promoted yet and leaves the old containers serving. If the old container cannot be removed after the new one is healthy, the service reports a failure, the new replica keeps serving, and the next deploy reconciles the leftover. When several services are selected, services already replaced stay on the new release; there is no automatic revert of those.

## Add a Traefik retry yourself

Traefik drops the old backend only when the container dies, so requests can still reach it during its stop grace period. Dokploy does not inject a middleware for this. Add a retry middleware once, by hand, and attach it to the domain:

```yaml
http:
  middlewares:
    rolling-retry:
      retry:
        attempts: 3
        initialInterval: 100ms
```

Save it as `/etc/dokploy/traefik/dynamic/rolling-retry.yml` on the host and add `rolling-retry@file` to the domain's custom middlewares. A retry covers connection errors and short blips, not a long outage.

## Swarm stacks

Rolling replace does not apply to Compose stacks of type `stack`. For those, put a healthcheck in the compose file and set `deploy.update_config.order: start-first` with `failure_action: rollback`, which gives the same start-before-stop behavior through Docker Swarm.

## Limits

- Stateful services, previews, stacks, custom commands and fresh-volumes deploys are out of scope.
- A deploy killed with `kill -9` can leave extra containers until the next deploy reconciles them.
- At most 10 replicas per rolled service, and during the overlap it runs twice that many.
- Eligibility is read from the compose file after variable interpolation but before `extends`, `include` and profiles. A problem that only appears after those makes the new replicas fail to start, and the old containers keep serving.

## Source

- [Rolling replace guide](https://github.com/DevinoSolutions/dokploy-community/blob/canary/docs/compose-rolling-replace.md) with every eligibility rule and the cancel details
- [Design notes](https://github.com/DevinoSolutions/dokploy-community/blob/canary/docs/design/compose-zero-downtime.md)
