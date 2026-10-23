import type { ServiceType } from "@dokploy/server/db/schema";
import { VOLUME_NAME_REGEX } from "@dokploy/server/db/schema/utils";
import { TRPCError } from "@trpc/server";

// A Docker volume name is global to the host. Volume backups, restores and
// named mounts all hand the user's name straight to `docker run -v` or to the
// swarm service, so a name that is not tied to the service lets a member read
// (back up), overwrite (restore) or mount another tenant's volume.
//
// What each kind of service really owns, from the code:
// - databases: `<appName>-data`, created with the service (routers/postgres.ts
//   and the other database routers);
// - compose: `<appName>_<volume>` (the compose project prefix), with a
//   `-<suffix>` on the key for isolated deployments;
// - applications: nothing is created for them. A named mount is whatever its
//   author typed, so it only belongs to the service by its `appName` prefix.
// `appName` is unique on the host, random-suffixed and immutable, so it is the
// one name a service can claim without touching anyone else's.
const NAMESPACE_SEPARATORS = ["-", "_"] as const;

export const isInServiceVolumeNamespace = (
	volumeName: string,
	appName: string,
) =>
	!!appName &&
	(volumeName === appName ||
		NAMESPACE_SEPARATORS.some((separator) =>
			volumeName.startsWith(`${appName}${separator}`),
		));

// Dokploy's own volumes (`dokploy-postgres`, `dokploy-redis`, ...). They hold
// every organization's configuration and secrets.
export const isDokployReservedVolumeName = (volumeName: string) =>
	volumeName === "dokploy" ||
	volumeName.startsWith("dokploy-") ||
	volumeName.startsWith("dokploy_");

type ServiceHost = { serverId?: string | null } | null | undefined;

// The server a volume backup (and a restore into its service) really runs on:
// the one the owning service is deployed to, null for the local Dokploy host.
// Backup, restore and the binding check all use this single answer, so the
// claims are always evaluated for the host that runs `docker run -v`.
export const resolveVolumeBackupHost = (row: {
	application?: ServiceHost;
	compose?: ServiceHost;
	postgres?: ServiceHost;
	mysql?: ServiceHost;
	mariadb?: ServiceHost;
	mongo?: ServiceHost;
	redis?: ServiceHost;
	libsql?: ServiceHost;
}): string | null =>
	(
		row.application ??
		row.compose ??
		row.postgres ??
		row.mysql ??
		row.mariadb ??
		row.mongo ??
		row.redis ??
		row.libsql
	)?.serverId || null;

export type VolumeBindingFacts = {
	volumeName: string;
	serviceType: ServiceType;
	serviceId: string;
	appName: string;
	// Docker volume names are per host. Only claims of services on this same
	// server count (null is the local Dokploy host); the loader already
	// filtered the claim flags below by it.
	serverId: string | null;
	// The volume is recorded as a named mount of this very service.
	recordedOnOwnMount: boolean;
	// The volume is recorded as a named mount of another service of the same
	// organization.
	recordedOnOtherSameOrgMount: boolean;
	// The volume is recorded on a volume backup of this very service.
	recordedOnOwnVolumeBackup?: boolean;
	// Another service of the same organization on the same server claims the
	// name: a mount, a volume backup or its `appName` namespace. Only compose
	// files are checked against it (see services/volume-binding.ts).
	claimedByOtherSameOrgService?: boolean;
	// The service is a compose whose own file declares this volume (an
	// `external: true` volume or one with an explicit `name:`).
	declaredByComposeFile: boolean;
	// Another organization's service on the same server claims the name: it sits
	// in that service's `appName` namespace or is recorded on its mounts or
	// volume backups.
	claimedByOtherOrganization: boolean;
	// What makes claimedByOtherOrganization true, for the server log only
	// (never for the user-facing refusal).
	otherOrganizationClaims?: Array<{
		source: "namespace" | "mount" | "volumeBackup" | "composeFile";
		id: string;
	}>;
};

export type VolumeBindingVerdict =
	| { ok: true }
	| { ok: false; message: string };

export const isPrivilegedVolumeRole = (role: string | null | undefined) =>
	role === "owner" || role === "admin";

// `privileged` is an organization owner/admin, or an existing row that is being
// checked again (the creator's role is not stored, so the run-time and restore
// checks give the row the owner/admin reach and rely on the claim checks).
//
// An outside volume (not in the service's namespace) is only accepted for
// privileged callers, and only when it is already known to the organization:
// mounted by one of its services, or declared by the service's own compose
// file. A brand-new outside name is rejected for everybody, because nothing on
// the host tells which organization an unrecorded volume belongs to.
// One message for every refusal, so that the text cannot be used to tell
// another organization's volume from a name nobody uses.
const refusal = (
	volumeName: string,
	appName: string,
): VolumeBindingVerdict => ({
	ok: false,
	message: `Volume "${volumeName}" is not one of this service's volumes. Name it "${appName}-<name>" or "${appName}_<name>". Using a volume outside that name needs an organization owner or admin, and only works for a volume another service of the organization already mounts or the service's compose file declares.`,
});

export const evaluateVolumeBinding = (
	facts: VolumeBindingFacts,
	{ privileged }: { privileged: boolean },
): VolumeBindingVerdict => {
	const { volumeName, appName } = facts;
	// Rows written before the name was validated can hold a path such as
	// `/etc`, which `docker run -v` turns into a host bind mount.
	if (!VOLUME_NAME_REGEX.test(volumeName)) {
		return refusal(volumeName, appName);
	}
	// Claims come first: a short legacy appName (`app`) would otherwise own
	// another organization's `app-xxxx-data` by prefix.
	if (
		isDokployReservedVolumeName(volumeName) ||
		facts.claimedByOtherOrganization
	) {
		return refusal(volumeName, appName);
	}
	if (isInServiceVolumeNamespace(volumeName, appName)) {
		return { ok: true };
	}
	if (facts.recordedOnOwnMount) {
		return { ok: true };
	}
	if (
		privileged &&
		(facts.recordedOnOtherSameOrgMount || facts.declaredByComposeFile)
	) {
		return { ok: true };
	}
	return refusal(volumeName, appName);
};

export const assertVolumeBindingAllowed = (
	facts: VolumeBindingFacts,
	options: { privileged: boolean },
) => {
	const verdict = evaluateVolumeBinding(facts, options);
	if (!verdict.ok) {
		throw new TRPCError({ code: "BAD_REQUEST", message: verdict.message });
	}
};
