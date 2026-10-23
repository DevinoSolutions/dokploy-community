import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	previewDeployments,
} from "@dokploy/server/db/schema";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
	hasPermission,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import { getAccessibleServerIds } from "@dokploy/server/services/server";
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

const isOwnerOrAdmin = async (ctx: PermissionCtx) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	return member.role === "owner" || member.role === "admin";
};

/**
 * Whether the caller may reach `serverId`: it belongs to their organization and,
 * for a member, is one of the servers they were granted. No `serverId` is the
 * local Dokploy host, which every caller reaches.
 */
export const canReachServer = async (ctx: PermissionCtx, serverId?: string) => {
	if (!serverId) return true;
	const accessible = await getAccessibleServerIds({
		userId: ctx.user.id,
		activeOrganizationId: ctx.session.activeOrganizationId,
	});
	return accessible.has(serverId);
};

export const assertServerReachable = async (
	ctx: PermissionCtx,
	serverId?: string,
) => {
	if (!(await canReachServer(ctx, serverId)))
		throw new TRPCError({ code: "UNAUTHORIZED" });
};

/**
 * Resolves what a docker route was sent (a name or an id prefix) to the full id
 * of the ONE container that passed the ownership check; run the command on that
 * id and never on the string the client sent.
 *
 * The same rules as the container WebSockets (resolveDockerTarget):
 * - the caller can reach `serverId` (their organization, and for a member a
 *   server they were granted);
 * - the labels name the services behind the container, every one of them on
 *   that server and readable by the caller in their organization;
 * - a container that backs no service (Dokploy itself, Traefik, its database,
 *   an unlabelled one) is the host's own: owners and admins only.
 *
 * `access: "write"` is for routes that change the container or its files
 * (restart, stop, kill, remove, upload, edit, delete). The docker statement has
 * no write action, so those also need `deployment:create` on every service
 * behind the container, the same gate that starts, stops and reloads the
 * service itself. Owners and admins pass it like every enterprise statement.
 *
 * Every refusal is the same NOT_FOUND, so the answer says nothing about which
 * containers exist.
 */
export const resolveContainerForRoute = async (
	ctx: PermissionCtx,
	containerId: string,
	serverId: string | undefined,
	access: "read" | "write" = "read",
): Promise<string> => {
	try {
		if (!(await canReachServer(ctx, serverId))) throw containerNotFound();
		const container = await readDockerObject(containerId, serverId);
		if (!container) throw containerNotFound();

		const check = await checkDockerObjectServices(ctx, container, serverId);
		if (check.outcome === "refused") throw containerNotFound();
		if (check.outcome === "unowned") {
			if (!(await isOwnerOrAdmin(ctx))) throw containerNotFound();
			return container.id;
		}
		if (access === "write") {
			for (const serviceId of check.serviceIds) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					deployment: ["create"],
				});
			}
		}
		return container.id;
	} catch {
		throw containerNotFound();
	}
};

/**
 * The same check for a route that is sent an appName (the swarm service name or
 * compose project) instead of a container: the appName must name a service the
 * caller can read on `serverId`. An appName that names no service is the host's
 * own (Dokploy, Traefik): owners and admins only.
 */
export const assertAppNameReadable = async (
	ctx: PermissionCtx,
	appName: string,
	serverId?: string,
) => {
	try {
		if (!(await canReachServer(ctx, serverId))) throw containerNotFound();
		const check = await checkDockerObjectServices(
			ctx,
			{ id: "", appNames: [appName] },
			serverId,
		);
		if (check.outcome === "readable") return;
		if (check.outcome === "unowned" && (await isOwnerOrAdmin(ctx))) return;
		throw containerNotFound();
	} catch {
		throw containerNotFound();
	}
};

// What one list row may show a caller: a service they can read, or, for the
// host's own containers (no service behind them), only an owner or admin.
const rowVisible = (check: ContainerServiceCheck, admin: boolean) =>
	check.outcome === "readable" || (check.outcome === "unowned" && admin);

/**
 * Narrows a container list to the containers of services the caller can read.
 *
 * A member gets only the containers whose labels name services they were
 * granted on this server; a container that backs no service is dropped, and so
 * is everything when the labels cannot be read.
 *
 * Owners and admins see the list as it is (the Docker page lists everything on
 * the host). With `strict` they are checked too: a container of another
 * organization is dropped, and the host's own containers stay. The routes that
 * list by an appName use `strict`, because the command behind them matches more
 * than the appName (a prefix, a substring, an id prefix) and the appName is
 * something the caller can rename their own service to.
 *
 * The batched `docker inspect` exits non-zero when one container has vanished
 * but still prints the others; those are used and only the missing ones are
 * dropped.
 */
export const filterReadableContainers = async <
	T extends { containerId: string },
>(
	ctx: PermissionCtx,
	containers: T[],
	serverId?: string,
	options: { strict?: boolean } = {},
): Promise<T[]> => {
	if (containers.length === 0) return containers;
	const admin = await isOwnerOrAdmin(ctx);
	if (admin && !options.strict) return containers;

	// the placeholder "No container id" is not something docker can inspect
	const listed = containers.filter((container) =>
		/^[a-f0-9]{12,64}$/.test(container.containerId),
	);
	if (listed.length === 0) return [];

	let stdout: string;
	try {
		({ stdout } = await runOn(
			`${quote([
				"docker",
				"inspect",
				"--type",
				"container",
				"--format",
				"{{.Id}} {{json .Config.Labels}}",
				...listed.map((container) => container.containerId),
			])} 2>/dev/null || true`,
			serverId,
		));
	} catch {
		return [];
	}

	const labelled: { id: string; appNames: string[] }[] = [];
	for (const line of stdout.trim().split("\n")) {
		const split = line.indexOf(" ");
		const id = line.slice(0, split);
		if (split < 0 || !FULL_ID.container.test(id)) continue;
		try {
			const labels = (JSON.parse(line.slice(split + 1)) ?? {}) as Record<
				string,
				unknown
			>;
			labelled.push({ id, appNames: ownershipNames(labelValues(labels)) });
		} catch {
			// unreadable labels: the container stays out of the list
		}
	}

	const outcomes = new Map<string, Promise<ContainerServiceCheck>>();
	const kept: T[] = [];
	for (const container of listed) {
		const object = labelled.find((entry) =>
			entry.id.startsWith(container.containerId),
		);
		if (!object) continue;
		const key = [...object.appNames].sort().join("|");
		let outcome = outcomes.get(key);
		if (!outcome) {
			outcome = checkDockerObjectServices(ctx, object, serverId);
			outcomes.set(key, outcome);
		}
		if (rowVisible(await outcome, admin)) kept.push(container);
	}
	return kept;
};

/**
 * The same narrowing for swarm task rows (`docker service ps`, `docker stack
 * ps`), which carry a task id, not a container id. `serviceNameOf` gives the
 * swarm service a row belongs to; each distinct service is resolved once with
 * `docker service inspect` and checked like a container's labels. Everybody is
 * checked, owners and admins included (see `strict` above), and a service that
 * cannot be resolved drops its rows.
 */
export const filterReadableTasks = async <T>(
	ctx: PermissionCtx,
	rows: T[],
	serviceNameOf: (row: T) => string,
	serverId?: string,
): Promise<T[]> => {
	if (rows.length === 0) return rows;
	const admin = await isOwnerOrAdmin(ctx);

	const visible = new Map<string, Promise<boolean>>();
	const kept: T[] = [];
	for (const row of rows) {
		const serviceName = serviceNameOf(row);
		if (!serviceName) continue;
		let allowed = visible.get(serviceName);
		if (!allowed) {
			allowed = (async () => {
				const service = await readDockerObject(
					serviceName,
					serverId,
					"service",
				);
				if (!service) return false;
				return rowVisible(
					await checkDockerObjectServices(ctx, service, serverId),
					admin,
				);
			})();
			visible.set(serviceName, allowed);
		}
		if (await allowed) kept.push(row);
	}
	return kept;
};

/**
 * Whether the caller may see the environment variables of a container. The
 * inspect output (`Config.Env`) and `/proc/<pid>/environ` carry them, so a
 * member whose role lacks `envVars:read` (a custom role can drop it) gets them
 * blanked or refused. Owners and admins always hold it.
 */
export const canReadContainerEnv = (ctx: PermissionCtx) =>
	hasPermission(ctx, { envVars: ["read"] });

/** `KEY=value` entries of `Config.Env` keep their names and lose their values. */
export const redactContainerEnv = <T>(config: T): T => {
	if (!config || typeof config !== "object") return config;
	const inner = (config as { Config?: { Env?: unknown } }).Config;
	if (!inner || !Array.isArray(inner.Env)) return config;
	return {
		...config,
		Config: {
			...inner,
			Env: inner.Env.map((entry) =>
				typeof entry === "string" ? `${entry.split("=")[0]}=` : entry,
			),
		},
	};
};
