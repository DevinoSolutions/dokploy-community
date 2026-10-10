// better-auth declares vitest as an optional peer (for its test helpers). pnpm
// resolves that peer per workspace, so apps/dokploy (real vitest + jiti 2) and
// packages/server (auto-installed vitest + jiti 1) ended up with two distinct
// better-auth instances, and with them two copies of every plugin. Nothing here
// uses better-auth's vitest helpers, so drop the peer to keep one instance.
function readPackage(pkg) {
	if (pkg.name === "better-auth") {
		if (pkg.peerDependencies) delete pkg.peerDependencies.vitest;
		if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.vitest;
	}
	return pkg;
}

module.exports = { hooks: { readPackage } };
