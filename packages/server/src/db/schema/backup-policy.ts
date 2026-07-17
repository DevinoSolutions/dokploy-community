import { relations } from "drizzle-orm";
import {
	boolean,
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
import { backups } from "./backups";
import { destinations } from "./destination";
import { volumeBackups } from "./volume-backups";

// Which services a policy covers. `organization` ignores scopeIds; `projects`
// scopes to the given project ids; `environments` scopes to the given
// environment ids.
export const backupPolicyScopeType = pgEnum("backupPolicyScopeType", [
	"organization",
	"projects",
	"environments",
]);

// Service types a policy may target. Mirrors the `serviceType` enum used by
// mounts/volume backups. Stored as a plain text[] so the filter can be empty
// (meaning "all applicable service types").
export const BACKUP_POLICY_SERVICE_TYPES = [
	"application",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"compose",
	"libsql",
] as const;

export type BackupPolicyServiceType =
	(typeof BACKUP_POLICY_SERVICE_TYPES)[number];

export const backupPolicies = pgTable("backup_policy", {
	backupPolicyId: text("backupPolicyId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	scopeType: backupPolicyScopeType("scopeType")
		.notNull()
		.default("organization"),
	// project ids or environment ids depending on scopeType; empty for
	// `organization`.
	scopeIds: text("scopeIds").array().notNull().default([]),
	includeDatabases: boolean("includeDatabases").notNull().default(true),
	includeVolumes: boolean("includeVolumes").notNull().default(false),
	// Subset of BACKUP_POLICY_SERVICE_TYPES; empty means "all applicable".
	serviceTypeFilter: text("serviceTypeFilter").array().notNull().default([]),
	// Restrict: a destination in use by a policy cannot be deleted out from
	// under it. The UI disables/warns when a destination is missing.
	destinationId: text("destinationId")
		.notNull()
		.references(() => destinations.destinationId, { onDelete: "restrict" }),
	schedule: text("schedule").notNull(),
	// Base S3 prefix; materialized rows get `<prefix>/<projectName>/<serviceName>`.
	prefix: text("prefix"),
	keepLatestCount: integer("keepLatestCount"),
	enabled: boolean("enabled").notNull().default(true),
	// Last error from a sync attempt, surfaced as a policy warning. Null when the
	// last sync succeeded.
	lastSyncError: text("lastSyncError"),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export type BackupPolicy = typeof backupPolicies.$inferSelect;

export const backupPoliciesRelations = relations(
	backupPolicies,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [backupPolicies.organizationId],
			references: [organization.id],
		}),
		destination: one(destinations, {
			fields: [backupPolicies.destinationId],
			references: [destinations.destinationId],
		}),
		backups: many(backups),
		volumeBackups: many(volumeBackups),
	}),
);

const serviceTypeFilterSchema = z.array(z.enum(BACKUP_POLICY_SERVICE_TYPES));

const createSchema = createInsertSchema(backupPolicies, {
	backupPolicyId: z.string(),
	name: z.string().min(1),
	organizationId: z.string(),
	scopeType: z.enum(["organization", "projects", "environments"]),
	scopeIds: z.array(z.string()).max(200).default([]),
	includeDatabases: z.boolean().optional(),
	includeVolumes: z.boolean().optional(),
	serviceTypeFilter: serviceTypeFilterSchema.default([]),
	destinationId: z.string().min(1),
	schedule: z.string().min(1),
	prefix: z.string().optional(),
	keepLatestCount: z.number().optional(),
	enabled: z.boolean().optional(),
});

export const apiCreateBackupPolicy = createSchema.pick({
	name: true,
	scopeType: true,
	scopeIds: true,
	includeDatabases: true,
	includeVolumes: true,
	serviceTypeFilter: true,
	destinationId: true,
	schedule: true,
	prefix: true,
	keepLatestCount: true,
	enabled: true,
});

export const apiUpdateBackupPolicy = createSchema
	.pick({
		name: true,
		scopeType: true,
		scopeIds: true,
		includeDatabases: true,
		includeVolumes: true,
		serviceTypeFilter: true,
		destinationId: true,
		schedule: true,
		prefix: true,
		keepLatestCount: true,
		enabled: true,
	})
	.partial()
	.extend({
		backupPolicyId: z.string().min(1),
	});

export const apiFindOneBackupPolicy = z.object({
	backupPolicyId: z.string().min(1),
});

export const apiRemoveBackupPolicy = z.object({
	backupPolicyId: z.string().min(1),
	// When true, delete the materialized backup/volume-backup rows (and
	// unschedule them) instead of demoting them to manual rows.
	deleteBackups: z.boolean().optional(),
});

export const apiToggleBackupPolicy = z.object({
	backupPolicyId: z.string().min(1),
	enabled: z.boolean(),
});
