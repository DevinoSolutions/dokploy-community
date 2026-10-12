import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	deployments,
	previewDeployments,
	type SnapvisorBuildCheck,
	snapvisorBuildCheck,
} from "@dokploy/server/db/schema";
import { sendSnapvisorChangesNotifications } from "@dokploy/server/utils/notifications/snapvisor-changes";
import { backgroundJob } from "@dokploy/server/utils/process/background";
import {
	isSnapvisorOrganizationWideFailure,
	isTerminalSnapvisorStatus,
	pickLatestSnapvisorBuild,
	SNAPVISOR_BUILD_LOOKUP_PAGE_SIZE,
	SNAPVISOR_CHANGES_STATUS,
} from "@dokploy/server/utils/snapvisor/build-lookup";
import {
	type SnapvisorBuild,
	SnapvisorError,
} from "@dokploy/server/utils/snapvisor/client";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	like,
	lt,
	lte,
} from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { IS_CLOUD } from "../constants";
import {
	commitShaFromDescription,
	findSnapvisorByOrganizationId,
	isGitSourceType,
	type SnapvisorIntegration,
	snapvisorBuildReviewUrl,
	snapvisorClientFor,
} from "./snapvisor";

/**
 * Server-side watch for Snapvisor builds that need a visual review.
 *
 * Snapvisor webhooks cannot reach a panel on a private network, so this polls
 * outbound. A deployed commit of a Snapvisor-linked service becomes a
 * `snapvisor_build_check` row (discovered from the `Commit: <sha>` marker
 * every git deploy writes on its deployment, so regular, branch and preview
 * deploys are all covered and nothing in the deploy path changes). A
 * scheduled job then asks Snapvisor for the build of that commit until it
 * reaches a state that needs no further watching, or the watch window runs
 * out. A build that lands in `changes-detected` sends one notification.
 *
 * The notification is claimed (`pending` -> `notified`) with a conditional
 * update before it is sent, so it is sent at most once per commit of a
 * service across overlapping runs and restarts. A crash between the claim
 * and the send loses that one notification rather than repeating it.
 */

/** How long after a deploy a build is still watched for. */
export const SNAPVISOR_WATCH_WINDOW_MS = 6 * 60 * 60_000;
/** The scheduler tick; a check is only due once its own `nextCheckAt` passes. */
export const SNAPVISOR_CHECK_CRON = "*/3 * * * *";
/** Rows are kept this long after creation, as the record of what was notified. */
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_CHECKS_PER_CYCLE = 50;
const POLL_BASE_MS = 3 * 60_000;
const POLL_MAX_MS = 15 * 60_000;
const ERROR_BASE_MS = 5 * 60_000;
const ERROR_MAX_MS = 60 * 60_000;

/** Delay before asking again about a build that is missing or still running. */
export const snapvisorPollDelayMs = (attempts: number) =>
	Math.round(
		Math.min(POLL_BASE_MS * 1.4 ** Math.max(0, attempts), POLL_MAX_MS),
	);

/**
 * Delay after a failed call: exponential in the number of failures in a row,
 * and never shorter than the `Retry-After` Snapvisor asked for on a 429.
 */
export const snapvisorErrorDelayMs = (
	errorStreak: number,
	retryAfterSeconds?: number,
) => {
	const backoff = Math.min(
		ERROR_BASE_MS * 2 ** Math.max(0, errorStreak - 1),
		ERROR_MAX_MS,
	);
	const asked = Math.min((retryAfterSeconds ?? 0) * 1000, ERROR_MAX_MS);
	return Math.max(backoff, asked);
};

export interface SnapvisorCheckContext {
	snapvisorProjectName: string;
	serviceName: string;
	projectName: string;
	environmentName: string;
	integration: SnapvisorIntegration;
}

export interface SnapvisorChangesPayload {
	organizationId: string;
	projectName: string;
	serviceName: string;
	serviceType: string;
	environmentName: string;
	branch: string;
	commitSha: string;
	snapvisorProjectName: string;
	changedSnapshots: number | null;
	addedSnapshots: number | null;
	removedSnapshots: number | null;
	reviewUrl: string;
}

export type SnapvisorCheckPatch = Partial<
	Pick<
		SnapvisorBuildCheck,
		| "state"
		| "attempts"
		| "errorStreak"
		| "buildNumber"
		| "buildStatus"
		| "nextCheckAt"
	>
>;

/** The persisted half of the watch, so the logic can be tested without a database. */
export interface SnapvisorCheckStore {
	/** Records the not-yet-watched deployed commits; returns how many are new. */
	discover(now: Date): Promise<number>;
	expireOverdue(now: Date): Promise<number>;
	listDue(now: Date, limit: number): Promise<SnapvisorBuildCheck[]>;
	update(checkId: string, patch: SnapvisorCheckPatch): Promise<void>;
	/** Pushes every pending check of the organization that is due before `until` back to it. */
	deferOrganization(organizationId: string, until: Date): Promise<void>;
	/** `true` for exactly one caller per check: the one that may send. */
	claimNotification(checkId: string, now: Date): Promise<boolean>;
	prune(before: Date): Promise<void>;
}

export interface SnapvisorCheckDeps extends SnapvisorCheckStore {
	now(): Date;
	/** `null`: the service, its link or the integration is gone. */
	loadContext(
		check: SnapvisorBuildCheck,
	): Promise<SnapvisorCheckContext | null>;
	findBuild(
		context: SnapvisorCheckContext,
		commitSha: string,
	): Promise<SnapvisorBuild | null>;
	notify(payload: SnapvisorChangesPayload): Promise<void>;
}

export interface SnapvisorCheckCycleSummary {
	discovered: number;
	expired: number;
	checked: number;
	notified: number;
	settled: number;
	failed: number;
}

/** Why a Snapvisor call failed, for the log: never the message or the URL. */
const describeFailure = (error: unknown) =>
	error instanceof SnapvisorError && error.status
		? `HTTP ${error.status}`
		: "unreachable";

export const runSnapvisorCheckCycle = async (
	deps: SnapvisorCheckDeps,
): Promise<SnapvisorCheckCycleSummary> => {
	const summary: SnapvisorCheckCycleSummary = {
		discovered: 0,
		expired: 0,
		checked: 0,
		notified: 0,
		settled: 0,
		failed: 0,
	};
	const startedAt = deps.now();
	summary.discovered = await deps.discover(startedAt);
	summary.expired = await deps.expireOverdue(startedAt);
	await deps.prune(new Date(startedAt.getTime() - RETENTION_MS));

	const due = await deps.listDue(startedAt, MAX_CHECKS_PER_CYCLE);
	// An organization whose Snapvisor access just failed (token, rate limit,
	// outage) is left alone for the rest of the cycle: its other checks were
	// pushed back with it. A failure of one project or build only defers that
	// check, so a renamed project cannot hold back its healthy neighbours.
	const failedOrganizations = new Set<string>();

	for (const check of due) {
		if (failedOrganizations.has(check.organizationId)) continue;
		const now = deps.now();

		const context = await deps.loadContext(check);
		if (!context) {
			await deps.update(check.checkId, { state: "settled" });
			summary.settled++;
			continue;
		}

		summary.checked++;
		let build: SnapvisorBuild | null;
		try {
			build = await deps.findBuild(context, check.commitSha);
		} catch (error) {
			summary.failed++;
			const organizationWide = isSnapvisorOrganizationWideFailure(error);
			if (organizationWide) failedOrganizations.add(check.organizationId);
			const errorStreak = check.errorStreak + 1;
			const until = new Date(
				now.getTime() +
					snapvisorErrorDelayMs(
						errorStreak,
						error instanceof SnapvisorError
							? error.retryAfterSeconds
							: undefined,
					),
			);
			await deps.update(check.checkId, {
				attempts: check.attempts + 1,
				errorStreak,
				nextCheckAt: until,
			});
			if (organizationWide) {
				await deps.deferOrganization(check.organizationId, until);
			}
			console.error(
				`[snapvisor] build check deferred: ${describeFailure(error)}`,
			);
			continue;
		}

		if (!build) {
			await deps.update(check.checkId, {
				attempts: check.attempts + 1,
				errorStreak: 0,
				nextCheckAt: new Date(
					now.getTime() + snapvisorPollDelayMs(check.attempts + 1),
				),
			});
			continue;
		}

		const seen = { buildNumber: build.number, buildStatus: build.status };

		if (build.status === SNAPVISOR_CHANGES_STATUS) {
			if (await deps.claimNotification(check.checkId, now)) {
				await deps.update(check.checkId, {
					...seen,
					attempts: check.attempts + 1,
					errorStreak: 0,
				});
				try {
					await deps.notify({
						organizationId: check.organizationId,
						projectName: context.projectName,
						serviceName: context.serviceName,
						serviceType: check.serviceType,
						environmentName: context.environmentName,
						branch: build.head.branch,
						commitSha: check.commitSha,
						snapvisorProjectName: context.snapvisorProjectName,
						changedSnapshots: build.stats?.changed ?? null,
						addedSnapshots: build.stats?.added ?? null,
						removedSnapshots: build.stats?.removed ?? null,
						reviewUrl: snapvisorBuildReviewUrl(
							context.integration,
							context.snapvisorProjectName,
							build.number,
						),
					});
				} catch {
					// The senders log their own failures without secrets; the claim
					// stands, so a failing channel cannot cause a repeat.
				}
				summary.notified++;
			}
			continue;
		}

		if (isTerminalSnapvisorStatus(build.status)) {
			await deps.update(check.checkId, {
				...seen,
				state: "settled",
				attempts: check.attempts + 1,
				errorStreak: 0,
			});
			summary.settled++;
			continue;
		}

		await deps.update(check.checkId, {
			...seen,
			attempts: check.attempts + 1,
			errorStreak: 0,
			nextCheckAt: new Date(
				now.getTime() + snapvisorPollDelayMs(check.attempts + 1),
			),
		});
	}

	return summary;
};

// ---------------------------------------------------------------------------
// Database-backed implementation
// ---------------------------------------------------------------------------

export const createSnapvisorCheckStore = (): SnapvisorCheckStore => ({
	async discover(now) {
		// Most panels have no Snapvisor integration: skip the deployments scan.
		const connected = await db.query.snapvisorIntegration.findMany({
			columns: { organizationId: true },
		});
		if (connected.length === 0) return 0;
		const connectedOrganizations = new Set(
			connected.map((row) => row.organizationId),
		);

		const since = new Date(now.getTime() - SNAPVISOR_WATCH_WINDOW_MS);
		const rows = await db.query.deployments.findMany({
			where: and(
				eq(deployments.status, "done"),
				gte(deployments.createdAt, since.toISOString()),
				like(deployments.description, "Commit: %"),
			),
			columns: {
				deploymentId: true,
				applicationId: true,
				composeId: true,
				previewDeploymentId: true,
				description: true,
				createdAt: true,
				finishedAt: true,
			},
			orderBy: desc(deployments.createdAt),
			limit: 500,
		});

		const deployed = rows.flatMap((row) => {
			const commitSha = commitShaFromDescription(row.description);
			return commitSha ? [{ ...row, commitSha }] : [];
		});
		if (deployed.length === 0) return 0;

		// A preview deployment row only knows its preview; the service is one hop
		// away.
		const previewIds = [
			...new Set(deployed.flatMap((row) => row.previewDeploymentId ?? [])),
		];
		const previews = previewIds.length
			? await db.query.previewDeployments.findMany({
					where: inArray(previewDeployments.previewDeploymentId, previewIds),
					columns: {
						previewDeploymentId: true,
						applicationId: true,
						composeId: true,
					},
				})
			: [];
		const previewById = new Map(
			previews.map((preview) => [preview.previewDeploymentId, preview]),
		);

		const wanted = deployed.flatMap((row) => {
			const preview = row.previewDeploymentId
				? previewById.get(row.previewDeploymentId)
				: undefined;
			const applicationId = row.applicationId ?? preview?.applicationId ?? null;
			const composeId = row.composeId ?? preview?.composeId ?? null;
			const serviceId = applicationId ?? composeId;
			if (!serviceId) return [];
			return [
				{
					...row,
					serviceId,
					serviceType: applicationId ? "application" : "compose",
				},
			];
		});

		const applicationIds = [
			...new Set(
				wanted
					.filter((w) => w.serviceType === "application")
					.map((w) => w.serviceId),
			),
		];
		const composeIds = [
			...new Set(
				wanted
					.filter((w) => w.serviceType === "compose")
					.map((w) => w.serviceId),
			),
		];
		// Narrow column lists: the application table is too wide to eager-load whole.
		const [linkedApplications, linkedComposes] = await Promise.all([
			applicationIds.length
				? db.query.applications.findMany({
						where: inArray(applications.applicationId, applicationIds),
						columns: {
							applicationId: true,
							snapvisorProjectName: true,
							sourceType: true,
						},
						with: {
							environment: {
								columns: { environmentId: true },
								with: { project: { columns: { organizationId: true } } },
							},
						},
					})
				: [],
			composeIds.length
				? db.query.compose.findMany({
						where: inArray(compose.composeId, composeIds),
						columns: {
							composeId: true,
							snapvisorProjectName: true,
							sourceType: true,
						},
						with: {
							environment: {
								columns: { environmentId: true },
								with: { project: { columns: { organizationId: true } } },
							},
						},
					})
				: [],
		]);
		const organizationByService = new Map<string, string>();
		// Only a git deploy writes the `Commit:` marker itself; on a Docker,
		// upload or raw service the description is free text, so it is not trusted.
		for (const row of linkedApplications) {
			if (row.snapvisorProjectName && isGitSourceType(row.sourceType)) {
				organizationByService.set(
					row.applicationId,
					row.environment.project.organizationId,
				);
			}
		}
		for (const row of linkedComposes) {
			if (row.snapvisorProjectName && isGitSourceType(row.sourceType)) {
				organizationByService.set(
					row.composeId,
					row.environment.project.organizationId,
				);
			}
		}
		if (organizationByService.size === 0) return 0;

		const values = new Map<string, typeof snapvisorBuildCheck.$inferInsert>();
		for (const row of wanted) {
			const organizationId = organizationByService.get(row.serviceId);
			if (!organizationId || !connectedOrganizations.has(organizationId)) {
				continue;
			}
			const deployedAt = new Date(row.finishedAt ?? row.createdAt);
			const expiresAt = new Date(
				deployedAt.getTime() + SNAPVISOR_WATCH_WINDOW_MS,
			);
			if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) continue;
			const key = `${row.serviceId}:${row.commitSha}`;
			// Newest first: the first row seen for a commit is its latest deploy.
			if (values.has(key)) continue;
			values.set(key, {
				organizationId,
				serviceType: row.serviceType,
				serviceId: row.serviceId,
				deploymentId: row.deploymentId,
				commitSha: row.commitSha,
				nextCheckAt: now,
				expiresAt,
			});
		}
		if (values.size === 0) return 0;

		const inserted = await db
			.insert(snapvisorBuildCheck)
			.values([...values.values()])
			.onConflictDoNothing()
			.returning({ checkId: snapvisorBuildCheck.checkId });
		return inserted.length;
	},

	async expireOverdue(now) {
		const expired = await db
			.update(snapvisorBuildCheck)
			.set({ state: "expired" })
			.where(
				and(
					eq(snapvisorBuildCheck.state, "pending"),
					lte(snapvisorBuildCheck.expiresAt, now),
				),
			)
			.returning({ checkId: snapvisorBuildCheck.checkId });
		return expired.length;
	},

	async listDue(now, limit) {
		return db.query.snapvisorBuildCheck.findMany({
			where: and(
				eq(snapvisorBuildCheck.state, "pending"),
				lte(snapvisorBuildCheck.nextCheckAt, now),
				gt(snapvisorBuildCheck.expiresAt, now),
			),
			orderBy: asc(snapvisorBuildCheck.nextCheckAt),
			limit,
		});
	},

	async update(checkId, patch) {
		await db
			.update(snapvisorBuildCheck)
			.set(patch)
			.where(eq(snapvisorBuildCheck.checkId, checkId));
	},

	async deferOrganization(organizationId, until) {
		await db
			.update(snapvisorBuildCheck)
			.set({ nextCheckAt: until })
			.where(
				and(
					eq(snapvisorBuildCheck.organizationId, organizationId),
					eq(snapvisorBuildCheck.state, "pending"),
					lt(snapvisorBuildCheck.nextCheckAt, until),
				),
			);
	},

	async claimNotification(checkId, now) {
		const claimed = await db
			.update(snapvisorBuildCheck)
			.set({ state: "notified", notifiedAt: now })
			.where(
				and(
					eq(snapvisorBuildCheck.checkId, checkId),
					eq(snapvisorBuildCheck.state, "pending"),
				),
			)
			.returning({ checkId: snapvisorBuildCheck.checkId });
		return claimed.length > 0;
	},

	async prune(before) {
		await db
			.delete(snapvisorBuildCheck)
			.where(lt(snapvisorBuildCheck.createdAt, before));
	},
});

const createDatabaseDeps = (): SnapvisorCheckDeps => {
	// Integrations are looked up once per cycle per organization.
	const integrations = new Map<string, Promise<SnapvisorIntegration | null>>();
	const integrationFor = (organizationId: string) => {
		let found = integrations.get(organizationId);
		if (!found) {
			found = findSnapvisorByOrganizationId(organizationId);
			integrations.set(organizationId, found);
		}
		return found;
	};

	return {
		...createSnapvisorCheckStore(),
		now: () => new Date(),

		async loadContext(check) {
			const integration = await integrationFor(check.organizationId);
			if (!integration) return null;

			if (check.serviceType === "application") {
				const row = await db.query.applications.findFirst({
					where: eq(applications.applicationId, check.serviceId),
					columns: { name: true, snapvisorProjectName: true },
					with: {
						environment: {
							columns: { name: true },
							with: {
								project: { columns: { name: true, organizationId: true } },
							},
						},
					},
				});
				if (
					!row?.snapvisorProjectName ||
					row.environment.project.organizationId !== check.organizationId
				) {
					return null;
				}
				return {
					snapvisorProjectName: row.snapvisorProjectName,
					serviceName: row.name,
					projectName: row.environment.project.name,
					environmentName: row.environment.name,
					integration,
				};
			}

			const row = await db.query.compose.findFirst({
				where: eq(compose.composeId, check.serviceId),
				columns: { name: true, snapvisorProjectName: true },
				with: {
					environment: {
						columns: { name: true },
						with: {
							project: { columns: { name: true, organizationId: true } },
						},
					},
				},
			});
			if (
				!row?.snapvisorProjectName ||
				row.environment.project.organizationId !== check.organizationId
			) {
				return null;
			}
			return {
				snapvisorProjectName: row.snapvisorProjectName,
				serviceName: row.name,
				projectName: row.environment.project.name,
				environmentName: row.environment.name,
				integration,
			};
		},

		async findBuild(context, commitSha) {
			// Snapvisor lists builds "most recent first" (listBuilds API docs), but
			// the newest is picked by build number so the order is not load-bearing.
			const builds = await snapvisorClientFor(context.integration).listBuilds({
				accountSlug: context.integration.accountSlug,
				projectName: context.snapvisorProjectName,
				headSha: commitSha,
				perPage: SNAPVISOR_BUILD_LOOKUP_PAGE_SIZE,
			});
			return pickLatestSnapvisorBuild(builds);
		},

		notify: (payload) => sendSnapvisorChangesNotifications(payload),
	};
};

let cycleRunning = false;

/**
 * One scheduled run. Never rejects, and a run that is still going when the
 * next tick fires makes that tick a no-op.
 */
export const runSnapvisorBuildChecks = async (
	deps: SnapvisorCheckDeps = createDatabaseDeps(),
) => {
	if (cycleRunning) return null;
	cycleRunning = true;
	try {
		const summary = await runSnapvisorCheckCycle(deps);
		if (summary.notified > 0 || summary.discovered > 0 || summary.failed > 0) {
			console.log(
				`[snapvisor] build checks: ${summary.discovered} new, ${summary.checked} checked, ${summary.notified} notified, ${summary.settled} settled, ${summary.expired} expired, ${summary.failed} failed`,
			);
		}
		return summary;
	} finally {
		cycleRunning = false;
	}
};

/** Registers the poller. Snapvisor is a self-hosted-only integration. */
export const initSnapvisorBuildChecks = () => {
	if (IS_CLOUD) return;
	scheduleJob(
		"snapvisor-build-checks",
		SNAPVISOR_CHECK_CRON,
		backgroundJob("[Snapvisor] Build checks", () => runSnapvisorBuildChecks()),
	);
};
