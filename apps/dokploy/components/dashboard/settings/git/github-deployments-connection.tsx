import { ExternalLinkIcon, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";

interface Flow {
	flowId: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
}

/**
 * "Connect GitHub" (device flow): lets a Dokploy that GitHub Actions cannot
 * reach pull deployments from GitHub instead. No GitHub App to create, no
 * secret to paste. Sits with the other Git providers.
 */
export const GithubDeploymentsConnection = () => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: connections, isPending } =
		api.githubDeployment.connections.useQuery(undefined, {
			enabled: isCloud === false,
		});
	const { mutateAsync: startConnect, isPending: isStarting } =
		api.githubDeployment.startConnect.useMutation();
	const { mutateAsync: completeConnect } =
		api.githubDeployment.completeConnect.useMutation();
	const { mutateAsync: disconnect } =
		api.githubDeployment.disconnect.useMutation();

	const [open, setOpen] = useState(false);
	const [flow, setFlow] = useState<Flow | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const stopped = useRef(true);

	// Poll the server at the interval GitHub gave; the server never calls GitHub
	// more often than that, whatever the browser does.
	useEffect(() => {
		if (!flow) return;
		stopped.current = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (stopped.current) return;
			let wait = flow.intervalSeconds;
			try {
				const result = await completeConnect({ flowId: flow.flowId });
				if (result.status === "pending") {
					wait = Math.max(1, result.retryAfterSeconds);
				} else if (result.status === "connected") {
					toast.success(`Connected GitHub as ${result.connection.githubLogin}`);
					setFlow(null);
					setOpen(false);
					await utils.githubDeployment.connections.invalidate();
					return;
				} else {
					setFlow(null);
					setMessage(
						result.status === "denied"
							? "Authorization was denied on GitHub."
							: result.status === "expired"
								? "The code expired. Start again."
								: result.message,
					);
					return;
				}
			} catch (error) {
				setFlow(null);
				setMessage(
					error instanceof Error ? error.message : "Could not reach GitHub",
				);
				return;
			}
			timer = setTimeout(tick, wait * 1000);
		};
		timer = setTimeout(tick, flow.intervalSeconds * 1000);
		return () => {
			stopped.current = true;
			clearTimeout(timer);
		};
	}, [flow, completeConnect, utils]);

	if (isCloud !== false) return null;

	const begin = async () => {
		setMessage(null);
		try {
			setFlow(await startConnect());
		} catch (error) {
			setMessage(
				error instanceof Error
					? error.message
					: "Could not start the connection",
			);
		}
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<GithubIcon className="size-6 text-muted-foreground self-center" />
							GitHub Deployments
						</CardTitle>
						<CardDescription>
							Connect a GitHub account so services can deploy from GitHub
							Deployments, even when Dokploy is behind Tailscale or a private
							network that GitHub Actions cannot reach. Dokploy asks GitHub for
							new deployments; nothing connects inbound. Only the
							repo_deployment and read:packages scopes are requested.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-2 py-8 border-t">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : (
							connections?.map((connection) => (
								<div
									key={connection.connectionId}
									className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
								>
									<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full">
										<div className="flex flex-col gap-1">
											<span className="text-sm font-medium">
												{connection.githubLogin}
											</span>
											<span className="text-xs text-muted-foreground">
												Scopes:{" "}
												{connection.scopes.join(", ") || "none reported"}
											</span>
											{connection.lastError && (
												<span className="text-xs text-destructive">
													{connection.lastError}
												</span>
											)}
										</div>
										<div className="flex items-center gap-2">
											<Badge
												variant={
													connection.status === "active"
														? "green"
														: "destructive"
												}
											>
												{connection.status === "active"
													? "Connected"
													: "Reconnect"}
											</Badge>
											{permissions?.gitProviders.delete && (
												<DialogAction
													title="Disconnect GitHub"
													description={`Disconnect ${connection.githubLogin}? Services that follow GitHub Deployments through it stop doing so. To revoke the grant on GitHub too, remove "Dokploy Community" under GitHub Settings > Applications.`}
													type="destructive"
													onClick={async () => {
														await disconnect({
															connectionId: connection.connectionId,
														})
															.then(async () => {
																toast.success("GitHub disconnected");
																await utils.githubDeployment.connections.invalidate();
															})
															.catch((error) => {
																toast.error(
																	error instanceof Error
																		? error.message
																		: "Error disconnecting GitHub",
																);
															});
													}}
												>
													<Button variant="ghost" size="icon">
														<Trash2 className="size-4 text-muted-foreground" />
													</Button>
												</DialogAction>
											)}
										</div>
									</div>
								</div>
							))
						)}
						{permissions?.gitProviders.create && (
							<Dialog
								open={open}
								onOpenChange={(value) => {
									setOpen(value);
									if (!value) {
										setFlow(null);
										setMessage(null);
									}
								}}
							>
								<DialogTrigger asChild>
									<Button className="gap-2">
										<GithubIcon className="size-4" />
										{connections?.length
											? "Connect another account"
											: "Connect GitHub"}
									</Button>
								</DialogTrigger>
								<DialogContent className="sm:max-w-md">
									<DialogHeader>
										<DialogTitle>Connect GitHub</DialogTitle>
										<DialogDescription>
											Approve "Dokploy Community" on GitHub with a one-time
											code.
										</DialogDescription>
									</DialogHeader>
									{flow ? (
										<div className="flex flex-col items-center gap-4 py-2">
											<span className="text-sm text-muted-foreground text-center">
												Open GitHub, enter this code and approve.
											</span>
											<code className="text-3xl font-mono tracking-widest select-all">
												{flow.userCode}
											</code>
											<Button asChild variant="outline" className="gap-2">
												<a
													href={flow.verificationUri}
													target="_blank"
													rel="noreferrer"
												>
													Open{" "}
													{flow.verificationUri.replace(/^https?:\/\//, "")}
													<ExternalLinkIcon className="size-4" />
												</a>
											</Button>
											<div className="flex flex-row gap-2 items-center text-sm text-muted-foreground">
												<Loader2 className="animate-spin size-4" />
												Waiting for approval...
											</div>
										</div>
									) : (
										<div className="flex flex-col gap-3 py-2">
											{message && (
												<span className="text-sm text-destructive">
													{message}
												</span>
											)}
											<Button onClick={begin} isLoading={isStarting}>
												Get a code
											</Button>
										</div>
									)}
								</DialogContent>
							</Dialog>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
