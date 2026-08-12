import {
	ExternalLink,
	FileText,
	GitPullRequest,
	Hammer,
	Loader2,
	RocketIcon,
	Trash2,
} from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { toast } from "sonner";
import { GithubIcon, GitlabIcon } from "@/components/icons/data-tools-icons";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { ShowDeploymentsModal } from "../../application/deployments/show-deployments-modal";
import { ShowModalLogs } from "../../settings/web-server/show-modal-logs";
import { ShowPreviewSettingsCompose } from "./show-preview-settings";

interface Props {
	composeId: string;
}

export const ShowPreviewDeploymentsCompose = ({ composeId }: Props) => {
	const { data } = api.compose.one.useQuery({ composeId });
	const isGitlab = data?.sourceType === "gitlab";
	const ChangeRequestIcon = isGitlab ? GitlabIcon : GithubIcon;
	const changeRequestLabel = isGitlab ? "Merge Request" : "Pull Request";

	const { mutateAsync: deletePreviewDeployment, isPending } =
		api.previewDeployment.delete.useMutation();

	const { mutateAsync: redeployPreviewDeployment } =
		api.previewDeployment.redeploy.useMutation();

	const {
		data: previewDeployments,
		refetch: refetchPreviewDeployments,
		isLoading: isLoadingPreviewDeployments,
	} = api.previewDeployment.all.useQuery(
		{ composeId },
		{
			enabled: !!composeId,
			refetchInterval: 2000,
		},
	);

	const handleDeletePreviewDeployment = async (previewDeploymentId: string) => {
		deletePreviewDeployment({
			previewDeploymentId: previewDeploymentId,
		})
			.then(() => {
				refetchPreviewDeployments();
				toast.success("Preview deployment deleted");
			})
			.catch((error) => {
				toast.error(error.message);
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
				<div className="flex flex-col gap-2">
					<CardTitle className="text-xl">Preview Deployments</CardTitle>
					<CardDescription>See all the preview deployments</CardDescription>
				</div>
				{data?.isPreviewDeploymentsActive && (
					<ShowPreviewSettingsCompose composeId={composeId} />
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{data?.isPreviewDeploymentsActive ? (
					<>
						<div className="flex flex-col gap-2 text-sm">
							<span>
								Each {changeRequestLabel.toLowerCase()} gets an isolated copy of
								this stack. The copy has its own service domains, volumes, and
								network.
							</span>
						</div>
						{isLoadingPreviewDeployments ? (
							<div className="flex w-full flex-row items-center justify-center gap-3 min-h-[35vh]">
								<Loader2 className="size-5 text-muted-foreground animate-spin" />
								<span className="text-base text-muted-foreground">
									Loading preview deployments...
								</span>
							</div>
						) : !previewDeployments?.length ? (
							<div className="flex w-full flex-col items-center justify-center gap-3 min-h-[35vh]">
								<RocketIcon className="size-8 text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									No preview deployments found
								</span>
							</div>
						) : (
							<div className="flex flex-col gap-4">
								{previewDeployments?.map((deployment) => {
									const status = deployment.previewStatus;
									// Compose previews attach one domain per service; the legacy
									// single-domain field covers application-style rows.
									const previewDomains = deployment.domains?.length
										? deployment.domains
										: deployment.domain
											? [deployment.domain]
											: [];
									return (
										<div
											key={deployment.previewDeploymentId}
											className="group relative overflow-hidden border rounded-lg transition-colors"
										>
											<div
												className={`absolute left-0 top-0 w-1 h-full ${
													status === "done"
														? "bg-green-500"
														: status === "running"
															? "bg-yellow-500"
															: "bg-red-500"
												}`}
											/>

											<div className="p-4">
												<div className="flex items-start justify-between mb-3">
													<div className="flex items-start gap-3">
														<GitPullRequest className="size-5 text-muted-foreground mt-1 shrink-0" />
														<div>
															<div className="font-medium text-sm">
																{deployment.pullRequestTitle}
															</div>
															<div className="text-sm text-muted-foreground mt-1">
																{deployment.branch}
															</div>
														</div>
													</div>
													<Badge variant="outline" className="gap-2">
														<StatusTooltip
															status={deployment.previewStatus}
															className="size-2"
														/>
														<DateTooltip date={deployment.createdAt} />
													</Badge>
												</div>

												<div className="pl-8 space-y-3">
													{previewDomains.map((domain) => {
														const deploymentUrl = `${domain.https ? "https" : "http"}://${domain.host}${domain.path || "/"}`;
														return (
															<div
																key={domain.domainId}
																className="flex flex-col gap-1"
															>
																{domain.serviceName && (
																	<span className="text-xs text-muted-foreground">
																		{domain.serviceName}
																	</span>
																)}
																<div className="relative grow">
																	<Input
																		value={deploymentUrl}
																		readOnly
																		className="pr-8 text-sm text-blue-500 hover:text-blue-600 cursor-pointer"
																		onClick={() =>
																			window.open(deploymentUrl, "_blank")
																		}
																	/>
																	<ExternalLink className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
																</div>
															</div>
														);
													})}

													<div className="flex gap-2 opacity-80 group-hover:opacity-100 transition-opacity">
														<Button
															variant="outline"
															size="sm"
															className="gap-2"
															onClick={() =>
																window.open(deployment.pullRequestURL, "_blank")
															}
														>
															<ChangeRequestIcon className="size-4" />
															{changeRequestLabel}
														</Button>
														<ShowModalLogs
															appName={deployment.appName}
															serverId={data?.serverId || ""}
														>
															<Button
																variant="outline"
																size="sm"
																className="gap-2"
															>
																<FileText className="size-4" />
																Logs
															</Button>
														</ShowModalLogs>

														<ShowDeploymentsModal
															id={deployment.previewDeploymentId}
															type="previewDeployment"
															serverId={data?.serverId || ""}
														>
															<Button
																variant="outline"
																size="sm"
																className="gap-2"
															>
																<RocketIcon className="size-4" />
																Deployments
															</Button>
														</ShowDeploymentsModal>

														<DialogAction
															title="Rebuild Preview Deployment"
															description="Are you sure you want to rebuild this preview deployment?"
															type="default"
															onClick={async () => {
																await redeployPreviewDeployment({
																	previewDeploymentId:
																		deployment.previewDeploymentId,
																})
																	.then(() => {
																		toast.success(
																			"Preview deployment rebuild started",
																		);
																		refetchPreviewDeployments();
																	})
																	.catch(() => {
																		toast.error(
																			"Error rebuilding preview deployment",
																		);
																	});
															}}
														>
															<Button
																variant="outline"
																size="sm"
																isLoading={status === "running"}
																className="gap-2"
															>
																<TooltipProvider>
																	<Tooltip>
																		<TooltipTrigger asChild>
																			<div className="flex items-center gap-2">
																				<Hammer className="size-4" />
																				Rebuild
																			</div>
																		</TooltipTrigger>
																		<TooltipPrimitive.Portal>
																			<TooltipContent
																				sideOffset={5}
																				className="z-60"
																			>
																				<p>
																					Rebuild the preview stack from the
																					latest{" "}
																					{changeRequestLabel.toLowerCase()}{" "}
																					code
																				</p>
																			</TooltipContent>
																		</TooltipPrimitive.Portal>
																	</Tooltip>
																</TooltipProvider>
															</Button>
														</DialogAction>

														<DialogAction
															title="Delete Preview"
															description="Are you sure you want to delete this preview? The stack, volumes and network of this preview will be removed."
															onClick={() =>
																handleDeletePreviewDeployment(
																	deployment.previewDeploymentId,
																)
															}
														>
															<Button
																variant="ghost"
																size="sm"
																isLoading={isPending}
																className="text-red-600 hover:text-red-700 hover:bg-red-50"
															>
																<Trash2 className="size-4" />
															</Button>
														</DialogAction>
													</div>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</>
				) : (
					<div className="flex w-full flex-col items-center justify-center gap-3 pt-10">
						<RocketIcon className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							Preview deployments are disabled for this compose service, please
							enable it
						</span>
						<ShowPreviewSettingsCompose composeId={composeId} />
					</div>
				)}
			</CardContent>
		</Card>
	);
};
