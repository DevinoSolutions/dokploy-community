import { RefreshCw } from "lucide-react";
import { SnapvisorLogo } from "@/components/icons/product-logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * The compact Snapvisor build badge: status, a refresh action and a deep link
 * to the review. Presentation only; the preview card and the deployments list
 * each own how they fetch the build (see `SnapvisorPreviewBadge` and
 * `SnapvisorDeploymentBadge`).
 */
export const SnapvisorBuildBadge = ({
	label,
	className,
	title,
	reviewUrl,
	isRefreshing,
	onRefresh,
}: {
	label: string;
	className?: string;
	title?: string;
	reviewUrl: string | null;
	isRefreshing: boolean;
	onRefresh: () => void;
}) => (
	<div className="flex items-center gap-1">
		<Badge variant="outline" className="gap-1.5" title={title}>
			<SnapvisorLogo className="size-3.5" />
			<span className={className}>{label}</span>
		</Badge>
		<Button
			variant="ghost"
			size="icon"
			className="size-6"
			isLoading={isRefreshing}
			aria-label="Refresh Snapvisor status"
			onClick={onRefresh}
		>
			<RefreshCw className="size-3" />
		</Button>
		{reviewUrl && (
			<a
				href={reviewUrl}
				target="_blank"
				rel="noopener noreferrer"
				className="text-xs text-blue-500 hover:underline"
			>
				Review in Snapvisor
			</a>
		)}
	</div>
);
