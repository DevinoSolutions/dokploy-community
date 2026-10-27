import type { IUpdateData } from "@dokploy/server/index";
import {
	compareDokployVersions,
	DOKPLOY_MIN_PINNED_VERSION,
	isBelowDokployPinFloor,
	parseDokployUpdateTarget,
} from "@dokploy/server/utils/dokploy-update-target";
import {
	Bug,
	Download,
	HardDriveDownload,
	Info,
	RefreshCcw,
	Server,
	Sparkles,
	Stars,
	X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { ToggleAutoCheckUpdates } from "./toggle-auto-check-updates";
import { UpdateMigrationNotice } from "./update-migration-notice";
import { UpdateWebServer } from "./update-webserver";

interface Props {
	updateData?: IUpdateData;
	children?: React.ReactNode;
	isOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export const UpdateServer = ({
	updateData,
	children,
	isOpen: isOpenProp,
	onOpenChange: onOpenChangeProp,
}: Props) => {
	const [hasCheckedUpdate, setHasCheckedUpdate] = useState(!!updateData);
	const [isUpdateAvailable, setIsUpdateAvailable] = useState(
		!!updateData?.updateAvailable,
	);
	const { mutateAsync: getUpdateData, isPending } =
		api.settings.getUpdateData.useMutation();
	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();
	const { data: releaseTag } = api.settings.getReleaseTag.useQuery();
	const [latestVersion, setLatestVersion] = useState(
		updateData?.latestVersion ?? "",
	);
	const { data: releaseNotes, isLoading: isLoadingReleaseNotes } =
		api.settings.getReleaseNotes.useQuery(
			{ version: latestVersion },
			{ enabled: isUpdateAvailable && !!latestVersion },
		);
	const [isOpenInternal, setIsOpenInternal] = useState(false);
	const [pinnedTarget, setPinnedTarget] = useState("");
	const trimmedTarget = pinnedTarget.trim();
	const parsedTarget = parseDokployUpdateTarget(trimmedTarget);

	const handleCheckUpdates = async () => {
		try {
			const updateData = await getUpdateData();
			const versionToUpdate = updateData.latestVersion || "";
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(updateData.updateAvailable);
			setLatestVersion(versionToUpdate);

			if (updateData.updateAvailable) {
				toast.success(versionToUpdate, {
					description: "New version available!",
				});
			} else {
				toast.info("No updates available");
			}
		} catch (error) {
			console.error("Error checking for updates:", error);
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(false);
			toast.error(
				"An error occurred while checking for updates, please try again.",
			);
		}
	};

	const isOpen = isOpenInternal || isOpenProp;
	const { data: rollbackPoint } = api.settings.getUpdateRollback.useQuery(
		undefined,
		{ enabled: !!isOpen, retry: false },
	);
	// The version the server reports after the install: the tag, or for a bare
	// digest the recorded rollback (the server accepts no other bare digest).
	const pinnedVersion =
		parsedTarget?.tag ??
		(parsedTarget && rollbackPoint?.digest === parsedTarget.digest
			? rollbackPoint.version
			: undefined);
	let pinnedTargetError: string | null = null;
	if (trimmedTarget && !parsedTarget) {
		pinnedTargetError = "Use a release tag like v0.30.8-community.32.";
	} else if (parsedTarget?.tag && isBelowDokployPinFloor(parsedTarget.tag)) {
		pinnedTargetError = `Releases older than ${DOKPLOY_MIN_PINNED_VERSION} can't be installed from here.`;
	} else if (parsedTarget && !pinnedVersion) {
		pinnedTargetError =
			"A digest is only accepted for the recorded rollback. Use a release tag.";
	} else if (pinnedVersion && pinnedVersion === dokployVersion) {
		pinnedTargetError = `Already running ${pinnedVersion}.`;
	}
	const compareToRunning = (version: string) =>
		dokployVersion ? (compareDokployVersions(version, dokployVersion) ?? 0) : 0;
	const onOpenChange = (open: boolean) => {
		setIsOpenInternal(open);
		onOpenChangeProp?.(open);
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{children ? (
					children
				) : (
					<TooltipProvider delayDuration={0}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant={updateData ? "outline" : "secondary"}
									size="sm"
									onClick={() => onOpenChange?.(true)}
								>
									<Download className="h-4 w-4 shrink-0" />
									{updateData ? (
										<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
											Update Available
										</span>
									) : (
										<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
											Check for updates
										</span>
									)}
									{updateData && (
										<span className="absolute right-2 flex h-2 w-2 group-data-[collapsible=icon]:hidden">
											<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
											<span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
										</span>
									)}
								</Button>
							</TooltipTrigger>
							{updateData && (
								<TooltipContent side="right" sideOffset={10}>
									<p>Update Available</p>
								</TooltipContent>
							)}
						</Tooltip>
					</TooltipProvider>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-lg" showCloseButton={false}>
				<div className="flex items-center gap-2 mb-8">
					<DialogTitle className="text-2xl font-semibold mr-auto">
						Web Server Update
					</DialogTitle>
					{dokployVersion && (
						<div className="flex items-center gap-1.5 rounded-full px-3 py-1 bg-muted">
							<Server className="h-4 w-4 text-muted-foreground" />
							<span className="text-sm text-muted-foreground">
								{dokployVersion}{" "}
								{(releaseTag === "canary" || releaseTag === "feature") &&
									`(${releaseTag})`}
							</span>
						</div>
					)}
					<DialogClose asChild>
						<Button variant="ghost" size="icon-sm" className="shrink-0">
							<X />
							<span className="sr-only">Close</span>
						</Button>
					</DialogClose>
				</div>

				{/* Initial state */}
				{!hasCheckedUpdate && (
					<div className="mb-8">
						<p className="text text-muted-foreground">
							Check for new releases and update Dokploy.
							<br />
							<br />
							We recommend checking for updates regularly to ensure you have the
							latest features and security improvements.
						</p>
					</div>
				)}

				{/* Update available state */}
				{isUpdateAvailable && latestVersion && (
					<div className="mb-8">
						<div className="inline-flex items-center gap-2 rounded-lg px-3 py-2 border border-emerald-900 bg-emerald-900 dark:bg-emerald-900/40 mb-4 w-full">
							<div className="flex items-center gap-1.5">
								<Download className="h-4 w-4 text-emerald-400" />
								<span className="text font-medium text-emerald-400 ">
									New version available:
								</span>
							</div>
							<span className="text font-semibold text-emerald-300">
								{latestVersion}
							</span>
						</div>

						<div className="space-y-4 text-muted-foreground">
							<p className="text">
								A new version of the server software is available. Consider
								updating if you:
							</p>
							<ul className="space-y-3">
								<li className="flex items-start gap-2">
									<Stars className="h-5 w-5 mt-0.5 text-[#5B9DFF]" />
									<span className="text">
										Want to access the latest features and improvements
									</span>
								</li>
								<li className="flex items-start gap-2">
									<Bug className="h-5 w-5 mt-0.5 text-[#5B9DFF]" />
									<span className="text">
										Are experiencing issues that may be resolved in the new
										version
									</span>
								</li>
							</ul>
						</div>

						{/* Combined release notes: our fork release first, then the upstream base release */}
						<div className="mt-6 space-y-4">
							{isLoadingReleaseNotes && (
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<RefreshCcw className="h-4 w-4 animate-spin" />
									Loading release notes...
								</div>
							)}

							{releaseNotes?.fork && (
								<div className="space-y-2">
									<div className="flex items-center justify-between gap-2">
										<h4 className="text-sm font-semibold text-foreground">
											Community release {releaseNotes.fork.tag}
										</h4>
										<Link
											href={releaseNotes.fork.url}
											target="_blank"
											className="text-xs text-[#5B9DFF] underline hover:text-white shrink-0"
										>
											View on GitHub
										</Link>
									</div>
									<div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
										{releaseNotes.fork.body ? (
											<ReactMarkdown className="prose prose-sm dark:prose-invert max-w-none break-words">
												{releaseNotes.fork.body}
											</ReactMarkdown>
										) : (
											<p className="text-sm text-muted-foreground">
												Release notes are unavailable right now.
											</p>
										)}
									</div>
								</div>
							)}

							{releaseNotes?.upstream && (
								<div className="space-y-2">
									<div className="flex items-center justify-between gap-2">
										<h4 className="text-sm font-semibold text-foreground">
											From upstream {releaseNotes.upstream.tag}
										</h4>
										<Link
											href={releaseNotes.upstream.url}
											target="_blank"
											className="text-xs text-[#5B9DFF] underline hover:text-white shrink-0"
										>
											View on GitHub
										</Link>
									</div>
									<div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
										{releaseNotes.upstream.body ? (
											<ReactMarkdown className="prose prose-sm dark:prose-invert max-w-none break-words">
												{releaseNotes.upstream.body}
											</ReactMarkdown>
										) : (
											<p className="text-sm text-muted-foreground">
												Upstream release notes are unavailable right now.
											</p>
										)}
									</div>
								</div>
							)}
						</div>

						<div className="mt-6">
							<UpdateMigrationNotice version={latestVersion} />
						</div>
					</div>
				)}

				{/* Up to date state */}
				{hasCheckedUpdate && !isUpdateAvailable && !isPending && (
					<div className="mb-8">
						<div className="flex flex-col items-center gap-6 mb-6">
							<div className="rounded-full p-4 bg-emerald-400/40">
								<Sparkles className="h-8 w-8 text-emerald-400" />
							</div>
							<div className="text-center space-y-2">
								<h3 className="text-lg font-medium">
									You are using the latest version
								</h3>
								<p className="text text-muted-foreground">
									Your server is up to date with all the latest features and
									security improvements.
								</p>
							</div>
						</div>
					</div>
				)}

				{hasCheckedUpdate && isPending && (
					<div className="mb-8">
						<div className="flex flex-col items-center gap-6 mb-6">
							<div className="rounded-full p-4 bg-[#5B9DFF]/40 text-foreground">
								<RefreshCcw className="h-8 w-8 animate-spin" />
							</div>
							<div className="text-center space-y-2">
								<h3 className="text-lg font-medium">Checking for updates...</h3>
								<p className="text text-muted-foreground">
									Please wait while we pull the latest version information from
									GitHub releases.
								</p>
							</div>
						</div>
					</div>
				)}

				{isUpdateAvailable && (
					<div className="rounded-lg bg-[#16254D] p-4 mb-8">
						<div className="flex gap-2">
							<Info className="h-5 w-5 shrink-0 text-[#5B9DFF]" />
							<div className="text-[#5B9DFF]">
								We recommend reviewing the{" "}
								<Link
									href="https://github.com/DevinoSolutions/dokploy-community/releases"
									target="_blank"
									className="text-white underline hover:text-zinc-200"
								>
									release notes
								</Link>{" "}
								for any breaking changes before updating.
							</div>
						</div>
					</div>
				)}

				<div className="mb-6 space-y-2">
					<p className="text-sm font-medium">Install a specific version</p>
					<div className="flex items-center gap-2">
						<Input
							value={pinnedTarget}
							onChange={(e) => setPinnedTarget(e.target.value)}
							placeholder="v0.30.8-community.32"
							className="font-mono text-xs"
						/>
						{pinnedVersion && !pinnedTargetError ? (
							<UpdateWebServer
								buttonClassName="w-auto"
								pin={{
									target: trimmedTarget,
									version: pinnedVersion,
									label: "Install",
								}}
							/>
						) : (
							<Button variant="outline" disabled>
								<HardDriveDownload className="h-4 w-4" />
								Install
							</Button>
						)}
					</div>
					{pinnedTargetError && (
						<p className="text-xs text-destructive">{pinnedTargetError}</p>
					)}
					{!pinnedTargetError &&
						pinnedVersion &&
						compareToRunning(pinnedVersion) < 0 && (
							<p className="text-xs text-yellow-600 dark:text-yellow-400">
								{pinnedVersion} is older than the running {dokployVersion}.
							</p>
						)}
					{pinnedVersion && !pinnedTargetError && (
						<UpdateMigrationNotice version={pinnedVersion} debounceMs={500} />
					)}
					{rollbackPoint && (
						<div className="space-y-2">
							<UpdateWebServer
								buttonClassName="w-auto"
								pin={{
									version: rollbackPoint.version,
									label:
										compareToRunning(rollbackPoint.version) > 0
											? `Switch to ${rollbackPoint.version}`
											: `Roll back to ${rollbackPoint.version}`,
									isRollback: true,
								}}
							/>
							{rollbackPoint.recordedAt && (
								<p className="text-xs text-muted-foreground">
									Rollback point recorded{" "}
									{new Date(rollbackPoint.recordedAt).toLocaleString()}
								</p>
							)}
							<UpdateMigrationNotice version={rollbackPoint.version} />
						</div>
					)}
				</div>

				<div className="flex items-center justify-between pt-2">
					<ToggleAutoCheckUpdates disabled={isPending} />
				</div>

				<div className="flex items-center justify-end mt-4">
					<div className="flex items-center gap-2">
						<Button variant="outline" onClick={() => onOpenChange?.(false)}>
							Cancel
						</Button>
						{isUpdateAvailable ? (
							<UpdateWebServer buttonClassName="w-auto" />
						) : (
							<Button
								variant="secondary"
								onClick={handleCheckUpdates}
								disabled={isPending}
							>
								{isPending ? (
									<>
										<RefreshCcw className="h-4 w-4 animate-spin" />
										Checking for updates
									</>
								) : (
									<>
										<RefreshCcw className="h-4 w-4" />
										Check for updates
									</>
								)}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};

export default UpdateServer;
