import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { encryptedText } from "./utils";

/**
 * "Deploy from GitHub Deployments" (T-12166): a Dokploy that GitHub Actions
 * cannot reach (Tailscale, a private network) pulls GitHub's Deployments API
 * instead. See docs/design/github-deployments-pull.md.
 */

/** Public OAuth App "Dokploy Community". Public by design; there is no secret. */
export const GITHUB_DEVICE_DEFAULT_CLIENT_ID = "Ov23liBkg97sIGx9nKb6";

/** Scopes asked for in the device flow. Narrow on purpose. */
export const GITHUB_DEVICE_SCOPE = "repo_deployment read:packages";

export const GITHUB_WATCH_SERVICE_TYPES = ["application", "compose"] as const;
export type GithubWatchServiceType =
	(typeof GITHUB_WATCH_SERVICE_TYPES)[number];

export const GITHUB_CONNECTION_STATUSES = ["active", "revoked"] as const;
export type GithubConnectionStatus =
	(typeof GITHUB_CONNECTION_STATUSES)[number];

/**
 * One GitHub account an organization connected through the device flow.
 *
 * `accessToken` is encrypted at rest (AES-256-GCM, like other provider
 * secrets). No API or MCP output ever carries it: every read path selects the
 * columns below `accessToken`, see `presentGithubConnection`.
 */
export const githubDeploymentConnection = pgTable(
	"github_deployment_connection",
	{
		connectionId: text("connectionId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** Dokploy user who ran the flow (informational, no foreign key). */
		createdByUserId: text("createdByUserId"),
		githubLogin: text("githubLogin").notNull(),
		githubUserId: text("githubUserId").notNull(),
		/** Comma separated scopes GitHub granted, from `X-OAuth-Scopes`. */
		scopes: text("scopes").notNull().default(""),
		accessToken: encryptedText("accessToken").notNull(),
		/** "revoked" once GitHub answered 401: the poller stops using the token. */
		status: text("status").notNull().default("active"),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => [
		unique("github_deployment_connection_org_user_unique").on(
			table.organizationId,
			table.githubUserId,
		),
	],
);

/**
 * One service (application or compose) that follows a repository's GitHub
 * Deployments. Kept out of the `application` table, which sits at the Drizzle /
 * Postgres 100-argument cap (error 54023).
 */
export const githubDeploymentWatch = pgTable(
	"github_deployment_watch",
	{
		watchId: text("watchId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		serviceType: text("serviceType").$type<GithubWatchServiceType>().notNull(),
		/** applicationId or composeId; polymorphic, so no foreign key. */
		serviceId: text("serviceId").notNull(),
		connectionId: text("connectionId")
			.notNull()
			.references(() => githubDeploymentConnection.connectionId, {
				onDelete: "cascade",
			}),
		owner: text("owner").notNull(),
		repo: text("repo").notNull(),
		environment: text("environment").notNull().default("production"),
		enabled: boolean("enabled").notNull().default(true),
		/**
		 * Opt in to sending the Dokploy dashboard link to GitHub as the status
		 * `log_url`. Off by default: the link is internal and every status is
		 * readable by whoever can see the repository.
		 */
		postLogUrl: boolean("postLogUrl").notNull().default(false),
		/** Highest GitHub deployment id handled. Null until the first poll baselines it. */
		lastSeenDeploymentId: bigint("lastSeenDeploymentId", { mode: "number" }),
		/** ETag of the last list response that was fully handled. */
		etag: text("etag"),
		/** The GitHub deployment being deployed now; its end is reported to GitHub. */
		inflightDeploymentId: bigint("inflightDeploymentId", { mode: "number" }),
		inflightStartedAt: timestamp("inflightStartedAt"),
		lastCheckedAt: timestamp("lastCheckedAt"),
		lastError: text("lastError"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => [
		unique("github_deployment_watch_service_unique").on(
			table.serviceType,
			table.serviceId,
		),
	],
);

export const githubDeploymentConnectionRelations = relations(
	githubDeploymentConnection,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [githubDeploymentConnection.organizationId],
			references: [organization.id],
		}),
		watches: many(githubDeploymentWatch),
	}),
);

export const githubDeploymentWatchRelations = relations(
	githubDeploymentWatch,
	({ one }) => ({
		connection: one(githubDeploymentConnection, {
			fields: [githubDeploymentWatch.connectionId],
			references: [githubDeploymentConnection.connectionId],
		}),
	}),
);

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** "." and ".." match GITHUB_NAME, and encodeURIComponent leaves dots alone: /repos/../x would walk out of /repos. */
const isDotSegment = (name: string) => /^\.{1,2}$/.test(name);

export const apiGithubOwnerRepo = z.object({
	owner: z
		.string()
		.trim()
		.regex(GITHUB_NAME, "Not a valid GitHub owner")
		.refine((name) => !isDotSegment(name), "Not a valid GitHub owner")
		.describe("GitHub user or organization that owns the repository."),
	repo: z
		.string()
		.trim()
		.regex(GITHUB_NAME, "Not a valid GitHub repository name")
		.refine((name) => !isDotSegment(name), "Not a valid GitHub repository name")
		.describe("GitHub repository name, without the owner."),
});

export const apiGithubDeploymentEnvironment = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.describe(
		'GitHub Deployments environment name to follow (default "production").',
	);

export const apiGithubDeploymentCompleteConnect = z.object({
	flowId: z
		.string()
		.min(1)
		.describe("The flowId returned by githubDeployment-startConnect."),
});

export const apiGithubDeploymentDisconnect = z.object({
	connectionId: z.string().min(1).describe("The connection to remove."),
});

export const apiGithubDeploymentWatchOne = z.object({
	serviceType: z.enum(GITHUB_WATCH_SERVICE_TYPES),
	serviceId: z.string().min(1).describe("applicationId or composeId."),
});

export const apiGithubDeploymentWatchSet = z.object({
	serviceType: z.enum(GITHUB_WATCH_SERVICE_TYPES),
	serviceId: z.string().min(1).describe("applicationId or composeId."),
	connectionId: z
		.string()
		.min(1)
		.describe("GitHub connection (from githubDeployment-connections) to use."),
	owner: apiGithubOwnerRepo.shape.owner,
	repo: apiGithubOwnerRepo.shape.repo,
	environment: apiGithubDeploymentEnvironment.default("production"),
	enabled: z.boolean().default(true),
	postLogUrl: z
		.boolean()
		.default(false)
		.describe(
			"Send the Dokploy dashboard link to GitHub as the deployment status log_url. Off by default: the link is internal.",
		),
});
