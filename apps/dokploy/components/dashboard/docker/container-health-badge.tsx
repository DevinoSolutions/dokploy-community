import { Badge } from "@/components/ui/badge";
import {
	type ContainerHealth,
	parseContainerHealth,
} from "@/lib/docker-health";

const HEALTH_BADGE: Record<
	Exclude<ContainerHealth, "none">,
	{ variant: "green" | "yellow" | "red"; label: string }
> = {
	healthy: { variant: "green", label: "Healthy" },
	starting: { variant: "yellow", label: "Starting" },
	unhealthy: { variant: "red", label: "Unhealthy" },
};

interface Props {
	status?: string | null;
	className?: string;
}

/**
 * Renders a coloured badge for a container's Docker healthcheck state derived
 * from its `docker ps` status string. Renders nothing when the container has no
 * healthcheck configured.
 */
export const ContainerHealthBadge = ({ status, className }: Props) => {
	const health = parseContainerHealth(status);
	if (health === "none") {
		return null;
	}
	const { variant, label } = HEALTH_BADGE[health];
	return (
		<Badge variant={variant} className={className}>
			{label}
		</Badge>
	);
};
