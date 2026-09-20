# Ross's Dokploy

A personal Dokploy build based on [`DevinoSolutions/dokploy-community`](https://github.com/DevinoSolutions/dokploy-community), which in turn tracks the official [`Dokploy/dokploy`](https://github.com/Dokploy/dokploy) project.

This repository is maintained for my own infrastructure. It is not an official Dokploy distribution and is not affiliated with the Dokploy project or DevinoSolutions.

## Image

The `canary` branch publishes a multi-platform image to:

```text
ghcr.io/rossreicks/dokploy-community:canary
```

To install it over an existing Dokploy service:

```bash
docker service update \
  --image ghcr.io/rossreicks/dokploy-community:canary \
  --with-registry-auth \
  dokploy
```

After the first installation, the Dokploy UI detects successful builds from this repository and can update the service to the latest `canary` image.

## Personal changes

[`CHANGELOG.md`](CHANGELOG.md) lists changes carried by this repository that have not been adopted by the DevinoSolutions community fork.

For the community edition's complete feature set and documentation, see:

- [DevinoSolutions/dokploy-community](https://github.com/DevinoSolutions/dokploy-community)
- [Official Dokploy documentation](https://docs.dokploy.com)

## Upstream synchronization

`.github/workflows/sync-devino-canary.yml` checks the DevinoSolutions `canary` branch daily. When changes are available, it opens a draft pull request into this repository's `canary` branch.

The workflow preserves this fork's documentation, installation files, and publishing workflows. Sync pull requests still require review because application code and database migrations may need manual reconciliation.

A sync can also be started manually from the repository's **Actions** page.

## Development

Use the same commands as the community project:

```bash
pnpm install
pnpm --filter=dokploy run typecheck
pnpm --filter=dokploy run build-server
pnpm --filter=dokploy test -- run
```

See [`docs/UPSTREAM_SYNC.md`](docs/UPSTREAM_SYNC.md) for the community fork's detailed synchronization and migration guidance.

## License

See [`LICENSE.MD`](LICENSE.MD), [`LICENSE_PROPRIETARY.md`](LICENSE_PROPRIETARY.md), and the licenses of the upstream projects.
