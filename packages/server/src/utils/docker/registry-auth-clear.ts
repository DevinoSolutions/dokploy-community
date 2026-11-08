/**
 * Anonymous registry auth for swarm service create/update calls.
 *
 * Why this exists: Docker Swarm remembers the registry credentials a service
 * was last created or updated with (`ContainerSpec.PullOptions.RegistryAuth`).
 * A `ServiceUpdate` that carries no `X-Registry-Auth` header does NOT clear
 * them. In moby (`daemon/cluster/services.go`, `UpdateService`) an empty
 * `encodedAuth` means "keep the previous spec's PullOptions", so the stored
 * credentials are copied onto the new spec and offered to whatever registry the
 * new image lives on.
 *
 * dockerode only sends `X-Registry-Auth` when `authconfig` is truthy. For a
 * service with no registry (a public Docker image, or a GitHub Actions pull-mode
 * image on a public ghcr.io package) `getAuthConfig` returns `undefined`, no
 * header goes out, and credentials stored months ago for a different (private)
 * registry are replayed against the new host. ghcr.io answers `denied: denied`
 * for the foreign credentials even though an anonymous pull of the same public
 * digest works (T-15783).
 *
 * Sending an explicit auth object that holds only a `serveraddress` makes
 * dockerode emit a non-empty `X-Registry-Auth` (base64 JSON of that object), so
 * swarm replaces the stored PullOptions with an anonymous pull for that host.
 * Real credentials from `getAuthConfig` must still win; use this only as the
 * fallback when there are none.
 */

import type { AuthConfig } from "dockerode";

/**
 * Registry host of an image reference, following Docker's rule: the first path
 * segment is a host when it contains a `.` or `:` or is `localhost`; anything
 * else (including a bare `nginx:1.27`) lives on Docker Hub.
 */
export const registryHostOfImage = (image: string): string => {
	const firstSlash = image.indexOf("/");
	if (firstSlash === -1) return "docker.io";
	const first = image.slice(0, firstSlash);
	if (first === "localhost" || first.includes(".") || first.includes(":")) {
		return first;
	}
	return "docker.io";
};

/**
 * Auth object with a `serveraddress` and no username/password. dockerode's
 * `AuthConfig` type requires both, but the daemon accepts their absence, and the
 * object must stay truthy so docker-modem still sends `X-Registry-Auth`.
 */
export const anonymousRegistryAuth = (image: string): AuthConfig =>
	({ serveraddress: registryHostOfImage(image) }) as AuthConfig;
