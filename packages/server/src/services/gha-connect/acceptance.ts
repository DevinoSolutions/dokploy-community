import type { GhaManifestSource } from "../../db/schema/gha-connection";
import type { ActionsApi, ApiFailure, ApiResult, RunInfo } from "./actions-api";
import { evaluateEnvironmentPolicy } from "./environment-policy";
import {
	extractLogManifest,
	JOB_LOG_MAX_BYTES,
	releaseJobs,
} from "./log-manifest";
import {
	MANIFEST_ARTIFACT_NAME,
	MANIFEST_MAX_BYTES,
	type ManifestImage,
	parseReleaseManifest,
} from "./manifest";
import {
	allowedNamespaces,
	canonicalRepository,
	checkImageRepository,
	splitRepository,
} from "./namespace";
import { decideOrdering, type ReleaseStamp } from "./ordering";
import type { RegistryProbe } from "./registry-probe";
import { readZipEntry } from "./zip";

/**
 * Should Dokploy deploy what GitHub says was released? The six rules of the
 * design (docs/superpowers/specs/2026-11-03-gha-native-connect-design.md,
 * "Trust model"), in order, over a candidate (run id, attempt) that a GitHub
 * Deployment or a run listing woke us up with:
 *
 *   1. the run: right workflow file, tracked branch, push or manual dispatch,
 *      from this repository, completed with success;
 *   2. the manifest source: the artifact `dokploy-release` (not expired, uploaded by that run),
 *      or, when that is unavailable (GitHub's Actions storage quota blocks uploads), the
 *      `::dokploy-release::<base64>` line in the log of the release job of the same run attempt;
 *   3. the manifest: parses, names this run and branch, `sha` = the run's head;
 *   4. every image: in the connection's namespace, a repository the service
 *      runs, and served by the registry under the same digest;
 *   5. the environment branch policy still allows only the tracked branch;
 *   6. ordering: on the branch, not older than what is deployed.
 *
 * Nothing in the Deployment itself (payload, creator, description) is trusted.
 * No side effects: the caller writes the result.
 */

export type DeployedStamp = ReleaseStamp;

export interface ConnectionFacts {
	repoId: number;
	workflowPath: string;
	trackedBranch: string;
	environment: string;
	serviceKey: string;
	owner: string;
	repo: string;
	protectionMode: "environment" | "repository-secret";
	/** Where mirrored images live as written in a release (host[:port][/path]); null = public GHCR only. */
	registryPrefix: string | null;
	/** Host of the Dokploy registry record that answers for the prefix; the digest check goes there. */
	registryProbeHost: string | null;
	deployed: DeployedStamp | null;
	/** Repositories the service runs now (empty before its first image). */
	currentRepositories: string[];
	/** True only for an explicit rollback. */
	allowBehind?: boolean;
	/** Exact name of the release job, when the connection knows it (the job-log manifest is read from it). */
	releaseJobName?: string | null;
}

/** Where the manifest of an accepted release was read from. Equal trust, same rules. */
export type ManifestSource = GhaManifestSource;

export interface AcceptedRelease {
	runId: number;
	runAttempt: number;
	runUrl: string;
	sha: string;
	releaseId: string;
	delivery: "pull" | "push";
	environment: string;
	serviceKey: string;
	images: ManifestImage[];
	composePath: string | null;
	releaseServices: string[];
	/** Mirrored repository to the GHCR repository it was copied from (only mirrored images appear). */
	canonical: Record<string, string>;
	/** When the run finished (epoch ms), for the multi-service completion timeout; null if unknown. */
	runEndedAt: number | null;
	/** The run artifact, or (when that is unavailable, e.g. the Actions storage quota) the release job's log. */
	manifestSource: ManifestSource;
}

export type RefusalCode =
	| "run-missing"
	| "run-path"
	| "run-branch"
	| "run-event"
	| "run-repository"
	| "run-failed"
	| "artifact-missing"
	| "artifact-expired"
	| "artifact-binding"
	| "artifact-unreadable"
	| "manifest-invalid"
	| "manifest-schema"
	| "manifest-migrations"
	| "manifest-binding"
	| "image-namespace"
	| "image-repository"
	| "image-unverified"
	| "policy-wider"
	| "policy-unreadable"
	| "not-on-branch"
	| "ordering-behind"
	| "ordering-lower-attempt"
	| "ordering-older-run";

/**
 * Refusals that happen only AFTER the run and its artifact are proven to be
 * this connection's own release run on the tracked branch. Those mean the
 * release itself is broken (or the setup drifted), so the service shows
 * Blocked. Everything before that point can be provoked by anyone who may
 * create a GitHub Deployment, so it is answered on the Deployment and logged,
 * and never blocks the service.
 */
const BLOCKING: ReadonlySet<RefusalCode> = new Set([
	"manifest-invalid",
	"manifest-schema",
	"manifest-migrations",
	"manifest-binding",
	"image-namespace",
	"image-repository",
	"image-unverified",
	"policy-wider",
	"policy-unreadable",
]);

export type AcceptanceResult =
	/** The run has not completed yet; ask again on a later tick. */
	| { kind: "pending"; reason: string }
	/** GitHub or the registry could not answer; nothing was decided. */
	| { kind: "retry"; cause: ApiFailure }
	/** The run is a release of other services only. */
	| { kind: "ignored"; reason: string }
	| {
			kind: "refused";
			code: RefusalCode;
			message: string;
			/** The service shows Blocked. */
			block: boolean;
			/** Fixing GitHub (not re-running) can clear it: the caller asks again later and does not record the run as handled. */
			recheck: boolean;
	  }
	/** A newer attempt of this run replaced the artifact: this Deployment is answered as inactive and never blocks. */
	| { kind: "superseded"; reason: string }
	/** Accepted, and it changes nothing (same digests as deployed). */
	| { kind: "noop"; release: AcceptedRelease }
	| { kind: "accepted"; release: AcceptedRelease };

const RECHECK: ReadonlySet<RefusalCode> = new Set([
	"policy-wider",
	"policy-unreadable",
]);

const refuse = (code: RefusalCode, message: string): AcceptanceResult => ({
	kind: "refused",
	code,
	message,
	block: BLOCKING.has(code),
	recheck: RECHECK.has(code),
});

type Step<T> = { ok: true; value: T } | { ok: false; result: AcceptanceResult };

const needs = <T>(
	result: ApiResult<T>,
	onMissing: AcceptanceResult,
): Step<T> => {
	if (result.kind === "ok") return { ok: true, value: result.value };
	if (result.kind === "not-found") return { ok: false, result: onMissing };
	return { ok: false, result: { kind: "retry", cause: result } };
};

export const digestsOf = (images: ManifestImage[]): string[] =>
	images.map((image) => image.digest).sort();

type ManifestRead =
	| { ok: true; text: string }
	| {
			ok: false;
			result: AcceptanceResult;
			/** Whether the job log may still hold the manifest. */
			fallback: boolean;
	  };

/** Rule 2: the artifact `dokploy-release` of the run, bound to the run and the repository. */
const readArtifactManifest = async (
	api: ActionsApi,
	runId: number,
	c: ConnectionFacts,
): Promise<ManifestRead> => {
	const unavailable = (code: RefusalCode, message: string): ManifestRead => ({
		ok: false,
		result: refuse(code, message),
		fallback: true,
	});
	const transient = (failure: ApiFailure): ManifestRead => ({
		ok: false,
		result: { kind: "retry", cause: failure },
		// A rate limit or a dead token fails the log read the same way: ask again later.
		fallback:
			failure.kind !== "rate-limited" && failure.kind !== "unauthorized",
	});

	const listing = await api.artifacts(runId, MANIFEST_ARTIFACT_NAME);
	if (listing.kind === "not-found") {
		return unavailable("artifact-missing", "The run has no release artifact");
	}
	if (listing.kind !== "ok") return transient(listing);
	const artifact = listing.value
		.filter((a) => a.name === MANIFEST_ARTIFACT_NAME)
		.sort((a, b) => b.id - a.id)[0];
	if (!artifact) {
		return unavailable("artifact-missing", "The run has no release artifact");
	}
	if (artifact.expired) {
		return unavailable("artifact-expired", "The release artifact has expired");
	}
	if (
		artifact.workflowRunId !== runId ||
		artifact.workflowRunRepositoryId !== c.repoId ||
		artifact.workflowRunHeadRepositoryId !== c.repoId
	) {
		// An artifact that claims to belong elsewhere is an anomaly, not an absence: no fallback.
		return {
			ok: false,
			result: refuse(
				"artifact-binding",
				"The release artifact was not uploaded by this run of this repository",
			),
			fallback: false,
		};
	}
	if (artifact.sizeInBytes > 2 * MANIFEST_MAX_BYTES) {
		return unavailable(
			"artifact-unreadable",
			"The release artifact is too large",
		);
	}
	const downloaded = await api.downloadArtifact(
		artifact.id,
		2 * MANIFEST_MAX_BYTES,
	);
	if (downloaded.kind === "not-found") {
		return unavailable("artifact-expired", "The release artifact is gone");
	}
	if (downloaded.kind !== "ok") return transient(downloaded);
	const entry = readZipEntry(
		downloaded.value,
		`${MANIFEST_ARTIFACT_NAME}.json`,
		MANIFEST_MAX_BYTES,
	);
	if (!entry.ok) return unavailable("artifact-unreadable", entry.reason);
	return { ok: true, text: entry.bytes.toString("utf8") };
};

type LogRead =
	| { kind: "found"; text: string }
	| { kind: "none" }
	| { kind: "result"; result: AcceptanceResult };

/**
 * The same manifest from the log of the release job of THIS run attempt (jobs are listed per
 * attempt, so an older or newer attempt's log is never read). Not finding it is not a verdict;
 * a log that carries a broken or a second, different manifest is, because the run is proven to be
 * the connection's own release run.
 */
const readJobLogManifest = async (
	api: ActionsApi,
	run: RunInfo,
	runAttempt: number,
	c: ConnectionFacts,
): Promise<LogRead> => {
	const listing = await api.runJobs(run.id, runAttempt);
	if (listing.kind === "not-found") return { kind: "none" };
	if (listing.kind !== "ok") {
		return { kind: "result", result: { kind: "retry", cause: listing } };
	}
	const jobs = releaseJobs({
		jobs: listing.value,
		runId: run.id,
		attempt: runAttempt,
		headSha: run.headSha,
		releaseJobName: c.releaseJobName,
	});
	const logs: string[] = [];
	for (const job of jobs) {
		const log = await api.jobLog(job.id, JOB_LOG_MAX_BYTES);
		if (log.kind === "ok") {
			logs.push(log.value);
		} else if (log.kind === "error" && log.status === 413) {
			// Too large to be the small release job: not the one.
		} else if (log.kind !== "not-found") {
			return { kind: "result", result: { kind: "retry", cause: log } };
		}
	}
	const extracted = extractLogManifest(logs);
	if (extracted.ok) return { kind: "found", text: extracted.text };
	if (extracted.code === "none") return { kind: "none" };
	return {
		kind: "result",
		result: refuse("manifest-invalid", extracted.message),
	};
};

export const acceptRelease = async (
	input: {
		runId: number;
		runAttempt: number;
		connection: ConnectionFacts;
	},
	deps: { api: ActionsApi; probe: RegistryProbe },
): Promise<AcceptanceResult> => {
	const { runId, runAttempt, connection: c } = input;
	const { api, probe } = deps;

	// Rule 1: the run.
	const runStep = needs(
		await api.runAttempt(runId, runAttempt),
		refuse("run-missing", "GitHub has no such run attempt"),
	);
	if (!runStep.ok) return runStep.result;
	const run: RunInfo = runStep.value;
	if (run.path !== c.workflowPath) {
		return refuse(
			"run-path",
			`The run belongs to ${run.path || "another workflow"}`,
		);
	}
	if (run.headBranch !== c.trackedBranch) {
		return refuse("run-branch", "The run is not on the tracked branch");
	}
	if (run.event !== "push" && run.event !== "workflow_dispatch") {
		return refuse(
			"run-event",
			`A ${run.event || "unknown"} run is never released`,
		);
	}
	if (run.repositoryId !== c.repoId || run.headRepositoryId !== c.repoId) {
		return refuse("run-repository", "The run comes from another repository");
	}
	if (run.status !== "completed") {
		return { kind: "pending", reason: `The run is ${run.status}` };
	}
	if (run.conclusion !== "success") {
		return refuse(
			"run-failed",
			`The run concluded ${run.conclusion ?? "without a result"}`,
		);
	}

	// Rules 2 and 3 start from a manifest. Two sources, the same trust: the run artifact
	// first, and when it is unavailable (never uploaded, expired, unreadable, or the Actions
	// storage quota blocked the upload) the manifest line in the release job's log.
	const fromArtifact = await readArtifactManifest(api, runId, c);
	let manifestText: string;
	let manifestSource: ManifestSource;
	if (fromArtifact.ok) {
		manifestText = fromArtifact.text;
		manifestSource = "artifact";
	} else if (!fromArtifact.fallback) {
		return fromArtifact.result;
	} else {
		const fromLog = await readJobLogManifest(api, run, runAttempt, c);
		if (fromLog.kind === "found") {
			manifestText = fromLog.text;
			manifestSource = "job-log";
		} else if (fromLog.kind === "result") {
			return fromLog.result;
		} else {
			return fromArtifact.result;
		}
	}

	// Rule 3: the manifest.
	const parsed = parseReleaseManifest(manifestText);
	if (!parsed.ok) {
		return refuse(
			parsed.code === "unknown-schema"
				? "manifest-schema"
				: parsed.code === "migrations-unsupported"
					? "manifest-migrations"
					: "manifest-invalid",
			parsed.message,
		);
	}
	const manifest = parsed.manifest;
	// The artifact is per run, not per attempt, and a re-run replaces it. A Deployment of an
	// older attempt is not wrong, only old: answer it as inactive, never block the service.
	if (
		manifest.source.runId === String(runId) &&
		manifest.source.runAttempt > runAttempt
	) {
		return {
			kind: "superseded",
			reason: `Attempt ${manifest.source.runAttempt} of this run replaced attempt ${runAttempt}`,
		};
	}
	if (
		manifest.sha !== run.headSha ||
		manifest.source.runId !== String(runId) ||
		manifest.source.runAttempt !== runAttempt ||
		manifest.source.ref !== `refs/heads/${c.trackedBranch}` ||
		manifest.environment !== c.environment
	) {
		return refuse(
			"manifest-binding",
			"The manifest does not describe this run, commit, branch and environment",
		);
	}
	const service = manifest.services.find((s) => s.key === c.serviceKey);
	if (!service) {
		return {
			kind: "ignored",
			reason: `The release does not include ${c.serviceKey}`,
		};
	}

	// Rule 4: the images.
	const namespaces = allowedNamespaces({
		owner: c.owner,
		repo: c.repo,
		registryPrefix: c.registryPrefix,
	});
	for (const image of service.images) {
		const checked = checkImageRepository({
			repository: image.repository,
			namespaces,
			currentRepositories: c.currentRepositories,
		});
		if (!checked.ok) return refuse(checked.code, checked.message);
	}
	for (const image of service.images) {
		const parts = splitRepository(image.repository);
		if (!parts) {
			return refuse(
				"image-namespace",
				`${image.repository} has no registry host`,
			);
		}
		const head = await probe.headDigest({
			// A mirrored image is checked at the Dokploy registry record, under the name it has there.
			host:
				c.registryProbeHost &&
				canonicalRepository({
					repository: image.repository,
					owner: c.owner,
					registryPrefix: c.registryPrefix,
				})
					? c.registryProbeHost
					: parts.host,
			name: parts.name,
			digest: image.digest,
		});
		if (head.kind === "unreachable") {
			return {
				kind: "retry",
				cause: { kind: "error", status: head.status },
			};
		}
		if (head.kind === "not-found" || head.digest !== image.digest) {
			return refuse(
				"image-unverified",
				`The registry does not serve ${image.repository}@${image.digest.slice(0, 19)}`,
			);
		}
	}

	// Rule 5: the environment's deployment branch policy.
	if (c.protectionMode === "environment") {
		const policy = needs(
			await api.environmentPolicy(c.environment),
			refuse(
				"policy-unreadable",
				`The GitHub environment ${c.environment} does not exist`,
			),
		);
		if (!policy.ok) {
			// A read error is never a downgrade. GitHub being unable to answer at
			// all (rate limit, dead token) is a retry; any other failure refuses.
			const failed = policy.result;
			if (
				failed.kind === "retry" &&
				failed.cause.kind !== "rate-limited" &&
				failed.cause.kind !== "unauthorized"
			) {
				return refuse(
					"policy-unreadable",
					"GitHub would not show the deployment branch policy of the environment",
				);
			}
			return failed;
		}
		const verdict = evaluateEnvironmentPolicy(policy.value, c.trackedBranch);
		if (!verdict.ok) return refuse("policy-wider", verdict.message);
	}

	// Rule 6: ordering.
	const head = needs(
		await api.branchHead(c.trackedBranch),
		refuse("not-on-branch", "The tracked branch no longer exists"),
	);
	if (!head.ok) return head.result;
	let reachable = manifest.sha === head.value.sha;
	if (!reachable) {
		const toHead = needs(
			await api.compare(manifest.sha, head.value.sha),
			refuse("not-on-branch", "The release commit is unknown to GitHub"),
		);
		if (!toHead.ok) return toHead.result;
		reachable = toHead.value === "ahead" || toHead.value === "identical";
	}
	let deployedToCandidate = null;
	if (c.deployed && c.deployed.sha !== manifest.sha) {
		const compared = needs(
			await api.compare(c.deployed.sha, manifest.sha),
			refuse("not-on-branch", "The deployed commit is unknown to GitHub"),
		);
		if (!compared.ok) return compared.result;
		deployedToCandidate = compared.value;
	}
	const order = decideOrdering({
		deployed: c.deployed,
		candidate: {
			sha: manifest.sha,
			runId,
			attempt: runAttempt,
			digests: digestsOf(service.images),
		},
		deployedToCandidate,
		reachableFromBranch: reachable,
		allowBehind: c.allowBehind === true,
	});
	if (!order.accept) return refuse(order.code, order.message);

	const release: AcceptedRelease = {
		runId,
		runAttempt,
		runUrl: run.htmlUrl,
		sha: manifest.sha,
		releaseId: manifest.releaseId,
		delivery: manifest.delivery,
		environment: manifest.environment,
		serviceKey: c.serviceKey,
		images: service.images,
		composePath: service.composePath,
		releaseServices: manifest.releaseServices,
		canonical: Object.fromEntries(
			service.images.flatMap((image) => {
				const canonical = canonicalRepository({
					repository: image.repository,
					owner: c.owner,
					registryPrefix: c.registryPrefix,
				});
				return canonical ? [[image.repository, canonical]] : [];
			}),
		),
		runEndedAt: run.updatedAt ? Date.parse(run.updatedAt) || null : null,
		manifestSource,
	};
	return order.noop ? { kind: "noop", release } : { kind: "accepted", release };
};
