import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { githubDeploymentConnection } from "./github-deployment";
import {
	apiGithubDeploymentEnvironment,
	apiGithubOwnerRepo,
	GITHUB_WATCH_SERVICE_TYPES,
	type GithubWatchServiceType,
} from "./github-deployment-shared";

/**
 * "Build on GitHub Actions", connected natively (T-13719). One row per
 * service that follows a repository's GitHub Actions releases: Dokploy reads
 * the release manifest from the run artifact and deploys it. Kept out of the
 * `application` table, which sits at the Drizzle / Postgres 100-argument cap.
 * See docs/superpowers/specs/2026-11-03-gha-native-connect-design.md.
 *
 * The repository is stored by its immutable id, so a rename changes nothing;
 * `repoFullName` is only the name seen at the last poll.
 */

export const GHA_CONNECTION_STATES = [
	"not_connected",
	"proposed",
	"detected",
	"waiting",
	"connected",
	"stale",
	"blocked",
	"disconnected",
] as const;
export type GhaConnectionState = (typeof GHA_CONNECTION_STATES)[number];

export const GHA_GATE_MODES = ["image", "checks", "workflows"] as const;
export type GhaGateMode = (typeof GHA_GATE_MODES)[number];

/** Where a release stands at the deploy gate (T-13720). Null: not looked at yet, or the gate is off. */
export const GHA_GATE_STATES = [
	"waiting",
	"blocked",
	"passed",
	"overridden",
] as const;
export type GhaGateState = (typeof GHA_GATE_STATES)[number];

/** The checks a release waits for, decided once per release so the answer cannot drift while it waits. */
export interface GhaGateExpected {
	source: "required" | "last-green" | "fallback";
	names: string[];
	/** Required checks pinned to one GitHub App by branch protection: name to app id. */
	appIds?: Record<string, number>;
}

/** Who deployed a gated release anyway, when and why. */
export interface GhaGateOverride {
	by: string;
	at: string;
	reason: string | null;
}

export const GHA_GATE_TIMEOUT_MINUTES = {
	min: 5,
	max: 720,
	default: 60,
} as const;
export const GHA_GATE_WORKFLOWS_MAX = 20;

export const GHA_PROTECTION_MODES = [
	"environment",
	"repository-secret",
] as const;
export type GhaProtectionMode = (typeof GHA_PROTECTION_MODES)[number];

/** A run that was looked at, newest first, capped. */
export interface GhaProcessedRun {
	runId: number;
	attempt: number;
	outcome: string;
	at: string;
}

export const ghaConnection = pgTable(
	"gha_connection",
	{
		ghaConnectionId: text("ghaConnectionId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceType: text("serviceType").$type<GithubWatchServiceType>().notNull(),
		/** applicationId or composeId; polymorphic, so no foreign key. */
		serviceId: text("serviceId").notNull(),
		/** The GitHub account (device flow token) used to read the repository. */
		githubConnectionId: text("githubConnectionId").notNull(),
		repoId: bigint("repoId", { mode: "number" }).notNull(),
		repoFullName: text("repoFullName").notNull(),
		workflowPath: text("workflowPath")
			.notNull()
			.default(".github/workflows/dokploy.yml"),
		trackedBranch: text("trackedBranch").notNull(),
		environment: text("environment").notNull(),
		/** Name in the Deployment task `dokploy:<key>` and in the manifest. */
		serviceKey: text("serviceKey").notNull(),
		protectionMode: text("protectionMode")
			.$type<GhaProtectionMode>()
			.notNull()
			.default("environment"),
		/**
		 * Image prefix of the mirror, exactly as it appears in the images of a release:
		 * host[:port][/path], no trailing slash. The tunnel mirror pushes to
		 * `localhost:5000/registry.devino.ca/<repo>/<service>`, so its prefix is
		 * `localhost:5000/registry.devino.ca`. Null: public GHCR images only.
		 */
		registryPrefix: text("registryPrefix"),
		/** The Dokploy registry record (Settings, Registry) whose URL and login the digest check uses. */
		registryId: text("registryId"),
		/**
		 * Host of that record's URL (e.g. registry.devino.ca). The v2 manifest check goes to
		 * https://<this host> with the record's login, never to the prefix host: `localhost:5000`
		 * inside the Dokploy container is the registry only if the host publishes it there.
		 */
		registryProbeHost: text("registryProbeHost"),
		gateMode: text("gateMode").$type<GhaGateMode>().notNull().default("image"),
		/** Workflow names (or file names without .yml) the release waits for in the `workflows` gate mode. */
		gateWorkflows: text("gateWorkflows").array().notNull().default([]),
		/** How long a check or workflow may take to report before the release is blocked. */
		gateTimeoutMinutes: integer("gateTimeoutMinutes").notNull().default(60),
		gateStartedAt: timestamp("gateStartedAt"),
		/** Bumped on every settings change and Deploy anyway; an evaluation that read an older value writes nothing. */
		gateVersion: integer("gateVersion").notNull().default(0),
		/** True while the connection is Blocked by the deploy gate (and not by something else). */
		gateBlocked: boolean("gateBlocked").notNull().default(false),
		state: text("state")
			.$type<GhaConnectionState>()
			.notNull()
			.default("waiting"),
		stateDetail: text("stateDetail"),
		stateSince: timestamp("stateSince").notNull().defaultNow(),
		/** The branch head when the user confirmed Connect. */
		expectedSha: text("expectedSha"),
		deployedSha: text("deployedSha"),
		deployedRunId: bigint("deployedRunId", { mode: "number" }),
		deployedRunAttempt: integer("deployedRunAttempt"),
		/** Sorted image digests of the deployed release. */
		deployedDigests: jsonb("deployedDigests").$type<string[]>(),
		deployedAt: timestamp("deployedAt"),
		/** Runs already looked at, so a poll never repeats a request for them. */
		processed: jsonb("processed")
			.$type<GhaProcessedRun[]>()
			.notNull()
			.default([]),
		/** The service's source before Connect (git settings, autodeploy), for "Take over locally". */
		previousSource: jsonb("previousSource").$type<Record<string, unknown>>(),
		lastActivityAt: timestamp("lastActivityAt"),
		lastRunSeenId: bigint("lastRunSeenId", { mode: "number" }),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => [
		// Named by hand: the generated name would be 78 characters, and
		// PostgreSQL silently cuts identifiers at 63. Restrict, not cascade: removing
		// a GitHub account must never drop the saved source of a flipped service
		// (githubDeployment.disconnect refuses while a connection uses the account).
		foreignKey({
			columns: [table.githubConnectionId],
			foreignColumns: [githubDeploymentConnection.connectionId],
			name: "gha_connection_github_connection_fk",
		}).onDelete("restrict"),
		unique("gha_connection_service_unique").on(
			table.serviceType,
			table.serviceId,
		),
		unique("gha_connection_repo_key_unique").on(
			table.repoId,
			table.environment,
			table.serviceKey,
		),
	],
);

export const GHA_RELEASE_STATUSES = [
	"accepted",
	"deployed",
	"failed",
	"noop",
	"verified",
] as const;
export type GhaReleaseStatus = (typeof GHA_RELEASE_STATUSES)[number];

/** Every release a connection accepted: the history rollback and retention read. */
export const ghaRelease = pgTable(
	"gha_release",
	{
		releaseId: text("releaseId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		ghaConnectionId: text("ghaConnectionId")
			.notNull()
			.references(() => ghaConnection.ghaConnectionId, {
				onDelete: "cascade",
			}),
		/** `release.id` of the manifest, e.g. gh-9876543210.1. */
		manifestReleaseId: text("manifestReleaseId").notNull(),
		sha: text("sha").notNull(),
		runId: bigint("runId", { mode: "number" }).notNull(),
		runAttempt: integer("runAttempt").notNull(),
		delivery: text("delivery").$type<"pull" | "push">().notNull(),
		status: text("status").$type<GhaReleaseStatus>().notNull(),
		/** The GitHub Deployment that woke Dokploy up; its statuses are the record. */
		githubDeploymentId: bigint("githubDeploymentId", { mode: "number" }),
		images: jsonb("images")
			.$type<Array<{ name: string; composeService: string; ref: string }>>()
			.notNull(),
		/** Sorted digests, to compare releases without reading the images. */
		digests: jsonb("digests").$type<string[]>().notNull(),
		/**
		 * The service as it was just before this release changed it (an application's source
		 * settings without the registry password, or a compose stack's id and file text), written in
		 * the same transaction as the change. The record a rollback or a "take over" reads.
		 */
		sourceBackup: jsonb("sourceBackup").$type<Record<string, unknown>>(),
		/** The deploy gate: waiting, blocked, passed or overridden (T-13720). */
		gateState: text("gateState").$type<GhaGateState>(),
		gateReason: text("gateReason"),
		gateCheckedAt: timestamp("gateCheckedAt"),
		gateExpected: jsonb("gateExpected").$type<GhaGateExpected>(),
		gateOverride: jsonb("gateOverride").$type<GhaGateOverride>(),
		/** Kept by retention and never garbage collected. */
		pinned: boolean("pinned").notNull().default(false),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		settledAt: timestamp("settledAt"),
	},
	(table) => [
		unique("gha_release_run_unique").on(
			table.ghaConnectionId,
			table.runId,
			table.runAttempt,
		),
		index("gha_release_connection_created_idx").on(
			table.ghaConnectionId,
			table.createdAt,
		),
	],
);

export const ghaConnectionRelations = relations(
	ghaConnection,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [ghaConnection.organizationId],
			references: [organization.id],
		}),
		githubConnection: one(githubDeploymentConnection, {
			fields: [ghaConnection.githubConnectionId],
			references: [githubDeploymentConnection.connectionId],
		}),
		releases: many(ghaRelease),
	}),
);

export const ghaReleaseRelations = relations(ghaRelease, ({ one }) => ({
	connection: one(ghaConnection, {
		fields: [ghaRelease.ghaConnectionId],
		references: [ghaConnection.ghaConnectionId],
	}),
}));

const GATE_MODE_HELP =
	"When a release is deployed: image (as soon as the image is accepted), checks (when every check on the commit passes) or workflows (when the workflows named in gateWorkflows pass).";

const gateWorkflowsSchema = z
	.array(z.string().trim().min(1).max(100))
	.max(GHA_GATE_WORKFLOWS_MAX)
	.describe(
		"Workflows that must pass on the commit when gateMode is workflows: the workflow's name or its file name without .yml. 1 to 20 names.",
	);

const gateTimeoutSchema = z
	.number()
	.int()
	.min(GHA_GATE_TIMEOUT_MINUTES.min)
	.max(GHA_GATE_TIMEOUT_MINUTES.max)
	.describe(
		"Minutes a check or workflow may take to report before the release is blocked. 5 to 720, default 60.",
	);

const REGISTRY_PREFIX =
	/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

export const apiGhaConnectionOne = z.object({
	serviceType: z.enum(GITHUB_WATCH_SERVICE_TYPES),
	serviceId: z.string().min(1).describe("applicationId or composeId."),
});

export const apiGhaConnect = z.object({
	serviceType: z.enum(GITHUB_WATCH_SERVICE_TYPES),
	serviceId: z.string().min(1).describe("applicationId or composeId."),
	githubConnectionId: z
		.string()
		.min(1)
		.describe(
			"GitHub account (from githubDeployment-connections) to read the repository with.",
		),
	owner: apiGithubOwnerRepo.shape.owner,
	repo: apiGithubOwnerRepo.shape.repo,
	workflowPath: z
		.string()
		.trim()
		.regex(
			/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/,
			"Must be a workflow file under .github/workflows",
		)
		.default(".github/workflows/dokploy.yml")
		.describe("The workflow file whose runs are releases of this service."),
	trackedBranch: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.regex(/^[A-Za-z0-9._/-]+$/, "Not a valid branch name")
		.refine(
			(name) => !name.includes("..") && !name.endsWith("/"),
			"Not a valid branch name",
		)
		.describe("The branch whose releases are deployed."),
	environment: apiGithubDeploymentEnvironment,
	serviceKey: z
		.string()
		.regex(
			/^[a-z0-9][a-z0-9._-]{0,62}$/,
			"Lowercase letters, digits, dots, dashes and underscores",
		)
		.describe(
			"The key in the Deployment task dokploy:<key> and in the release manifest.",
		),
	registryPrefix: z
		.string()
		.trim()
		.toLowerCase()
		.regex(
			REGISTRY_PREFIX,
			"Not a valid registry prefix (host[:port][/path], no trailing slash)",
		)
		.nullable()
		.default(null)
		.describe(
			"Where the images of a release live when they are mirrored, exactly as written in the release: host[:port][/path] without a trailing slash, e.g. localhost:5000/registry.devino.ca for the tunnel mirror. Needs registryId. Null: public GHCR images only.",
		),
	registryId: z
		.string()
		.min(1)
		.nullable()
		.default(null)
		.describe(
			"The Dokploy registry (Settings, Registry) whose URL and login are used to check the digests. Required with registryPrefix.",
		),
	protectionMode: z.enum(GHA_PROTECTION_MODES).default("environment"),
	gateMode: z.enum(GHA_GATE_MODES).default("image").describe(GATE_MODE_HELP),
	gateWorkflows: gateWorkflowsSchema.default([]),
	gateTimeoutMinutes: gateTimeoutSchema.default(
		GHA_GATE_TIMEOUT_MINUTES.default,
	),
});

/** The connect input as the router takes it: the workflows gate needs workflows to wait for. */
export const apiGhaConnectInput = apiGhaConnect.superRefine((value, ctx) => {
	if (value.gateMode === "workflows" && value.gateWorkflows.length === 0) {
		ctx.addIssue({
			code: "custom",
			path: ["gateWorkflows"],
			message: "Name at least one workflow to wait for",
		});
	}
});

export const apiGhaUpdate = apiGhaConnectionOne.extend({
	gateMode: z.enum(GHA_GATE_MODES).optional().describe(GATE_MODE_HELP),
	gateWorkflows: gateWorkflowsSchema.optional(),
	gateTimeoutMinutes: gateTimeoutSchema.optional(),
});

export const apiGhaDeployAnyway = apiGhaConnectionOne.extend({
	releaseId: z
		.string()
		.min(1)
		.describe(
			"The release to deploy (releaseId from ghaConnection.one). Refused when it is not the newest accepted release.",
		),
	reason: z
		.string()
		.trim()
		.max(300)
		.optional()
		.describe("Why the checks are skipped. Kept in the audit log."),
});

export const apiGhaDisconnect = apiGhaConnectionOne.extend({
	restoreSource: z
		.boolean()
		.default(true)
		.describe(
			"Put an application back on the git source it had before it was connected (its saved settings). Has no effect on a compose stack.",
		),
});
export const apiGhaCheckNow = apiGhaConnectionOne;

export const apiGhaSnippet = z.object({
	serviceKey: apiGhaConnect.shape.serviceKey,
	trackedBranch: apiGhaConnect.shape.trackedBranch,
	environment: apiGithubDeploymentEnvironment,
	buildJob: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Not a valid job id")
		.describe(
			"Id of the job in your workflow that builds and pushes the image.",
		),
	imageOutput: z
		.string()
		.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "Not a valid output name")
		.describe("Output of that job holding repository@sha256:digest."),
	delivery: z.enum(["pull", "push"]).default("pull"),
});
