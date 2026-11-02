import {
	BUILD_ORIGIN_LABELS,
	githubCommitUrl,
	isBuildOrigin,
	normalizeBuildRunUrl,
} from "@dokploy/server/services/build-origin-shared";
import { ExternalLink, Hammer, Package } from "lucide-react";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { OpensInNewTab } from "@/components/shared/opens-in-new-tab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
	buildOrigin?: string | null;
	buildRunUrl?: string | null;
	/**
	 * Make the badge a link to the GitHub Actions run when there is one. Leave it
	 * off where the badge sits inside another link (the service cards).
	 */
	linkToRun?: boolean;
	className?: string;
}

/**
 * Where the image of an application or compose was built: Dokploy, GitHub
 * Actions (with the run link when known) or a prebuilt image. Renders nothing
 * until the API has a value.
 */
export const BuildOriginBadge = ({
	buildOrigin,
	buildRunUrl,
	linkToRun = false,
	className,
}: Props) => {
	if (!isBuildOrigin(buildOrigin)) return null;
	const { label, description } = BUILD_ORIGIN_LABELS[buildOrigin];
	const runUrl =
		buildOrigin === "github-actions" ? normalizeBuildRunUrl(buildRunUrl) : null;

	const content = (
		<>
			{buildOrigin === "github-actions" && <GithubIcon />}
			{buildOrigin === "dokploy" && <Hammer />}
			{buildOrigin === "external" && <Package />}
			{label}
		</>
	);

	return (
		<TooltipProvider delayDuration={0}>
			<Tooltip>
				<TooltipTrigger asChild>
					{runUrl && linkToRun ? (
						<Badge
							variant="outline"
							className={cn("cursor-pointer", className)}
							asChild
						>
							<a
								href={runUrl}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(e) => e.stopPropagation()}
							>
								{content}
								<OpensInNewTab />
							</a>
						</Badge>
					) : (
						<Badge variant="outline" className={className}>
							{content}
						</Badge>
					)}
				</TooltipTrigger>
				<TooltipContent className="z-999 max-w-[320px]">
					<span>{description}</span>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
};

/**
 * A Deployments tab row built in GitHub Actions: the GitHub mark, the commit (linked when the repository is
 * known) and the run link. The duration sits next to it in the row itself.
 */
export const GithubActionsDeploymentMark = ({
	buildRunUrl,
	buildRepository,
	buildCommitSha,
	buildRunId,
}: {
	buildRunUrl?: string | null;
	buildRepository?: string | null;
	buildCommitSha?: string | null;
	buildRunId?: string | null;
}) => {
	const runUrl = normalizeBuildRunUrl(buildRunUrl);
	const commitUrl = githubCommitUrl(buildRepository, buildCommitSha);
	const shortSha = buildCommitSha?.slice(0, 7) ?? null;
	const runLabel = buildRunId ? `Run #${buildRunId}` : "Open run";
	return (
		<span className="flex flex-wrap items-center gap-2 normal-case">
			<Badge variant="outline" className="gap-1 text-[10px]">
				<GithubIcon />
				{shortSha ? (
					commitUrl ? (
						<a
							href={commitUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="font-mono hover:underline"
						>
							{shortSha}
							<OpensInNewTab />
						</a>
					) : (
						<span className="font-mono">{shortSha}</span>
					)
				) : (
					"GitHub Actions"
				)}
			</Badge>
			{runUrl ? (
				<a
					href={runUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-1 text-xs text-primary hover:underline"
				>
					{runLabel}
					<ExternalLink className="size-3" />
					<OpensInNewTab />
				</a>
			) : (
				buildRunId && (
					<span className="text-xs text-muted-foreground">{runLabel}</span>
				)
			)}
		</span>
	);
};

/**
 * Shown above the log of a deployment built in GitHub Actions. The build output is on GitHub, so the way there is
 * the primary action; the log below it is only Dokploy's own pull and start.
 */
export const GithubActionsLogBanner = ({
	buildRunUrl,
}: {
	buildRunUrl?: string | null;
}) => {
	const runUrl = normalizeBuildRunUrl(buildRunUrl);
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded border bg-muted/50 px-4 py-3">
			<div className="flex items-center gap-2 text-sm">
				<GithubIcon />
				<span>
					Built and deployed by GitHub Actions. The build log is on GitHub.
				</span>
			</div>
			{runUrl ? (
				<Button asChild size="sm">
					<a href={runUrl} target="_blank" rel="noopener noreferrer">
						Open run on GitHub
						<ExternalLink className="size-3.5" />
						<OpensInNewTab />
					</a>
				</Button>
			) : (
				<span className="text-sm text-muted-foreground">
					The run link was not recorded.
				</span>
			)}
		</div>
	);
};
