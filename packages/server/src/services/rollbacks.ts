import { getSafeRegistryLoginCommand } from "@dokploy/server/db/schema";
import type { CreateServiceOptions } from "dockerode";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createRollbackSchema,
	deployments as deploymentsSchema,
	rollbacks,
} from "../db/schema";
import { getECRAuthToken } from "../utils/aws/ecr";
import type { ApplicationNested } from "../utils/builders";
import { getRegistryTag } from "../utils/cluster/upload";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateVolumeMounts,
	prepareEnvironmentVariables,
} from "../utils/docker/utils";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { type Application, findApplicationById } from "./application";
import { findDeploymentById } from "./deployment";
import type { Mount } from "./mount";
import { resolveNetworkNamesForResource } from "./network";
import type { Port } from "./port";
import type { Project } from "./project";
import { findRegistryByIdWithCredentials, type Registry } from "./registry";

export const createRollback = async (
	input: z.infer<typeof createRollbackSchema>,
) => {
	return await db.transaction(async (tx) => {
		const { fullContext, ...other } = input;
		const rollback = await tx
			.insert(rollbacks)
			.values(other)
			.returning()
			.then((res) => res[0]);

		if (!rollback) {
			throw new Error("Failed to create rollback");
		}

		const tagImage = `${input.appName}:v${rollback.version}`;
		const deployment = await findDeploymentById(rollback.deploymentId);

		if (!deployment?.applicationId) {
			throw new Error("Deployment not found");
		}

		const {
			deployments: _,
			bitbucket,
			github,
			gitlab,
			gitea,
			...rest
		} = await findApplicationById(deployment.applicationId);

		const registry = rest.registryId
			? await findRegistryByIdWithCredentials(rest.registryId)
			: rest.registry;
		const buildRegistry = rest.buildRegistryId
			? await findRegistryByIdWithCredentials(rest.buildRegistryId)
			: rest.buildRegistry;
		const rollbackRegistry = rest.rollbackRegistryId
			? await findRegistryByIdWithCredentials(rest.rollbackRegistryId)
			: rest.rollbackRegistry;

		const fullContextWithCredentials = {
			...rest,
			registry,
			buildRegistry,
			rollbackRegistry,
		};

		await tx
			.update(rollbacks)
			.set({
				image: tagImage,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				fullContext: fullContextWithCredentials as any,
			})
			.where(eq(rollbacks.rollbackId, rollback.rollbackId));

		// Update the deployment to reference this rollback
		await tx
			.update(deploymentsSchema)
			.set({
				rollbackId: rollback.rollbackId,
			})
			.where(eq(deploymentsSchema.deploymentId, rollback.deploymentId));

		const updatedRollback = await tx.query.rollbacks.findFirst({
			where: eq(rollbacks.rollbackId, rollback.rollbackId),
		});

		return updatedRollback;
	});
};

export const findRollbackById = async (rollbackId: string) => {
	const result = await db.query.rollbacks.findFirst({
		where: eq(rollbacks.rollbackId, rollbackId),
		with: {
			deployment: {
				with: {
					// `application` has 100 columns (incl. the fork's `networkIds`).
					// Drizzle packs every selected column of a joined resource plus one
					// entry per nested relation into a single json_build_array(...),
					// which Postgres caps at 100 arguments (error 54023). Selecting all
					// of `application` emits json_build_array(100 columns + environment)
					// = 101 args and throws, so we project it down. Consumers only read
					// `deployment.applicationId` (a deployments column); the identifying
					// columns below are kept for API-shape stability. See
					// services/schedule.ts and services/volume-backups.ts for the same
					// fix.
					application: {
						columns: {
							applicationId: true,
							appName: true,
							name: true,
							serverId: true,
						},
						with: {
							environment: {
								columns: { environmentId: true, name: true },
								with: {
									project: {
										columns: {
											projectId: true,
											name: true,
											organizationId: true,
										},
									},
								},
							},
						},
					},
				},
			},
		},
	});

	if (!result) {
		throw new Error("Rollback not found");
	}

	return result;
};

const deleteRollbackImage = async (image: string, serverId?: string | null) => {
	const command = `docker image rm ${image} --force`;

	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const removeRollbackById = async (rollbackId: string) => {
	const rollback = await findRollbackById(rollbackId);

	if (!rollback) {
		throw new Error("Rollback not found");
	}

	if (rollback?.image) {
		try {
			const deployment = await findDeploymentById(rollback.deploymentId);

			if (!deployment?.applicationId) {
				throw new Error("Deployment not found");
			}

			const application = await findApplicationById(deployment.applicationId);
			await deleteRollbackImage(rollback.image, application.serverId);

			await db
				.delete(rollbacks)
				.where(eq(rollbacks.rollbackId, rollbackId))
				.returning()
				.then((res) => res[0]);
		} catch (error) {
			console.error(error);
		}
	}

	return rollback;
};

export const rollback = async (rollbackId: string) => {
	const result = await findRollbackById(rollbackId);

	const deployment = await findDeploymentById(result.deploymentId);

	if (!deployment?.applicationId) {
		throw new Error("Deployment not found");
	}

	const application = await findApplicationById(deployment.applicationId);

	if (!result.fullContext) {
		throw new Error("Rollback context not found");
	}
	await rollbackApplication(
		application.appName,
		result.image || "",
		application.serverId,
		result.fullContext,
	);
};

const dockerLoginForRegistry = async (
	registry: Registry,
	serverId?: string | null,
): Promise<string | undefined> => {
	let ecrAuthPassword: string | undefined;
	if (registry.registryType === "awsEcr") {
		const token = await getECRAuthToken({
			awsAccessKeyId: registry.awsAccessKeyId || "",
			awsSecretAccessKey: registry.awsSecretAccessKey || "",
			awsRegion: registry.awsRegion || "",
		});
		ecrAuthPassword = token.password;
	}

	const loginCommand = getSafeRegistryLoginCommand({
		registryType: registry.registryType,
		registryUrl: registry.registryUrl,
		username: registry.username,
		password: registry.password,
		ecrAuthPassword,
	});

	if (serverId) {
		await execAsyncRemote(serverId, loginCommand);
	} else {
		await execAsync(loginCommand);
	}

	return ecrAuthPassword;
};

const rollbackApplication = async (
	appName: string,
	image: string,
	serverId?: string | null,
	fullContext?: Application & {
		environment: {
			project: Project;
		};
		mounts: Mount[];
		ports: Port[];
		rollbackRegistry?: Registry | null;
	},
) => {
	if (!fullContext) {
		throw new Error("Full context is required for rollback");
	}

	const rollbackRegistry = fullContext.rollbackRegistry ?? undefined;

	// Ensure Docker daemon is authenticated with the rollback registry
	// before updating the swarm service. The authconfig in CreateServiceOptions
	// alone is not sufficient — Docker Swarm also relies on the daemon's
	// cached credentials (~/.docker/config.json) to distribute auth to nodes.
	let ecrAuthPassword: string | undefined;
	if (fullContext.rollbackRegistry) {
		ecrAuthPassword = await dockerLoginForRegistry(
			fullContext.rollbackRegistry,
			serverId,
		);
	}

	const docker = await getRemoteDocker(serverId);

	const {
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		ports,
	} = fullContext;

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const volumesMount = generateVolumeMounts(mounts);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		Networks,
		Ulimits,
	} = generateConfigContainer(
		fullContext as Parameters<typeof generateConfigContainer>[0],
		await resolveNetworkNamesForResource(
			(fullContext as ApplicationNested).networkIds,
			(fullContext as ApplicationNested).serverId,
			(fullContext as ApplicationNested).environment.project.organizationId,
		),
	);

	const bindsMount = generateBindMounts(mounts);
	const envVariables = prepareEnvironmentVariables(
		env,
		fullContext.environment.project.env,
	);

	let rollbackImage = image;
	if (rollbackRegistry) {
		rollbackImage = getRegistryTag(rollbackRegistry, image);
	}

	const isEcrRollback = fullContext.rollbackRegistry?.registryType === "awsEcr";
	const settings: CreateServiceOptions = {
		authconfig: {
			password: isEcrRollback
				? ecrAuthPassword || ""
				: fullContext.rollbackRegistry?.password || "",
			username: isEcrRollback
				? "AWS"
				: fullContext.rollbackRegistry?.username || "",
			serveraddress: fullContext.rollbackRegistry?.registryUrl || "",
		},
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: rollbackImage,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount],
				...(command
					? {
							Command: ["/bin/sh"],
							Args: ["-c", command],
						}
					: {}),
				...(Ulimits && { Ulimits }),
				Labels,
			},
			Networks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig,
		EndpointSpec: {
			Ports: ports.map((port) => ({
				PublishMode: port.publishMode,
				Protocol: port.protocol,
				TargetPort: port.targetPort,
				PublishedPort: port.publishedPort,
			})),
		},
		UpdateConfig,
	};

	try {
		const service = docker.getService(appName);
		const inspect = await service.inspect();

		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
			},
		});
	} catch (error) {
		console.error(error);
		await docker.createService(settings);
	}
};
