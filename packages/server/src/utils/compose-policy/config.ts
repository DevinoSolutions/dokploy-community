import { z } from "zod";

/**
 * Settings of the "restricted compose" audit (T-7455). Deliberately pure (no
 * db, no node APIs): the db schema imports it for the exclusion type, and so
 * can the UI.
 *
 * The audit is read-only: when it is on for an organization, every compose
 * deploy of that organization evaluates its compose and records what a sandbox
 * WOULD refuse. It never blocks, fails or changes a deploy. Enforcement is a
 * separate, later switch (a second column next to `restrictedComposeAudit`).
 */

/** The fixed rule ids a finding can carry. The log and the table hold only these. */
export const COMPOSE_POLICY_RULES = [
	"host-privilege",
	"namespace-join",
	"docker-socket-bind",
	"system-path-bind",
	"foreign-host-bind",
	"external-volume",
	"foreign-volume-name",
	"build-context-outside",
	"build-context-docker-storage",
	"custom-command",
	"unparseable-compose",
	"compose-too-large",
] as const;

export type ComposePolicyRuleId = (typeof COMPOSE_POLICY_RULES)[number];

/**
 * A compose file (or override file) above this many bytes is not parsed: it is
 * one `compose-too-large` finding. Bounds the CPU the audit can take.
 */
export const COMPOSE_POLICY_MAX_BYTES = 512 * 1024;

/** Findings older than this are deleted when a newer batch is recorded. */
export const COMPOSE_POLICY_RETENTION_DAYS = 90;

/** `serviceName` of a finding that belongs to the whole compose, not one service. */
export const COMPOSE_LEVEL_SERVICE = "<compose>";

/** What a detail shows in place of anything that is not a fixed, known value. */
export const REDACTED = "<redacted>";

/** A compose the audit skips. */
export const composePolicyExclusionSchema = z.object({
	id: z.string().min(1),
	reason: z.string().max(300).optional(),
});

export type ComposePolicyExclusion = z.infer<
	typeof composePolicyExclusionSchema
>;

// Only the id decides whether a compose is excluded: a reason that is too long
// (a direct SQL edit) must not cost the compose its exclusion.
const storedExclusionSchema = z.object({
	id: z.string().min(1),
	reason: z.unknown().optional(),
});

/** Each entry on its own: one bad element is dropped, the valid ones are kept. */
export const parseComposePolicyExclusions = (
	value: unknown,
): ComposePolicyExclusion[] => {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ComposePolicyExclusion[] => {
		const parsed = storedExclusionSchema.safeParse(item);
		if (!parsed.success) return [];
		const { id, reason } = parsed.data;
		return [
			typeof reason === "string" && reason.length > 0
				? { id, reason: reason.slice(0, 300) }
				: { id },
		];
	});
};

export const isComposePolicyExcluded = (
	exclusions: readonly ComposePolicyExclusion[],
	composeId: string,
): boolean => exclusions.some((entry) => entry.id === composeId);

export interface ComposePolicySettings {
	/** `restrictedComposeAudit`: record what a sandbox would refuse. Off by default. */
	auditEnabled: boolean;
	exclusions: ComposePolicyExclusion[];
}

type StoredOrganization = {
	restrictedComposeAudit?: boolean | null;
	restrictedComposeAuditExclusions?: unknown;
} | null;

/** The effective settings from the stored organization row. */
export const resolveComposePolicySettings = (
	row: StoredOrganization | undefined,
): ComposePolicySettings => ({
	auditEnabled: row?.restrictedComposeAudit === true,
	exclusions: parseComposePolicyExclusions(
		row?.restrictedComposeAuditExclusions,
	),
});

/** What `composePolicy.updateSettings` accepts. */
export const apiUpdateComposePolicySettings = z.object({
	auditEnabled: z.boolean(),
});

/** What `composePolicy.findings` accepts. */
export const apiListComposePolicyFindings = z.object({
	composeId: z.string().min(1).optional(),
	since: z.coerce.date().optional(),
	limit: z.number().int().min(1).max(500).default(200),
});
