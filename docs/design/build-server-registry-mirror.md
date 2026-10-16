# Build server registry mirror (Docker Hub 429)

Design note for GetItDone T-2689. Nothing in this note has been applied; every
host was inspected read-only on 2026-10-16.

## Problem

Deploys fail with `429 Too Many Requests` from Docker Hub when BuildKit
resolves a `FROM` line:

```
#2 [internal] load metadata for docker.io/library/node:24-alpine
#2 ERROR: unexpected status from HEAD request to
   https://registry-1.docker.io/v2/library/node/manifests/24-alpine: 429 Too Many Requests
```

Two Marka production deploys died this way on 2026-10-16: `7aaa2fa9` (web
`vb6dL7qC...` 12:49Z, marka-ai `yvzcZ_bg...` 12:48Z) and `9aced134` (web
`vir3sJn0...` 12:58Z, marka-ai `lOQmttbT...` 12:58Z). All four have
`buildServerId = saZ6E_4nv0Ue2nUdm2GOi`, which is devino-third. The failure
takes 5 to 8 seconds, before any layer is touched.

### Scope

- Reported by the user: sentry-selfhost counted 16 of the last 175 Dokploy deploy
  logs with Docker Hub rate-limit errors, about 9.1%. Ten chats report affected
  services: landing, shop, marka, portfolio, posthog, postify, sentry, uptimely,
  upup and upAPI.
- Cross-check from `deployment-allCentralized` (read-only) plus a grep of the deploy
  logs for `429 Too Many Requests`, 2026-10-16: all of it falls in one burst between
  12:48Z and 12:58Z.
  - **16 compose deploys on devino-first**, the Dokploy host, not a build server
    (composes build and pull there): Lead Gen Workers x4, upAPI `iii` x6, Uptimely
    `uptimely-stack` x2, Marketing Studio `marketing-studio-stack` x2, Notifly
    `notifly-dev`, BioFlow Stack, Demofy `demofy-stack`. That equals the user's
    16 of 175.
  - **12 application builds on devino-third**: Marka web, marka-ai, `iii` and
    marka-docs (2 each, which includes the four above), upAPI web and landing (2 each).
  - 28 failed deploys in roughly ten minutes, 7 projects beyond Marka.
  - The failing images were `node` (`20-alpine`, `22-alpine`, `22-slim`,
    `22-bookworm-slim`, `22.21.1-alpine`, `22.23.2-alpine3.23`, `24-alpine`),
    `rust:1.90-slim`, `python:3.12-slim` and `debian:bookworm-slim`.
  - Older logs with the same error exist for 2026-07-10 (Shorty, devino-first) and
    one possible hit on 2026-08-31 (a plain "rate limit" match, not confirmed as
    Docker Hub). Logs for 16 older failed deploys were not found on devino-first or devino-third, so the earlier
    history is incomplete.
- So the fix is not build-server only. devino-first, devino-third and devino-second
  all egress through the site's shared public egress IP and share one bucket.
- Naming: Dokploy has two build servers. `devino-third Build Server` is
  devino-third (192.168.2.229, `saZ6E_4nv0Ue2nUdm2GOi`), which runs the app builds.
  `Main Build Server` is devino-second (192.168.2.217, `z23s7X5TGtmf0VRFc3Q43`);
  its ssh alias is `devino-second`. devino-first (192.168.2.16) is the Dokploy host
  and builds composes locally.
- The shared bucket is 100 requests per hour (`ratelimit-limit: 100;w=3600`, keyed on
  the site's shared public egress IP), not per host. Both build servers and anything else behind that
  address (devino-first, other devino hosts, the workstation) draw from it together.
  It was checked from devino-third and devino-second, both reporting the same
  remaining count (94).

## Findings

| | devino-first (Dokploy host) | devino-third (192.168.2.229) | Main Build Server = devino-second (192.168.2.217) |
|---|---|---|---|
| Dokploy serverId | local | `saZ6E_4nv0Ue2nUdm2GOi` | `z23s7X5TGtmf0VRFc3Q43` |
| 429 on 2026-10-16 | yes, 16 compose deploys (deploy logs) | yes, 12 app builds; dockerd journal 12:56:01 to 12:58:32Z | none seen |
| Docker | 29.9.0, `live-restore=false` | 28.5.0, overlay2, `live-restore=false` | 29.6.1, overlay2, `live-restore=false` |
| `/etc/docker/daemon.json` | nvidia runtime, `default-address-pools`, `dns`, `node-generic-resources`, `min-api-version`, `features` | does not exist (`/etc/docker` is empty) | `{"insecure-registries": ["192.168.2.217:5001", "127.0.0.1:5001"]}` |
| `docker info` mirrors | `[]` | `null` | `[]` |
| `~/.docker/config.json` auths | only `localhost:5000` | only `localhost:5000`; no `index.docker.io` | none |
| buildx | `default*` driver `docker` (BuildKit 0.34.0) only | `default*` driver `docker` (0.25.0) only | `default*` driver `docker` (0.31.1) and `devino-remote` driver `remote` (`tcp://192.168.2.217:1234`, container `buildkitd` 0.33.0) |
| Running containers | hundreds (435 to 525 counted during this session) | 0 (pure build box) | 2 (registry-proxy, buildkitd) |
| `/etc/docker/certs.d` (would hold a docker.io `hosts.toml`) | absent | absent | absent |
| `dockerd --validate` on the current file | configuration OK | no file | configuration OK |
| Public egress IP | the shared site IP | the shared site IP | the shared site IP |

- All three hosts sit behind the same public IP, so they draw from one anonymous
  Docker Hub bucket. devino-second just did not build a docker.io image in that
  window. Anything else NATed behind that address (other devino hosts, the
  workstation) draws from the same bucket.
- One `ratelimitpreview/test` HEAD each from devino-third and devino-second after 13:17Z returned the
  same state: `ratelimit-limit: 100;w=3600`, `ratelimit-remaining: 94;w=3600`,
  `docker-ratelimit-source` equal to the shared egress IP. The bucket has mostly recovered, which
  is why this looks intermittent: it empties during a burst of builds and refills.
  Marka deploys web and marka-ai on every merge, and every build resolves its
  docker.io bases again: web alone ran 6 builds between 04:43Z and 12:58Z on 2026-10-16.
- The log line `building with "default" instance using docker driver` shows
  Dokploy builds run on the daemon's embedded BuildKit, so the daemon's
  `registry-mirrors` setting is the one that matters on devino-third.
- devino-second already runs `registry-proxy` (`registry:2`, 192.168.2.217:5001,
  plain HTTP, restart `unless-stopped`, volume `registry-proxy-data`). Its
  `proxy.remoteurl` is `https://ghcr.io`, so it cannot serve docker.io. A
  `registry:2` proxy can mirror only one upstream, so Docker Hub needs a second instance.
- The `registry-proxy` config comment refers to a "Docker Hub mirror
  (k8s/dockerhub-mirror.yaml)". I could not find that manifest in any local
  checkout I searched, so I did not rely on it.
- mirror.gcr.io serves what we need today: from devino-third, HEAD requests for
  `library/node` tags `24-alpine`, `22-alpine` and `22.23.2-alpine3.23` all
  returned 200 with a digest. These requests do not touch our Docker Hub budget.
  That is the whole evidence that it still works in 2026. Google's own page says
  it caches "frequently-accessed public" images and gives no SLA, no cache
  guarantee and no deprecation statement, so it could change or drop a tag
  without notice.

## Options

Ranking: (a) now, then (c) if 429s still recur, then (b), then (d).

### (a) `registry-mirrors: ["https://mirror.gcr.io"]` (recommended)

Docker tries the mirror first for docker.io images (including the BuildKit
metadata HEAD that failed here) and falls back to Docker Hub if the mirror
errors or lacks the image. Only docker.io is affected; ghcr.io, `localhost:5000`
and the LAN registry are untouched. mirror.gcr.io is Google's cache of popular
Docker Hub images, so a miss for a rare image or a brand-new tag still goes to
Docker Hub and still spends budget. There is no SLA or cache guarantee, and cached
tags can lag slightly, which is fine for base images. If the mirror is down or
errors, Docker falls back to Docker Hub, so the worst case is today's behavior.

daemon.json diff, devino-third (new file):

```diff
+{
+  "registry-mirrors": ["https://mirror.gcr.io"]
+}
```

daemon.json diff, devino-second (merge with the existing key):

```diff
 {
-  "insecure-registries": ["192.168.2.217:5001", "127.0.0.1:5001"]
+  "insecure-registries": ["192.168.2.217:5001", "127.0.0.1:5001"],
+  "registry-mirrors": ["https://mirror.gcr.io"]
 }
```

daemon.json diff, devino-first (add one key; keep every existing key, shown
elided here, and make sure the preceding line gets its comma):

```diff
   "features": {
     "containerd-snapshotter": false
-  }
+  },
+  "registry-mirrors": ["https://mirror.gcr.io"]
 }
```

None of the three hosts sets `data-root` or `log-opts`, so there is nothing else to
preserve. Before editing, copy the file (`cp -a /etc/docker/daemon.json
/etc/docker/daemon.json.bak` on first and second; third has no file, so there is
nothing to back up). On devino-first, edit a copy, run the validation below, and only
then move it into place. Apply with `systemctl reload docker` only, never
`restart`: devino-first runs hundreds of containers with `live-restore=false`.

### (b) Local pull-through cache for docker.io

A second `registry:2` next to the ghcr one on devino-second (disk: 2.3 TB free).

```
docker volume create registry-dockerhub-cache
docker run -d --name registry-dockerhub --restart unless-stopped \
  -p 192.168.2.217:5002:5000 \
  -v registry-dockerhub-cache:/var/lib/registry \
  -v /opt/registry-dockerhub/config.yml:/etc/docker/registry/config.yml:ro \
  registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
```

`config.yml` is the ghcr one with `proxy.remoteurl: https://registry-1.docker.io`,
no `username`/`password`, `ttl: 168h`, `storage.delete.enabled: true`. Reuse the
pinned digest from the existing container.

- Storage and TTL: base images only, expect a few GB. With `ttl: 168h` expired
  blobs and manifests are removed and re-fetched on the next use.
- TLS: an HTTP endpoint on the LAN needs `192.168.2.217:5002` in
  `insecure-registries` on every client (devino-second already follows this
  pattern for `:5001`). Do not expose the port beyond the LAN.
- Serves all three hosts over the LAN. devino-second may use `127.0.0.1:5002`
  or the LAN address.
- Its upstream pulls are still anonymous and come from the same public IP, so it
  saves budget only through cache hits. Tag revalidation still contacts Docker
  Hub. Whether a cached tag is served while Hub is returning 429 depends on the
  distribution version, so test it before counting on it.
- Single point of failure: if the container is down, Docker falls back to the
  next mirror, then Hub.

daemon.json diff, devino-third:

```diff
+{
+  "registry-mirrors": ["http://192.168.2.217:5002"],
+  "insecure-registries": ["192.168.2.217:5002"]
+}
```

daemon.json diff, devino-second:

```diff
 {
-  "insecure-registries": ["192.168.2.217:5001", "127.0.0.1:5001"]
+  "insecure-registries": ["192.168.2.217:5001", "127.0.0.1:5001", "192.168.2.217:5002"],
+  "registry-mirrors": ["http://192.168.2.217:5002"]
 }
```

### (c) Both: local cache first, then mirror.gcr.io

Docker tries mirrors in the listed order, then Docker Hub. This gives LAN-speed
hits for everything already seen, mirror.gcr.io for first-time pulls, and Hub only
when both miss. It is the most robust end state and the most to maintain.

```diff
-  "registry-mirrors": ["http://192.168.2.217:5002"],
+  "registry-mirrors": ["http://192.168.2.217:5002", "https://mirror.gcr.io"],
```

(devino-third: the new file from (b) with that mirrors line; devino-first: the same
two keys added to its existing file; devino-second: the merged file from (b) with that
mirrors line.)

### (d) Dockerfile rewrites

`FROM mirror.gcr.io/library/node:24-alpine`, or an `ARG REGISTRY` prefix, in each
app repo. This is per-repo, does not cover images pulled by compose files or
buildpacks, and is not ours to change. Mention it to app owners only as a
fallback.

## Reload, not restart

- `live-restore` is `false` on all three hosts, so a full `systemctl restart docker`
  would kill running containers and any in-flight build. devino-third runs 0
  containers; devino-second runs 2; devino-first runs hundreds, including Dokploy
  itself, so a restart there must never be the plan. Every apply and rollback step in
  this note is a reload.
- A reload is enough. All three units define `ExecReload=/bin/kill -s HUP $MAINPID`,
  and the dockerd reference (via Context7, docs.docker.com/reference/cli/dockerd)
  lists `registry-mirrors` and `insecure-registries` among the options reconfigured
  on SIGHUP without a restart. `systemctl reload docker` does not touch running
  containers or builds. If dockerd finds an error in `daemon.json` during reload it
  logs it and keeps the old configuration.
- Embedded BuildKit picks the new mirrors up on reload, with no restart. Per review
  of moby's builder code (not tested here), `Daemon.RegistryHosts` reads the
  registry service config on every call and builds the docker.io mirror hosts from
  it. Caveat: this holds only while `/etc/docker/certs.d/docker.io/hosts.toml` is
  absent. It is absent on all three hosts (`/etc/docker/certs.d` does not exist).
  The first-build check below still confirms it empirically.
- Reload on devino-first with the nvidia runtime and `features` keys: the reloadable
  list includes `runtimes`, `default-runtime` and `features`, which are present and
  unchanged, so the reload re-applies identical values; non-reloadable keys
  (`default-address-pools`, `dns`, `node-generic-resources`, `min-api-version`) are
  not applied on reload. `dockerd --validate --config-file=/etc/docker/daemon.json` on the
  current file returned "configuration OK" on devino-first and devino-second, so
  run it again on the edited copy and expect the same.
- Rollout order: devino-third first, verify, then devino-first, then devino-second.

## BuildKit and buildx

- Builds on devino-third and devino-first use the `docker` driver (embedded
  BuildKit), which honors the daemon's `registry-mirrors`. No `buildkitd.toml` is
  needed. Plain `docker compose pull` of a docker.io image also goes through the
  daemon's mirror list.
- devino-second also has `devino-remote`, a `remote` driver builder
  (`buildkitd` container, TLS on `:1234`). A `docker-container` or `remote`
  builder does not read `daemon.json`; it needs
  `[registry."docker.io"] mirrors = ["mirror.gcr.io"]` in its own `buildkitd.toml`
  and a restart of that container. Nothing observed shows Dokploy selecting this
  builder (the logs say `default`). Confirm there is no `BUILDX_BUILDER`
  override before assuming the daemon setting covers devino-second. If the
  remote builder is in use, treat the `buildkitd.toml` change as a separate step.

## Safe window

The deploy queue is read through the Dokploy MCP tool `deployment-queueList`
(read-only). It is one queue on devino-first, not a per-server queue. At the time
of writing it held 2 active and 3 waiting jobs, none for Marka. A reload interrupts
nothing, so these windows are about a clean first build to verify with and about
never being caught mid-change if a restart is ever needed.

- **devino-third:** host-level idle check: `docker ps -q` prints nothing, and
  `pgrep -c -f '[d]ocker.* build'` prints 0 (count only, never `-a`, since argv can
  hold tokens; the bracket stops the pattern matching its own shell). A reload is
  harmless even mid-build. A restart, by contrast, kills an in-flight embedded-BuildKit
  build, so if a restart is ever required here, stop new deploys to this server
  first and wait for the idle check.
- **devino-first:** the standing rule. Deploy queue empty on two checks, and a
  `pg_dump` first. A reload does not stop containers, but a compose build in flight
  could see the registry config change underneath it, so wait for the queue to drain.
  Reload only, never restart.
- **devino-second:** no active build for it in the queue, and the same idle check as
  devino-third (it also runs the `registry-proxy` and `buildkitd` containers, which a
  reload leaves alone).

## Verification

1. `dockerd --validate --config-file=/etc/docker/daemon.json` before reloading.
2. `systemctl reload docker`, then `journalctl -u docker --since '-2min'` shows
   no config error.
3. `docker info --format '{{json .RegistryConfig.Mirrors}}'` lists the new mirror
   (it prints `[]` on first and second and `null` on third today).
4. Pull a small, otherwise unused docker.io image on the host and confirm its layers
   came through the mirror (for (b)/(c), `docker logs registry-dockerhub`
   shows the request; for (a) a pull of an image missing from the local store
   succeeds without a new `registry-1.docker.io` fetch in the dockerd journal).
   Do not use this to test a rate-limited bucket.
5. Redeploy-free proof: the next ordinary Marka build gets past
   `load metadata for docker.io/library/node:24-alpine`. Compare the dockerd
   journal: no new `registry-1.docker.io ... 429` lines.

## Rollback

Do not roll back by deleting the file or restoring a `.bak` that lacks the key and
then reloading. On reload dockerd only changes the mirror list if `registry-mirrors`
is present in the file (it starts from the live configuration), so the mirror would
stay active. Write the key explicitly as an empty list first, keeping every other key,
then validate, reload and confirm, and only then tidy the file. The same rule applies
to `insecure-registries` if option (b)/(c) added an entry: write the old list out
explicitly. Every step is a reload; never restart.

devino-third (no file existed originally):

```
printf '{\n  "registry-mirrors": []\n}\n' > /etc/docker/daemon.json
dockerd --validate --config-file=/etc/docker/daemon.json
systemctl reload docker
docker info --format '{{json .RegistryConfig.Mirrors}}'    # must now print []
rm /etc/docker/daemon.json     # only after the line above shows []
```

devino-second (keep `insecure-registries`; a bare `rm` would drop it):

```
cat > /etc/docker/daemon.json <<'JSON'
{
  "insecure-registries": ["192.168.2.217:5001", "127.0.0.1:5001"],
  "registry-mirrors": []
}
JSON
dockerd --validate --config-file=/etc/docker/daemon.json
systemctl reload docker
docker info --format '{{json .RegistryConfig.Mirrors}}'    # must print []
mv /etc/docker/daemon.json.bak /etc/docker/daemon.json     # original, no mirror key
```

devino-first (keep the nvidia runtime, address pools, dns, features and the rest; a
lost file here would be catastrophic at the next restart):

```
cp -a /etc/docker/daemon.json.bak /tmp/daemon.rollback.json
# edit the copy: set  "registry-mirrors": []  and change nothing else
dockerd --validate --config-file=/tmp/daemon.rollback.json
cp /tmp/daemon.rollback.json /etc/docker/daemon.json
systemctl reload docker          # RELOAD ONLY. Never restart: hundreds of containers, live-restore=false
docker info --format '{{json .RegistryConfig.Mirrors}}'    # must print []
cp -a /etc/docker/daemon.json.bak /etc/docker/daemon.json  # original, no mirror key
```

For (b)/(c), also `docker stop registry-dockerhub` once no client lists it.

## Docker Hub login (alternative)

An authenticated pull uses a per-account bucket instead of the shared IP bucket.
The figure I recall for a free personal account is 200 pulls per 6 hours (not
re-verified here; check Docker's current limits page); paid plans raise or lift it. Where it would go:

- `docker login` on devino-third and devino-second (writes `/root/.docker/config.json`,
  used by the daemon and BuildKit for docker.io), or
- a Dokploy registry entry, which only helps flows that read Dokploy's registry list,
  not a bare `FROM` resolved by the daemon.

A login can also be added to the `registry-proxy` instance in (b) via
`proxy.username`/`password`, so every cache miss is authenticated. This needs a
Docker Hub credential, which Amin decides on. Nothing in (a) to (c) requires one.

## Recommendation

Do (a) on all three hosts now (devino-third, devino-first, devino-second): one key,
`systemctl reload docker`, no restart, no new service. It removes the Docker Hub HEAD/GET from the common case, which is
exactly what failed. Revisit (c) only if 429s recur with the mirror in place.
