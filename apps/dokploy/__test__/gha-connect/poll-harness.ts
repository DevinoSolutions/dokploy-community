import type {
	AcceptanceResult,
	AcceptedRelease,
	ConnectionFacts,
} from "@dokploy/server/services/gha-connect/acceptance";
import type { GateDecision } from "@dokploy/server/services/gha-connect/deploy-gate";
import type {
	DeployGateStore,
	GateConnection,
	RunDeployGateInput,
} from "@dokploy/server/services/gha-connect/deploy-gate-step";
import type {
	ConnectionPollDeps,
	ConnectionRecord,
	PendingRelease,
} from "@dokploy/server/services/gha-connect/poll";
import type { ProcessedEntry } from "@dokploy/server/services/gha-connect/processed";
import { WAKE_SCHEMA } from "@dokploy/server/services/gha-connect/wake-payload";
import type {
	StartOutcome,
	WatchPatch,
	WatchRow,
} from "@dokploy/server/services/github-deployments/poll-core";
import { type Recorded, type Reply, routedFetch } from "./gha-helpers";

export const NOW = 1_700_000_000_000;
export const DIGEST = `sha256:${"e".repeat(64)}`;
export const REPOSITORY = "registry.devino.ca/voicelabs/web";

export const watchRow = (overrides: Partial<WatchRow> = {}): WatchRow => ({
	watchId: "w1",
	organizationId: "org1",
	serviceType: "compose",
	serviceId: "svc1",
	connectionId: "gh1",
	owner: "DevinoSolutions",
	repo: "voicelabs",
	environment: "development",
	enabled: true,
	lastSeenDeploymentId: 10,
	etag: 'W/"old"',
	inflightDeploymentId: null,
	inflightStartedAt: null,
	postLogUrl: false,
	ghaConnectionId: "c1",
	...overrides,
});

export const facts: ConnectionFacts = {
	repoId: 42,
	workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
	trackedBranch: "dev",
	environment: "development",
	serviceKey: "web",
	owner: "DevinoSolutions",
	repo: "voicelabs",
	protectionMode: "environment",
	registryPrefix: "registry.devino.ca",
	registryProbeHost: null,
	deployed: null,
	currentRepositories: [REPOSITORY],
};

export const gateConnection = (
	overrides: Partial<GateConnection> = {},
): GateConnection => ({
	ghaConnectionId: "c1",
	state: "waiting",
	gateBlocked: false,
	repoFullName: "DevinoSolutions/voicelabs",
	repoId: 42,
	gateVersion: 3,
	trackedBranch: "dev",
	workflowPath: facts.workflowPath,
	gateMode: "image",
	gateWorkflows: [],
	gateTimeoutMinutes: 60,
	gateStartedAt: null,
	deployedSha: null,
	...overrides,
});

export const wake = (
	id: number,
	runId: number,
	attempt = 1,
	task = "dokploy:web",
) => ({
	id,
	task,
	payload: {
		schema: WAKE_SCHEMA,
		run_id: runId,
		run_attempt: attempt,
		artifact: "dokploy-release",
	},
});

export const release = (
	runId: number,
	delivery: "pull" | "push" = "pull",
	overrides: Partial<AcceptedRelease> = {},
): AcceptedRelease => ({
	runId,
	runAttempt: 1,
	runUrl: `https://github.com/DevinoSolutions/voicelabs/actions/runs/${runId}`,
	sha: "a".repeat(40),
	releaseId: `gh-${runId}.1`,
	delivery,
	environment: "development",
	serviceKey: "web",
	images: [
		{
			name: "web",
			composeService: "web",
			ref: `${REPOSITORY}@${DIGEST}`,
			repository: REPOSITORY,
			digest: DIGEST,
		},
	],
	composePath: null,
	releaseServices: ["web"],
	canonical: {},
	runEndedAt: null,
	manifestSource: "artifact",
	...overrides,
});

export const pending = (
	runId: number,
	deploymentId: number,
	overrides: Partial<PendingRelease> = {},
): PendingRelease => ({
	releaseId: `rel-${runId}`,
	manifestReleaseId: `gh-${runId}.1`,
	sha: "a".repeat(40),
	runId,
	runAttempt: 1,
	delivery: "pull",
	githubDeploymentId: deploymentId,
	images: [
		{ name: "web", composeService: "web", ref: `${REPOSITORY}@${DIGEST}` },
	],
	createdAt: new Date(NOW - 60_000),
	gateState: null,
	gateExpected: null,
	gateCheckedAt: null,
	...overrides,
});

export interface HarnessOptions {
	processed?: ProcessedEntry[];
	/** The Deployments the list returns (newest first, as GitHub does). `null`: the list answers 304. */
	deployments?: unknown[] | null;
	/** What acceptance says per run id. */
	results?: Record<number, AcceptanceResult>;
	/** Accepted releases already stored (they survive a restart). */
	pending?: PendingRelease[];
	gate?: Partial<GateConnection>;
	/** What the gate says; a function sees the input. */
	decision?: GateDecision | ((input: RunDeployGateInput) => GateDecision);
	startOutcome?: StartOutcome | (() => StartOutcome | Promise<StartOutcome>);
	backup?: (() => Promise<{ ok: boolean; note: string }>) | null;
	/** Status posts that answer something other than 201, in order. */
	statusReplies?: number[];
	factsOverride?: Partial<ConnectionFacts>;
	now?: number;
	/** Extra scripted GitHub routes (the repository, the branch, the runs), tried first. */
	routes?: Array<[string, Reply | ((call: Recorded) => Reply)]>;
	/** When the connection was made (epoch ms). Default: an hour before NOW. */
	connectedAt?: number;
	/** The connection is gone from the database when the poll reads it again (after the first read). */
	goneAfterFirstRead?: boolean;
}

/**
 * A scripted GitHub and an in-memory store behind the connection poll: the
 * list of Deployments, the statuses posted, what was recorded, what the gate
 * was asked and what was started.
 */
export const harness = (options: HarnessOptions = {}) => {
	const statusReplies = [...(options.statusReplies ?? [])];
	const { fetch, calls } = routedFetch([
		...(options.routes ?? []),
		["/statuses", () => ({ status: statusReplies.shift() ?? 201, json: {} })],
		[
			"/deployments?",
			() =>
				options.deployments === null
					? { status: 304 }
					: {
							json: options.deployments ?? [],
							headers: { etag: 'W/"new"' },
						},
		],
	]);
	const patches: WatchPatch[] = [];
	const blocks = new Map<string, number>();
	const accepted: number[] = [];
	const acceptHints: unknown[] = [];
	const processedWrites: ProcessedEntry[][] = [];
	const events: string[] = [];
	const eventLog: Array<{ type: string; message?: string }> = [];
	const verifiedPush: number[] = [];
	const noops: number[] = [];
	const recordedAccepted: Array<{ run: number; deployment: number }> = [];
	const superseded: string[][] = [];
	const failed: string[] = [];
	const started: Array<{
		id: number;
		payload: unknown;
		cursor: number | null;
	}> = [];
	const gateCalls: RunDeployGateInput[] = [];
	const clears: string[] = [];
	const backups: number[] = [];
	const stored: PendingRelease[] = [...(options.pending ?? [])];
	let gateConn = gateConnection(options.gate);
	let reads = 0;
	const record = (): ConnectionRecord => ({
		connectionId: "c1",
		organizationId: "org1",
		createdAt: options.connectedAt ?? NOW - 3_600_000,
		facts: { ...facts, ...options.factsOverride },
		processed: options.processed ?? [],
		gate: gateConn,
	});
	const gateStore: DeployGateStore = {
		clearGateStart: async (id) => {
			clears.push(id);
		},
		recordGateOutcome: async () => true,
	};
	const deps: ConnectionPollDeps = {
		fetch,
		now: () => options.now ?? NOW,
		loadToken: async () => "gho_secret",
		markRevoked: async (id) => {
			events.push(`revoked ${id}`);
		},
		blockedUntil: (key) => blocks.get(key),
		block: (key, until) => {
			blocks.set(key, until);
		},
		patchWatch: async (_id, patch) => {
			patches.push(patch);
			return true;
		},
		startDeploy: async (w, deployment, payload) => {
			started.push({
				id: deployment.id,
				payload,
				cursor: w.lastSeenDeploymentId,
			});
			const outcome = options.startOutcome ?? { kind: "started" as const };
			return typeof outcome === "function" ? outcome() : outcome;
		},
		inspectInflight: async () => ({ state: "running" }),
		log: () => {},
		loadConnection: async () => {
			reads += 1;
			return options.goneAfterFirstRead && reads > 1 ? null : record();
		},
		loadPendingReleases: async () => [...stored],
		createApi: () => ({}) as never,
		createProbe: () => ({ headDigest: async () => ({ kind: "not-found" }) }),
		createGateGithub: () => ({}) as never,
		gateStore,
		accept: async ({ runId, hint }) => {
			accepted.push(runId);
			acceptHints.push(hint);
			const result = options.results?.[runId];
			if (!result) throw new Error(`no scripted result for run ${runId}`);
			return result;
		},
		runGate: async (input) => {
			gateCalls.push(input);
			const decision = options.decision ?? { state: "deploy" as const };
			return typeof decision === "function" ? decision(input) : decision;
		},
		recordProcessed: async (_id, entries) => {
			processedWrites.push(entries);
		},
		applyEvent: async (_id, event) => {
			events.push(event.type);
			eventLog.push({
				type: event.type,
				message: "message" in event ? event.message : undefined,
			});
			if (event.type === "release-refused" && event.block) {
				gateConn = { ...gateConn, state: "blocked", gateBlocked: false };
			}
		},
		recordAccepted: async (_c, r, deploymentId) => {
			recordedAccepted.push({ run: r.runId, deployment: deploymentId });
			stored.push(
				pending(r.runId, deploymentId, {
					manifestReleaseId: r.releaseId,
					sha: r.sha,
					runAttempt: r.runAttempt,
				}),
			);
		},
		supersedeReleases: async (_c, ids) => {
			superseded.push(ids);
			for (const id of ids) {
				const at = stored.findIndex((s) => s.releaseId === id);
				if (at >= 0) stored.splice(at, 1);
			}
		},
		failRelease: async (_c, id) => {
			failed.push(id);
			const at = stored.findIndex((s) => s.releaseId === id);
			if (at >= 0) stored.splice(at, 1);
		},
		recordVerifiedPush: async (_c, _r, id) => {
			verifiedPush.push(id);
		},
		recordNoop: async (_c, _r, id) => {
			noops.push(id);
		},
		// Only a test that is about the backup has one: it runs outside the tick.
		preFlipBackup: options.backup
			? async () => {
					backups.push(1);
					return (options.backup as NonNullable<typeof options.backup>)();
				}
			: undefined,
	};
	const statuses = () =>
		calls
			.filter((c) => c.method === "POST")
			.map((c) => ({
				deployment: Number(c.url.split("/deployments/")[1]?.split("/")[0]),
				...JSON.parse(c.body ?? "{}"),
			}));
	return {
		deps,
		calls,
		patches,
		blocks,
		accepted,
		acceptHints,
		processedWrites,
		events,
		eventLog,
		verifiedPush,
		noops,
		recordedAccepted,
		superseded,
		failed,
		started,
		gateCalls,
		clears,
		backups,
		stored,
		statuses,
		setGate: (next: Partial<GateConnection>) => {
			gateConn = { ...gateConn, ...next };
		},
		listCalls: () => calls.filter((c) => c.method === "GET"),
	};
};
