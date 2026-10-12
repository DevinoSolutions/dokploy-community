import { trimTrailingSlashes } from "@dokploy/server/utils/integrations/base-url";
import { relations } from "drizzle-orm";
import {
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";

import { SNAPVISOR_DEFAULT_BASE_URL } from "../../utils/snapvisor/urls";

export { SNAPVISOR_DEFAULT_BASE_URL };

/**
 * Organization-scoped Snapvisor connection (one per organization).
 *
 * `accessToken` is a Snapvisor **personal access token**, stored as a
 * plaintext text column like `cloudflare.apiToken`; it is write-only from the
 * dashboard's perspective and every read path masks it. A PAT is required
 * (not a project token): the fork needs to list every project under the
 * account (`GET /v2/accounts/{accountSlug}/projects`, `patOrOAuthAuth` only)
 * as well as read builds for the one project an application is linked to
 * (`GET /v2/projects/{owner}/{project}/builds`, which also accepts a PAT).
 * See services/snapvisor.ts for the cited source files.
 */
export const snapvisorIntegration = pgTable("snapvisor_integration", {
	snapvisorId: text("snapvisorId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.unique()
		.references(() => organization.id, { onDelete: "cascade" }),
	name: text("name").notNull(),
	accessToken: text("accessToken").notNull(),
	accountSlug: text("accountSlug").notNull(),
	baseUrl: text("baseUrl").notNull().default(SNAPVISOR_DEFAULT_BASE_URL),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
});

export const snapvisorIntegrationRelations = relations(
	snapvisorIntegration,
	({ one }) => ({
		organization: one(organization, {
			fields: [snapvisorIntegration.organizationId],
			references: [organization.id],
		}),
	}),
);

/**
 * One deployed commit of a Snapvisor-linked service whose build is being
 * watched for visual changes (see services/snapvisor-checks.ts).
 *
 * Its own table, not columns on `application`/`compose`: the application
 * table is at Postgres' 100-argument limit for eager-loaded relational
 * queries. There is deliberately no foreign key to the service or the
 * deployment: the row is also the record that a notification was sent, and
 * must outlive a deployment cleaned up by log retention (or a redeploy of the
 * same commit would be notified twice). Stale rows are pruned by age; the
 * organization FK cleans up with the organization.
 *
 * `state`: `pending` (still watching), `notified` (changes found, the
 * notification was claimed), `settled` (reached a state that needs no
 * notification, or the link was removed) or `expired` (gave up after the
 * watch window).
 */
export const snapvisorBuildCheck = pgTable(
	"snapvisor_build_check",
	{
		checkId: text("checkId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceType: text("serviceType").notNull(),
		serviceId: text("serviceId").notNull(),
		deploymentId: text("deploymentId"),
		commitSha: text("commitSha").notNull(),
		state: text("state").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		errorStreak: integer("errorStreak").notNull().default(0),
		buildNumber: integer("buildNumber"),
		buildStatus: text("buildStatus"),
		nextCheckAt: timestamp("nextCheckAt").notNull().defaultNow(),
		expiresAt: timestamp("expiresAt").notNull(),
		notifiedAt: timestamp("notifiedAt"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => ({
		// One watch (and one notification) per commit of a service, however many
		// times it is redeployed.
		serviceCommitUnique: uniqueIndex(
			"snapvisor_build_check_service_commit_unique",
		).on(table.serviceId, table.commitSha),
		dueIdx: index("snapvisor_build_check_due_idx").on(
			table.state,
			table.nextCheckAt,
		),
	}),
);

export type SnapvisorBuildCheck = typeof snapvisorBuildCheck.$inferSelect;

const snapvisorBaseUrlSchema = z
	.string()
	.trim()
	.url("Enter a valid URL")
	.refine((value) => /^https?:\/\//i.test(value), "Use an http(s) URL")
	.transform((value) => trimTrailingSlashes(value));

// Snapvisor account/project slugs are URL path segments.
const snapvisorSlugSchema = z
	.string()
	.trim()
	.min(1)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "Use the slug only, not a URL");

export const apiCreateSnapvisor = z.object({
	name: z.string().trim().min(1),
	// Trim before validating so a whitespace-only token cannot pass `.min(1)`.
	accessToken: z.string().trim().min(1),
	accountSlug: snapvisorSlugSchema,
	baseUrl: snapvisorBaseUrlSchema.default(SNAPVISOR_DEFAULT_BASE_URL),
});

export const apiUpdateSnapvisor = z.object({
	name: z.string().trim().min(1).optional(),
	// Write-only: omit it to keep the stored token.
	accessToken: z.string().trim().min(1).optional(),
	accountSlug: snapvisorSlugSchema.optional(),
	baseUrl: snapvisorBaseUrlSchema.optional(),
});

export const apiTestSnapvisorConnection = z.object({
	// Blank on the edit flow: the stored token of the caller's integration is used.
	accessToken: z.string().trim().min(1).optional(),
	baseUrl: snapvisorBaseUrlSchema.default(SNAPVISOR_DEFAULT_BASE_URL),
});

export const apiSetSnapvisorApplicationProject = z.object({
	applicationId: z.string().min(1),
	// `null` turns visual testing off for the application.
	projectName: snapvisorSlugSchema.nullable(),
});

export const apiSetSnapvisorComposeProject = z.object({
	composeId: z.string().min(1),
	// `null` turns visual testing off for the compose service.
	projectName: snapvisorSlugSchema.nullable(),
});

export const apiSnapvisorPreviewBuild = z.object({
	previewDeploymentId: z.string().min(1),
});

export const apiSnapvisorDeploymentBuild = z.object({
	deploymentId: z.string().min(1),
});
