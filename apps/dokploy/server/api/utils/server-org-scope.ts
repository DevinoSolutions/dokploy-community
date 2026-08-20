import { findServerById } from "@dokploy/server";
import { TRPCError } from "@trpc/server";

/**
 * Several routers take a caller-supplied `serverId` and then run docker / SSH
 * commands (or write files) against that server. `adminProcedure`,
 * `protectedProcedure` and `withPermission` only assert a role/permission
 * inside the caller's *active* organization, never that the target server
 * belongs to it, so without this check an owner/admin of one organization could
 * pass another organization's `serverId` and act on it.
 *
 * No-op when no `serverId` is supplied: those calls target the local Dokploy
 * host, which is already covered by the procedure's role gate.
 *
 * Must be called BEFORE any remote exec or database write, and outside any
 * try/catch that rewrites errors, so the UNAUTHORIZED code reaches the client.
 */
export const assertServerInOrganization = async (
	serverId: string | undefined,
	activeOrganizationId: string | null | undefined,
) => {
	if (!serverId) {
		return;
	}
	const targetServer = await findServerById(serverId);
	if (targetServer.organizationId !== activeOrganizationId) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
};
