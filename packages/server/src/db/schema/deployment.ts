import { relations, sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	BUILD_ORIGIN_DESCRIPTION,
	BUILD_ORIGINS,
	BUILD_RUN_URL_DESCRIPTION,
} from "../../services/build-origin-shared";
import { applications } from "./application";
import { backups } from "./backups";
import { compose } from "./compose";
import { previewDeployments } from "./preview-deployments";
import { rollbacks } from "./rollbacks";
import { schedules } from "./schedule";
import { server } from "./server";
import { volumeBackups } from "./volume-backups";
export const deploymentStatus = pgEnum("deploymentStatus", [
	"running",
	"done",
	"error",
	"cancelled",
]);

export const deployments = pgTable(
	"deployment",
	{
		deploymentId: text("deploymentId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		title: text("title").notNull(),
		description: text("description"),
		status: deploymentStatus("status").default("running"),
		logPath: text("logPath").notNull(),
		pid: text("pid"),
		applicationId: text("applicationId").references(
			() => applications.applicationId,
			{ onDelete: "cascade" },
		),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
		serverId: text("serverId").references(() => server.serverId, {
			onDelete: "cascade",
		}),
		isPreviewDeployment: boolean("isPreviewDeployment").default(false),
		previewDeploymentId: text("previewDeploymentId").references(
			(): AnyPgColumn => previewDeployments.previewDeploymentId,
			{ onDelete: "cascade" },
		),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		startedAt: text("startedAt"),
		// Parse with new Date(): the finish time of a cancelled schedule run carries a
		// "+00:00" offset as a token (see utils/schedules/run-status.ts), so it must
		// not be compared or sorted as a string.
		finishedAt: text("finishedAt"),
		errorMessage: text("errorMessage"),
		scheduleId: text("scheduleId").references(
			(): AnyPgColumn => schedules.scheduleId,
			{ onDelete: "cascade" },
		),
		backupId: text("backupId").references((): AnyPgColumn => backups.backupId, {
			onDelete: "cascade",
		}),
		rollbackId: text("rollbackId").references(
			(): AnyPgColumn => rollbacks.rollbackId,
			{ onDelete: "cascade" },
		),
		volumeBackupId: text("volumeBackupId").references(
			(): AnyPgColumn => volumeBackups.volumeBackupId,
			{ onDelete: "cascade" },
		),
		buildServerId: text("buildServerId").references(() => server.serverId, {
			onDelete: "cascade",
		}),
		/**
		 * Fork columns (build-policy). The image this deployment actually shipped:
		 * the `<repository>:<sha>` tag that was pushed and the digest the swarm
		 * service was pinned to. Null on a local build. Together they are what a
		 * rollback redeploys with no build.
		 */
		imageTag: text("imageTag"),
		imageDigest: text("imageDigest"),
		/**
		 * Fork columns (T-7960). What a build-server compose deploy whose release
		 * is running built: the commit its fresh clone checked out on the serving host
		 * (read before anything else touched the checkout), the build server, and a
		 * digest of the enabled patch rows it applied. A rebuild builds the code
		 * already on disk, so it refuses unless all three still match (see
		 * `assertRebuildCommitMatchesDeploy`). A rebuild that passed carries them
		 * forward. Null everywhere else.
		 */
		pinnedCommit: text("pinnedCommit"),
		pinnedBuildServerId: text("pinnedBuildServerId"),
		pinnedPatchDigest: text("pinnedPatchDigest"),
		/**
		 * Fork columns (T-12149). Where the image this deployment shipped was built:
		 * 'dokploy' | 'github-actions' | 'external' (see services/build-origin-shared.ts),
		 * and the GitHub Actions run link when the caller sent a valid one. Null on
		 * rows written before the columns existed; readers infer those. Kept here and
		 * not on the application/compose tables, which sit at the Postgres 100-argument
		 * cap for Drizzle eager loads.
		 */
		buildOrigin: text("buildOrigin"),
		buildRunUrl: text("buildRunUrl"),
		/**
		 * Fork columns (T-12686). A row registered while GitHub Actions still builds
		 * the image (deployment.registerExternalBuild) carries the run it follows: the
		 * run id, the repository (`owner/name`), the commit, the run state (`queued` |
		 * `in_progress` | `completed`) and a short label of the step that runs now
		 * ("build · Build image (3/7)"). `completed` also means the deploy call took
		 * the row over, so nothing polls GitHub for it any more. All null on every
		 * other row.
		 */
		buildRunId: text("buildRunId"),
		buildRepository: text("buildRepository"),
		buildCommitSha: text("buildCommitSha"),
		buildRunStatus: text("buildRunStatus"),
		buildRunStep: text("buildRunStep"),
		/**
		 * Fork column (T-12686). True from deployment.registerExternalBuild until a deploy
		 * job takes the row over (then false). A row that is still true never deployed
		 * anything to Dokploy, so it only shows in the Deployments lists: every derivation
		 * of "the last deployment" (baseline image, last deployed, build origin of the
		 * service) ignores it, and so do the watchdog and the restart sweep. A row closed
		 * by finishExternalBuild or by the poller keeps it true.
		 */
		externalBuildOnly: boolean("externalBuildOnly").notNull().default(false),
		/**
		 * Fork columns (T-12686). `deployQueuedAt`: when application/compose deploy or
		 * redeploy accepted this row's id (the deploy waits in Dokploy's queue, which can take
		 * far longer than the workflow waits). A row with it set is never ended by the run
		 * poller. `deployStartedAt`: when the queue job took the row over; the watchdog
		 * matches the job and counts its wall limit from it, not from the GitHub build.
		 */
		deployQueuedAt: text("deployQueuedAt"),
		deployStartedAt: text("deployStartedAt"),
	},
	(table) => [
		// One run of one service is one registered row, however many matrix legs
		// register at once. Registered rows only: a rollback deploy shares its run link.
		uniqueIndex("deployment_external_build_run_unique")
			.on(
				sql`coalesce(${table.applicationId}, ${table.composeId})`,
				table.buildRunUrl,
			)
			.where(sql`${table.externalBuildOnly} = true`),
	],
);

export const deploymentsRelations = relations(deployments, ({ one }) => ({
	application: one(applications, {
		fields: [deployments.applicationId],
		references: [applications.applicationId],
	}),
	compose: one(compose, {
		fields: [deployments.composeId],
		references: [compose.composeId],
	}),
	server: one(server, {
		fields: [deployments.serverId],
		references: [server.serverId],
		relationName: "deploymentServer",
	}),
	buildServer: one(server, {
		fields: [deployments.buildServerId],
		references: [server.serverId],
		relationName: "deploymentBuildServer",
	}),
	previewDeployment: one(previewDeployments, {
		fields: [deployments.previewDeploymentId],
		references: [previewDeployments.previewDeploymentId],
	}),
	schedule: one(schedules, {
		fields: [deployments.scheduleId],
		references: [schedules.scheduleId],
	}),
	backup: one(backups, {
		fields: [deployments.backupId],
		references: [backups.backupId],
	}),
	rollback: one(rollbacks, {
		fields: [deployments.deploymentId],
		references: [rollbacks.deploymentId],
	}),
	volumeBackup: one(volumeBackups, {
		fields: [deployments.volumeBackupId],
		references: [volumeBackups.volumeBackupId],
	}),
}));

const schema = createInsertSchema(deployments, {
	title: z.string().min(1),
	status: z.string().default("running"),
	logPath: z.string().min(1),
	applicationId: z.string(),
	composeId: z.string(),
	description: z.string().optional(),
	previewDeploymentId: z.string(),
	buildServerId: z.string(),
});
export const apiCreateDeployment = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		applicationId: true,
		description: true,
		previewDeploymentId: true,
	})
	.extend({
		applicationId: z.string().min(1),
	});

export const apiCreateDeploymentPreview = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
		previewDeploymentId: true,
	})
	.extend({
		previewDeploymentId: z.string().min(1),
	});

export const apiCreateDeploymentCompose = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		composeId: true,
		description: true,
	})
	.extend({
		composeId: z.string().min(1),
	});

export const apiCreateDeploymentBackup = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		backupId: true,
		description: true,
	})
	.extend({
		backupId: z.string().min(1),
	});

export const apiCreateDeploymentServer = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		serverId: true,
		description: true,
	})
	.extend({
		serverId: z.string().min(1),
	});

export const apiCreateDeploymentSchedule = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
	})
	.extend({
		scheduleId: z.string().min(1),
	});

export const apiCreateDeploymentVolumeBackup = schema
	.pick({
		title: true,
		status: true,
		logPath: true,
		description: true,
	})
	.extend({
		volumeBackupId: z.string().min(1),
	});

/**
 * Optional inputs of the deploy/redeploy procedures that say where the image was
 * built. Both are claims by the caller, not verified by Dokploy. The URL is
 * validated (and dropped when it is not a GitHub Actions run link) by
 * normalizeBuildRunUrl, so a bad link never fails a deploy.
 */
export const apiBuildOriginInput = {
	buildOrigin: z
		.enum(BUILD_ORIGINS)
		.optional()
		.describe(BUILD_ORIGIN_DESCRIPTION),
	buildRunUrl: z
		.string()
		.max(300)
		.optional()
		.describe(BUILD_RUN_URL_DESCRIPTION),
};

/**
 * Optional input of the deploy/redeploy procedures: the deployment that
 * deployment.registerExternalBuild created while GitHub Actions built the image.
 * The deploy then continues that row (same log, same deployment id) instead of
 * creating a second one. Ignored, never an error, when the row is not a running
 * GitHub Actions row of the same service that still waits for its deploy.
 */
export const apiLiveBuildInput = {
	deploymentId: z
		.string()
		.max(100)
		.optional()
		.describe(
			"The deploymentId returned by deployment.registerExternalBuild for this GitHub Actions run. The deploy continues that deployment (same log) instead of creating a new one. Ignored when it does not belong to this service or is no longer waiting for its deploy.",
		),
};

/**
 * The workflow tells Dokploy that a GitHub Actions run is building an image for a service, before the build ends
 * (T-12686). Exactly one of applicationId / composeId.
 */
export const apiRegisterExternalBuild = z
	.object({
		applicationId: z.string().min(1).optional(),
		composeId: z.string().min(1).optional(),
		buildOrigin: z
			.literal("github-actions")
			.describe("Only 'github-actions' is supported."),
		buildRunUrl: z
			.string()
			.min(1)
			.max(300)
			.describe(
				"Link to the GitHub Actions run: https://github.com/<owner>/<repo>/actions/runs/<id>, with /attempts/<n> for a re-run. The same link for the same service returns the deployment it created before.",
			),
		buildRunId: z
			.string()
			.regex(/^[0-9]{1,20}$/)
			.describe("The run id (GITHUB_RUN_ID). Must be the one in buildRunUrl."),
		buildRepository: z
			.string()
			.min(3)
			.max(140)
			.describe(
				"owner/name (GITHUB_REPOSITORY). Must be the one in buildRunUrl.",
			),
		buildCommitSha: z
			.string()
			.regex(/^[0-9a-fA-F]{7,40}$/)
			.describe("The commit the image is built from."),
		title: z.string().min(1).max(300),
		description: z.string().max(1000).optional(),
	})
	.refine(
		(input) => Boolean(input.applicationId) !== Boolean(input.composeId),
		{
			message: "Send either applicationId or composeId.",
		},
	);

export const apiFinishExternalBuild = z.object({
	deploymentId: z.string().min(1),
	conclusion: z
		.enum(["failure", "cancelled", "skipped"])
		.describe(
			"How the run ended before it deployed. failure = the deployment ends as error, cancelled and skipped = it ends as cancelled.",
		),
	message: z
		.string()
		.max(1000)
		.optional()
		.describe(
			"Why it ended, added to the deployment log and its error message.",
		),
});

export const apiFindAllByApplication = z.object({
	applicationId: z.string().min(1),
});

export const apiFindAllByCompose = z.object({
	composeId: z.string().min(1),
});

export const apiFindAllByServer = z.object({
	serverId: z.string().min(1),
});

export const apiFindAllByType = z.object({
	id: z.string().min(1),
	type: z.enum([
		"application",
		"compose",
		"server",
		"schedule",
		"previewDeployment",
		"backup",
		"volumeBackup",
	]),
});
