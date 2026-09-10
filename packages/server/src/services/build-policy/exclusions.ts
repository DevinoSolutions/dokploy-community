import { db } from "@dokploy/server/db";
import {
	type BuildPolicyExclusion,
	buildPolicyExclusion,
} from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import type { BuildPolicyUnitType } from "./policy";

/** Units that keep a local build while enforcement is on (spec 5.2.2). */
const unitColumn = (unitType: BuildPolicyUnitType) =>
	unitType === "application"
		? buildPolicyExclusion.applicationId
		: buildPolicyExclusion.composeId;

export const listBuildPolicyExclusions = async (organizationId: string) =>
	db.query.buildPolicyExclusion.findMany({
		where: eq(buildPolicyExclusion.organizationId, organizationId),
		with: { application: true, compose: true },
	});

export const isUnitExcluded = async ({
	organizationId,
	unitType,
	unitId,
}: {
	organizationId: string;
	unitType: BuildPolicyUnitType;
	unitId: string;
}): Promise<boolean> => {
	const row = await db.query.buildPolicyExclusion.findFirst({
		where: and(
			eq(buildPolicyExclusion.organizationId, organizationId),
			eq(unitColumn(unitType), unitId),
		),
	});
	return !!row;
};

export const addBuildPolicyExclusion = async ({
	organizationId,
	applicationId,
	composeId,
	reason,
}: {
	organizationId: string;
	applicationId?: string | null;
	composeId?: string | null;
	reason?: string | null;
}): Promise<BuildPolicyExclusion> => {
	const [row] = await db
		.insert(buildPolicyExclusion)
		.values({
			organizationId,
			applicationId: applicationId ?? null,
			composeId: composeId ?? null,
			reason: reason ?? null,
		})
		.returning();
	if (!row) throw new Error("Failed to add build policy exclusion");
	return row;
};

export const removeBuildPolicyExclusion = async ({
	organizationId,
	buildPolicyExclusionId,
}: {
	organizationId: string;
	buildPolicyExclusionId: string;
}): Promise<BuildPolicyExclusion | null> => {
	const [row] = await db
		.delete(buildPolicyExclusion)
		.where(
			and(
				eq(buildPolicyExclusion.organizationId, organizationId),
				eq(buildPolicyExclusion.buildPolicyExclusionId, buildPolicyExclusionId),
			),
		)
		.returning();
	return row ?? null;
};
