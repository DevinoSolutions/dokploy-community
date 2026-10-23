import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	previewDeployments,
} from "@dokploy/server/db/schema";
import {
	checkServiceAccess,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { quote } from "shell-quote";
import {
	OWNERSHIP_LABELS,
	SERVICE_TABLES,
} from "@/server/wss/container-ownership";

// One answer for every refusal (no such container, no service behind it, a
// service of another organization, a service the caller was not granted), so
// the response says nothing about which containers exist.
const containerNotFound = () =>
	new TRPCError({ code: "NOT_FOUND", message: "Container not found" });

// Docker resolves a name before an ID prefix, and a compose user may name a
// container like the prefix of another one. The id comes back with the labels so
// the caller can run its command on the object that was checked, not on
// whatever the string resolves to later. A swarm service is a different docker
// object from a container (`docker service logs` takes a service), and its ids
// are 25 characters.
export type DockerObjectKind = "container" | "service";

const FULL_ID: Record<DockerObjectKind, RegExp> = {
	container: /^[a-f0-9]{64}$/,
	service: /^[a-z0-9]{25}$/,
};

type DockerObject = { id: string; appNames: string[] };

const inspectCommand = (kind: DockerObjectKind, reference: string) =>
	quote(
		kind === "service"
			? [
					"docker",
					"service",
					"inspect",
					"--format",
					"{{.ID}} {{json .Spec.Labels}} {{.Spec.Name}}",
					reference,
				]
			: [
					"docker",
					"inspect",
					"--type",
					"container",
					"--format",
					"{{.Id}} {{json .Config.Labels}}",
					reference,
				],
	);

// The swarm pages list tasks (`docker service ps`), whose ids are not service
// ids, and `docker service logs` takes either. A task is resolved to the
// service it belongs to, and that service is what gets checked.
const taskCommand = (reference: string) =>
	quote([
		"docker",
		"inspect",
		"--type",
		"task",
		"--format",
		"{{.ID}} {{.ServiceID}}",
		reference,
	]);

const runOn = async (command: string, serverId?: string) =>
	serverId
		? await execAsyncRemote(serverId, command)
		: await execAsync(command);

const readService = async (
	reference: string,
	serverId?: string,
): Promise<DockerObject | null> => {
	const { stdout } = await runOn(
		inspectCommand("service", reference),
		serverId,
	);
	const output = stdout.trim();
	const split = output.indexOf(" ");
	const id = output.slice(0, split);
	if (split < 0 || !FULL_ID.service.test(id)) return null;
	// The service name is the last word; docker names hold no spaces.
	const rest = output.slice(split + 1);
	const nameAt = rest.lastIndexOf(" ");
	const labels = (JSON.parse(rest.slice(0, nameAt)) ?? {}) as Record<
		string,
		unknown
	>;
	return {
		id,
		appNames: ownershipNames([rest.slice(nameAt + 1), ...labelValues(labels)]),
	};
};

const readTask = async (
	reference: string,
	serverId?: string,
): Promise<DockerObject | null> => {
	const { stdout } = await runOn(taskCommand(reference), serverId);
	const [taskId, serviceId, ...extra] = stdout.trim().split(/\s+/);
	if (
		extra.length > 0 ||
		!taskId ||
		!serviceId ||
		!FULL_ID.service.test(taskId) ||
		!FULL_ID.service.test(serviceId)
	)
		return null;
	const service = await readService(serviceId, serverId);
	// `docker service logs` runs on the task id, so the single-task view stays.
	return service && { id: taskId, appNames: service.appNames };
};

const labelValues = (labels: Record<string, unknown>) =>
	OWNERSHIP_LABELS.map((label) => labels[label]);

const ownershipNames = (names: unknown[]) => [
	...new Set(
		names.filter(
			(value): value is string => typeof value === "string" && value !== "",
		),
	),
];

export const readDockerObject = async (
	reference: string,
	serverId?: string,
	kind: DockerObjectKind = "container",
): Promise<DockerObject | null> => {
	try {
		if (kind === "service") {
			try {
				const service = await readService(reference, serverId);
				if (service) return service;
			} catch {
				// not a service id: it may be a task of one
			}
			return await readTask(reference, serverId);
		}
		const { stdout } = await runOn(inspectCommand(kind, reference), serverId);
		const output = stdout.trim();
		const split = output.indexOf(" ");
		const id = output.slice(0, split);
		if (split < 0 || !FULL_ID.container.test(id)) return null;
		const labels = (JSON.parse(output.slice(split + 1)) ?? {}) as Record<
			string,
			unknown
		>;
		return { id, appNames: ownershipNames(labelValues(labels)) };
	} catch {
		return null;
	}
};

// Every service (and the service behind a preview deployment) whose appName is
// one of `appNames`, with the server it runs on.
const findServicesByAppName = async (appNames: string[]) => {
	const found: { serviceId: string; serverId: string | null }[] = [];
	for (const { table, id } of SERVICE_TABLES) {
		const rows = await db
			.select({ serviceId: id, serverId: table.serverId })
			.from(table)
			.where(inArray(table.appName, appNames));
		found.push(...rows);
	}

	const previews = await db
		.select({
			applicationId: previewDeployments.applicationId,
			composeId: previewDeployments.composeId,
		})
		.from(previewDeployments)
		.where(inArray(previewDeployments.appName, appNames));
	for (const { applicationId, composeId } of previews) {
		if (applicationId) {
			const [parent] = await db
				.select({ serverId: applications.serverId })
				.from(applications)
				.where(eq(applications.applicationId, applicationId));
			if (parent)
				found.push({ serviceId: applicationId, serverId: parent.serverId });
		}
		if (composeId) {
			const [parent] = await db
				.select({ serverId: compose.serverId })
				.from(compose)
				.where(eq(compose.composeId, composeId));
			if (parent)
				found.push({ serviceId: composeId, serverId: parent.serverId });
		}
	}
	return found;
};

export type ContainerServiceCheck =
	| { outcome: "readable"; serviceIds: string[] }
	| { outcome: "unowned" }
	| { outcome: "refused" };

/**
 * Maps a docker object's ownership labels to the Dokploy services behind it
 * and checks the caller may read every one of them.
 *
 * The labels (swarm service name, compose project, stack namespace) name the
 * service; the client never says which one. Every service the labels name must
 * run on `serverId`, and the caller must hold `service.read` on each of them.
 * `checkServiceAccess` applies the member allow-list and the organization
 * scope, so an owner or admin of one organization is refused a container of
 * another, and a member only gets the services they were granted.
 *
 * "unowned" means the labels name no service at all (Dokploy itself, Traefik,
 * its database, a container nobody labelled): the caller decides who may touch
 * those. "refused" means a service exists but is not the caller's to read.
 */
export const checkDockerObjectServices = async (
	ctx: PermissionCtx,
	object: DockerObject,
	serverId?: string,
): Promise<ContainerServiceCheck> => {
	if (object.appNames.length === 0) return { outcome: "unowned" };

	const services = await findServicesByAppName(object.appNames);
	if (services.length === 0) return { outcome: "unowned" };

	for (const service of services) {
		if ((service.serverId ?? undefined) !== serverId)
			return { outcome: "refused" };
		try {
			await checkServiceAccess(ctx, service.serviceId, "read");
		} catch {
			return { outcome: "refused" };
		}
	}
	return {
		outcome: "readable",
		serviceIds: [...new Set(services.map((service) => service.serviceId))],
	};
};

/**
 * Proves the caller may read the service a container belongs to, before
 * anything is run against the container (`docker top` prints the full argv of
 * its processes).
 *
 * Owners and admins are not exempt from the "belongs to a service" rule: a
 * container that backs no service is refused for every role.
 *
 * Returns the full id of the container that was checked. Run the command on
 * that id and never on the string the client sent.
 */
export const assertContainerServiceReadable = async (
	ctx: PermissionCtx,
	containerId: string,
	serverId?: string,
): Promise<string> => {
	const container = await readDockerObject(containerId, serverId);
	if (!container) throw containerNotFound();

	const check = await checkDockerObjectServices(ctx, container, serverId);
	if (check.outcome !== "readable") throw containerNotFound();
	return container.id;
};
