import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	previewDeployments,
} from "@dokploy/server/db/schema";
import {
	checkServicePermissionAndAccess,
	findMemberByUserId,
	findServiceOrganizations,
	hasPermission,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import { getAccessibleServerIds } from "@dokploy/server/services/server";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { inArray } from "drizzle-orm";
import { quote } from "shell-quote";
import { canAccessLocalHost } from "@/server/api/utils/local-host-access";
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
): Promise<(DockerObject & { name: string }) | null> => {
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
	const name = rest.slice(nameAt + 1);
	return {
		id,
		name,
		appNames: ownershipNames([name, ...labelValues(labels)]),
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
	object: Pick<DockerObject, "appNames">,
	serverId?: string,
): Promise<ContainerServiceCheck> => {
	// one rule for one object and for a list: the batched check decides both
	const [check] = await checkDockerObjectsServices(ctx, [object], serverId);
	return check ?? { outcome: "refused" };
};

type ServiceRef = { serviceId: string; serverId: string | null };

// `findServicesByAppName` for every appName of a list at once: one query per
// service table, one for the previews and one per parent table, keyed by the
// appName that found the service.
const findServicesByAppNames = async (appNames: string[]) => {
	const found = new Map<string, ServiceRef[]>();
	if (appNames.length === 0) return found;
	const add = (appName: string, service: ServiceRef) =>
		found.set(appName, [...(found.get(appName) ?? []), service]);

	const tables = await Promise.all(
		SERVICE_TABLES.map(({ table, id }) =>
			db
				.select({
					serviceId: id,
					serverId: table.serverId,
					appName: table.appName,
				})
				.from(table)
				.where(inArray(table.appName, appNames)),
		),
	);
	for (const rows of tables) {
		for (const { appName, serviceId, serverId } of rows)
			add(appName, { serviceId, serverId });
	}

	const previews = await db
		.select({
			appName: previewDeployments.appName,
			applicationId: previewDeployments.applicationId,
			composeId: previewDeployments.composeId,
		})
		.from(previewDeployments)
		.where(inArray(previewDeployments.appName, appNames));
	const applicationIds = [
		...new Set(previews.flatMap((row) => row.applicationId ?? [])),
	];
	const composeIds = [
		...new Set(previews.flatMap((row) => row.composeId ?? [])),
	];
	const [applicationParents, composeParents] = await Promise.all([
		applicationIds.length > 0
			? db
					.select({
						parentId: applications.applicationId,
						serverId: applications.serverId,
					})
					.from(applications)
					.where(inArray(applications.applicationId, applicationIds))
			: [],
		composeIds.length > 0
			? db
					.select({ parentId: compose.composeId, serverId: compose.serverId })
					.from(compose)
					.where(inArray(compose.composeId, composeIds))
			: [],
	]);
	const parentServer = new Map<string, string | null>();
	for (const { parentId, serverId } of [
		...applicationParents,
		...composeParents,
	])
		parentServer.set(parentId, serverId);
	for (const { appName, applicationId, composeId } of previews) {
		for (const parentId of [applicationId, composeId]) {
			if (parentId && parentServer.has(parentId))
				add(appName, {
					serviceId: parentId,
					serverId: parentServer.get(parentId) ?? null,
				});
		}
	}
	return found;
};

/**
 * `checkDockerObjectServices` for a whole list, with the same answer for each
 * object, at a cost that does not grow with the list: the services behind
 * every appName are looked up together, the member and the `service.read`
 * permission once, and the organizations of all the services in one query.
 * The rest of the decision (`checkServiceAccess`: the role's `service.read`,
 * the member allow-list, the organization scope) is made in memory.
 */
export const checkDockerObjectsServices = async (
	ctx: PermissionCtx,
	objects: Pick<DockerObject, "appNames">[],
	serverId?: string,
): Promise<ContainerServiceCheck[]> => {
	const appNames = [...new Set(objects.flatMap((object) => object.appNames))];
	const servicesByName = await findServicesByAppNames(appNames);
	const servicesOf = (object: Pick<DockerObject, "appNames">) =>
		object.appNames.flatMap((appName) => servicesByName.get(appName) ?? []);

	const serviceIds = [
		...new Set(
			objects.flatMap((object) =>
				servicesOf(object).map((service) => service.serviceId),
			),
		),
	];
	let readable: (serviceId: string) => boolean = () => false;
	if (serviceIds.length > 0) {
		try {
			const organizationId = ctx.session.activeOrganizationId;
			const member = await findMemberByUserId(ctx.user.id, organizationId);
			const admin = member.role === "owner" || member.role === "admin";
			const [canRead, organizations] = await Promise.all([
				hasPermission(ctx, { service: ["read"] }),
				findServiceOrganizations(serviceIds),
			]);
			readable = (serviceId) =>
				canRead &&
				(admin || member.accessedServices.includes(serviceId)) &&
				organizations.get(serviceId) === organizationId;
		} catch {
			// no member: every service is refused
		}
	}

	return objects.map((object): ContainerServiceCheck => {
		const services = servicesOf(object);
		if (services.length === 0) return { outcome: "unowned" };
		for (const service of services) {
			if ((service.serverId ?? undefined) !== serverId)
				return { outcome: "refused" };
			if (!readable(service.serviceId)) return { outcome: "refused" };
		}
		return {
			outcome: "readable",
			serviceIds: [...new Set(services.map((service) => service.serviceId))],
		};
	});
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

export const isOwnerOrAdmin = async (ctx: PermissionCtx) => {
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	return member.role === "owner" || member.role === "admin";
};

/**
 * Who may use a container that backs no service (Dokploy itself, Traefik, its
 * database): an owner or admin, and on the local host only those of the
 * organization that owns the instance, since the host serves every
 * organization. A remote server's own containers stay with its organization.
 */
export const canUseHostOwnContainers = async (
	ctx: PermissionCtx,
	serverId?: string,
) =>
	(await isOwnerOrAdmin(ctx)) &&
	(await canAccessLocalHost(serverId, ctx.session.activeOrganizationId));

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
 *   an unlabelled one) is the host's own: owners and admins only, and on the
 *   local host only those of the organization that owns the instance.
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
			if (!(await canUseHostOwnContainers(ctx, serverId)))
				throw containerNotFound();
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
			{ appNames: [appName] },
			serverId,
		);
		if (check.outcome === "readable") return;
		if (
			check.outcome === "unowned" &&
			(await canUseHostOwnContainers(ctx, serverId))
		)
			return;
		throw containerNotFound();
	} catch {
		throw containerNotFound();
	}
};

// A swarm task's container is named "<service>.<slot>.<task id>" (a global
// service has the node id in place of the slot), and a swarm service name has
// no dot.
const isTaskOf = (service: string) => (containerName: string) => {
	if (containerName === service) return true;
	if (!containerName.startsWith(`${service}.`)) return false;
	const rest = containerName.slice(service.length + 1).split(".");
	return rest.length === 2 && rest.every(Boolean);
};

const isNamed = (name: string) => (containerName: string) =>
	containerName === name;

// Whether a failed docker command said the object is not there: "No such
// container: x" (or "No such object"), "no such service: x", and on a host
// that is no swarm manager "This node is not a swarm manager", which has no
// services. Anything else (the daemon or the SSH connection is down, a
// timeout) says nothing about the host, and the caller refuses.
const saysAbsent = (error: unknown, pattern: RegExp) => {
	const { message, stderr } = (error ?? {}) as {
		message?: unknown;
		stderr?: unknown;
	};
	return [message, stderr].some(
		(text) => typeof text === "string" && pattern.test(text),
	);
};

const NO_SUCH_CONTAINER = /no such (container|object)/i;
const NO_SUCH_SERVICE = /no such service|not a swarm manager/i;

// The container named exactly `name`, or null when docker says there is none:
// docker also resolves an id prefix, which is not what the metrics agent
// matches on. Any other failure throws.
const readContainerByName = async (
	name: string,
	serverId?: string,
): Promise<DockerObject | null> => {
	let stdout: string;
	try {
		({ stdout } = await runOn(
			quote([
				"docker",
				"inspect",
				"--type",
				"container",
				"--format",
				"{{.Name}} {{.Id}} {{json .Config.Labels}}",
				name,
			]),
			serverId,
		));
	} catch (error) {
		if (saysAbsent(error, NO_SUCH_CONTAINER)) return null;
		throw error;
	}
	const [containerName, id, ...labels] = stdout.trim().split(" ");
	if (!id || !FULL_ID.container.test(id))
		throw new Error("Unreadable docker inspect output");
	// an id prefix resolved to another container: none carries the name
	if (containerName !== `/${name}`) return null;
	const parsed = (JSON.parse(labels.join(" ")) ?? {}) as Record<
		string,
		unknown
	>;
	return { id, appNames: ownershipNames(labelValues(parsed)) };
};

// The swarm service named exactly `name`, or null when docker says there is
// none. Any other failure throws.
const readServiceByName = async (name: string, serverId?: string) => {
	let service: Awaited<ReturnType<typeof readService>>;
	try {
		service = await readService(name, serverId);
	} catch (error) {
		if (saysAbsent(error, NO_SUCH_SERVICE)) return null;
		throw error;
	}
	if (!service) throw new Error("Unreadable docker service inspect output");
	// an id prefix resolved to another service: none carries the name
	return service.name === name ? service : null;
};

// The leading parts of a container name, cut where a compose ("-"), stack
// ("_") or swarm task (".") name continues an appName: "cmp-x-web-1" gives
// "cmp", "cmp-x" and "cmp-x-web".
const appNamePrefixes = (name: string) =>
	[...name.matchAll(/[-_.]/g)].map((match) => name.slice(0, match.index));

/**
 * `user.getContainerMetrics` sends the monitoring agent a name the client
 * picked, and the agent answers every container named that name or starting
 * with it and a dot (an SQL LIKE, in which "_" matches any character). The UI
 * sends the appName of an application or a database (whose swarm tasks are
 * "<appName>.<slot>.<task id>") or, on the compose page, the name of one
 * container of the compose.
 *
 * The name must be, in this order:
 * - the appName of a service the caller can read on `serverId` (another
 *   organization's appName, or one on another server, is refused outright);
 * - a swarm service on that server, checked by its labels like the docker
 *   routes (Dokploy itself and other host services: owners and admins only);
 * - a container of exactly that name on that server, checked by its labels;
 * - for an owner or admin only, a name nothing on the host carries any more.
 *
 * Where nothing names a service (the host's own containers, a name nothing
 * carries any more), the name must not extend the appName of a service the
 * caller cannot read either: a compose that was taken down leaves its rows
 * behind under "<appName>-<service>-<n>". A docker failure that does not say
 * the object is absent refuses, so an unreachable daemon is never read as
 * "nothing on the host".
 *
 * Returns which of the agent's rows belong to what was checked: the swarm
 * tasks of the service, or the container of that exact name. The caller drops
 * the rest, so a wildcard in the agent's match cannot widen the answer.
 *
 * Every refusal is the same NOT_FOUND.
 */
export const resolveMetricsTarget = async (
	ctx: PermissionCtx,
	name: string,
	serverId?: string,
): Promise<(containerName: string) => boolean> => {
	try {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw containerNotFound();
		if (!(await canReachServer(ctx, serverId))) throw containerNotFound();
		// the host's own: owners and admins, and no other service's name in it
		const hostOwn = async () =>
			(await isOwnerOrAdmin(ctx)) &&
			(
				await checkDockerObjectServices(
					ctx,
					{ appNames: appNamePrefixes(name) },
					serverId,
				)
			).outcome !== "refused";
		const allowed = async (check: ContainerServiceCheck) =>
			check.outcome === "readable" ||
			(check.outcome === "unowned" && (await hostOwn()));

		const byAppName = await checkDockerObjectServices(
			ctx,
			{ appNames: [name] },
			serverId,
		);
		if (byAppName.outcome === "readable") return isTaskOf(name);
		if (byAppName.outcome === "refused") throw containerNotFound();

		const service = await readServiceByName(name, serverId);
		if (service) {
			if (
				!(await allowed(
					await checkDockerObjectServices(ctx, service, serverId),
				))
			)
				throw containerNotFound();
			return isTaskOf(name);
		}

		const container = await readContainerByName(name, serverId);
		if (container) {
			if (
				!(await allowed(
					await checkDockerObjectServices(ctx, container, serverId),
				))
			)
				throw containerNotFound();
			return isNamed(name);
		}

		if (!(await hostOwn())) throw containerNotFound();
		return isNamed(name);
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

	const rows = listed.flatMap((container) => {
		const object = labelled.find((entry) =>
			entry.id.startsWith(container.containerId),
		);
		return object ? [{ container, object }] : [];
	});
	const outcomes = await checkDockerObjectsServices(
		ctx,
		rows.map((row) => row.object),
		serverId,
	);
	return rows.flatMap(({ container }, index) => {
		const outcome = outcomes[index];
		return outcome && rowVisible(outcome, admin) ? [container] : [];
	});
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
 * Narrows rows that name a swarm service (`docker service ls`, `docker service
 * ps`) the way the container lists are narrowed: a member gets only the rows of
 * services they can read on this server. Owners and admins see the host's list
 * as it is (the Docker page lists everything on the host), without one
 * `docker service inspect` per row.
 */
export const filterReadableServiceRows = async <T>(
	ctx: PermissionCtx,
	rows: T[],
	serviceNameOf: (row: T) => string,
	serverId?: string,
): Promise<T[]> => {
	if (await isOwnerOrAdmin(ctx)) return rows;
	return await filterReadableTasks(ctx, rows, serviceNameOf, serverId);
};

/**
 * The same for `docker stats` rows, which carry the container id as `ID`.
 * `strict` checks owners and admins too (see `filterReadableContainers`).
 */
export const filterReadableStats = async <T extends { ID: string }>(
	ctx: PermissionCtx,
	rows: T[],
	serverId?: string,
	options: { strict?: boolean } = {},
): Promise<T[]> => {
	if (!options.strict && (await isOwnerOrAdmin(ctx))) return rows;
	const readable = new Set(
		(
			await filterReadableContainers(
				ctx,
				rows.map((row) => ({ containerId: row.ID })),
				serverId,
				options,
			)
		).map((row) => row.containerId),
	);
	return rows.filter((row) => readable.has(row.ID));
};

type DockerEventLike = {
	Type?: string;
	Actor?: { Attributes?: Record<string, string> };
};

/**
 * Narrows `docker events` to the events of containers and swarm services the
 * caller can read. The event carries the container's labels (or the service
 * name) in `Actor.Attributes`, which are mapped to Dokploy services like any
 * other container's. Events that belong to no service (images, networks,
 * volumes, nodes, the daemon, a container nobody labelled) are the host's own
 * and only an owner or admin sees them, so everything else is dropped for a
 * member.
 */
export const filterReadableEvents = async <T extends DockerEventLike>(
	ctx: PermissionCtx,
	events: T[],
	serverId?: string,
): Promise<T[]> => {
	if (events.length === 0 || (await isOwnerOrAdmin(ctx))) return events;

	const rows = events.flatMap((event) => {
		const attributes = event.Actor?.Attributes ?? {};
		let appNames: string[];
		if (event.Type === "container") {
			appNames = ownershipNames(labelValues(attributes));
		} else if (event.Type === "service") {
			appNames = ownershipNames([attributes.name, ...labelValues(attributes)]);
		} else {
			return [];
		}
		return appNames.length > 0 ? [{ event, appNames }] : [];
	});
	const outcomes = await checkDockerObjectsServices(ctx, rows, serverId);
	return rows.flatMap(({ event }, index) => {
		const outcome = outcomes[index];
		return outcome && rowVisible(outcome, false) ? [event] : [];
	});
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
