import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { server as servers } from "@dokploy/server/db/schema";
import { shEscape } from "@dokploy/server/db/schema/utils";
import { getRegistryConfigDir } from "@dokploy/server/utils/process/dockerConfig";
import { runDockerLogin } from "@dokploy/server/utils/process/dockerLogin";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { eq } from "drizzle-orm";
import { loadGhcrCredentials } from "./store";

/**
 * Registry credentials for private ghcr.io images, from the GitHub connection
 * of a service that follows GitHub Deployments (T-12166). The token is read at
 * pull time and handed straight to Docker; it is never stored on the service,
 * returned by an API or written to a log.
 *
 * The login is NEVER written to the host's default Docker config, where every
 * later ghcr.io pull on that host (any organization, any service) would reuse
 * it and where it would outlive the connection. Each watch gets a Docker config
 * dir of its own and only that service's pull / up is pointed at it
 * (`docker --config <dir>` / `DOCKER_CONFIG=<dir>`). The dir is deleted when the
 * connection is removed, the watch is removed or turned off, or the service goes
 * away. Docker has no per-repository credentials, so a login is also limited to
 * the images it is meant for: those under `ghcr.io/<watched owner>/`.
 */

/** A watch's own docker config dir name; the id is a nanoid so it is path-safe. */
const WATCH_DIR_PREFIX = "ghcr-";

export const getGhcrWatchConfigDir = (watchId: string, isRemote: boolean) =>
	getRegistryConfigDir(`${WATCH_DIR_PREFIX}${watchId}`, isRemote);

/**
 * The command that deletes one watch's config dir, or null when the computed
 * path is not exactly `<base>/docker-config/ghcr-<watchId>`: an odd id must
 * never turn into an `rm -rf` of the parent directory.
 */
export const getGhcrWatchConfigDirRemovalCommand = (
	watchId: string,
	isRemote: boolean,
): string | null => {
	let dir: string;
	try {
		dir = getGhcrWatchConfigDir(watchId, isRemote);
	} catch {
		return null;
	}
	if (
		!watchId ||
		!dir.startsWith("/") ||
		!dir.endsWith(`/docker-config/${WATCH_DIR_PREFIX}${watchId}`)
	) {
		return null;
	}
	return `rm -rf -- ${shEscape(dir)}`;
};

/**
 * Delete the config dirs of these watches (they hold the GitHub token) from
 * this host and from every server of the organization. Best effort: a host that
 * cannot be reached is logged and skipped, and the token is revoked on GitHub's
 * side only by the user, as the disconnect text says.
 */
export const removeGhcrWatchConfigDirs = async (
	watchIds: string[],
	organizationId: string,
) => {
	if (watchIds.length === 0) return;
	const local: string[] = [];
	const remote: string[] = [];
	for (const watchId of watchIds) {
		const l = getGhcrWatchConfigDirRemovalCommand(watchId, false);
		const r = getGhcrWatchConfigDirRemovalCommand(watchId, true);
		if (!l || !r) {
			console.error("GitHub deployments: skipped an odd docker config dir");
			continue;
		}
		local.push(l);
		remote.push(r);
	}
	const tasks: Promise<unknown>[] = [];
	const failed = (error: unknown) =>
		console.error(
			"GitHub deployments: could not remove a docker config dir:",
			error instanceof Error ? error.message : "unknown error",
		);
	if (!IS_CLOUD && local.length > 0) {
		tasks.push(execAsync(local.join("; ")).catch(failed));
	}
	if (remote.length > 0) {
		try {
			const rows = await db.query.server.findMany({
				where: eq(servers.organizationId, organizationId),
				columns: { serverId: true },
			});
			for (const { serverId } of rows) {
				tasks.push(execAsyncRemote(serverId, remote.join("; ")).catch(failed));
			}
		} catch (error) {
			failed(error);
		}
	}
	await Promise.all(tasks);
};

export const isGhcrImage = (image: string | null | undefined) =>
	typeof image === "string" &&
	image.trim().toLowerCase().startsWith("ghcr.io/");

/** `ghcr.io/<owner>/...`, case-insensitive: the only images a watch's login serves. */
export const isImageOfOwner = (
	image: string | null | undefined,
	owner: string,
) =>
	typeof image === "string" &&
	image
		.trim()
		.toLowerCase()
		.startsWith(`ghcr.io/${owner.trim().toLowerCase()}/`);

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a compose file has an `image:` under `ghcr.io/<owner>/`. */
export const composeHasImageOfOwner = (
	composeFile: string | null | undefined,
	owner: string,
) =>
	typeof composeFile === "string" &&
	new RegExp(
		String.raw`^[ \t]*(?:-[ \t]*)?image:[ \t]*["']?ghcr\.io/${escapeRegExp(owner.trim())}/`,
		"im",
	).test(composeFile);

/**
 * The Docker auth config of an application's watch, or undefined. Only for an
 * image under the watched owner: the token of a GitHub account is not offered
 * to any other ghcr.io image the application happens to run.
 */
export const ghcrAuthConfigForApplication = async (
	applicationId: string,
	image: string | null | undefined,
) => {
	// No database read for the (usual) image that is not on ghcr.io.
	if (!isGhcrImage(image)) return undefined;
	const credentials = await loadGhcrCredentials("application", applicationId);
	if (!credentials || !isImageOfOwner(image, credentials.owner)) {
		return undefined;
	}
	return {
		username: credentials.username,
		password: credentials.password,
		serveraddress: credentials.registryUrl,
	};
};

/**
 * The watch's config dir REPLACES the host's default one for that service's pull
 * and up, so on its own it would hide every other login of the host (a build
 * server registry, Docker Hub, a private registry) and the CLI plugins. This
 * shell seeds the dir from `$HOME/.docker` first: `config.json` is copied under
 * umask 077 and `cli-plugins` is linked. The default config is only READ.
 * The ghcr.io login is then added to the copy by `docker --config <dir> login`.
 *
 * A credential helper cannot be isolated: with `credsStore` / `credHelpers` in
 * the copy, `docker login` would hand the ghcr token to the host's shared
 * store. Both keys are renamed in the copy (still valid JSON, ignored by
 * Docker), so the ghcr login stays in the file and the logins the host keeps in
 * a helper are not visible to this deploy. Hosts set up by Dokploy have none.
 */
export const getGhcrConfigSeedCommand = (configDir: string) => {
	const dir = shEscape(configDir);
	return [
		"umask 077",
		`mkdir -p ${dir}`,
		`if [ -f "$HOME/.docker/config.json" ]; then sed -e 's/"credsStore"/"x-dokploy-ignored-credsStore"/' -e 's/"credHelpers"/"x-dokploy-ignored-credHelpers"/' "$HOME/.docker/config.json" > ${dir}/config.json.seed && mv -f ${dir}/config.json.seed ${dir}/config.json; fi`,
		`if [ -d "$HOME/.docker/cli-plugins" ]; then ln -sfn "$HOME/.docker/cli-plugins" ${dir}/cli-plugins; fi`,
	].join("; ");
};

const seedConfigDir = async (
	configDir: string,
	serverId: string | null | undefined,
) => {
	const command = getGhcrConfigSeedCommand(configDir);
	try {
		if (serverId) await execAsyncRemote(serverId, command);
		else await execAsync(command);
	} catch (error) {
		// The login below still works on an empty dir; only other registries are lost.
		console.warn(
			"GitHub deployments: could not copy the default docker config:",
			error instanceof Error ? error.message : "unknown error",
		);
	}
};

const login = async (
	credentials: NonNullable<Awaited<ReturnType<typeof loadGhcrCredentials>>>,
	serverId: string | null | undefined,
): Promise<string | undefined> => {
	const configDir = getGhcrWatchConfigDir(credentials.watchId, !!serverId);
	await seedConfigDir(configDir, serverId);
	try {
		await runDockerLogin(
			{
				configDir,
				registryType: "cloud",
				registryUrl: credentials.registryUrl,
				username: credentials.username,
				password: credentials.password,
			},
			serverId,
		);
		return configDir;
	} catch (error) {
		console.warn(
			"GitHub deployments: could not log in to ghcr.io:",
			error instanceof Error ? error.message : "unknown error",
		);
		return undefined;
	}
};

/**
 * `docker login ghcr.io` into the watch's own config dir on the host that will
 * run the stack, with the password on stdin (never in argv). Returns the dir to
 * point this stack's pull / up at (`DOCKER_CONFIG`), or undefined when the stack
 * has no watch or runs no image of the watched owner. A failed login is reported
 * but never fails the deploy: a public image still pulls, and a private one
 * fails at the pull with Docker's own message.
 */
export const loginGhcrForCompose = async (
	composeId: string,
	serverId: string | null | undefined,
	composeFile: string | null | undefined,
): Promise<string | undefined> => {
	if (!/ghcr\.io\//i.test(composeFile ?? "")) return undefined;
	const credentials = await loadGhcrCredentials("compose", composeId);
	if (!credentials || !composeHasImageOfOwner(composeFile, credentials.owner)) {
		return undefined;
	}
	return login(credentials, serverId);
};

/**
 * The same for the host that pulls an application's image: returns the config
 * dir for `docker --config`, or undefined unless the image is under the watched
 * owner and the application has an active watch.
 */
export const loginGhcrForApplication = async (
	applicationId: string,
	image: string | null | undefined,
	serverId: string | null | undefined,
): Promise<string | undefined> => {
	if (!isGhcrImage(image)) return undefined;
	const credentials = await loadGhcrCredentials("application", applicationId);
	if (!credentials || !isImageOfOwner(image, credentials.owner)) {
		return undefined;
	}
	return login(credentials, serverId);
};
