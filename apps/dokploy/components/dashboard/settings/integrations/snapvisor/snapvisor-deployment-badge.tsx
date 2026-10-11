import { toast } from "sonner";
import { useInView } from "@/hooks/use-in-view";
import { api } from "@/utils/api";
import {
	deploymentBuildRefetchInterval,
	presentDeploymentBuild,
	type SnapvisorDeploymentBuildData,
} from "./snapvisor-badge-state";
import { SnapvisorBuildBadge } from "./snapvisor-build-badge";

/**
 * Snapvisor build badge for one row of the deployments list.
 *
 * Rendered only for a finished deployment of a service linked to a Snapvisor
 * project that recorded its full commit. The lookup waits until the row has
 * been on screen (a long list does not fire a request per row up front), is
 * answered from the server's short cache, and only polls while the answer can
 * still change. A missing build, a bad token and an unreachable Snapvisor are
 * quiet states of the badge, never an error that touches the list.
 */
export const SnapvisorDeploymentBadge = ({
	deploymentId,
}: {
	deploymentId: string;
}) => {
	const [ref, seen] = useInView<HTMLDivElement>();
	const { data } = api.snapvisor.deploymentBuild.useQuery(
		{ deploymentId },
		{
			enabled: seen,
			staleTime: 30_000,
			retry: false,
			refetchOnWindowFocus: false,
			refetchInterval: (query) =>
				query.state.status === "error"
					? false
					: deploymentBuildRefetchInterval(
							query.state.data as SnapvisorDeploymentBuildData | undefined,
						),
		},
	);
	const { mutateAsync: refresh, isPending: isRefreshing } =
		api.snapvisor.refreshDeploymentBuild.useMutation();
	const utils = api.useUtils();

	const view = presentDeploymentBuild(
		data as SnapvisorDeploymentBuildData | undefined,
	);

	// The wrapper stays mounted so the row can be observed before there is
	// anything to show.
	return (
		<div ref={ref}>
			{view && (
				<SnapvisorBuildBadge
					label={view.label}
					className={view.className}
					title={view.title}
					reviewUrl={view.reviewUrl}
					isRefreshing={isRefreshing}
					onRefresh={async () => {
						await refresh({ deploymentId })
							.then(async () => {
								await utils.snapvisor.deploymentBuild.invalidate({
									deploymentId,
								});
							})
							.catch((error) => {
								toast.error("Error refreshing Snapvisor status", {
									description: error.message,
								});
							});
					}}
				/>
			)}
		</div>
	);
};
