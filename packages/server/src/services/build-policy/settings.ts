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

/**
 * "Does any organization enforce remote builds?"
 *
 * The enqueue gate runs on every webhook delivery and every deploy hook, and it
 * only has an `environmentId` — resolving that to an organization is itself a
 * query. So the gate asks this first, and on an instance where nobody has
 * turned the policy on (every instance, the moment this merges) it does one
 * cheap indexed read and then nothing at all until the cache expires.
 *
 * The cache is process-local and short. Turning the policy on through the
 * settings router clears it, so the only staleness window is another process's
 * write, bounded by the TTL below.
 */
const ENFORCEMENT_CACHE_TTL_MS = 5_000;

let enforcementCache: { value: boolean; readAt: number } | null = null;

export const clearBuildPolicyEnforcementCache = () => {
	enforcementCache = null;
};

export const isBuildPolicyEnforcedAnywhere = async (
	now: () => number = Date.now,
): Promise<boolean> => {
	const cached = enforcementCache;
	if (cached && now() - cached.readAt < ENFORCEMENT_CACHE_TTL_MS) {
		return cached.value;
	}
	const row = await db.query.buildPolicySettings.findFirst({
		where: eq(buildPolicySettings.enforceRemoteBuilds, true),
		columns: { buildPolicySettingsId: true },
	});
	const value = !!row;
	enforcementCache = { value, readAt: now() };
	return value;
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
	// A write can flip enforcement on or off; drop the cached global answer.
	clearBuildPolicyEnforcementCache();

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
