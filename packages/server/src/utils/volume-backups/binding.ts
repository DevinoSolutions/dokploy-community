import type { ServiceType } from "@dokploy/server/db/schema";
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

export type VolumeBindingFacts = {
	volumeName: string;
	serviceType: ServiceType;
	serviceId: string;
	appName: string;
	// The volume is recorded as a named mount of this very service.
	recordedOnOwnMount: boolean;
	// The volume is recorded as a named mount of another service of the same
	// organization.
	recordedOnOtherSameOrgMount: boolean;
	// The service is a compose whose own file declares this volume (an
	// `external: true` volume or one with an explicit `name:`).
	declaredByComposeFile: boolean;
	// Another organization's service claims the name: it sits in that service's
	// `appName` namespace or is recorded on its mounts or volume backups.
	claimedByOtherOrganization: boolean;
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
export const evaluateVolumeBinding = (
	facts: VolumeBindingFacts,
	{ privileged }: { privileged: boolean },
): VolumeBindingVerdict => {
	const { volumeName, appName } = facts;
	if (isInServiceVolumeNamespace(volumeName, appName)) {
		return { ok: true };
	}
	if (
		isDokployReservedVolumeName(volumeName) ||
		facts.claimedByOtherOrganization
	) {
		return {
			ok: false,
			message: `Volume "${volumeName}" belongs to another service, another organization or Dokploy itself and cannot be used here.`,
		};
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
	return {
		ok: false,
		message: privileged
			? `Volume "${volumeName}" is not one of this service's volumes. An outside volume is only accepted when another service of this organization already mounts it or the service's compose file declares it. Otherwise name it "${appName}-<name>" or "${appName}_<name>".`
			: `Volume "${volumeName}" is not one of this service's volumes. Name it "${appName}-<name>" or "${appName}_<name>"; using a volume outside that name needs an organization owner or admin.`,
	};
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
