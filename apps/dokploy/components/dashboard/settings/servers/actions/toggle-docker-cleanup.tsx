import { HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { DockerCleanupScheduleSelect } from "../docker-cleanup-schedule-select";

interface Props {
	serverId?: string;
}
export const ToggleDockerCleanup = ({ serverId }: Props) => {
	const { data, refetch } = api.settings.getWebServerSettings.useQuery(
		undefined,
		{
			enabled: !serverId,
		},
	);

	const { data: server, refetch: refetchServer } = api.server.one.useQuery(
		{
			serverId: serverId || "",
		},
		{
			enabled: !!serverId,
		},
	);

	// Cloud cleanup runs on the jobs service, which keeps its own fixed schedule.
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const enabled = serverId
		? server?.enableDockerCleanup
		: data?.enableDockerCleanup;
	const cron = serverId ? server?.dockerCleanupCron : data?.dockerCleanupCron;

	const { mutateAsync } = api.settings.updateDockerCleanup.useMutation();

	const save = async (
		enableDockerCleanup: boolean,
		dockerCleanupCron?: string,
	) => {
		try {
			await mutateAsync({
				enableDockerCleanup,
				...(dockerCleanupCron && { dockerCleanupCron }),
				...(serverId && { serverId }),
			} as {
				enableDockerCleanup: boolean;
				dockerCleanupCron?: string;
				serverId?: string;
			});
			if (serverId) {
				await refetchServer();
			} else {
				await refetch();
			}
			toast.success("Docker Cleanup updated");
		} catch {
			toast.error("Docker Cleanup Error");
		}
	};

	const handleToggle = (checked: boolean) => save(checked);

	return (
		<div className="flex items-center gap-4">
			<Switch checked={!!enabled} onCheckedChange={handleToggle} />
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Label className="text-primary flex items-center gap-1.5 cursor-pointer">
							Daily Docker Cleanup
							<HelpCircle className="size-4 text-muted-foreground" />
						</Label>
					</TooltipTrigger>
					<TooltipContent side="top" className="max-w-sm">
						<p>
							Runs a full Docker cleanup daily, pruning stopped containers,
							unused images, build cache, and system resources. This may remove
							images built for Compose services that run on-demand (backup
							runners, cron jobs, one-off tasks).
						</p>
						<p className="mt-1">
							It runs at the hour you pick (UTC) and waits while deployments are
							running or queued on the server, retrying for up to 3 hours.
						</p>
						<p className="mt-1">
							For custom cleanup strategies, use{" "}
							<a
								href="https://docs.dokploy.com/docs/core/schedule-jobs#example-1-automatic-docker-cleanup"
								target="_blank"
								rel="noopener noreferrer"
								className="underline text-primary"
							>
								Schedule Jobs
							</a>{" "}
							on your web server or remote servers.
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			{enabled && cron && !isCloud && (
				<DockerCleanupScheduleSelect
					value={cron}
					onChange={(next) => save(true, next)}
				/>
			)}
		</div>
	);
};
