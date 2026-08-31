import { relations } from "drizzle-orm";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { environments } from "./environment";
import { projectTags } from "./tag";
import { encryptedText } from "./utils";

export const projects = pgTable("project", {
	projectId: text("projectId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	logo: text("logo"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),

	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	env: encryptedText("env").notNull().default(""),
	/**
	 * Fork column. Per-project override for the base domain used when Dokploy
	 * generates a domain. Stored BARE (`apps.example.com`), displayed as
	 * `*.apps.example.com`. Highest rung of `resolveGeneratedDomainBase`.
	 */
	wildcardDomain: text("wildcardDomain"),
	/**
	 * Fork column. When true (default), a project with no `wildcardDomain` of
	 * its own falls back to `organization.wildcardDomain`. Set to false to opt a
	 * project out of the organization-wide base entirely.
	 */
	useOrganizationWildcard: boolean("useOrganizationWildcard")
		.notNull()
		.default(true),
});

export const projectRelations = relations(projects, ({ many, one }) => ({
	environments: many(environments),
	projectTags: many(projectTags),
	organization: one(organization, {
		fields: [projects.organizationId],
		references: [organization.id],
	}),
}));

const createSchema = createInsertSchema(projects, {
	projectId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
	logo: z.string().optional(),
	env: z.string().optional(),
});

export const apiCreateProject = createSchema.pick({
	name: true,
	description: true,
	logo: true,
	env: true,
});

export const apiFindOneProject = z.object({
	projectId: z.string().min(1),
});
export const apiRemoveProject = createSchema
	.pick({
		projectId: true,
	})
	.required();

// export const apiUpdateProject = createSchema
// 	.pick({
// 		name: true,
// 		description: true,
// 		projectId: true,
// 		env: true,
// 	})
// 	.required();

export const apiUpdateProject = createSchema
	.partial()
	.extend({
		projectId: z.string().min(1),
	})
	// The generated-domain fields are written exclusively through
	// `project.updateWildcardDomain`, which normalizes and validates the value
	// (`*.` stripping, prefix-pattern rejection, hostname validation). Leaving
	// them writable through the generic project update would let an unvalidated
	// string reach the column, so they are omitted here on purpose.
	.omit({ wildcardDomain: true, useOrganizationWildcard: true });
// .omit({ serverId: true });

export const apiUpdateProjectWildcardDomain = z.object({
	projectId: z.string().min(1),
	// `null` / "" clears the override.
	wildcardDomain: z.string().nullable().optional(),
	useOrganizationWildcard: z.boolean().optional(),
});
