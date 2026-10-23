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
// the caller can run its command on the container that was checked, not on
// whatever the string resolves to later.
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;

const readContainer = async (
	containerId: string,
	serverId?: string,
): Promise<{ id: string; appNames: string[] } | null> => {
	const command = quote([
		"docker",
		"inspect",
		"--type",
		"container",
		"--format",
		"{{.Id}} {{json .Config.Labels}}",
		containerId,
	]);
	try {
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		const output = stdout.trim();
		const split = output.indexOf(" ");
		const id = output.slice(0, split);
		if (split < 0 || !FULL_CONTAINER_ID.test(id)) return null;
		const labels = (JSON.parse(output.slice(split + 1)) ?? {}) as Record<
			string,
			unknown
		>;
		const names = OWNERSHIP_LABELS.map((label) => labels[label]).filter(
			(value): value is string => typeof value === "string" && value !== "",
		);
		return { id, appNames: [...new Set(names)] };
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

/**
 * Proves the caller may read the service a container belongs to, before
 * anything is run against the container (`docker top` prints the full argv of
 * its processes).
 *
 * The container's own ownership labels (swarm service name, compose project,
 * stack namespace) name the service; the client never says which one. The
 * container must belong to at least one service, every service it names must
 * run on the server the container is on, and the caller must hold
 * `service.read` on each of them. `checkServiceAccess` applies the member
 * allow-list and the organization scope, so an owner or admin of one
 * organization is refused a container of another, and a member only gets the
 * services they were granted.
 *
 * Owners and admins are not exempt from the "belongs to a service" rule: a
 * container that backs no service (Dokploy itself, Traefik, its database) is
 * refused for every role.
 *
 * Returns the full id of the container that was checked. Run the command on
 * that id and never on the string the client sent.
 */
export const assertContainerServiceReadable = async (
	ctx: PermissionCtx,
	containerId: string,
	serverId?: string,
): Promise<string> => {
	const container = await readContainer(containerId, serverId);
	if (!container || container.appNames.length === 0) throw containerNotFound();

	const services = await findServicesByAppName(container.appNames);
	if (services.length === 0) throw containerNotFound();

	for (const service of services) {
		if ((service.serverId ?? undefined) !== serverId) throw containerNotFound();
		try {
			await checkServiceAccess(ctx, service.serviceId, "read");
		} catch {
			throw containerNotFound();
		}
	}
	return container.id;
};
