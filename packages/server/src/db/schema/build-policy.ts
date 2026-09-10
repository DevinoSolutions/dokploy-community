import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { applications } from "./application";
import { compose } from "./compose";
import { registry } from "./registry";
import { server } from "./server";
import { user } from "./user";

/**
 * Fork module: build policy (enforced remote builds).
 *
 * Everything in this file is additive to upstream Dokploy. See
 * `packages/server/src/services/build-policy/README.md` for the hook points
 * this schema is read from.
 */

export const buildPolicyAuditAction = pgEnum("buildPolicyAuditAction", [
	"settings_updated",
	"exclusion_added",
	"exclusion_removed",
	"break_glass_granted",
	"break_glass_consumed",
	"remote_build_enforced",
	"build_server_missing",
	"deploy_coalesced",
	"deploy_skipped",
	"required_checks_failed",
	"required_checks_timeout",
	"deploy_by_digest",
]);

/**
 * One row per organization. Absent row == policy off, which is the default and
 * keeps every unmodified instance on the stock upstream behaviour.
 */
export const buildPolicySettings = pgTable("build_policy_settings", {
	buildPolicySettingsId: text("buildPolicySettingsId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	/** Master switch. When false the module is inert. */
	enforceRemoteBuilds: boolean("enforceRemoteBuilds").notNull().default(false),
	/** Build server every enforced unit is pinned to. */
	defaultBuildServerId: text("defaultBuildServerId").references(
		() => server.serverId,
		{ onDelete: "set null" },
	),
	/** Registry the built image is pushed to and pulled from by digest. */
	defaultRegistryId: text("defaultRegistryId").references(
		() => registry.registryId,
		{ onDelete: "set null" },
	),
	/** Minutes a deploy waits for a unit's `requiredChecks` before failing. */
	requiredChecksTimeoutMinutes: integer("requiredChecksTimeoutMinutes")
		.notNull()
		.default(30),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

/** Units that keep a local build while enforcement is on. */
export const buildPolicyExclusion = pgTable(
	"build_policy_exclusion",
	{
		buildPolicyExclusionId: text("buildPolicyExclusionId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{ onDelete: "cascade" },
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
		reason: text("reason"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(t) => ({
		orgIdx: index("buildPolicyExclusion_organizationId_idx").on(
			t.organizationId,
		),
		applicationIdx: index("buildPolicyExclusion_applicationId_idx").on(
			t.applicationId,
		),
		composeIdx: index("buildPolicyExclusion_composeId_idx").on(t.composeId),
	}),
);

/**
 * Append-only trail for every policy decision that a human needs to be able to
 * reconstruct. Break-glass grants live here too: a grant is a row with
 * `action = "break_glass_granted"` and `consumedAt IS NULL`; the next deploy of
 * that unit stamps `consumedAt` and writes a `break_glass_consumed` row.
 */
export const buildPolicyAudit = pgTable(
	"build_policy_audit",
	{
		buildPolicyAuditId: text("buildPolicyAuditId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		action: buildPolicyAuditAction("action").notNull(),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{ onDelete: "set null" },
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "set null",
		}),
		actorId: text("actorId").references(() => user.id, {
			onDelete: "set null",
		}),
		actorEmail: text("actorEmail"),
		reason: text("reason"),
		/** JSON.stringify'd, matching the convention in `audit_log.metadata`. */
		metadata: text("metadata"),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		consumedAt: timestamp("consumedAt"),
	},
	(t) => ({
		orgIdx: index("buildPolicyAudit_organizationId_idx").on(t.organizationId),
		applicationIdx: index("buildPolicyAudit_applicationId_idx").on(
			t.applicationId,
		),
		composeIdx: index("buildPolicyAudit_composeId_idx").on(t.composeId),
		createdAtIdx: index("buildPolicyAudit_createdAt_idx").on(t.createdAt),
	}),
);

export const buildPolicySettingsRelations = relations(
	buildPolicySettings,
	({ one }) => ({
		organization: one(organization, {
			fields: [buildPolicySettings.organizationId],
			references: [organization.id],
		}),
		defaultBuildServer: one(server, {
			fields: [buildPolicySettings.defaultBuildServerId],
			references: [server.serverId],
		}),
		defaultRegistry: one(registry, {
			fields: [buildPolicySettings.defaultRegistryId],
			references: [registry.registryId],
		}),
	}),
);

export const buildPolicyExclusionRelations = relations(
	buildPolicyExclusion,
	({ one }) => ({
		organization: one(organization, {
			fields: [buildPolicyExclusion.organizationId],
			references: [organization.id],
		}),
		application: one(applications, {
			fields: [buildPolicyExclusion.applicationId],
			references: [applications.applicationId],
		}),
		compose: one(compose, {
			fields: [buildPolicyExclusion.composeId],
			references: [compose.composeId],
		}),
	}),
);

export const buildPolicyAuditRelations = relations(
	buildPolicyAudit,
	({ one }) => ({
		organization: one(organization, {
			fields: [buildPolicyAudit.organizationId],
			references: [organization.id],
		}),
		application: one(applications, {
			fields: [buildPolicyAudit.applicationId],
			references: [applications.applicationId],
		}),
		compose: one(compose, {
			fields: [buildPolicyAudit.composeId],
			references: [compose.composeId],
		}),
		actor: one(user, {
			fields: [buildPolicyAudit.actorId],
			references: [user.id],
		}),
	}),
);

export type BuildPolicySettings = typeof buildPolicySettings.$inferSelect;
export type BuildPolicyExclusion = typeof buildPolicyExclusion.$inferSelect;
export type BuildPolicyAudit = typeof buildPolicyAudit.$inferSelect;
export type BuildPolicyAuditAction =
	(typeof buildPolicyAuditAction.enumValues)[number];

const createSettingsSchema = createInsertSchema(buildPolicySettings);

export const apiUpdateBuildPolicySettings = createSettingsSchema
	.pick({
		enforceRemoteBuilds: true,
		defaultBuildServerId: true,
		defaultRegistryId: true,
	})
	.partial()
	.extend({
		requiredChecksTimeoutMinutes: z.number().int().min(1).max(720).optional(),
	});

export const apiAddBuildPolicyExclusion = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		reason: z.string().max(500).optional(),
	})
	.refine((v) => !!v.applicationId !== !!v.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	});

export const apiRemoveBuildPolicyExclusion = z.object({
	buildPolicyExclusionId: z.string().min(1),
});

export const apiGrantBuildPolicyBreakGlass = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		reason: z.string().min(1).max(500),
	})
	.refine((v) => !!v.applicationId !== !!v.composeId, {
		message: "Provide exactly one of applicationId or composeId",
	});

export const apiListBuildPolicyAudit = z.object({
	limit: z.number().int().min(1).max(200).default(50),
	offset: z.number().int().min(0).default(0),
});

export const apiRollbackToBuildPolicyDigest = z.object({
	deploymentId: z.string().min(1),
});
