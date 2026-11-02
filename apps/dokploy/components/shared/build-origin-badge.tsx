import {
	BUILD_ORIGIN_LABELS,
	isBuildOrigin,
	normalizeBuildRunUrl,
} from "@dokploy/server/services/build-origin-shared";
import { ExternalLink, Hammer, Package } from "lucide-react";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
							</a>
						</Badge>
					) : (
						<Badge variant="outline" className={className}>
							{content}
						</Badge>
					)}
				</TooltipTrigger>
				<TooltipContent className="z-999 max-w-[320px]">
					<div className="flex flex-col gap-1">
						<span>{description}</span>
						{buildOrigin === "github-actions" && (
							<span className="break-all text-muted-foreground">
								{runUrl ? `Run: ${runUrl}` : "The run link was not recorded."}
							</span>
						)}
					</div>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
};

/**
 * A Deployments tab row built in GitHub Actions: the mark and, when the run link was recorded, "View run".
 */
export const GithubActionsDeploymentMark = ({
	buildRunUrl,
}: {
	buildRunUrl?: string | null;
}) => {
	const runUrl = normalizeBuildRunUrl(buildRunUrl);
	return (
		<span className="flex flex-wrap items-center gap-2 normal-case">
			<Badge variant="outline" className="text-[10px] gap-1">
				<GithubIcon />
				Built on GitHub Actions
			</Badge>
			{runUrl && (
				<a
					href={runUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-1 text-xs text-primary hover:underline"
				>
					View run
					<ExternalLink className="size-3" />
				</a>
			)}
		</span>
	);
};

/**
 * Shown above the log of a deployment built in GitHub Actions: Dokploy only pulls and starts the image, so the
 * build output is on GitHub.
 */
export const GithubActionsLogBanner = ({
	buildRunUrl,
}: {
	buildRunUrl?: string | null;
}) => {
	const runUrl = normalizeBuildRunUrl(buildRunUrl);
	return (
		<div className="flex flex-wrap items-center gap-2 rounded border bg-muted/50 px-3 py-2 text-sm">
			<GithubIcon />
			<span>Build logs live on GitHub Actions.</span>
			{runUrl ? (
				<a
					href={runUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-1 text-primary hover:underline"
				>
					Open run
					<ExternalLink className="size-3" />
				</a>
			) : (
				<span className="text-muted-foreground">
					The run link was not recorded.
				</span>
			)}
		</div>
	);
};

/** Replaces the build settings of a service that GitHub Actions builds. The settings stay in the database. */
export const GithubActionsBuildsNote = ({
	buildRunUrl,
}: {
	buildRunUrl?: string | null;
}) => {
	const runUrl = normalizeBuildRunUrl(buildRunUrl);
	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<GithubIcon />
					Builds run in GitHub Actions
				</CardTitle>
				<CardDescription>
					Dokploy only pulls and starts the image, so the build settings do not
					apply. They are kept and show again if the service is built here.
					{runUrl && (
						<>
							{" "}
							<a
								href={runUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:underline"
							>
								Open the latest run
							</a>
							.
						</>
					)}
				</CardDescription>
			</CardHeader>
		</Card>
	);
};
