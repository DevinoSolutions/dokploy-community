import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { and, eq } from "drizzle-orm";

import { quote } from "shell-quote";
import semver from "semver";
import { db } from "../db";
import { compose } from "../db/schema";
import {
	ensureTraefikImage,
	initializeTraefikService,
	queueTraefikRecreate,
	recreateStandaloneTraefik,
	resolveRoutineTraefikImage,
	restoreInterruptedTraefik,
	splitImageReference,
	TRAEFIK_IMAGE_REFUSED,
	TRAEFIK_VERSION,
	type TraefikOptions,
} from "../setup/traefik-setup";
export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
};

/** Returns current Dokploy docker image tag or `latest` by default. */
export const getDokployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

/** Returns Dokploy docker service image digest */
export const getServiceImageDigest = async () => {
	const { stdout } = await execAsync(
		"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
	);

	const currentDigest = stdout.trim().split("@")[1];

	if (!currentDigest) {
		throw new Error("Could not get current service image digest");
	}

	return currentDigest;
};

/** Returns latest version and whether an update is available by checking
 *  GitHub releases on the DevinoSolutions fork. */
export const getUpdateData = async (
	currentVersion: string,
): Promise<IUpdateData> => {
	try {
		const response = await fetch(
			"https://api.github.com/repos/DevinoSolutions/dokploy-community/releases/latest",
			{
				method: "GET",
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "dokploy-community",
				},
			},
		);

		if (!response.ok) {
			return DEFAULT_UPDATE_DATA;
		}

		const release = (await response.json()) as { tag_name: string };
		const latestVersion = release.tag_name;

		if (!latestVersion) {
			return DEFAULT_UPDATE_DATA;
		}

		const cleanedCurrent = semver.clean(currentVersion);
		const cleanedLatest = semver.clean(latestVersion);

		if (!cleanedCurrent || !cleanedLatest) {
			return DEFAULT_UPDATE_DATA;
		}

		const updateAvailable = semver.gt(cleanedLatest, cleanedCurrent);

		return {
			latestVersion,
			updateAvailable,
		};
	} catch (error) {
		console.error("Error fetching update data:", error);
		return DEFAULT_UPDATE_DATA;
	}
};

export interface IReleaseNotesSection {
	/** Git tag for this release, e.g. `v0.29.12-community.1`. */
	tag: string;
	/** Public GitHub release page URL. */
	url: string;
	/** Raw markdown release body, or null when it could not be fetched. */
	body: string | null;
}

export interface IReleaseNotes {
	fork: IReleaseNotesSection | null;
	upstream: IReleaseNotesSection | null;
}

const GITHUB_API_HEADERS = {
	Accept: "application/vnd.github+json",
	"User-Agent": "dokploy-community",
};

/** Fetches the raw markdown release body for a repo + tag from the GitHub API.
 *  Returns null on any failure so callers never throw. */
const fetchReleaseBody = async (
	repo: string,
	tag: string,
): Promise<string | null> => {
	try {
		const response = await fetch(
			`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(
				tag,
			)}`,
			{
				method: "GET",
				headers: GITHUB_API_HEADERS,
			},
		);

		if (!response.ok) {
			return null;
		}

		const release = (await response.json()) as { body?: string | null };
		return release.body ?? null;
	} catch (error) {
		console.error(`Error fetching release notes for ${repo}@${tag}:`, error);
		return null;
	}
};

/** Returns the fork release notes for `version` together with the matching
 *  upstream base-release notes. The upstream base tag is derived by stripping
 *  the `-community.N` fork suffix. Section metadata (tag + url) is always
 *  populated; `body` is null when the GitHub fetch fails, and `upstream` is
 *  null when `version` carries no fork suffix. Never throws to the client. */
export const getReleaseNotes = async (
	version: string,
): Promise<IReleaseNotes> => {
	const cleaned = version.trim();
	if (!cleaned) {
		return { fork: null, upstream: null };
	}

	const forkTag = cleaned.startsWith("v") ? cleaned : `v${cleaned}`;
	const baseTag = forkTag.replace(/-community\.\d+$/, "");
	const hasUpstreamBase = baseTag !== forkTag;

	const [forkBody, upstreamBody] = await Promise.all([
		fetchReleaseBody("DevinoSolutions/dokploy-community", forkTag),
		hasUpstreamBase
			? fetchReleaseBody("Dokploy/dokploy", baseTag)
			: Promise.resolve(null),
	]);

	return {
		fork: {
			tag: forkTag,
			url: `https://github.com/DevinoSolutions/dokploy-community/releases/tag/${forkTag}`,
			body: forkBody,
		},
		upstream: hasUpstreamBase
			? {
					tag: baseTag,
					url: `https://github.com/Dokploy/dokploy/releases/tag/${baseTag}`,
					body: upstreamBody,
				}
			: null,
	};
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

/** Deepest directory level `readDirectory` lists; deeper entries are left out. */
export const MAX_READ_DIRECTORY_DEPTH = 16;

const READ_DIRECTORY_SENTINEL = "--";

/**
 * Lists `root` on a remote host as NUL-delimited paths relative to it: the
 * directories, a sentinel, the symlinks, a sentinel, then everything else.
 * `find` never follows symlinks (`-P`), so a link to a directory is reported
 * as a link and is not descended, and names are only ever data: there is no
 * `eval` and no JSON built in shell. Only `-P`, `-mindepth`, `-maxdepth`,
 * `-type` and `-print0` are used, which busybox find has too.
 */
export const buildRemoteReadDirectoryCommand = (root: string) => {
	const find = `find -P . -mindepth 1 -maxdepth ${MAX_READ_DIRECTORY_DEPTH}`;
	const sentinel = `printf '%s\\000' ${READ_DIRECTORY_SENTINEL}`;
	return [
		`root=${quote([root])}`,
		'[ -d "$root" ] || exit 0',
		'cd -- "$root" || exit 0',
		`${find} -type d -print0`,
		sentinel,
		`${find} -type l -print0`,
		sentinel,
		`${find} ! -type d ! -type l -print0`,
		// An unreadable subdirectory makes find exit 1; list what was readable.
		"exit 0",
	].join("\n");
};

const compareNames = (a: TreeDataItem, b: TreeDataItem) =>
	a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Builds the tree from the output of `buildRemoteReadDirectoryCommand`. */
export const parseRemoteReadDirectory = (
	root: string,
	stdout: string,
): TreeDataItem[] => {
	const records = stdout.split("\0");
	// The output ends with a NUL, which leaves one empty trailing record.
	if (records[records.length - 1] === "") records.pop();

	const directories: string[] = [];
	const others: { rel: string; type: "file" }[] = [];
	let section = 0;
	for (const record of records) {
		if (record === READ_DIRECTORY_SENTINEL) {
			section++;
			continue;
		}
		if (!record.startsWith("./")) continue;
		const rel = record.slice(2);
		if (!rel) continue;
		if (section === 0) directories.push(rel);
		// Symlinks and everything that is not a directory are plain files.
		else others.push({ rel, type: "file" });
	}

	const result: TreeDataItem[] = [];
	const childrenOf = new Map<string, TreeDataItem[]>([["", result]]);
	const parentOf = (rel: string) => {
		const slash = rel.lastIndexOf("/");
		return slash === -1 ? "" : rel.slice(0, slash);
	};
	const nameOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

	// Shallowest first, so a directory exists before its children are added.
	directories.sort((a, b) => a.split("/").length - b.split("/").length);
	for (const rel of directories) {
		const siblings = childrenOf.get(parentOf(rel));
		if (!siblings) continue;
		const children: TreeDataItem[] = [];
		siblings.push({
			id: posix.join(root, rel),
			name: nameOf(rel),
			type: "directory",
			children,
		});
		childrenOf.set(rel, children);
	}
	for (const { rel } of others) {
		childrenOf.get(parentOf(rel))?.push({
			id: posix.join(root, rel),
			name: nameOf(rel),
			type: "file",
		});
	}
	for (const siblings of childrenOf.values()) siblings.sort(compareNames);
	return result;
};

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			buildRemoteReadDirectoryCommand(dirPath),
		);
		return parseRemoteReadDirectory(dirPath, stdout);
	}

	const stack: { path: string; depth: number }[] = [
		{ path: dirPath, depth: 1 },
	];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const currentPath = current.path;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			// A Dirent is typed without following links: a symlink is a file here.
			if (item.isDirectory()) {
				if (current.depth < MAX_READ_DIRECTORY_DEPTH) {
					stack.push({ path: fullPath, depth: current.depth + 1 });
				}
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
	version?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		if (resourceName === "dokploy") {
			const currentImageTag = getDokployImageTag();
			let imageTag = version;
			if (currentImageTag === "canary" || currentImageTag === "feature") {
				imageTag = currentImageTag;
			}

			command = `docker service update --force --image ghcr.io/devinosolutions/dokploy-community:${imageTag} ${resourceName}`;
		} else {
			command = `docker service update --force ${resourceName}`;
		}
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => (await readEnvironmentVariableList(resourceName, serverId)).join("\n");

export const readEnvironmentVariableList = async (
	resourceName: string,
	serverId?: string,
): Promise<string[]> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return [];
	}
	return JSON.parse(result) ?? [];
};

/**
 * Thrown by `readPorts` when the docker resource is neither a swarm service nor
 * a standalone container (for example Traefik is not installed on the host).
 */
export class DockerResourceNotFoundError extends Error {
	constructor(message = "Resource type not found") {
		super(message);
		this.name = "DockerResourceNotFoundError";
	}
}

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new DockerResourceNotFoundError();
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	const seenPorts = new Set<string>();
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMappings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			// A target port can be published on several host ports. Docker also
			// lists each host port once per address family (IPv4 and IPv6), so
			// keep every distinct host port and drop the per-family duplicates.
			// Docker reports `null` for a port that is exposed but not published.
			for (const mapping of containerPortMappings ?? []) {
				const publishedPort = Number.parseInt(mapping?.HostPort, 10);
				if (Number.isNaN(publishedPort)) {
					continue;
				}
				const portKey = `${targetPort}-${publishedPort}-${protocol}`;
				if (!seenPorts.has(portKey)) {
					seenPorts.add(portKey);
					ports.push({
						targetPort: targetPort,
						publishedPort: publishedPort,
						protocol: protocol,
					});
				}
			}
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

/**
 * Whether the Traefik dashboard port (8080) is published. A host without
 * Traefik has no published ports, so it reports `false` instead of failing.
 * Any other failure (docker/SSH errors) still propagates.
 */
export const isTraefikDashboardPortEnabled = async (
	serverId?: string,
): Promise<boolean> => {
	try {
		const ports = await readPorts("dokploy-traefik", serverId);
		return ports.some((port) => port.targetPort === 8080);
	} catch (error) {
		if (error instanceof DockerResourceNotFoundError) {
			return false;
		}
		throw error;
	}
};

export const checkPortInUse = async (
	port: number,
	serverId?: string,
): Promise<{ isInUse: boolean; conflictingContainer?: string }> => {
	try {
		// Check if port is in use by a Docker container
		const dockerCommand = `docker ps -a --format '{{.Names}}' | grep -v '^dokploy-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
		const { stdout: dockerOut } = serverId
			? await execAsyncRemote(serverId, dockerCommand)
			: await execAsync(dockerCommand);

		const container = dockerOut.trim();

		if (container) {
			return {
				isInUse: true,
				conflictingContainer: `container "${container}"`,
			};
		}

		// Check if port is in use by a host-level service (non-Docker)
		// Dokploy runs inside a container, so we spawn an ephemeral container
		// with --net=host to share the host's network stack and use nc -z to
		// check if something is listening on the port
		const hostCommand = `docker run --rm --net=host busybox sh -c 'nc -z 0.0.0.0 ${port} 2>/dev/null && echo in_use || echo free'`;
		const { stdout: hostOut } = serverId
			? await execAsyncRemote(serverId, hostCommand)
			: await execAsync(hostCommand);

		if (hostOut.includes("in_use")) {
			return {
				isInUse: true,
				conflictingContainer: "a host-level service",
			};
		}

		return { isInUse: false };
	} catch (error) {
		console.error("Error checking port availability:", error);
		return { isInUse: false };
	}
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	// One queued job per server: restoring the backup while another recreate
	// has its container renamed away would leave both recreates fighting over
	// it, and the first one then removes it.
	await queueTraefikRecreate(input.serverId, async () => {
		await restoreInterruptedTraefik(input.serverId);
		const resourceType = await getDockerResourceType(
			"dokploy-traefik",
			input.serverId,
		);

		if (resourceType === "service") {
			await initializeTraefikService({
				env: input.env,
				additionalPorts: input.additionalPorts,
				serverId: input.serverId,
				image: input.image,
			});
		} else if (resourceType === "standalone") {
			await recreateStandaloneTraefik({
				env: input.env,
				additionalPorts: input.additionalPorts,
				serverId: input.serverId,
				image: input.image,
			});
		} else {
			throw new Error("Traefik resource type not found");
		}
	});
	await reconnectServicesToTraefik(input.serverId);
};

export const parseTraefikImageVersion = (image: string) => {
	const { tag } = splitImageReference(image);
	return tag ? (semver.coerce(tag)?.version ?? null) : null;
};

// The exec helpers have no timeout of their own.
const rejectAfter = <T>(promise: Promise<T>, ms: number, message: string) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

const OFFICIAL_TRAEFIK_REPOSITORIES = [
	"traefik",
	"library/traefik",
	"docker.io/traefik",
	"docker.io/library/traefik",
];

type TraefikVersionStatus =
	| "not-found"
	| "custom"
	| "unknown"
	| "outdated"
	| "up-to-date"
	| "newer";

export const getTraefikOverview = async (serverId?: string) => {
	const recommendedVersion = TRAEFIK_VERSION;

	// Unlike getDockerResourceType, an unreachable server throws instead of
	// being reported as a missing Traefik.
	const command = `
if ! docker info >/dev/null 2>&1; then
	echo "docker-unavailable"
elif docker service inspect dokploy-traefik >/dev/null 2>&1; then
	task=$(docker service ps dokploy-traefik --filter desired-state=running --no-trunc -q | head -n 1)
	[ -z "$task" ] && task=$(docker service ps dokploy-traefik --no-trunc -q | head -n 1)
	if [ -n "$task" ]; then
		docker inspect "$task" --format '{{.Spec.ContainerSpec.Image}}|{{.Status.State}}|{{.Status.Timestamp}}'
	else
		echo "$(docker service inspect dokploy-traefik --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')|stopped|"
	fi
elif docker container inspect dokploy-traefik >/dev/null 2>&1; then
	docker container inspect dokploy-traefik --format '{{.Config.Image}}|{{.State.Status}}|{{.State.StartedAt}}'
else
	echo "missing"
fi`;
	const { stdout } = await rejectAfter(
		serverId ? execAsyncRemote(serverId, command) : execAsync(command),
		30_000,
		"Timed out reading the Traefik status from this server after 30 seconds.",
	);
	const output = stdout.trim();

	if (output === "docker-unavailable") {
		throw new Error(
			"Docker is not reachable on this server. Check that it is installed and running.",
		);
	}
	if (output === "missing") {
		return {
			state: null,
			startedAt: null,
			image: null,
			currentVersion: null,
			recommendedVersion,
			versionStatus: "not-found" as const,
		};
	}

	const [image = "", state = "", startedAt = ""] = output.split("|");
	const currentVersion = parseTraefikImageVersion(image);
	const target = semver.coerce(recommendedVersion)?.version;

	let versionStatus: TraefikVersionStatus = "up-to-date";
	if (
		!OFFICIAL_TRAEFIK_REPOSITORIES.includes(
			splitImageReference(image).repository,
		)
	) {
		versionStatus = "custom";
	} else if (!currentVersion || !target) {
		versionStatus = "unknown";
	} else if (semver.lt(currentVersion, target)) {
		versionStatus = "outdated";
	} else if (semver.gt(currentVersion, target)) {
		versionStatus = "newer";
	}

	return {
		state: state || null,
		startedAt: state === "running" && startedAt ? startedAt : null,
		image,
		currentVersion,
		recommendedVersion,
		versionStatus,
	};
};

// Routine Traefik actions recreate in the background, where an image that
// can't be kept is refused; check it first so the caller sees why. An
// unreachable host is left to the action itself.
export const assertRunningTraefikImageKept = async (serverId?: string) => {
	try {
		await resolveRoutineTraefikImage(serverId);
	} catch (error) {
		if (error instanceof Error && error.name === TRAEFIK_IMAGE_REFUSED) {
			throw error;
		}
	}
};

// Stays under proxy timeouts (~100s); the download continues in the background.
export const pullTraefikImage = (serverId?: string) =>
	rejectAfter(
		ensureTraefikImage(serverId),
		90_000,
		"the download took longer than 90 seconds. It continues in the background, so try again in a minute.",
	);

export const reconnectServicesToTraefik = async (serverId?: string) => {
	const composeResult = await db.query.compose.findMany({
		where: and(
			...(serverId ? [eq(compose.serverId, serverId)] : []),
			eq(compose.isolatedDeployment, true),
		),
	});

	if (composeResult.length === 0) {
		return;
	}
	let commands = "";

	for (const compose of composeResult) {
		commands += `docker network connect ${compose.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n`;
	}

	if (serverId) {
		await execAsyncRemote(serverId, commands);
	} else {
		await execAsync(commands);
	}
};
