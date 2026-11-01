import {
	BUILD_ORIGIN_LABELS,
	isBuildOrigin,
	normalizeBuildRunUrl,
} from "@dokploy/server/services/build-origin-shared";
import { Hammer, Package } from "lucide-react";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { Badge } from "@/components/ui/badge";
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
