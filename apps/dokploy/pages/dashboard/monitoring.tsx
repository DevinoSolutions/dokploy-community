import { IS_CLOUD } from "@dokploy/server/constants";
import { validateRequest } from "@dokploy/server/lib/auth";
import { LOCAL_SERVER_ID } from "@dokploy/server/monitoring/constants";
import { hasPermission } from "@dokploy/server/services/permission";
import { Loader2 } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import Link from "next/link";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { ContainerFreeMonitoring } from "@/components/dashboard/monitoring/free/container/show-free-container-monitoring";
import { ShowPaidMonitoring } from "@/components/dashboard/monitoring/paid/servers/show-paid-monitoring";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { canShowLocalHost } from "@/lib/local-host-flag";
import { api } from "@/utils/api";

const Dashboard = () => {
	const [toggleMonitoring, _setToggleMonitoring] = useLocalStorage(
		"monitoring-enabled",
		false,
	);

	const {
		data: monitoring,
		isPending,
		isError: isMonitoringError,
	} = api.user.getMetricsToken.useQuery();
	const [selectedServerId, setSelectedServerId] =
		useState<string>(LOCAL_SERVER_ID);
	const { data: servers } = api.server.getServersForMonitoring.useQuery();
	// The Dokploy host serves every organization of the instance, so only the
	// one that owns it monitors it: any other starts on its first server, and so
	// does one whose flag failed to load.
	const canMonitorLocalHost = canShowLocalHost({
		enabled: true,
		isError: isMonitoringError,
		localHostAccess: monitoring?.localHostAccess,
	});
	const firstServerId = servers?.[0]?.serverId;
	useEffect(() => {
		if (!canMonitorLocalHost && firstServerId) {
			setSelectedServerId((current) =>
				current === LOCAL_SERVER_ID ? firstServerId : current,
			);
		}
	}, [canMonitorLocalHost, firstServerId]);
	// Nothing to pick: the host is not this organization's and it has no servers
	const noServersToPick = !canMonitorLocalHost && servers?.length === 0;
	const hostRefused =
		!canMonitorLocalHost && selectedServerId === LOCAL_SERVER_ID;
	const isRemoteSelected = selectedServerId !== LOCAL_SERVER_ID;
	const selectedServer = isRemoteSelected
		? servers?.find((s) => s.serverId === selectedServerId)
		: undefined;
	// Fetch the metrics token only when a remote server is selected. The
	// dropdown list does not include the token; it is gated by `monitoring:read`
	// here so users with read-only monitoring access can still scope to a
	// specific server without seeing other tokens.
	const {
		data: remoteMonitoringConfig,
		isPending: remoteMonitoringConfigPending,
	} = api.server.getMonitoringConfig.useQuery(
		{ serverId: selectedServerId },
		{ enabled: isRemoteSelected },
	);

	// The metrics endpoint and its token are resolved server-side from the
	// selected `serverId` (or from the web-server settings for the local host);
	// this page only decides *which* server to ask about. `getMonitoringConfig`
	// is still queried so we can show the "not configured" hint before firing a
	// metrics request that would fail.
	let paidMonitoringContent: ReactElement;
	if (hostRefused) {
		paidMonitoringContent = (
			<Card className="bg-sidebar p-2.5 rounded-xl mx-auto">
				<div className="rounded-xl bg-background shadow-md p-6 text-sm text-muted-foreground">
					Monitoring is available for your servers. Add one under{" "}
					<Link className="underline" href="/dashboard/settings/servers">
						Remote Servers
					</Link>{" "}
					to see its metrics here.
				</div>
			</Card>
		);
	} else if (selectedServer) {
		const remotePort = remoteMonitoringConfig?.port;
		const remoteToken = remoteMonitoringConfig?.token;
		// Hold the loader while the remote config is in flight so the user
		// doesn't see a "Monitoring is not configured" flash before the query
		// resolves.
		if (remoteMonitoringConfigPending) {
			paidMonitoringContent = (
				<Card className="bg-sidebar  p-2.5 rounded-xl  mx-auto  items-center">
					<div className="rounded-xl bg-background flex shadow-md px-4 min-h-[50vh] justify-center items-center text-muted-foreground">
						Loading...
						<Loader2 className="h-4 w-4 animate-spin" />
					</div>
				</Card>
			);
		} else if (!remotePort || !remoteToken) {
			paidMonitoringContent = (
				<Card className="bg-sidebar p-2.5 rounded-xl mx-auto">
					<div className="rounded-xl bg-background shadow-md p-6 text-sm text-muted-foreground space-y-2">
						<p>Monitoring is not configured for this server.</p>
						<p>
							Go to{" "}
							<Link className="underline" href="/dashboard/settings/servers">
								Remote Servers
							</Link>{" "}
							→ {selectedServer.name} → Setup Monitoring.
						</p>
					</div>
				</Card>
			);
		} else {
			paidMonitoringContent = (
				<Card
					key={`paid-${selectedServerId}`}
					className="bg-sidebar  p-2.5 rounded-xl  mx-auto"
				>
					<div className="rounded-xl bg-background shadow-md">
						<ShowPaidMonitoring serverId={selectedServerId} />
					</div>
				</Card>
			);
		}
	} else {
		paidMonitoringContent = (
			<Card className="bg-sidebar  p-2.5 rounded-xl  mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<ShowPaidMonitoring />
				</div>
			</Card>
		);
	}

	return (
		<div className="space-y-4 pb-10">
			{/* <AlertBlock>
				You are watching the <strong>Free</strong> plan.{" "}
				<a
					href="https://dokploy.com#pricing"
					target="_blank"
					className="underline"
					rel="noreferrer"
				>
					Upgrade
				</a>{" "}
				to get more features.
			</AlertBlock> */}
			<div className="flex items-center gap-2">
				<Label htmlFor="monitoring-server-select">Server</Label>
				{noServersToPick ? (
					<p className="text-sm text-muted-foreground">
						No servers yet. Add a server under Remote Servers to monitor it.
					</p>
				) : (
					<Select value={selectedServerId} onValueChange={setSelectedServerId}>
						<SelectTrigger id="monitoring-server-select" className="w-[260px]">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{canMonitorLocalHost && (
								<SelectItem value={LOCAL_SERVER_ID}>
									<span className="flex items-center gap-2 justify-between w-full">
										<span>Dokploy (Main)</span>
										{monitoring?.serverIp ? (
											<span className="text-muted-foreground text-xs">
												{monitoring.serverIp}
											</span>
										) : null}
									</span>
								</SelectItem>
							)}
							{servers?.map((server) => (
								<SelectItem key={server.serverId} value={server.serverId}>
									<span className="flex items-center gap-2 justify-between w-full">
										<span>{server.name}</span>
										<span className="text-muted-foreground text-xs">
											{server.ipAddress}
										</span>
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</div>
			{isPending ? (
				<Card className="bg-sidebar  p-2.5 rounded-xl  mx-auto  items-center">
					<div className="rounded-xl bg-background flex shadow-md px-4 w-full min-h-[50vh] justify-center items-center text-muted-foreground">
						Loading... <Loader2 className="h-4 w-4 animate-spin" />
					</div>
				</Card>
			) : (
				<>
					{/* {monitoring?.enabledFeatures && (
						<div className="flex flex-row border w-fit p-4 rounded-lg items-center gap-2">
							<Label className="text-muted-foreground">Change Monitoring</Label>
							<Switch
								checked={toggleMonitoring}
								onCheckedChange={setToggleMonitoring}
							/>
						</div>
					)} */}
					{hostRefused || toggleMonitoring ? (
						paidMonitoringContent
					) : (
						<Card className="h-full bg-sidebar  p-2.5 rounded-xl">
							<div className="rounded-xl bg-background shadow-md p-6">
								<ContainerFreeMonitoring
									key={selectedServerId}
									appName="dokploy"
									serverId={selectedServerId}
								/>
							</div>
						</Card>
					)}
				</>
			)}
		</div>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
	}

	const permissionCtx = {
		user: { id: user.id },
		session: { activeOrganizationId: session?.activeOrganizationId || "" },
	};
	const [canReadMonitoring, canReadDocker] = await Promise.all([
		hasPermission(permissionCtx, { monitoring: ["read"] }),
		hasPermission(permissionCtx, { docker: ["read"] }),
	]);
	const canView = canReadMonitoring && canReadDocker;

	if (!canView) {
		return {
			redirect: {
				permanent: false,
				destination: "/dashboard/home",
			},
		};
	}

	return {
		props: {},
	};
}
