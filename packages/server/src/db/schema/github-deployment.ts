import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	foreignKey,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import {
	apiGithubDeploymentEnvironment,
	apiGithubOwnerRepo,
	GITHUB_WATCH_SERVICE_TYPES,
	type GithubWatchServiceType,
} from "./github-deployment-shared";
import { encryptedText } from "./utils";

/**
 * "Deploy from GitHub Deployments" (T-12166): a Dokploy that GitHub Actions
 * cannot reach (Tailscale, a private network) pulls GitHub's Deployments API
 * instead. See docs/design/github-deployments-pull.md.
 */

/** Public OAuth App "Dokploy Community". Public by design; there is no secret. */
export const GITHUB_DEVICE_DEFAULT_CLIENT_ID = "Ov23liBkg97sIGx9nKb6";

/** Scopes asked for in the device flow. `public_repo` reads public repositories; `repo` is needed for private ones. */
export const GITHUB_DEVICE_SCOPE = "repo_deployment public_repo";
export const GITHUB_DEVICE_SCOPE_PRIVATE = "repo_deployment repo";
/** Opt-in: also pull the owner's private GHCR packages (what #577 asked for before T-13719). */
export const GITHUB_PACKAGES_SCOPE = "read:packages";

/** The scope string for a connect request: the default, the private-repository one, each with or without packages. */
export const githubDeviceScope = (options: {
	repositoryAccess?: "public" | "private";
	pullPrivatePackages?: boolean;
}) =>
	`${
		options.repositoryAccess === "private"
			? GITHUB_DEVICE_SCOPE_PRIVATE
			: GITHUB_DEVICE_SCOPE
	}${options.pullPrivatePackages ? ` ${GITHUB_PACKAGES_SCOPE}` : ""}`;

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
		/**
		 * Dokploy user who ran the flow: the connection's owner. A member may bind
		 * or remove only their own connection (an owner or admin any), unless it is
		 * shared with the organization (bind only). No foreign key.
		 */
		createdByUserId: text("createdByUserId"),
		/**
		 * The owner lets every member of the organization bind this connection to
		 * a service they can deploy (same meaning as git_provider's flag). Off by
		 * default: the token can pull the owner's private GHCR packages.
		 */
		sharedWithOrganization: boolean("sharedWithOrganization")
			.notNull()
			.default(false),
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
		connectionId: text("connectionId").notNull(),
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
		// Named by hand: the generated name is 81 characters and Postgres cuts
		// identifiers at 63.
		foreignKey({
			columns: [table.connectionId],
			foreignColumns: [githubDeploymentConnection.connectionId],
			name: "github_deployment_watch_connectionId_fk",
		}).onDelete("cascade"),
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

export {
	apiGithubDeploymentEnvironment,
	apiGithubOwnerRepo,
	GITHUB_WATCH_SERVICE_TYPES,
	type GithubWatchServiceType,
};

export const apiGithubDeploymentStartConnect = z.object({
	repositoryAccess: z
		.enum(["public", "private"])
		.default("public")
		.describe(
			"public asks GitHub for the public_repo scope (read AND write access to the account's public repositories, which classic OAuth cannot narrow), private for the repo scope that private repositories need (full control of the account's private repositories, including their code).",
		),
	pullPrivatePackages: z
		.boolean()
		.default(false)
		.describe(
			"Also ask for read:packages, so services that follow plain GitHub Deployments can pull the account's private GHCR packages. Off by default: a GitHub Actions connection never needs it.",
		),
});

export const apiGithubDeploymentCompleteConnect = z.object({
	flowId: z
		.string()
		.min(1)
		.describe("The flowId returned by githubDeployment-startConnect."),
});

export const apiGithubDeploymentDisconnect = z.object({
	connectionId: z.string().min(1).describe("The connection to remove."),
});

export const apiGithubDeploymentToggleShare = z.object({
	connectionId: z
		.string()
		.min(1)
		.describe("The connection to share or unshare."),
	sharedWithOrganization: z
		.boolean()
		.describe(
			"true lets every member of the organization bind this connection to a service they can deploy; false keeps it to its owner and the organization's owners and admins.",
		),
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
	override: z
		.boolean()
		.default(false)
		.describe(
			"Set the watch even though a GitHub Actions build of this service is live or was sent to Dokploy in the last 24 hours (two deployers on one service). Not stored.",
		),
});
