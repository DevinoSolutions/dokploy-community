import { db } from "@dokploy/server/db";
import {
	type BuildPolicySettings,
	buildPolicySettings,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * Organization build-policy settings.
 *
 * A missing row means "policy off", which is the default for every
 * organization and keeps an unconfigured instance on stock upstream behaviour.
 * Reads therefore never create a row; only an explicit update does.
 */
export const findBuildPolicySettings = async (
	organizationId: string,
): Promise<BuildPolicySettings | null> => {
	const row = await db.query.buildPolicySettings.findFirst({
		where: eq(buildPolicySettings.organizationId, organizationId),
	});
	return row ?? null;
};

export interface BuildPolicySettingsUpdate {
	enforceRemoteBuilds?: boolean;
	defaultBuildServerId?: string | null;
	defaultRegistryId?: string | null;
	requiredChecksTimeoutMinutes?: number;
}

export const upsertBuildPolicySettings = async (
	organizationId: string,
	updates: BuildPolicySettingsUpdate,
): Promise<BuildPolicySettings> => {
	const existing = await findBuildPolicySettings(organizationId);
	const now = new Date().toISOString();

	if (!existing) {
		const [created] = await db
			.insert(buildPolicySettings)
			.values({ organizationId, ...updates, createdAt: now, updatedAt: now })
			.returning();
		if (!created) {
			throw new Error("Failed to create build policy settings");
		}
		return created;
	}

	const [updated] = await db
		.update(buildPolicySettings)
		.set({ ...updates, updatedAt: now })
		.where(eq(buildPolicySettings.organizationId, organizationId))
		.returning();
	if (!updated) {
		throw new Error("Failed to update build policy settings");
	}
	return updated;
};

/** Timeout, in milliseconds, a deploy waits for a unit's required checks. */
export const requiredChecksTimeoutMs = (
	settings: BuildPolicySettings | null,
): number => (settings?.requiredChecksTimeoutMinutes ?? 30) * 60_000;
