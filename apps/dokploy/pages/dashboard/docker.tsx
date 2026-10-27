import { validateRequest } from "@dokploy/server/lib/auth";
import { createServerSideHelpers } from "@trpc/react-query/server";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowDiskUsage } from "@/components/dashboard/docker/disk-usage/show-disk-usage";
import { ShowDockerEvents } from "@/components/dashboard/docker/events/show-docker-events";
import { ShowHealth } from "@/components/dashboard/docker/health/show-health";
import { ShowImages } from "@/components/dashboard/docker/images/show-images";
import { LocalHostOnlyNotice } from "@/components/dashboard/docker/local-host-only";
import { ShowContainers } from "@/components/dashboard/docker/show/show-containers";
import { ShowVolumes } from "@/components/dashboard/docker/volumes/show-volumes";
import { ShowNetworks } from "@/components/dashboard/networks/show-networks";
import { ShowNodes } from "@/components/dashboard/settings/cluster/nodes/show-nodes";
import { ShowSwarmContainers } from "@/components/dashboard/swarm/containers/show-swarm-containers";
import SwarmMonitorCard from "@/components/dashboard/swarm/monitoring-card";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { ServerFilter } from "@/components/shared/server-filter";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	canShowLocalHost,
	explainsEmptyLocalHost,
} from "@/lib/local-host-flag";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const DEFAULT_TAB = "containers";
const ADMIN_SWARM_TAB = "overview";
const MEMBER_SWARM_TAB = "containers";

const Dashboard = () => {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: auth } = api.user.get.useQuery();
	// Volume names, images, nodes and the host's health belong to no service, so
	// their APIs are owner/admin only.
	const isAdmin = auth?.role === "owner" || auth?.role === "admin";
	const canSeeVolumes = isAdmin;
	const canSeeImages = isAdmin;
	const canSeeNodes = isAdmin;
	// Host-level diagnostics, so this needs server.read on top of docker.read.
	const canSeeHealth =
		isAdmin && !!permissions?.docker.read && !!permissions?.server.read;
	// The Dokploy host serves every organization of the instance, so only the
	// one that owns it sees the host's Docker data; a remote server is unaffected.
	// The flag comes from a monitoring:read route, so users without monitoring.read
	// keep the old behaviour (the content, whatever the host answers).
	// A flag that failed to load shows no host, like an organization that does
	// not own it.
	const canReadMonitoring = !!permissions?.monitoring.read;
	const {
		data: metrics,
		isLoading: isLoadingMetrics,
		isError: isMetricsError,
	} = api.user.getMetricsToken.useQuery(undefined, {
		enabled: canReadMonitoring,
	});
	const canSeeLocalHost = canShowLocalHost({
		enabled: canReadMonitoring,
		isError: isMetricsError,
		localHostAccess: metrics?.localHostAccess,
	});
	// Hold the host's tabs back until the flag is known, so an organization that
	// does not own the host never fires a query the host would refuse.
	const isHostFlagPending = !permissions || isLoadingMetrics;
	const hostGate = (serverId: string | undefined, content: ReactElement) => {
		if (serverId) return content;
		if (isHostFlagPending) return null;
		return canSeeLocalHost ? content : <LocalHostOnlyNotice />;
	};

	const queryTab =
		typeof router.query.tab === "string" ? router.query.tab : DEFAULT_TAB;
	const activeTab =
		(queryTab === "health" && !canSeeHealth) ||
		(queryTab === "images" && !canSeeImages) ||
		(queryTab === "volumes" && !canSeeVolumes)
			? DEFAULT_TAB
			: queryTab;

	const defaultSwarmTab = canSeeNodes ? ADMIN_SWARM_TAB : MEMBER_SWARM_TAB;
	const querySwarmTab =
		typeof router.query.subtab === "string"
			? router.query.subtab
			: defaultSwarmTab;
	const activeSwarmTab =
		!canSeeNodes && querySwarmTab !== MEMBER_SWARM_TAB
			? MEMBER_SWARM_TAB
			: querySwarmTab;

	const setTab = (value: string) => {
		const { tab: _current, subtab: _subtab, ...query } = router.query;
		router.replace(
			{
				pathname: router.pathname,
				query: value === DEFAULT_TAB ? query : { ...query, tab: value },
			},
			undefined,
			{ shallow: true },
		);
	};

	const setSwarmTab = (value: string) => {
		const { subtab: _current, ...query } = router.query;
		router.replace(
			{
				pathname: router.pathname,
				query: value === defaultSwarmTab ? query : { ...query, subtab: value },
			},
			undefined,
			{ shallow: true },
		);
	};

	return (
		<ServerFilter>
			{(serverId) => (
				<Tabs value={activeTab} onValueChange={setTab}>
					<TabsList>
						<TabsTrigger value="containers">Containers</TabsTrigger>
						<TabsTrigger value="swarm">Swarm</TabsTrigger>
						{canSeeImages && <TabsTrigger value="images">Images</TabsTrigger>}
						{canSeeVolumes && (
							<TabsTrigger value="volumes">Volumes</TabsTrigger>
						)}
						<TabsTrigger value="networks">Networks</TabsTrigger>
						<TabsTrigger value="events">Events</TabsTrigger>
						<TabsTrigger value="disk-usage">Disk Usage</TabsTrigger>
						{canSeeHealth && <TabsTrigger value="health">Health</TabsTrigger>}
					</TabsList>
					<TabsContent value="containers">
						{/* The list is filtered to the services the caller can read, which
							include their own on the host, so it is not held back like the
							host's other tabs; only its empty state explains the host. */}
						<ShowContainers
							serverId={serverId}
							explainEmptyHost={explainsEmptyLocalHost({
								serverId,
								isFlagPending: isHostFlagPending,
								canSeeLocalHost,
							})}
						/>
					</TabsContent>
					<TabsContent value="swarm">
						<Tabs value={activeSwarmTab} onValueChange={setSwarmTab}>
							<TabsList>
								{canSeeNodes && (
									<TabsTrigger value="overview">Overview</TabsTrigger>
								)}
								<TabsTrigger value="containers">Containers</TabsTrigger>
								{canSeeNodes && <TabsTrigger value="nodes">Nodes</TabsTrigger>}
							</TabsList>
							{canSeeNodes && (
								<TabsContent value="overview">
									{hostGate(serverId, <SwarmMonitorCard serverId={serverId} />)}
								</TabsContent>
							)}
							<TabsContent value="containers">
								<Card className="h-full bg-sidebar p-2.5 rounded-xl mx-auto w-full">
									<div className="rounded-xl bg-background shadow-md p-6">
										<ShowSwarmContainers serverId={serverId} />
									</div>
								</Card>
							</TabsContent>
							{canSeeNodes && (
								<TabsContent value="nodes">
									{hostGate(serverId, <ShowNodes serverId={serverId} />)}
								</TabsContent>
							)}
						</Tabs>
					</TabsContent>
					{canSeeImages && (
						<TabsContent value="images">
							{hostGate(serverId, <ShowImages serverId={serverId} />)}
						</TabsContent>
					)}
					{canSeeVolumes && (
						<TabsContent value="volumes">
							{hostGate(serverId, <ShowVolumes serverId={serverId} />)}
						</TabsContent>
					)}
					<TabsContent value="networks">
						<ShowNetworks serverId={serverId} />
					</TabsContent>
					<TabsContent value="events">
						<ShowDockerEvents serverId={serverId} />
					</TabsContent>
					<TabsContent value="disk-usage">
						{hostGate(serverId, <ShowDiskUsage serverId={serverId} />)}
					</TabsContent>
					{canSeeHealth && (
						<TabsContent value="health">
							{hostGate(serverId, <ShowHealth serverId={serverId} />)}
						</TabsContent>
					)}
				</Tabs>
			)}
		</ServerFilter>
	);
};

export default Dashboard;

Dashboard.getLayout = (page: ReactElement) => {
	return <DashboardLayout>{page}</DashboardLayout>;
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}
	const { req, res } = ctx;

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});
	try {
		await helpers.project.all.prefetch();

		const userPermissions = await helpers.user.getPermissions.fetch();

		if (!userPermissions?.docker.read) {
			return {
				redirect: {
					permanent: true,
					destination: "/",
				},
			};
		}
		return {
			props: {
				trpcState: helpers.dehydrate(),
			},
		};
	} catch {
		return {
			props: {},
		};
	}
}
