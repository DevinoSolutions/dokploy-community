# Changelog

This file tracks changes unique to `rossreicks/dokploy-community` that have not been adopted by [`DevinoSolutions/dokploy-community`](https://github.com/DevinoSolutions/dokploy-community).

Community and official Dokploy release history belongs in those projects' release notes rather than in this file.

## Unreleased

### Added

- Publish `canary` builds to `ghcr.io/rossreicks/dokploy-community` for AMD64 and ARM64, with reusable Docker layer caching.
- Install and update through the fork-owned `install.sh`, which uses the personal GHCR image instead of the DevinoSolutions registry.
- Embed the source commit SHA in each image so Dokploy can detect a newer successful `canary` build without relying on version bumps.
- Update this Dokploy installation from the UI using the personal `canary` image instead of switching back to the DevinoSolutions registry.
- Check the DevinoSolutions `canary` branch daily and open a draft synchronization pull request when new changes are available.

### Changed

- Show account linking in self-hosted profile settings instead of limiting it to Dokploy Cloud.
- Keep personal documentation, installation files, and image-publishing workflows unchanged during automated DevinoSolutions synchronization.
