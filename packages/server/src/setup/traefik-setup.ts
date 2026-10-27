import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type Dockerode from "dockerode";
import type {
	Container,
	ContainerCreateOptions,
	ContainerInspectInfo,
	CreateServiceOptions,
} from "dockerode";
import { stringify } from "yaml";
import { paths } from "../constants";
import { sleep } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import type { FileConfig } from "../utils/traefik/file-types";
import type { MainTraefikConfig } from "../utils/traefik/types";

export const TRAEFIK_SSL_PORT =
	Number.parseInt(process.env.TRAEFIK_SSL_PORT!, 10) || 443;
export const TRAEFIK_PORT =
	Number.parseInt(process.env.TRAEFIK_PORT!, 10) || 80;
export const TRAEFIK_HTTP3_PORT =
	Number.parseInt(process.env.TRAEFIK_HTTP3_PORT!, 10) || 443;
export const TRAEFIK_BIND_IP = process.env.TRAEFIK_BIND_IP || "0.0.0.0";
export const TRAEFIK_VERSION = process.env.TRAEFIK_VERSION || "3.7.16";
export const TRAEFIK_IMAGE = `traefik:v${TRAEFIK_VERSION}`;

export interface TraefikOptions {
	env?: string[];
	serverId?: string;
	// Only the explicit Traefik update sets this. Without it a recreate keeps
	// the image the host runs, and uses TRAEFIK_IMAGE only when there is none.
	image?: string;
	additionalPorts?: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[];
}

export const splitImageReference = (image: string) => {
	// Swarm service images carry a @sha256 digest.
	const reference = image.split("@")[0] ?? "";
	const tagStart = reference.lastIndexOf(":");
	// A colon followed by a slash is a registry port, not a tag.
	if (tagStart === -1 || reference.slice(tagStart).includes("/")) {
		return { repository: reference, tag: null };
	}
	return {
		repository: reference.slice(0, tagStart),
		tag: reference.slice(tagStart + 1),
	};
};

// Checked by name, not instanceof: the server code can be bundled twice.
export const TRAEFIK_IMAGE_REFUSED = "TraefikImageRefusedError";

const refuseTraefikImage = (message: string) => {
	const error = new Error(message);
	error.name = TRAEFIK_IMAGE_REFUSED;
	return error;
};

export const isImageId = (reference: string) =>
	/^sha256:[0-9a-f]+$/i.test(reference);

// Saving env, ports or the dashboard toggle must not change the Traefik
// version, so a routine recreate reuses the running image as it is. Without a
// readable tag the recreate could pull another version, so it is refused.
export const keepRunningTraefikImage = (image: string | null | undefined) => {
	const reference = image?.trim() ?? "";
	if (
		!reference ||
		reference.startsWith("sha256:") ||
		!splitImageReference(reference).tag
	) {
		throw refuseTraefikImage(
			`Can't read the version tag of the running Traefik image${reference ? ` "${reference}"` : ""}, so Dokploy won't recreate it: that could change the Traefik version. Run dokploy-traefik from a tagged image (for example ${TRAEFIK_IMAGE}) first.`,
		);
	}
	return reference;
};

const localImageId = (docker: Dockerode, reference: string) =>
	docker
		.getImage(reference)
		.inspect()
		.then(
			(info) => info.Id,
			() => null,
		);

// A tag like traefik:latest or traefik:v3 can move after the container was
// created, so the tag is only reused while it still names the running image;
// otherwise the running image itself (by ID) is used. A routine recreate never
// pulls, so when Docker no longer has that image it is refused.
const keepRunningContainerImage = async (
	docker: Dockerode,
	info: ContainerInspectInfo,
) => {
	const reference = info.Config?.Image?.trim() ?? "";
	const runningId = info.Image;
	// A container recreated from its image ID below names that ID.
	if (!isImageId(reference)) {
		keepRunningTraefikImage(reference);
		if (runningId && (await localImageId(docker, reference)) === runningId) {
			return reference;
		}
	}
	if (runningId && (await localImageId(docker, runningId)) === runningId) {
		return runningId;
	}
	throw refuseTraefikImage(
		`The image the running Traefik was created from (${reference || "unknown"}${runningId && runningId !== reference ? `, ${runningId}` : ""}) is no longer on this server, so Dokploy won't recreate it: downloading the tag again could change the Traefik version. Pull that exact image on the server first.`,
	);
};

// For a routine Traefik action: the image its recreate would use, or the
// refusal it would hit. Swarm services keep their image with its digest.
export const resolveRoutineTraefikImage = async (serverId?: string) => {
	const docker = await getRemoteDocker(serverId);
	const service = await docker
		.getService("dokploy-traefik")
		.inspect()
		.catch(() => null);
	if (service) {
		return keepRunningTraefikImage(
			service.Spec?.TaskTemplate?.ContainerSpec?.Image,
		);
	}
	const info = await docker
		.getContainer("dokploy-traefik")
		.inspect()
		.catch(() => null);
	return info ? keepRunningContainerImage(docker, info) : TRAEFIK_IMAGE;
};

type PortBinding = { HostPort: string; HostIp: string };

export const applyAdditionalPortBindings = (
	exposedPorts: Record<string, {}>,
	portBindings: Record<string, PortBinding[]>,
	additionalPorts: NonNullable<TraefikOptions["additionalPorts"]>,
) => {
	for (const port of additionalPorts) {
		const portKey = `${port.targetPort}/${port.protocol ?? "tcp"}`;
		exposedPorts[portKey] = {};
		const hostPort = port.publishedPort.toString();
		const bindings = portBindings[portKey] ?? [];
		// Several published ports can share one target port, so append instead of
		// replacing, but never bind the same host port twice.
		if (!bindings.some((binding) => binding.HostPort === hostPort)) {
			bindings.push({ HostPort: hostPort, HostIp: TRAEFIK_BIND_IP });
		}
		portBindings[portKey] = bindings;
	}
};

export const buildStandalonePortBindings = (
	additionalPorts: NonNullable<TraefikOptions["additionalPorts"]>,
) => {
	const exposedPorts: Record<string, {}> = {
		[`${TRAEFIK_PORT}/tcp`]: {},
		[`${TRAEFIK_SSL_PORT}/tcp`]: {},
		[`${TRAEFIK_HTTP3_PORT}/udp`]: {},
	};

	const portBindings: Record<string, PortBinding[]> = {
		[`${TRAEFIK_PORT}/tcp`]: [
			{ HostPort: TRAEFIK_PORT.toString(), HostIp: TRAEFIK_BIND_IP },
		],
		[`${TRAEFIK_SSL_PORT}/tcp`]: [
			{ HostPort: TRAEFIK_SSL_PORT.toString(), HostIp: TRAEFIK_BIND_IP },
		],
		[`${TRAEFIK_HTTP3_PORT}/udp`]: [
			{ HostPort: TRAEFIK_HTTP3_PORT.toString(), HostIp: TRAEFIK_BIND_IP },
		],
	};

	const enableDashboard = additionalPorts.some(
		(port) => port.targetPort === 8080,
	);

	// The dashboard binding is only a fallback: when 8080/tcp is itself one of the
	// additional ports, its published port(s) decide the host binding.
	const dashboardIsAdditional = additionalPorts.some(
		(port) => port.targetPort === 8080 && (port.protocol ?? "tcp") === "tcp",
	);
	if (enableDashboard) {
		exposedPorts["8080/tcp"] = {};
		portBindings["8080/tcp"] = dashboardIsAdditional
			? []
			: [{ HostPort: "8080", HostIp: TRAEFIK_BIND_IP }];
	}

	applyAdditionalPortBindings(exposedPorts, portBindings, additionalPorts);

	return { exposedPorts, portBindings };
};

// Overlapping recreates of one server would remove each other's containers.
const recreateQueue = new Map<string, Promise<void>>();

// Runs a job that touches the server's Traefik containers after the jobs
// already queued for that server. A job must not queue another one (it would
// wait for itself), so jobs call recreateStandaloneTraefik directly.
export const queueTraefikRecreate = <T>(
	serverId: string | undefined,
	job: () => Promise<T>,
): Promise<T> => {
	const key = serverId ?? "local";
	const run = (recreateQueue.get(key) ?? Promise.resolve()).then(job);
	// So a hung Docker call can't block later recreates.
	const settled = Promise.race([run.catch(() => {}), sleep(5 * 60_000)]).then(
		() => {},
	);
	recreateQueue.set(key, settled);
	void settled.then(() => {
		if (recreateQueue.get(key) === settled) {
			recreateQueue.delete(key);
		}
	});
	return run;
};

export const initializeStandaloneTraefik = (options: TraefikOptions = {}) =>
	queueTraefikRecreate(options.serverId, () =>
		recreateStandaloneTraefik(options),
	);

// Only from inside a queueTraefikRecreate job for the same server.
export const recreateStandaloneTraefik = async ({
	env,
	serverId,
	additionalPorts = [],
	image,
}: TraefikOptions) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const containerName = "dokploy-traefik";

	const docker = await getRemoteDocker(serverId);
	await restoreInterruptedTraefik(serverId);

	// Kept until the new container stays up, so it can be restored on failure.
	const currentInfo = await docker
		.getContainer(containerName)
		.inspect()
		.catch(() => null);
	const imageName =
		image ??
		(currentInfo
			? await keepRunningContainerImage(docker, currentInfo)
			: TRAEFIK_IMAGE);

	const { exposedPorts, portBindings } =
		buildStandalonePortBindings(additionalPorts);

	const settings: ContainerCreateOptions = {
		name: containerName,
		Image: imageName,
		NetworkingConfig: {
			EndpointsConfig: {
				"dokploy-network": {},
			},
		},
		ExposedPorts: exposedPorts,
		HostConfig: {
			RestartPolicy: {
				Name: "always",
			},
			Binds: [
				`${MAIN_TRAEFIK_PATH}/traefik.yml:/etc/traefik/traefik.yml`,
				`${DYNAMIC_TRAEFIK_PATH}:/etc/dokploy/traefik/dynamic`,
				"/var/run/docker.sock:/var/run/docker.sock",
			],
			PortBindings: portBindings,
		},
		Env: env,
	};

	// Only the explicit update and a first install download an image.
	if (image || !currentInfo) {
		await ensureTraefikImage(serverId, imageName);
	}

	const current = currentInfo ? docker.getContainer(currentInfo.Id) : null;
	if (current) {
		await docker
			.getContainer(PREVIOUS_TRAEFIK_CONTAINER)
			.remove({ force: true })
			.catch(() => {});
		// Docker 25 to 29.6 refuse to rename a running container that is attached
		// to a swarm overlay network ("could not add service state for endpoint ...
		// already exists", moby/moby#42351), and Traefik is attached to
		// dokploy-network. A stopped container renames fine, so stop it first.
		await current.stop().catch(() => {});
		try {
			await current.rename({ name: PREVIOUS_TRAEFIK_CONTAINER });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			try {
				if (currentInfo?.State.Running) {
					await startIfStopped(current);
				}
			} catch (startError) {
				throw new Error(
					`Could not rename the Traefik container: ${reason}. Starting it again also failed: ${startError instanceof Error ? startError.message : startError}`,
				);
			}
			throw new Error(
				`Could not rename the Traefik container: ${reason}. The previous Traefik was ${currentInfo?.State.Running ? "started again" : "left as it was"}.`,
			);
		}
		await sleep(5000);
	}

	try {
		const created = await docker.createContainer(settings);
		await created.start();
		await waitUntilStable(created);
	} catch (error) {
		if (!current) {
			console.log("Traefik Not Found: Starting ", error);
			return;
		}
		await docker
			.getContainer(containerName)
			.remove({ force: true })
			.catch(() => {});
		const reason = error instanceof Error ? error.message : String(error);
		try {
			await current.rename({ name: containerName });
			if (currentInfo?.State.Running) {
				await current.start();
			}
		} catch (restoreError) {
			throw new Error(
				`${reason}. Restoring the previous Traefik also failed: ${restoreError instanceof Error ? restoreError.message : restoreError}`,
			);
		}
		throw new Error(`${reason}. The previous Traefik was restored.`);
	}

	await current?.remove({ force: true }).catch(() => {});
	console.log("Traefik Started ✅");
};

export const PREVIOUS_TRAEFIK_CONTAINER = "dokploy-traefik-previous";

// Start is an error on a container that already runs.
const startIfStopped = async (container: Container) => {
	const info = await container.inspect();
	if (!info.State.Running) {
		await container.start();
	}
};

// An interrupted recreate (e.g. a Dokploy restart) leaves only the stopped backup.
export const restoreInterruptedTraefik = async (serverId?: string) => {
	const docker = await getRemoteDocker(serverId);
	const exists = await docker
		.getContainer("dokploy-traefik")
		.inspect()
		.then(
			() => true,
			() => false,
		);
	if (exists) {
		return;
	}
	const backupInfo = await docker
		.getContainer(PREVIOUS_TRAEFIK_CONTAINER)
		.inspect()
		.catch(() => null);
	if (!backupInfo) {
		return;
	}
	const backup = docker.getContainer(backupInfo.Id);
	// Normally stopped already; a running one is stopped for the rename (a
	// running container on the overlay network can't be renamed) and started
	// again below.
	if (backupInfo.State.Running) {
		await backup.stop();
	}
	try {
		await backup.rename({ name: "dokploy-traefik" });
	} catch (error) {
		if (backupInfo.State.Running) {
			await backup.start().catch(() => {});
		}
		throw error;
	}
	await backup.start();
	console.log("Restored Traefik left behind by an interrupted recreate");
};

// docker.pull resolves before the download ends and reports errors in the stream.
export const ensureTraefikImage = async (
	serverId?: string,
	imageName = TRAEFIK_IMAGE,
) => {
	const docker = await getRemoteDocker(serverId);
	const image = docker.getImage(imageName);
	if (
		await image.inspect().then(
			() => true,
			() => false,
		)
	) {
		return;
	}
	const stream = await docker.pull(imageName);
	await new Promise<void>((resolve, reject) => {
		docker.modem.followProgress(
			stream,
			(error: Error | null, events: { error?: string }[] = []) => {
				const failed = events.find((event) => event.error);
				if (error || failed) {
					reject(error ?? new Error(failed?.error));
				} else {
					resolve();
				}
			},
		);
	});
	await image.inspect();
};

// restart: always hides a container that exits on start.
const waitUntilStable = async (container: Container) => {
	await sleep(3000);
	const first = await container.inspect();
	await sleep(2000);
	const second = await container.inspect();
	if (
		second.State.Running &&
		second.State.StartedAt === first.State.StartedAt
	) {
		return;
	}
	const logs = await container
		.logs({ stdout: true, stderr: true, tail: 5 })
		.catch(() => null);
	const lastLine = logs ? lastLogLine(logs) : "";
	throw new Error(
		`The new Traefik container stopped right after starting${lastLine ? `: ${lastLine}` : ""}`,
	);
};

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// Non-TTY container logs come in frames with an 8-byte header.
export const lastLogLine = (logs: Buffer) => {
	let text = "";
	for (let offset = 0; offset + 8 <= logs.length; ) {
		const size = logs.readUInt32BE(offset + 4);
		text += logs.subarray(offset + 8, offset + 8 + size).toString();
		offset += 8 + size;
	}
	const lines = text.replace(ANSI_COLOR, "").trim().split("\n");
	return (lines.at(-1) ?? "").trim().slice(0, 300);
};

export const initializeTraefikService = async ({
	env,
	additionalPorts = [],
	serverId,
	image,
}: TraefikOptions) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const appName = "dokploy-traefik";
	const docker = await getRemoteDocker(serverId);
	const service = docker.getService(appName);
	const inspect = await service.inspect().catch(() => null);
	// The service image keeps its @sha256 digest, so the version stays exact.
	const imageName =
		image ??
		(inspect
			? keepRunningTraefikImage(
					inspect.Spec?.TaskTemplate?.ContainerSpec?.Image,
				)
			: TRAEFIK_IMAGE);

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: env,
				Mounts: [
					{
						Type: "bind",
						Source: `${MAIN_TRAEFIK_PATH}/traefik.yml`,
						Target: "/etc/traefik/traefik.yml",
					},
					{
						Type: "bind",
						Source: DYNAMIC_TRAEFIK_PATH,
						Target: "/etc/dokploy/traefik/dynamic",
					},
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
					},
				],
			},
			Networks: [{ Target: "dokploy-network" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		EndpointSpec: {
			Ports: [
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "udp",
				},
				{
					TargetPort: 80,
					PublishedPort: TRAEFIK_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},

				...additionalPorts.map((port) => ({
					TargetPort: port.targetPort,
					PublishedPort: port.publishedPort,
					Protocol: port.protocol as "tcp" | "udp" | "sctp" | undefined,
					PublishMode: "host" as const,
				})),
			],
		},
	};
	if (inspect) {
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
			},
		});
		console.log("Traefik Updated ✅");
	} else {
		await docker.createService(settings);
		console.log("Traefik Started ✅");
	}
};

export const createDefaultServerTraefikConfig = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configFilePath = path.join(DYNAMIC_TRAEFIK_PATH, "dokploy.yml");

	if (existsSync(configFilePath)) {
		console.log("Default traefik config already exists");
		return;
	}

	const appName = "dokploy";
	const serviceURLDefault = `http://${appName}:${process.env.PORT || 3000}`;
	const config: FileConfig = {
		http: {
			routers: {
				[`${appName}-router-app`]: {
					rule: `Host(\`${appName}.docker.localhost\`) && PathPrefix(\`/\`)`,
					service: `${appName}-service-app`,
					entryPoints: ["web"],
				},
			},
			services: {
				[`${appName}-service-app`]: {
					loadBalancer: {
						servers: [{ url: serviceURLDefault }],
						passHostHeader: true,
					},
				},
			},
		},
	};

	const yamlStr = stringify(config);
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(
		path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`),
		yamlStr,
		"utf8",
	);
};

export const getDefaultTraefikConfig = () => {
	const configObject: MainTraefikConfig = {
		global: {
			sendAnonymousUsage: false,
		},
		providers: {
			...(process.env.NODE_ENV === "development"
				? {
						docker: {
							defaultRule:
								"Host(`{{ trimPrefix `/` .Name }}.docker.localhost`)",
						},
					}
				: {
						swarm: {
							exposedByDefault: false,
							watch: true,
						},
						docker: {
							exposedByDefault: false,
							watch: true,
							network: "dokploy-network",
						},
					}),
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http2: {
					maxConcurrentStreams: 0,
				},
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
				...(process.env.NODE_ENV === "production" && {
					http: {
						tls: {
							certResolver: "letsencrypt",
						},
					},
				}),
			},
		},
		api: {
			insecure: false,
		},
		...(process.env.NODE_ENV === "production" && {
			certificatesResolvers: {
				letsencrypt: {
					acme: {
						email: "test@localhost.com",
						storage: "/etc/dokploy/traefik/dynamic/acme.json",
						httpChallenge: {
							entryPoint: "web",
						},
					},
				},
			},
		}),
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const getDefaultServerTraefikConfig = (withSwarmProvider = true) => {
	const configObject: MainTraefikConfig = {
		providers: {
			...(withSwarmProvider && {
				swarm: {
					exposedByDefault: false,
					watch: true,
				},
			}),
			docker: {
				exposedByDefault: false,
				watch: true,
				network: "dokploy-network",
			},
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
				http: {
					tls: {
						certResolver: "letsencrypt",
					},
				},
			},
		},
		api: {
			insecure: false,
		},
		certificatesResolvers: {
			letsencrypt: {
				acme: {
					email: "test@localhost.com",
					storage: "/etc/dokploy/traefik/dynamic/acme.json",
					httpChallenge: {
						entryPoint: "web",
					},
				},
			},
		},
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const createDefaultTraefikConfig = () => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths();
	const mainConfig = path.join(MAIN_TRAEFIK_PATH, "traefik.yml");
	const acmeJsonPath = path.join(DYNAMIC_TRAEFIK_PATH, "acme.json");

	if (existsSync(acmeJsonPath)) {
		chmodSync(acmeJsonPath, "600");
	}

	// Create the traefik directory first
	mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true });

	// Check if traefik.yml exists and handle the case where it might be a directory
	if (existsSync(mainConfig)) {
		const stats = statSync(mainConfig);
		if (stats.isDirectory()) {
			// If traefik.yml is a directory, remove it
			console.log("Found traefik.yml as directory, removing it...");
			rmSync(mainConfig, { recursive: true, force: true });
		} else if (stats.isFile()) {
			console.log("Main config already exists");
			return;
		}
	}

	const yamlStr = getDefaultTraefikConfig();
	writeFileSync(mainConfig, yamlStr, "utf8");
	console.log("Traefik config created successfully");
};

export const getDefaultMiddlewares = () => {
	const defaultMiddlewares = {
		http: {
			middlewares: {
				"redirect-to-https": {
					redirectScheme: {
						scheme: "https",
						permanent: true,
					},
				},
			},
		},
	};
	const yamlStr = stringify(defaultMiddlewares);
	return yamlStr;
};
export const createDefaultMiddlewares = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const middlewaresPath = path.join(DYNAMIC_TRAEFIK_PATH, "middlewares.yml");
	if (existsSync(middlewaresPath)) {
		console.log("Default middlewares already exists");
		return;
	}
	const yamlStr = getDefaultMiddlewares();
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(middlewaresPath, yamlStr, "utf8");
};
