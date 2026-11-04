import {
	canRedeployFromGithubActionsRun,
	deploymentImageReference,
	describeDeploymentDuration,
	describeGithubActionsAttempt,
	describeGithubActionsRollback,
	describeGithubActionsRun,
	describeGithubActionsRunState,
	describeGithubActionsSource,
	describeGithubActionsTitle,
	describeImageReference,
	extractComposeImages,
	GITHUB_ACTIONS_PILL_LABEL,
	GITHUB_ACTIONS_WAITING_PILL_LABEL,
	githubActionsBranch,
	githubActionsRunsOf,
	githubCommitUrl,
	githubRepositoryUrl,
	isLiveGithubBuild,
	normalizeBuildRunUrl,
	pickNewerLiveGithubDeployment,
	pickServingDeployment,
} from "@dokploy/server/services/build-origin-shared";
import copy from "copy-to-clipboard";
import {
	Copy,
	ExternalLink,
	Loader2,
	Rocket,
	ScrollText,
	Undo2,
} from "lucide-react";
import { useRouter } from "next/router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ShowDeployment } from "@/components/dashboard/application/deployments/show-deployment";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { OpensInNewTab } from "@/components/shared/opens-in-new-tab";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

/** The service a GitHub Actions run deployed: an application or a compose. */
export interface GithubActionsRunService {
	type: "application" | "compose";
	id: string;
}

/**
 * The fields of a deployment row the modal reads. The Deployments tab, the centralized Deployments table and the
 * home page all hand over rows that have them.
 */
export interface GithubActionsRunRow {
	deploymentId: string;
	title?: string | null;
	status?: string | null;
	createdAt?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	errorMessage?: string | null;
	logPath?: string | null;
	buildServerId?: string | null;
	buildOrigin?: string | null;
	buildRunUrl?: string | null;
	buildRepository?: string | null;
	buildCommitSha?: string | null;
	buildRunId?: string | null;
	buildRunStatus?: string | null;
	buildRunStep?: string | null;
	externalBuildOnly?: boolean | null;
	deployQueuedAt?: string | null;
	imageTag?: string | null;
	imageDigest?: string | null;
}

const TONE_VARIANTS = {
	running: "yellow",
	success: "green",
	failed: "red",
	cancelled: "outline",
	unknown: "blank",
} as const;

const ExternalLinkText = ({
	href,
	children,
}: {
	href: string;
	children: ReactNode;
}) => (
	<a
		href={href}
		target="_blank"
		rel="noopener noreferrer"
		className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
	>
		<span className="min-w-0 break-all">{children}</span>
		<ExternalLink className="size-3 shrink-0" />
		<OpensInNewTab />
	</a>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
	<div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-4">
		<dt className="text-sm text-muted-foreground sm:w-28 sm:shrink-0">
			{label}
		</dt>
		<dd className="min-w-0 break-words text-sm font-medium">{children}</dd>
	</div>
);

const ImageRow = ({ reference }: { reference: string }) => {
	const image = describeImageReference(reference);
	if (!image) return null;
	return (
		<span className="flex min-w-0 items-center gap-2">
			<code
				className="truncate rounded bg-muted px-2 py-0.5 font-mono text-xs"
				title={image.reference}
			>
				{image.label}
			</code>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-7 shrink-0"
				aria-label={`Copy the full reference of ${image.name}`}
				onClick={() => {
					if (copy(image.reference)) toast.success("Image copied");
				}}
			>
				<Copy className="size-3.5" />
			</Button>
		</span>
	);
};

const SectionTitle = ({ children }: { children: ReactNode }) => (
	<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
		{children}
	</h3>
);

interface LogRequest {
	logPath: string;
	serverId?: string;
	errorMessage?: string;
	runUrl: string | null;
	live: boolean;
}

interface BodyProps {
	service: GithubActionsRunService;
	/** The deployment to describe; the one that runs now when left out. */
	deployment?: GithubActionsRunRow;
	onClose: () => void;
	onOpenLogs: (request: LogRequest) => void;
}

/**
 * Everything the modal shows. Rendered only while the modal is open, so the queries below do not run for the
 * pills of a long Deployments list. They are the queries the service page and the Deployments tab already use.
 */
const RunDialogBody = ({
	service,
	deployment: given,
	onClose,
	onOpenLogs,
}: BodyProps) => {
	const router = useRouter();
	const utils = api.useUtils();
	const isApplication = service.type === "application";
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canDeploy = permissions?.deployment.create ?? false;

	const { data: application } = api.application.one.useQuery(
		{ applicationId: service.id },
		{ enabled: isApplication },
	);
	const { data: composeService } = api.compose.one.useQuery(
		{ composeId: service.id },
		{ enabled: !isApplication },
	);
	const { data: deployments } = api.deployment.allByType.useQuery(
		{ id: service.id, type: service.type },
		{
			// Only while something runs: a finished run does not change under the modal.
			refetchInterval: (query) =>
				query.state.data?.some((d) => d.status === "running") ? 5000 : false,
		},
	);
	const { mutateAsync: deployApplication, isPending: isDeployingApplication } =
		api.application.deploy.useMutation();
	const { mutateAsync: deployCompose, isPending: isDeployingCompose } =
		api.compose.deploy.useMutation();

	const svc = isApplication ? application : composeService;
	// Earlier builds Dokploy ran itself (before the service followed GitHub Actions) are not runs.
	const runs = githubActionsRunsOf(deployments ?? [], svc?.buildOrigin);
	const serving = pickServingDeployment(runs);
	// The row follows the list: a live GitHub Actions row changes under the modal while the run goes on.
	const fromList = given
		? deployments?.find((d) => d.deploymentId === given.deploymentId)
		: undefined;
	const row: GithubActionsRunRow | null =
		fromList ?? given ?? serving ?? runs[0] ?? null;
	const isServing = !row || row.deploymentId === serving?.deploymentId;

	const run = describeGithubActionsRun({
		title: row?.title,
		buildRunUrl: row?.buildRunUrl ?? (isServing ? svc?.buildRunUrl : null),
		buildRepository:
			row?.buildRepository ?? (isServing ? svc?.buildRepository : null),
		buildCommitSha:
			row?.buildCommitSha ?? (isServing ? svc?.buildCommitSha : null),
		buildRunId: row?.buildRunId ?? (isServing ? svc?.buildRunId : null),
	});
	const environment =
		run.buildEnvironment ?? (isServing ? svc?.buildEnvironment : null);
	const runUrl = normalizeBuildRunUrl(
		row?.buildRunUrl ?? (isServing ? svc?.buildRunUrl : null),
	);
	const repositoryUrl = githubRepositoryUrl(run.buildRepository);
	const commitUrl = githubCommitUrl(run.buildRepository, run.buildCommitSha);
	const shortSha = run.buildCommitSha?.slice(0, 7) ?? null;
	const { subject, attempt } = describeGithubActionsTitle(row?.title);
	const state = row ? describeGithubActionsRunState(row, Date.now()) : null;
	// From the service pill the modal describes what runs now. A newer run that is still going has a phase worth
	// seeing there, so it gets its own line and its own link to GitHub.
	const newerLive = !given
		? pickNewerLiveGithubDeployment(
				runs,
				row
					? { deploymentId: row.deploymentId, createdAt: row.createdAt ?? "" }
					: null,
			)
		: null;
	const newerLiveDetail = newerLive
		? describeGithubActionsRunState(newerLive, Date.now()).detail
		: null;
	const newerLiveUrl = normalizeBuildRunUrl(newerLive?.buildRunUrl);
	const duration = describeDeploymentDuration(row?.startedAt, row?.finishedAt);
	const branch = isServing
		? githubActionsBranch({ branch: svc?.branch, sourceType: svc?.sourceType })
		: null;

	const serviceImages = isApplication
		? application?.dockerImage
			? [application.dockerImage]
			: []
		: extractComposeImages(composeService?.composeFile);
	const rowImage = row ? deploymentImageReference(row) : null;
	const images = [
		...(isServing ? serviceImages : []),
		...(rowImage ? [rowImage] : []),
	].filter((reference, index, all) => all.indexOf(reference) === index);

	const rolledBack = Boolean(isServing && svc?.buildRolledBack);
	const isDeploying = isDeployingApplication || isDeployingCompose;
	// Redeploying pulls the image that runs now, so it is offered only on the row that describes that image.
	const canRedeploy =
		Boolean(svc) &&
		canRedeployFromGithubActionsRun({
			canDeploy,
			isServing,
			serviceBuildOrigin: svc?.buildOrigin,
		});
	const logPath = row?.logPath ?? null;

	const redeploy = async () => {
		try {
			if (isApplication) {
				await deployApplication({ applicationId: service.id });
			} else {
				await deployCompose({ composeId: service.id });
			}
			toast.success("Redeploying the current version");
			await Promise.all([
				utils.deployment.allByType.invalidate(),
				isApplication
					? utils.application.one.invalidate({ applicationId: service.id })
					: utils.compose.one.invalidate({ composeId: service.id }),
			]);
			onClose();
			if (svc?.environment?.projectId) {
				void router.push(
					`/dashboard/project/${svc.environment.projectId}/environment/${svc.environmentId}/services/${service.type}/${service.id}?tab=deployments`,
				);
			}
		} catch {
			toast.error(
				isApplication
					? "Error deploying application"
					: "Error deploying compose",
			);
		}
	};

	return (
		<>
			<DialogHeader className="pr-8">
				<DialogTitle className="flex flex-wrap items-center gap-2 text-lg">
					<GithubIcon />
					GitHub Actions run
					{state && (
						<Badge variant={TONE_VARIANTS[state.tone]} className="px-2">
							{state.tone === "running" && (
								<Loader2 className="size-3 animate-spin" aria-hidden="true" />
							)}
							{state.label}
						</Badge>
					)}
				</DialogTitle>
				<DialogDescription className="break-words">
					{subject ??
						row?.title?.trim().split("\n", 1)[0] ??
						"Built and deployed by GitHub Actions. Dokploy only pulls the image and starts it."}
				</DialogDescription>
			</DialogHeader>

			{!row && !svc ? (
				<div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					Loading the run...
				</div>
			) : (
				<div className="flex flex-col gap-5">
					{state?.detail && (
						<p
							role="status"
							className="flex items-center gap-2 rounded border bg-muted/50 px-3 py-2 text-sm"
						>
							<Loader2
								className="size-4 shrink-0 animate-spin"
								aria-hidden="true"
							/>
							{state.detail}
						</p>
					)}
					{newerLiveDetail && (
						<p
							role="status"
							className="flex flex-wrap items-center gap-2 rounded border bg-muted/50 px-3 py-2 text-sm"
						>
							<Loader2
								className="size-4 shrink-0 animate-spin"
								aria-hidden="true"
							/>
							<span className="min-w-0 break-words">
								A newer run is in progress: {newerLiveDetail}
							</span>
							{newerLiveUrl && (
								<ExternalLinkText href={newerLiveUrl}>Open it</ExternalLinkText>
							)}
						</p>
					)}
					<section className="flex flex-col gap-3">
						<SectionTitle>Run</SectionTitle>
						<dl className="flex flex-col gap-2.5">
							<Row label="Workflow run">
								{runUrl ? (
									<ExternalLinkText href={runUrl}>
										{run.buildRunId ? `Run #${run.buildRunId}` : "Open run"}
										{describeGithubActionsAttempt(attempt)}
									</ExternalLinkText>
								) : run.buildRunId ? (
									`Run #${run.buildRunId}${describeGithubActionsAttempt(attempt)}`
								) : (
									<span className="font-normal text-muted-foreground">
										Not recorded
									</span>
								)}
							</Row>
							{run.buildRepository && repositoryUrl && (
								<Row label="Repository">
									<ExternalLinkText href={repositoryUrl}>
										{run.buildRepository}
									</ExternalLinkText>
								</Row>
							)}
							{environment && <Row label="Environment">{environment}</Row>}
							{branch && <Row label="Branch">{branch}</Row>}
							{shortSha && (
								<Row label="Commit">
									{commitUrl ? (
										<ExternalLinkText href={commitUrl}>
											<code className="font-mono">{shortSha}</code>
										</ExternalLinkText>
									) : (
										<code className="font-mono">{shortSha}</code>
									)}
									{subject && (
										<span className="ml-2 font-normal text-muted-foreground">
											{subject}
										</span>
									)}
								</Row>
							)}
						</dl>
					</section>

					{row && (
						<section className="flex flex-col gap-3 border-t pt-4">
							<SectionTitle>Deployment in Dokploy</SectionTitle>
							<dl className="flex flex-col gap-2.5">
								{row.title?.trim() && (
									<Row label="Title">
										<span className="whitespace-pre-wrap">
											{row.title.trim()}
										</span>
									</Row>
								)}
								<Row label="Source">
									{state
										? describeGithubActionsSource({
												...state,
												externalBuildOnly: row.externalBuildOnly,
												deployQueuedAt: row.deployQueuedAt,
												buildRunStatus: row.buildRunStatus,
											})
										: null}
								</Row>
								{row.startedAt && (
									<Row label="Started">
										<DateTooltip
											date={row.startedAt}
											className="text-foreground"
										/>
									</Row>
								)}
								{row.finishedAt && (
									<Row label="Finished">
										<span className="flex flex-wrap items-center gap-2">
											<DateTooltip
												date={row.finishedAt}
												className="text-foreground"
											/>
											{duration && (
												<Badge variant="outline" className="text-[10px]">
													{duration}
												</Badge>
											)}
										</span>
									</Row>
								)}
								{!row.startedAt && !row.finishedAt && row.createdAt && (
									<Row label="Created">
										<DateTooltip
											date={row.createdAt}
											className="text-foreground"
										/>
									</Row>
								)}
								{images.length > 0 && (
									<Row label={images.length > 1 ? "Images" : "Image"}>
										<span className="flex flex-col gap-1">
											{images.map((reference) => (
												<ImageRow key={reference} reference={reference} />
											))}
										</span>
									</Row>
								)}
							</dl>
							{row.status === "error" && row.errorMessage?.trim() && (
								<p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
									{row.errorMessage.trim()}
								</p>
							)}
						</section>
					)}

					{rolledBack && (
						<p className="flex items-start gap-2 rounded border bg-muted/50 px-3 py-2 text-sm">
							<Undo2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
							<span>
								{describeGithubActionsRollback({
									buildCommitSha: svc?.buildCommitSha,
									buildRollbackRunId: svc?.buildRollbackRunId,
									buildRollbackFailure: svc?.buildRollbackFailure,
								})}
							</span>
						</p>
					)}
				</div>
			)}

			<DialogFooter className="flex-col sm:flex-row sm:flex-wrap sm:justify-start">
				{runUrl ? (
					<Button asChild>
						<a href={runUrl} target="_blank" rel="noopener noreferrer">
							<GithubIcon />
							Open run on GitHub
							<ExternalLink className="size-3.5" />
							<OpensInNewTab />
						</a>
					</Button>
				) : (
					<span className="self-center text-sm text-muted-foreground">
						The run link was not recorded.
					</span>
				)}
				{logPath && row && (
					<Button
						variant="outline"
						onClick={() =>
							onOpenLogs({
								logPath,
								serverId: row.buildServerId || svc?.serverId || undefined,
								errorMessage: row.errorMessage || undefined,
								runUrl,
								live: isLiveGithubBuild(row),
							})
						}
					>
						<ScrollText className="size-4" />
						View deployment logs
					</Button>
				)}
				{canRedeploy && (
					<DialogAction
						title="Redeploy current image"
						description={`Dokploy will pull the current image${
							isApplication ? "" : "s"
						} again and restart this ${service.type}. Nothing is built.`}
						type="default"
						onClick={redeploy}
					>
						<Button variant="outline" isLoading={isDeploying}>
							<Rocket className="size-4" />
							Redeploy current image
						</Button>
					</DialogAction>
				)}
			</DialogFooter>
		</>
	);
};

interface Props {
	service: GithubActionsRunService;
	/** The deployment row the pill sits on. Left out on the service page, where the run that is deployed now shows. */
	deployment?: GithubActionsRunRow;
	/** The service is connected but no release has arrived: the pill says so and opens nothing (there is no run). */
	waitingForFirstRelease?: boolean;
	className?: string;
}

/**
 * The "GitHub Actions" provenance pill. It is the one way into everything about the run: a click opens a modal
 * with the run, the Dokploy deployment it maps to, the image, the link to GitHub, the run-first logs and the
 * redeploy action. Keyboard users reach it as a button.
 */
export const GithubActionsRunPill = ({
	service,
	deployment,
	waitingForFirstRelease = false,
	className,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [logs, setLogs] = useState<LogRequest | null>(null);

	// No release has arrived: there is no run to open, so the pill only says what Dokploy waits for.
	if (waitingForFirstRelease) {
		return (
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Badge variant="outline" className={className}>
							<GithubIcon />
							{GITHUB_ACTIONS_WAITING_PILL_LABEL}
						</Badge>
					</TooltipTrigger>
					<TooltipContent className="z-999 max-w-[320px]">
						<span>
							Connected to GitHub Actions. The first release has not arrived
							yet; push to the tracked branch or press Check now on the Provider
							tab.
						</span>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	return (
		<>
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-haspopup="dialog"
							aria-label="GitHub Actions run details"
							onClick={(event) => {
								event.stopPropagation();
								setOpen(true);
							}}
							className={cn(
								badgeVariants({ variant: "outline" }),
								"cursor-pointer hover:bg-muted focus-visible:outline-none",
								className,
							)}
						>
							<GithubIcon />
							{GITHUB_ACTIONS_PILL_LABEL}
						</button>
					</TooltipTrigger>
					<TooltipContent className="z-999 max-w-[320px]">
						<span>
							Built and deployed by GitHub Actions. Click for the run, the image
							and the logs.
						</span>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xl">
					<RunDialogBody
						service={service}
						deployment={deployment}
						onClose={() => setOpen(false)}
						onOpenLogs={(request) => {
							setOpen(false);
							setLogs(request);
						}}
					/>
				</DialogContent>
			</Dialog>
			{logs && (
				<ShowDeployment
					open
					logPath={logs.logPath}
					serverId={logs.serverId}
					errorMessage={logs.errorMessage}
					onClose={() => setLogs(null)}
					githubActions={{ runUrl: logs.runUrl, live: logs.live }}
				/>
			)}
		</>
	);
};
