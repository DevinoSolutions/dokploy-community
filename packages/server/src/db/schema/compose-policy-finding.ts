import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import type { ComposePolicyRuleId } from "../../utils/compose-policy/config";
import { organization } from "./account";

/**
 * Fork module: what the "restricted compose" audit (T-7455) found. One row per
 * (deployment, service, rule): a sandbox WOULD have refused it. Written only
 * for organizations that turned the audit on; nothing reads it during a deploy.
 *
 * Never holds a secret: `detail` is a YAML key path, a literal system root, or
 * `<redacted>` (see utils/compose-policy/evaluate.ts). The compose and the
 * deployment are plain ids with no foreign keys on purpose: the trail has to
 * outlive the compose and its deployment history (clearing deployments).
 */
export const composePolicyFinding = pgTable(
	"compose_policy_finding",
	{
		composePolicyFindingId: text("composePolicyFindingId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		composeId: text("composeId").notNull(),
		deploymentId: text("deploymentId"),
		serviceName: text("serviceName").notNull(),
		ruleId: text("ruleId").$type<ComposePolicyRuleId>().notNull(),
		detail: text("detail").notNull(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
	},
	(t) => ({
		orgCreatedAtIdx: index(
			"composePolicyFinding_organizationId_createdAt_idx",
		).on(t.organizationId, t.createdAt),
		composeIdx: index("composePolicyFinding_composeId_idx").on(t.composeId),
	}),
);

export type ComposePolicyFindingRow = typeof composePolicyFinding.$inferSelect;
