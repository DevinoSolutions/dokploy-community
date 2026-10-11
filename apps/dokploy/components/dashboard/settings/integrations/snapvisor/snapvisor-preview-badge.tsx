import { toast } from "sonner";
import { api } from "@/utils/api";
import {
	SNAPVISOR_STATUS_PRESENTATION,
	SNAPVISOR_TERMINAL_STATUSES,
} from "./snapvisor-badge-state";
import { SnapvisorBuildBadge } from "./snapvisor-build-badge";

/**
 * Snapvisor visual-diff badge for one preview deployment. Only rendered when
 * the application or compose service has a Snapvisor project linked (its
 * preview settings);
 * polls the stored build linkage and offers a manual refresh + deep link.
 */
export const SnapvisorPreviewBadge = ({
	previewDeploymentId,
}: {
	previewDeploymentId: string;
}) => {
	const { data, isPending } = api.snapvisor.previewBuild.useQuery(
		{ previewDeploymentId },
		{
			refetchInterval: (query) => {
				// A failing query (Snapvisor down, access revoked) would otherwise
				// be retried every 15s forever; the refresh button stays available.
				if (query.state.status === "error") return false;
				const status = query.state.data?.buildStatus;
				return status && SNAPVISOR_TERMINAL_STATUSES.has(status)
					? false
					: 15_000;
			},
		},
	);
	const { mutateAsync: refresh, isPending: isRefreshing } =
		api.snapvisor.refreshPreviewBuild.useMutation();
	const utils = api.useUtils();

	if (isPending || !data) return null;

	const presentation = data.buildStatus
		? SNAPVISOR_STATUS_PRESENTATION[data.buildStatus]
		: null;

	return (
		<SnapvisorBuildBadge
			label={
				data.buildId ? (presentation?.label ?? "Unknown") : "Not registered"
			}
			className={presentation?.className}
			reviewUrl={data.reviewUrl}
			isRefreshing={isRefreshing}
			onRefresh={async () => {
				await refresh({ previewDeploymentId })
					.then(async () => {
						await utils.snapvisor.previewBuild.invalidate({
							previewDeploymentId,
						});
					})
					.catch((error) => {
						toast.error("Error refreshing Snapvisor status", {
							description: error.message,
						});
					});
			}}
		/>
	);
};
