import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { SnapvisorLogo } from "@/components/icons/product-logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

/** Snapvisor `Build.status` → the label/tone shown on the preview card. */
const SNAPVISOR_STATUS_PRESENTATION: Record<
	string,
	{ label: string; className: string }
> = {
	pending: { label: "Pending", className: "text-muted-foreground" },
	progress: { label: "Pending", className: "text-muted-foreground" },
	"no-changes": { label: "No changes", className: "text-green-600" },
	"changes-detected": {
		label: "Changes detected",
		className: "text-yellow-600",
	},
	accepted: { label: "Approved", className: "text-green-600" },
	rejected: { label: "Rejected", className: "text-red-600" },
	error: { label: "Error", className: "text-red-600" },
	aborted: { label: "Error", className: "text-red-600" },
	expired: { label: "Expired", className: "text-muted-foreground" },
};

/**
 * Build statuses that can never change again on their own: a review outcome
 * (accepted/rejected) or a finished/failed run (no-changes/error/aborted/
 * expired). Polling stops once one of these is reached; a new commit gets a
 * new build anyway, registered by the next preview deploy.
 */
const SNAPVISOR_TERMINAL_STATUSES = new Set([
	"accepted",
	"rejected",
	"no-changes",
	"error",
	"aborted",
	"expired",
]);

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
		<div className="flex items-center gap-1">
			<Badge variant="outline" className="gap-1.5">
				<SnapvisorLogo className="size-3.5" />
				<span className={presentation?.className}>
					{data.buildId ? (presentation?.label ?? "Unknown") : "Not registered"}
				</span>
			</Badge>
			<Button
				variant="ghost"
				size="icon"
				className="size-6"
				isLoading={isRefreshing}
				aria-label="Refresh Snapvisor status"
				onClick={async () => {
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
			>
				<RefreshCw className="size-3" />
			</Button>
			{data.reviewUrl && (
				<a
					href={data.reviewUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="text-xs text-blue-500 hover:underline"
				>
					Review in Snapvisor
				</a>
			)}
		</div>
	);
};
