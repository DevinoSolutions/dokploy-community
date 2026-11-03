import {
	githubCommitUrl,
	githubRepositoryUrl,
} from "@dokploy/server/services/build-origin-shared";
import {
	isGhaSourceType,
	REDEPLOY_LABEL,
	redeployHint,
} from "@dokploy/server/services/gha-connect/provider";
import {
	addWorkflowNames,
	type GateMode,
	gateFormProblem,
	TIMEOUT_DEFAULT,
} from "./gha-deploy-gate-model";

/**
 * The GitHub Actions provider of a service (T-13879), as plain functions: what the connect form needs to be valid
 * and what it sends, and what the status panel says about a connection. The components only draw this.
 */

export type ServiceKind = "application" | "compose";

/* ------------------------------------------------------------------ connect form */

export type ConnectMode = "build" | "existing";

export type ConnectForm = {
	githubConnectionId: string;
	/** owner/name */
	repository: string;
	trackedBranch: string;
	environment: string;
	/** Empty: derived from the repository name. */
	serviceKey: string;
	mode: ConnectMode;
	dockerfile: string;
	context: string;
	buildJob: string;
	imageOutput: string;
	/** The workflow file whose runs are releases. Fixed to dokploy.yml in build mode. */
	workflowPath: string;
	/** "none" = public GHCR images. */
	registryId: string;
	registryPrefix: string;
	gateMode: GateMode;
	gateWorkflows: string;
	gateTimeoutMinutes: string;
};

export const DEFAULT_WORKFLOW_PATH = ".github/workflows/dokploy.yml";

export const defaultConnectForm = (
	defaults: { repository?: string | null; branch?: string | null } = {},
): ConnectForm => ({
	githubConnectionId: "",
	repository: defaults.repository ?? "",
	trackedBranch: defaults.branch?.trim() || "main",
	environment: "production",
	serviceKey: "",
	mode: "build",
	dockerfile: "Dockerfile",
	context: ".",
	buildJob: "build",
	imageOutput: "image",
	workflowPath: DEFAULT_WORKFLOW_PATH,
	registryId: "none",
	registryPrefix: "",
	gateMode: "image",
	gateWorkflows: "",
	gateTimeoutMinutes: String(TIMEOUT_DEFAULT),
});

const REPO = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const JOB = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SAFE = /^[A-Za-z0-9._/-]+$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

export const parseRepository = (repository: string) => {
	const match = REPO.exec(repository.trim());
	return match ? { owner: match[1] as string, repo: match[2] as string } : null;
};

export const keyFromRepository = (repository: string): string => {
	const parsed = parseRepository(repository);
	if (!parsed) return "";
	return parsed.repo
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 63);
};

export const effectiveServiceKey = (form: ConnectForm): string =>
	form.serviceKey.trim() || keyFromRepository(form.repository);

/** Images mirrored to a private registry: the user's own workflow pushes them, so only the job is offered. */
export const isMirrored = (form: ConnectForm): boolean =>
	form.registryId !== "none";

export const effectiveMode = (form: ConnectForm): ConnectMode =>
	isMirrored(form) ? "existing" : form.mode;

export const effectiveWorkflowPath = (form: ConnectForm): string =>
	effectiveMode(form) === "build"
		? DEFAULT_WORKFLOW_PATH
		: form.workflowPath.trim();

/** Why the form cannot generate the file yet; null when it can. */
export const snippetProblem = (form: ConnectForm): string | null => {
	if (!SAFE.test(form.trackedBranch.trim()))
		return "Enter the branch whose pushes are released.";
	if (!SAFE.test(form.environment.trim()))
		return "Enter the GitHub environment name.";
	if (!KEY.test(effectiveServiceKey(form)))
		return "The service key needs lowercase letters, digits, dots, dashes or underscores.";
	if (effectiveMode(form) === "build") {
		if (!parseRepository(form.repository))
			return "Enter the repository as owner/name.";
		if (!SAFE.test(form.dockerfile.trim()))
			return "Enter the path of the Dockerfile.";
		if (!SAFE.test(form.context.trim()))
			return "Enter the build directory, or . for the repository root.";
		return null;
	}
	if (!JOB.test(form.buildJob)) return "Enter the id of your build job.";
	if (!JOB.test(form.imageOutput))
		return "Enter the name of the output that holds the image.";
	return null;
};

/** The first thing that stops Connect, in the order the form is read; null when it can go. */
export const connectFormProblem = (form: ConnectForm): string | null => {
	if (!form.githubConnectionId) return "Choose the GitHub account.";
	if (!parseRepository(form.repository))
		return "Enter the repository as owner/name.";
	const snippet = snippetProblem(form);
	if (snippet) return snippet;
	if (!WORKFLOW_FILE.test(effectiveWorkflowPath(form)))
		return "Enter the workflow file as .github/workflows/<name>.yml.";
	if (isMirrored(form) && form.registryPrefix.trim() === "")
		return "Enter how the mirrored images are named, for example localhost:5000/registry.devino.ca.";
	return gateFormProblem({
		mode: form.gateMode,
		workflows: addWorkflowNames([], form.gateWorkflows),
		timeout: form.gateTimeoutMinutes,
	});
};

/** The input of `ghaConnection.connect` (and `testConnection`). Call only when `connectFormProblem` is null. */
export const toConnectInput = (
	form: ConnectForm,
	service: { serviceType: ServiceKind; serviceId: string },
) => {
	const parsed = parseRepository(form.repository);
	if (!parsed) throw new Error("Enter the repository as owner/name.");
	const mirrored = isMirrored(form);
	return {
		serviceType: service.serviceType,
		serviceId: service.serviceId,
		githubConnectionId: form.githubConnectionId,
		owner: parsed.owner,
		repo: parsed.repo,
		workflowPath: effectiveWorkflowPath(form),
		trackedBranch: form.trackedBranch.trim(),
		environment: form.environment.trim(),
		serviceKey: effectiveServiceKey(form),
		registryPrefix: mirrored ? form.registryPrefix.trim() : null,
		registryId: mirrored ? form.registryId : null,
		protectionMode: "environment" as const,
		gateMode: form.gateMode,
		gateWorkflows:
			form.gateMode === "workflows"
				? addWorkflowNames([], form.gateWorkflows)
				: [],
		gateTimeoutMinutes: Number(form.gateTimeoutMinutes),
	};
};

/** The input of `ghaConnection.snippet`. Call only when `snippetProblem` is null. */
export const toSnippetInput = (form: ConnectForm) => {
	const base = {
		serviceKey: effectiveServiceKey(form),
		trackedBranch: form.trackedBranch.trim(),
		environment: form.environment.trim(),
		delivery: "pull" as const,
	};
	return effectiveMode(form) === "build"
		? {
				...base,
				mode: "build" as const,
				repository: form.repository.trim(),
				dockerfile: form.dockerfile.trim(),
				context: form.context.trim(),
			}
		: {
				...base,
				mode: "existing" as const,
				buildJob: form.buildJob,
				imageOutput: form.imageOutput,
			};
};

/** What to tell the user to do on GitHub before Connect, in one paragraph. */
export const environmentAdvice = (form: ConnectForm): string =>
	`Create the GitHub environment ${form.environment.trim() || "..."} first, limit its deployment branches to ${form.trackedBranch.trim() || "..."} only, and keep your secrets there. Dokploy never sees their values, and refuses to connect while the environment allows other branches.`;

/* ------------------------------------------------------------------ status panel */

export type PillTone = "neutral" | "good" | "warn" | "bad";

export type ProviderConnection = {
	state: string;
	statusText: string | null;
	lastError: string | null;
	repository: string;
	workflowPath: string;
	trackedBranch: string;
	environment: string;
	serviceKey: string;
	deployedSha: string | null;
	deployedRunId: number | null;
	deployedAt: Date | string | null;
	lastActivityAt: Date | string | null;
};

export type ProviderStatus = {
	pill: { label: string; tone: PillTone };
	/** The sentence under the pill: why it is in this state. */
	sentence: string;
	/** What the user can do about it, in plain words (never a command). */
	exit: string | null;
	/** Buttons the panel offers for this state. */
	actions: Array<"checkNow" | "reconnect">;
};

/**
 * The state table of the design, as the Provider tab shows it. The sentence comes from the server (it knows the
 * commits and the times); the pill and the way out are decided here.
 */
export const describeProviderStatus = (
	connection: ProviderConnection,
): ProviderStatus => {
	const sentence = connection.statusText ?? "";
	switch (connection.state) {
		case "connected":
			return {
				pill: { label: "Connected", tone: "good" },
				sentence: sentence || "Deployed from GitHub Actions.",
				exit: null,
				actions: ["checkNow"],
			};
		case "stale":
			return {
				pill: { label: "Stale", tone: "warn" },
				sentence,
				exit: `Look at the latest run of ${connection.workflowPath} on GitHub, or press Check now once it has finished.`,
				actions: ["checkNow"],
			};
		case "blocked":
			return {
				pill: { label: "Blocked", tone: "bad" },
				sentence,
				exit: "Fix what it says and re-run the workflow, change the deploy rule, or deploy this release anyway.",
				actions: ["checkNow"],
			};
		case "disconnected":
			return {
				pill: { label: "Blocked", tone: "bad" },
				sentence: sentence || "GitHub access was lost. Reconnect.",
				exit: "Reconnect the GitHub account under Settings, Git Providers.",
				actions: ["reconnect", "checkNow"],
			};
		default:
			// waiting, detected, proposed: no release has been accepted yet.
			return {
				pill: { label: "Waiting for first release", tone: "neutral" },
				sentence,
				exit: `Push a commit to ${connection.trackedBranch}, or press Check now.`,
				actions: ["checkNow"],
			};
	}
};

export type DetailRow = {
	label: string;
	value: string;
	href: string | null;
	mono: boolean;
};

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; null for no date or one that does not parse. */
export const relativeTime = (
	value: Date | string | null,
	now: Date = new Date(),
): string | null => {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const seconds = Math.max(
		0,
		Math.round((now.getTime() - date.getTime()) / 1000),
	);
	if (seconds < 45) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	return `${days} days ago`;
};

/** The facts under the pill, in reading order. A row is left out when the value is not known. */
export const providerDetailRows = (
	connection: ProviderConnection,
	now: Date = new Date(),
): DetailRow[] => {
	const rows: DetailRow[] = [
		{
			label: "Repository",
			value: connection.repository,
			href: githubRepositoryUrl(connection.repository),
			mono: false,
		},
		{
			label: "Workflow",
			value: connection.workflowPath,
			href: `https://github.com/${connection.repository}/blob/${connection.trackedBranch}/${connection.workflowPath}`,
			mono: true,
		},
		{
			label: "Branch",
			value: connection.trackedBranch,
			href: null,
			mono: true,
		},
		{
			label: "Environment",
			value: connection.environment,
			href: null,
			mono: false,
		},
	];
	if (connection.deployedSha) {
		rows.push({
			label: "Deployed commit",
			value: connection.deployedSha.slice(0, 7),
			href: githubCommitUrl(connection.repository, connection.deployedSha),
			mono: true,
		});
	}
	if (connection.deployedRunId !== null) {
		rows.push({
			label: "Run",
			value: `#${connection.deployedRunId}`,
			href: `https://github.com/${connection.repository}/actions/runs/${connection.deployedRunId}`,
			mono: true,
		});
	}
	const checked = relativeTime(connection.lastActivityAt, now);
	if (checked) {
		rows.push({
			label: "Last checked",
			value: checked,
			href: null,
			mono: false,
		});
	}
	return rows;
};

/* ------------------------------------------------------------------ the Provider tab itself */

/** Whether the Provider tab should open on the GitHub Actions option. */
export const opensOnGithubActions = (
	sourceType: string | null | undefined,
): boolean => isGhaSourceType(sourceType);

/** The label of the manual deploy button, and the line under it, for a service that follows GitHub Actions. */
export const redeployCopy = (trackedBranch: string | null | undefined) => ({
	label: REDEPLOY_LABEL,
	tooltip: "Pulls the current image again and restarts the service",
	confirm:
		"Dokploy will pull the current image again and restart this service. Nothing is built.",
	hint: redeployHint(trackedBranch),
});
