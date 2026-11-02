import {
	describeImageReference,
	githubCommitUrl,
	githubRepositoryUrl,
	normalizeBuildRunUrl,
} from "@dokploy/server/services/build-origin-shared";
import copy from "copy-to-clipboard";
import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** The fields application.one / compose.one return for a service built in GitHub Actions (T-12424). */
export interface GithubActionsServiceInfo {
	buildRunUrl?: string | null;
	buildRepository?: string | null;
	buildCommitSha?: string | null;
	buildEnvironment?: string | null;
	buildRunId?: string | null;
	buildDeployedAt?: string | null;
}

/** The hint under the deploy button of a service that GitHub Actions builds. */
export const GithubActionsRedeployHint = ({
	target,
}: {
	target?: string | null;
}) => (
	<p className="text-sm text-muted-foreground">
		To ship a new version, push to {target || "your repository"}. GitHub Actions
		builds and deploys it.
	</p>
);

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
		className="inline-flex items-center gap-1 text-primary hover:underline"
	>
		{children}
		<ExternalLink className="size-3" />
	</a>
);

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
	<div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
		<dt className="text-sm text-muted-foreground sm:w-36 sm:shrink-0">
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

interface PanelProps extends GithubActionsServiceInfo {
	/** The image references the service runs: one for an application, one per service for a compose. */
	images: readonly string[];
}

/**
 * The primary view of the General tab for a service that GitHub Actions builds: where the running image came
 * from and how it gets updated, in plain words. The raw image or compose editor sits behind "Advanced".
 */
export const GithubActionsPanel = ({
	images,
	buildRunUrl,
	buildRepository,
	buildCommitSha,
	buildEnvironment,
	buildRunId,
	buildDeployedAt,
}: PanelProps) => {
	const runUrl = normalizeBuildRunUrl(buildRunUrl);
	const repositoryUrl = githubRepositoryUrl(buildRepository);
	const commitUrl = githubCommitUrl(buildRepository, buildCommitSha);
	const shortSha = buildCommitSha?.slice(0, 7) ?? null;
	const runLabel = buildRunId ? `Run #${buildRunId}` : "Open run";
	const knowsTheRun = Boolean(repositoryUrl || runUrl || buildRunId);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<GithubIcon />
					Deployed from GitHub Actions
				</CardTitle>
				<CardDescription>
					GitHub Actions builds this service and hands the finished image to
					Dokploy. Dokploy only pulls it and starts it.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<dl className="flex flex-col gap-3">
					{buildRepository && repositoryUrl && (
						<Row label="Repository">
							<ExternalLinkText href={repositoryUrl}>
								{buildRepository}
							</ExternalLinkText>
						</Row>
					)}
					{buildEnvironment && (
						<Row label="Environment">{buildEnvironment}</Row>
					)}
					{shortSha && (
						<Row label="Commit">
							{commitUrl ? (
								<ExternalLinkText href={commitUrl}>
									<code className="font-mono">{shortSha}</code>
								</ExternalLinkText>
							) : (
								<code className="font-mono">{shortSha}</code>
							)}
						</Row>
					)}
					{(runUrl || buildRunId) && (
						<Row label="Workflow run">
							{runUrl ? (
								<ExternalLinkText href={runUrl}>{runLabel}</ExternalLinkText>
							) : (
								runLabel
							)}
						</Row>
					)}
					{buildDeployedAt && (
						<Row label="Last deployed">
							<DateTooltip date={buildDeployedAt} className="text-foreground" />
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
				<div className="flex flex-col gap-1 text-sm text-muted-foreground">
					<p>This image is updated by your workflow on every deploy.</p>
					{!knowsTheRun && (
						<p>
							The repository and the run show up here after the next deploy from
							GitHub Actions.
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
};

interface AdvancedProps {
	description: string;
	children: ReactNode;
}

/**
 * Keeps the raw image or compose editor (and the other source options) one click away, closed by default, so the
 * primary view of a GitHub Actions service stays about what is running and where it came from.
 */
export const GithubActionsAdvanced = ({
	description,
	children,
}: AdvancedProps) => {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="rounded-lg border bg-background"
		>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="flex w-full items-center justify-between gap-4 rounded-lg px-6 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span className="flex flex-col gap-0.5">
						<span className="font-medium">Advanced</span>
						<span className="text-sm text-muted-foreground">{description}</span>
					</span>
					<ChevronDown
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform",
							open && "rotate-180",
						)}
					/>
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent className="flex flex-col gap-4 border-t p-4">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
};
