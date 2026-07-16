# Dokploy Community Edition

> **This is a community fork of [Dokploy](https://github.com/Dokploy/dokploy).** We are **not** affiliated with or competing against the Dokploy project. This fork exists to make new features available faster.

Based on **Dokploy v0.29.12** | Fork version **v0.29.12-community.2**

## Switching from official Dokploy

One command. Keeps every app, database, domain, and setting — the extra migrations are additive:

```bash
docker service update \
  --image ghcr.io/devinosolutions/dokploy-community:v0.29.12-community.2 \
  --with-registry-auth \
  dokploy
```

Going back to official is just as easy (our extra tables/columns are simply ignored):

```bash
docker service update --image dokploy/dokploy:v0.29.12 --with-registry-auth dokploy
```

The image is public — no registry login required.

## What's different

Everything in Dokploy v0.29.12, plus:

### Docker Network Management
- New Networks page in the sidebar
- Create, delete, and manage Docker overlay networks
- Attach networks to any application or database service
- Per-resource network picker in the Advanced tab

https://github.com/user-attachments/assets/94134095-5601-4279-be2f-219734c8e199

> Concurrent deployments — previously a fork-only feature — shipped natively in upstream Dokploy v0.29.11, so this fork now uses the official implementation.

### New in v0.29.12-community.2

This release rolls up 100+ upstream fixes and features — each ported 1:1 and credited to its original author — plus fork-side security hardening. Highlights:

- **Cloudflare integration** — manage credentials, publish Tunnels, and gate apps behind Access (zero-trust)
- **Wildcard domain support**, with a per-server default domain for auto-generated app domains
- **AWS ECR registry support** and pulling images with stored registry credentials
- **S3 backup encryption at rest** (rclone crypt), plus generic rclone, SFTP, and FTP backup destinations
- **GitLab merge-request preview deployments** via webhook
- **Pre-deploy and post-deploy command hooks** for applications, and deploying a specific Docker image/tag on demand
- **Richer monitoring** — container resource breakdown, swap usage, and remote-server stats
- **Export a project** to a portable JSON file, bulk organization invites, and GitHub/Google social login on self-hosted

See the [full release notes](https://github.com/DevinoSolutions/dokploy-community/releases/tag/v0.29.12-community.2) for the complete list, migration details (schema 0176 → 0188), and known caveats.

## Fresh install

On a clean Linux server with root access (same requirements as Dokploy):

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Install a specific version:

```bash
export DOKPLOY_VERSION=v0.29.12-community.2
curl -sSL https://dokploy-community.devino.ca/install.sh | sh
```

Update an existing installation:

```bash
curl -sSL https://dokploy-community.devino.ca/install.sh | sh -s update
```

## Docker Image

```
ghcr.io/devinosolutions/dokploy-community:v0.29.12-community.2   # versioned (recommended)
ghcr.io/devinosolutions/dokploy-community:latest                  # latest release
ghcr.io/devinosolutions/dokploy-community:canary                  # latest build
```

## Versioning

We follow the scheme `v<upstream-version>-community.<release>`:

| Upstream | Fork release | Tag |
|---|---|---|
| v0.29.11 | 1st release | `v0.29.11-community.1` |
| v0.29.12 | 1st release | `v0.29.12-community.1` |
| v0.29.12 | 2nd release | `v0.29.12-community.2` |

## Contributing

This fork tracks upstream Dokploy's `canary` branch. To contribute:

1. Fork this repo
2. Create a feature branch from `canary`
3. Open a PR targeting `canary`

For features that should go upstream, please also open a PR on the [official Dokploy repo](https://github.com/Dokploy/dokploy).

## Credits

- [Dokploy](https://dokploy.com) — the original project by [@siumauricio](https://github.com/siumauricio)
- Community-maintained fork, stewarded by [Devino Solutions](https://devino.ca)

## License

Same as upstream — [Apache 2.0](LICENSE)
