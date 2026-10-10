import { db } from "@dokploy/server/db";
import {
	type apiCreateSnapvisor,
	type apiUpdateSnapvisor,
	applications,
	compose,
	deployments,
	snapvisorIntegration,
} from "@dokploy/server/db/schema";
import { getGitCommitInfo } from "@dokploy/server/utils/providers/git";
import {
	createSnapvisorClient,
	type SnapvisorBuild,
	type SnapvisorClient,
} from "@dokploy/server/utils/snapvisor/client";
import {
	isSameSnapvisorBaseUrl,
	SNAPVISOR_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
	snapvisorWebBaseUrl,
} from "@dokploy/server/utils/snapvisor/urls";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { findApplicationById } from "./application";
import { updateDeployment } from "./deployment";
import {
	findPreviewDeploymentById,
	type PreviewDeployment,
	updatePreviewDeployment,
} from "./preview-deployment";

// Re-exported so the router reaches them through the `@dokploy/server` barrel.
export {
	isSameSnapvisorBaseUrl,
	SNAPVISOR_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
} from "@dokploy/server/utils/snapvisor/urls";

export type SnapvisorIntegration = typeof snapvisorIntegration.$inferSelect;

export const snapvisorClientFor = (
	integration: Pick<SnapvisorIntegration, "accessToken" | "baseUrl">,
): SnapvisorClient =>
	createSnapvisorClient({
		accessToken: integration.accessToken,
		baseUrl: integration.baseUrl,
	});

/** Masks a stored access token down to its last four characters. */
export const maskSnapvisorAccessToken = (accessToken: string) =>
	accessToken.length > 4 ? `••••${accessToken.slice(-4)}` : "••••";

/**
 * Deep link to a build review in the Snapvisor dashboard. Path shape
 * `/{owner}/{project}/builds/{buildNumber}`, confirmed against the Snapvisor
 * frontend routes (`apps/frontend/src/pages/Build/BuildParams.ts`,
 * `apps/frontend/src/pages/Project/Builds.tsx`).
 */
export const snapvisorBuildReviewUrl = (
	integration: Pick<SnapvisorIntegration, "baseUrl" | "accountSlug">,
	projectName: string,
	buildNumber: number | string,
) =>
	`${snapvisorWebBaseUrl(integration.baseUrl)}/${encodeURIComponent(
		integration.accountSlug,
	)}/${encodeURIComponent(projectName)}/builds/${buildNumber}`;

// ---------------------------------------------------------------------------
// Integration CRUD (one row per organization)
// ---------------------------------------------------------------------------

export const findSnapvisorByOrganizationId = async (organizationId: string) => {
	const result = await db.query.snapvisorIntegration.findFirst({
		where: eq(snapvisorIntegration.organizationId, organizationId),
	});
	return result ?? null;
};

export const createSnapvisor = async (
	input: z.infer<typeof apiCreateSnapvisor>,
	organizationId: string,
) => {
	const existing = await findSnapvisorByOrganizationId(organizationId);
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"This organization already has a Snapvisor integration. Edit it instead.",
		});
	}
	const created = await db
		.insert(snapvisorIntegration)
		.values({
			name: input.name,
			accessToken: input.accessToken,
			accountSlug: input.accountSlug,
			baseUrl: input.baseUrl,
			organizationId,
		})
		.returning()
		.then((rows) => rows[0]);
	if (!created) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the Snapvisor integration",
		});
	}
	return created;
};

export const updateSnapvisor = async (
	organizationId: string,
	input: z.infer<typeof apiUpdateSnapvisor>,
) => {
	// The stored token must not be sent to a URL the caller just chose.
	if (input.baseUrl !== undefined && !input.accessToken) {
		const stored = await findSnapvisorByOrganizationId(organizationId);
		if (stored && !isSameSnapvisorBaseUrl(input.baseUrl, stored.baseUrl)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: SNAPVISOR_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
			});
		}
	}
	const values: Partial<SnapvisorIntegration> = {};
	if (input.name !== undefined) values.name = input.name;
	if (input.accessToken !== undefined) values.accessToken = input.accessToken;
	if (input.accountSlug !== undefined) values.accountSlug = input.accountSlug;
	if (input.baseUrl !== undefined) values.baseUrl = input.baseUrl;
	const updated = await db
		.update(snapvisorIntegration)
		.set(values)
		.where(eq(snapvisorIntegration.organizationId, organizationId))
		.returning()
		.then((rows) => rows[0]);
	if (!updated) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Snapvisor integration not found",
		});
	}
	return updated;
};

export const removeSnapvisor = async (organizationId: string) => {
	const removed = await db
		.delete(snapvisorIntegration)
		.where(eq(snapvisorIntegration.organizationId, organizationId))
		.returning()
		.then((rows) => rows[0]);
	return removed ?? null;
};

// ---------------------------------------------------------------------------
// Connection test + project picker
// ---------------------------------------------------------------------------

export const testSnapvisorConnection = async (params: {
	accessToken: string;
	baseUrl: string;
}) => {
	const client = snapvisorClientFor(params);
	const me = await client.getMe();
	return { accounts: me.accounts };
};

export const listSnapvisorProjects = async (
	integration: SnapvisorIntegration,
) => snapvisorClientFor(integration).listProjects(integration.accountSlug);

// ---------------------------------------------------------------------------
// Per-service project link (applications and compose services)
// ---------------------------------------------------------------------------

/**
 * What Snapvisor needs to know about the service a preview belongs to,
 * whatever its type: which Snapvisor project it posts to and which
 * organization (and so which integration) owns it.
 */
export interface SnapvisorServiceTarget {
	serviceId: string;
	name: string;
	snapvisorProjectName: string | null;
	organizationId: string;
}

export const findApplicationSnapvisorTarget = async (
	applicationId: string,
): Promise<SnapvisorServiceTarget> => {
	const application = await findApplicationById(applicationId);
	return {
		serviceId: application.applicationId,
		name: application.name,
		snapvisorProjectName: application.snapvisorProjectName,
		organizationId: application.environment.project.organizationId,
	};
};

/**
 * Deliberately narrow: loading a full compose (findComposeById) drags in every
 * relation just to read a project name and an organization.
 */
export const findComposeSnapvisorTarget = async (
	composeId: string,
): Promise<SnapvisorServiceTarget> => {
	const row = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		columns: { composeId: true, name: true, snapvisorProjectName: true },
		with: {
			environment: {
				columns: { environmentId: true },
				with: { project: { columns: { organizationId: true } } },
			},
		},
	});
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Compose not found" });
	}
	return {
		serviceId: row.composeId,
		name: row.name,
		snapvisorProjectName: row.snapvisorProjectName,
		organizationId: row.environment.project.organizationId,
	};
};

/** The service a preview deployment belongs to, or `null` for an orphan row. */
export const findPreviewSnapvisorTarget = async (
	previewDeployment: Pick<PreviewDeployment, "applicationId" | "composeId">,
) => {
	if (previewDeployment.applicationId) {
		return findApplicationSnapvisorTarget(previewDeployment.applicationId);
	}
	if (previewDeployment.composeId) {
		return findComposeSnapvisorTarget(previewDeployment.composeId);
	}
	return null;
};

export const setApplicationSnapvisorProject = async (
	applicationId: string,
	projectName: string | null,
) => {
	const updated = await db
		.update(applications)
		.set({ snapvisorProjectName: projectName })
		.where(eq(applications.applicationId, applicationId))
		.returning()
		.then((rows) => rows[0]);
	if (!updated) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
	}
	return updated;
};

export const setComposeSnapvisorProject = async (
	composeId: string,
	projectName: string | null,
) => {
	const updated = await db
		.update(compose)
		.set({ snapvisorProjectName: projectName })
		.where(eq(compose.composeId, composeId))
		.returning()
		.then((rows) => rows[0]);
	if (!updated) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Compose not found" });
	}
	return updated;
};

// ---------------------------------------------------------------------------
// Preview-deployment build linkage
// ---------------------------------------------------------------------------

/**
 * The commit sha of the code a preview deployment last built, read back from
 * the `Commit: <sha>` marker `finalizePreviewBuildMetadata` writes onto the
 * deployment row's `description` on success (the same convention
 * `deployApplication`/`deployCompose` use for regular deploys). Application and
 * compose previews share the marker.
 */
export const findLatestPreviewCommitSha = async (previewDeploymentId: string) => {
	const deployment = await db.query.deployments.findFirst({
		where: eq(deployments.previewDeploymentId, previewDeploymentId),
		orderBy: desc(deployments.createdAt),
	});
	// Snapvisor's `headSha` filter matches on the full SHA1, so a short/abbreviated
	// hash would silently return zero builds; require all 40 hex characters.
	const match = deployment?.description?.match(/Commit:\s*([0-9a-f]{40})/i);
	return match?.[1] ?? null;
};

export interface SnapvisorPreviewLinkResult {
	registered: boolean;
	reason?: string;
	build?: SnapvisorBuild;
}

/**
 * Looks up the Snapvisor build that already exists for a preview
 * deployment's latest commit and stores the linkage. Snapvisor's own
 * "Deployment" API (`createDeployment`/`finalizeDeployment` in
 * `apps/backend/src/api/handlers/{createDeployment,finalizeDeployment}.ts`)
 * is a static-hosting feature: it requires uploading every file with its
 * content hash and a *project* token, and returns a Snapvisor-hosted URL —
 * it has no field for an externally-hosted preview URL, so it cannot be used
 * to "register" a Dokploy preview. The only resource that actually carries
 * visual-diff state for a commit is a Build
 * (`apps/backend/src/api/handlers/listBuilds.ts`, filterable by `headSha`),
 * created by the user's own CI via the Snapvisor CLI. This function is
 * therefore the same lookup used by `refreshPreviewBuild`; the "register"
 * step is finding (not creating) the build for the commit Dokploy just
 * deployed.
 */
export const registerPreviewDeployment = async (params: {
	previewDeploymentId: string;
}): Promise<SnapvisorPreviewLinkResult> => {
	const previewDeployment = await findPreviewDeploymentById(
		params.previewDeploymentId,
	);
	const target = await findPreviewSnapvisorTarget(previewDeployment);
	if (!target) {
		return { registered: false, reason: "Not a service preview" };
	}
	if (!target.snapvisorProjectName) {
		return { registered: false, reason: "Visual testing is off" };
	}
	const integration = await findSnapvisorByOrganizationId(
		target.organizationId,
	);
	if (!integration) {
		return { registered: false, reason: "Snapvisor is not connected" };
	}
	const commitSha = await findLatestPreviewCommitSha(params.previewDeploymentId);
	if (!commitSha) {
		return { registered: false, reason: "No commit sha recorded yet" };
	}

	const client = snapvisorClientFor(integration);
	const builds = await client.listBuilds({
		accountSlug: integration.accountSlug,
		projectName: target.snapvisorProjectName,
		headSha: commitSha,
		perPage: 1,
	});
	const build = builds[0];
	if (!build) {
		return { registered: false, reason: "No Snapvisor build for this commit yet" };
	}

	await updatePreviewDeployment(params.previewDeploymentId, {
		snapvisorDeploymentId: build.id,
		snapvisorBuildId: String(build.number),
		snapvisorBuildStatus: build.status,
	});

	return { registered: true, build };
};

/**
 * Re-runs the Snapvisor build lookup for a preview deployment and refreshes
 * the stored status. Used by the manual refresh action on the preview card,
 * and functionally identical to `registerPreviewDeployment` (see its
 * docstring for why there is nothing to "create" on Snapvisor).
 */
export const refreshPreviewBuild = async (params: {
	previewDeploymentId: string;
}): Promise<SnapvisorPreviewLinkResult> => registerPreviewDeployment(params);

/**
 * After a preview build succeeds: records the commit it built using the same
 * `Commit: <sha>` marker the regular deploys write (read back by
 * `findLatestPreviewCommitSha`), then best-effort links the Snapvisor build for
 * that commit. Shared by application and compose previews, which keep their
 * checkout under different base paths (`type`). Neither step may fail the
 * deploy: commit extraction mirrors the existing non-preview convention
 * exactly, and the Snapvisor call is fire-and-forget with its own `.catch`.
 * `hasGitSource` is false for builds with no checkout to read a commit from
 * (Docker-image applications).
 */
export const finalizePreviewBuildMetadata = async ({
	type,
	hasGitSource,
	previewDeploymentId,
	appName,
	deploymentId,
	serverId,
}: {
	type: "application" | "compose";
	hasGitSource: boolean;
	previewDeploymentId: string;
	appName: string;
	deploymentId: string;
	serverId: string | null;
}) => {
	if (hasGitSource) {
		const commitInfo = await getGitCommitInfo({ appName, type, serverId });
		if (commitInfo) {
			await updateDeployment(deploymentId, {
				title: commitInfo.message,
				description: `Commit: ${commitInfo.hash}`,
			});
		}
	}

	registerPreviewDeployment({ previewDeploymentId }).catch((error) => {
		console.error("Error registering the Snapvisor preview deployment:", error);
	});
};
