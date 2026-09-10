import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { BuildPolicyUnitType } from "./policy";

/**
 * The build-policy router takes `applicationId` / `composeId` straight from
 * input, so every mutation that FK-links a row to a unit has to prove first
 * that the unit belongs to the caller's active organization. Without this an
 * admin of organization A can create exclusions and break-glass grants against
 * organization B's units.
 */
export interface AssertUnitInOrganizationInput {
	organizationId: string;
	applicationId?: string | null;
	composeId?: string | null;
}

export interface BuildPolicyOwnedUnit {
	unitType: BuildPolicyUnitType;
	unitId: string;
	unitName: string;
}

export const assertUnitInOrganization = async ({
	organizationId,
	applicationId,
	composeId,
}: AssertUnitInOrganizationInput): Promise<BuildPolicyOwnedUnit> => {
	if (applicationId) {
		const application = await db.query.applications.findFirst({
			where: eq(applications.applicationId, applicationId),
			with: { environment: { with: { project: true } } },
		});
		if (!application) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Application not found",
			});
		}
		if (application.environment.project.organizationId !== organizationId) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "You are not authorized to access this application",
			});
		}
		return {
			unitType: "application",
			unitId: application.applicationId,
			unitName: application.name,
		};
	}

	if (composeId) {
		const composeUnit = await db.query.compose.findFirst({
			where: eq(compose.composeId, composeId),
			with: { environment: { with: { project: true } } },
		});
		if (!composeUnit) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Compose not found" });
		}
		if (composeUnit.environment.project.organizationId !== organizationId) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "You are not authorized to access this compose",
			});
		}
		return {
			unitType: "compose",
			unitId: composeUnit.composeId,
			unitName: composeUnit.name,
		};
	}

	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "Provide exactly one of applicationId or composeId",
	});
};
