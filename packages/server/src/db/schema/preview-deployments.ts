import { relations, sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { applications } from "./application";
import { compose } from "./compose";
import { deployments } from "./deployment";
import { domains } from "./domain";
import { applicationStatus } from "./shared";
import { generateAppName } from "./utils";

export const previewDeployments = pgTable(
	"preview_deployments",
	{
		previewDeploymentId: text("previewDeploymentId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		branch: text("branch").notNull(),
		pullRequestId: text("pullRequestId").notNull(),
		pullRequestNumber: text("pullRequestNumber").notNull(),
		pullRequestURL: text("pullRequestURL").notNull(),
		pullRequestTitle: text("pullRequestTitle").notNull(),
		pullRequestCommentId: text("pullRequestCommentId").notNull().default(""),
		previewStatus: applicationStatus("previewStatus").notNull().default("idle"),
		appName: text("appName")
			.notNull()
			.$defaultFn(() => generateAppName("preview"))
			.unique(),
		// A preview belongs to exactly one of an application or a compose service.
		// Both FKs are nullable; the XOR is enforced in the service layer
		// (createPreviewDeployment / createComposePreview) to match the repo's
		// no-CHECK-constraint style.
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{
				onDelete: "cascade",
			},
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
		domainId: text("domainId").references(() => domains.domainId, {
			onDelete: "cascade",
		}),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		expiresAt: text("expiresAt"),
	},
	(table) => ({
		// Serializes the concurrent pull_request webhooks GitHub fires when a PR is
		// opened with a label (`opened` + `labeled`); createPreviewDeployment inserts
		// first and the loser reuses the winner's row instead of creating a duplicate.
		// Partial so compose previews (applicationId IS NULL) are covered by their own
		// index below instead of colliding here.
		applicationPrUnique: uniqueIndex(
			"preview_deployments_application_pr_unique",
		)
			.on(table.applicationId, table.pullRequestId)
			.where(sql`"applicationId" IS NOT NULL`),
		// Same insert-first dedupe guarantee for compose previews.
		composePrUnique: uniqueIndex("preview_deployments_compose_pr_unique")
			.on(table.composeId, table.pullRequestId)
			.where(sql`"composeId" IS NOT NULL`),
	}),
);

export const previewDeploymentsRelations = relations(
	previewDeployments,
	({ one, many }) => ({
		deployments: many(deployments),
		// The single legacy domain (application previews attach one domain via
		// domainId). Compose previews attach one domain per service via
		// domains.previewDeploymentId (the `domains` relation below).
		domain: one(domains, {
			fields: [previewDeployments.domainId],
			references: [domains.domainId],
		}),
		domains: many(domains),
		application: one(applications, {
			fields: [previewDeployments.applicationId],
			references: [applications.applicationId],
		}),
		compose: one(compose, {
			fields: [previewDeployments.composeId],
			references: [compose.composeId],
		}),
	}),
);

export const createSchema = createInsertSchema(previewDeployments, {
	applicationId: z.string().optional(),
	composeId: z.string().optional(),
});

export const apiCreatePreviewDeployment = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		domainId: z.string().optional(),
		branch: z.string().min(1),
		pullRequestId: z.string().min(1),
		pullRequestNumber: z.string().min(1),
		pullRequestURL: z.string().min(1),
		pullRequestTitle: z.string().min(1),
	})
	.refine((data) => !!data.applicationId !== !!data.composeId, {
		message: "Exactly one of applicationId or composeId must be provided",
		path: ["applicationId"],
	});
