import {
	findMemberByUserId,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import {
	checkDockerObjectServices,
	type DockerObjectKind,
	readDockerObject,
} from "@/server/api/utils/container-service-access";

type WssUser = { id: string } | null | undefined;
type WssSession = { activeOrganizationId?: string | null } | null | undefined;

// What a docker WebSocket (terminal, logs, attach) may run against.
//
// The client sends a name or an id prefix, and docker resolves a name before a
// prefix, so a compose user could name a container like the prefix of another
// one. The string is therefore resolved once, to the full id of ONE object,
// together with its labels; the caller runs `exec`, `logs` and `attach` on that
// id and never on the string it was sent.
//
// The labels name the Dokploy service the object belongs to:
// - A service page sends its serviceId; the object must belong to that service
//   (a preview deployment counts as its parent).
// - Every service the labels name must be on `serverId` and readable by the
//   caller, so another organization's container is refused for every role.
// - An object that backs no service (Dokploy itself, Traefik, its database, an
//   unlabelled container) is the host's own. Only an owner or admin may open
//   those, the same people who get the host terminal; a member holding
//   docker:read does not.
//
// Every refusal is the same `null`, so the answer says nothing about which
// containers exist.
export const resolveDockerTarget = async ({
	user,
	session,
	reference,
	serverId,
	serviceId,
	kind = "container",
}: {
	user: WssUser;
	session: WssSession;
	reference: string;
	serverId?: string | null;
	serviceId?: string | null;
	kind?: DockerObjectKind;
}): Promise<string | null> => {
	if (!user || !session?.activeOrganizationId) return null;
	const ctx: PermissionCtx = {
		user: { id: user.id },
		session: { activeOrganizationId: session.activeOrganizationId },
	};
	const server = serverId || undefined;

	try {
		const object = await readDockerObject(reference, server, kind);
		if (!object) return null;

		const check = await checkDockerObjectServices(ctx, object, server);
		if (check.outcome === "refused") return null;
		if (check.outcome === "readable") {
			if (serviceId && !check.serviceIds.includes(serviceId)) return null;
			return object.id;
		}

		if (serviceId) return null;
		const member = await findMemberByUserId(
			user.id,
			session.activeOrganizationId,
		);
		return member.role === "owner" || member.role === "admin"
			? object.id
			: null;
	} catch {
		return null;
	}
};
