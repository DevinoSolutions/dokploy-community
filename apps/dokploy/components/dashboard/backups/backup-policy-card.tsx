import {
	AlertTriangle,
	Clock,
	Database,
	HardDrive,
	RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import { commonCronExpressions } from "../application/schedules/handle-schedules";
import { DeleteBackupPolicy } from "./delete-backup-policy";
import { HandleBackupPolicy } from "./handle-backup-policy";
import { RunBackupPolicy } from "./run-backup-policy";
import { SERVICE_TYPE_LABELS } from "./service-type-icon";

type Policy = RouterOutputs["backupPolicy"]["all"][number];

interface Props {
	policy: Policy;
	projectNameById: Map<string, string>;
	environmentNameById: Map<string, string>;
}

const humanizeCron = (schedule: string) =>
	commonCronExpressions.find((expression) => expression.value === schedule)
		?.label ?? null;

export const BackupPolicyCard = ({
	policy,
	projectNameById,
	environmentNameById,
}: Props) => {
	const utils = api.useUtils();
	const { mutateAsync: toggle, isPending: isToggling } =
		api.backupPolicy.toggle.useMutation();
	const { mutateAsync: sync, isPending: isSyncing } =
		api.backupPolicy.sync.useMutation();

	const scopeSummary = (() => {
		if (policy.scopeType === "organization") {
			return "All environments in the organization";
		}
		const lookup =
			policy.scopeType === "projects" ? projectNameById : environmentNameById;
		const names = policy.scopeIds
			.map((id) => lookup.get(id))
			.filter((name): name is string => !!name);
		const noun = policy.scopeType === "projects" ? "project" : "environment";
		if (names.length === 0) {
			return `${policy.scopeIds.length} ${noun}${policy.scopeIds.length === 1 ? "" : "s"}`;
		}
		if (names.length <= 3) {
			return names.join(", ");
		}
		return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
	})();

	const cronLabel = humanizeCron(policy.schedule);
	const serviceTypeFilter = (policy.serviceTypeFilter ?? []) as string[];

	return (
		<div className="flex flex-col gap-4 rounded-lg border p-4 hover:bg-muted/40 transition-colors">
			<div className="flex flex-row items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<h3 className="text-base font-semibold">{policy.name}</h3>
						{policy.lastSyncError && (
							<TooltipProvider delayDuration={0}>
								<Tooltip>
									<TooltipTrigger asChild>
										<Badge variant="yellow" className="gap-1">
											<AlertTriangle className="size-3" />
											Sync issue
										</Badge>
									</TooltipTrigger>
									<TooltipContent className="max-w-80">
										{policy.lastSyncError}
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						)}
					</div>
					<p className="text-sm text-muted-foreground">{scopeSummary}</p>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">
						{policy.enabled ? "Enabled" : "Disabled"}
					</span>
					<Switch
						checked={policy.enabled}
						disabled={isToggling}
						onCheckedChange={async (checked) => {
							await toggle({
								backupPolicyId: policy.backupPolicyId,
								enabled: checked,
							})
								.then(async () => {
									await utils.backupPolicy.all.invalidate();
									await utils.backupPolicy.coverage.invalidate();
								})
								.catch(() => toast.error("Error toggling the backup policy"));
						}}
					/>
				</div>
			</div>

			<div className="flex flex-wrap gap-1.5">
				{policy.includeDatabases && (
					<Badge variant="blue" className="gap-1">
						<Database className="size-3" />
						DB dumps
					</Badge>
				)}
				{policy.includeVolumes && (
					<Badge variant="green" className="gap-1">
						<HardDrive className="size-3" />
						Volumes
					</Badge>
				)}
				{serviceTypeFilter.map((type) => (
					<Badge key={type} variant="blank">
						{SERVICE_TYPE_LABELS[type as keyof typeof SERVICE_TYPE_LABELS] ??
							type}
					</Badge>
				))}
			</div>

			<div className="flex flex-wrap gap-x-8 gap-y-3">
				<div>
					<span className="text-xs font-medium text-muted-foreground">
						Destination
					</span>
					<p className="text-sm font-medium">{policy.destination.name}</p>
				</div>
				<div>
					<span className="text-xs font-medium text-muted-foreground">
						Schedule
					</span>
					<p className="flex items-center gap-1.5 text-sm font-medium">
						<Clock className="size-3.5 text-muted-foreground" />
						<code className="text-xs">{policy.schedule}</code>
						{cronLabel && (
							<span className="text-xs text-muted-foreground">
								({cronLabel})
							</span>
						)}
					</p>
				</div>
				<div>
					<span className="text-xs font-medium text-muted-foreground">
						Coverage
					</span>
					<p className="text-sm font-medium">
						{policy.coverage.total} backups
						<span className="text-muted-foreground">
							{" "}
							({policy.coverage.dumpCount} dumps, {policy.coverage.volumeCount}{" "}
							volumes)
						</span>
					</p>
				</div>
				<div>
					<span className="text-xs font-medium text-muted-foreground">
						Keep latest
					</span>
					<p className="text-sm font-medium">
						{policy.keepLatestCount ?? "All"}
					</p>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-2 border-t pt-3">
				<RunBackupPolicy
					backupPolicyId={policy.backupPolicyId}
					disabled={!policy.enabled || policy.coverage.total === 0}
				/>
				<Button
					variant="outline"
					size="sm"
					isLoading={isSyncing}
					onClick={async () => {
						await sync({ backupPolicyId: policy.backupPolicyId })
							.then(async () => {
								toast.success("Backup policy synced");
								await utils.backupPolicy.all.invalidate();
								await utils.backupPolicy.coverage.invalidate();
							})
							.catch(() => toast.error("Error syncing the backup policy"));
					}}
				>
					<RefreshCw className="size-4" />
					Sync now
				</Button>
				<div className="ml-auto flex items-center gap-1">
					<HandleBackupPolicy backupPolicyId={policy.backupPolicyId} />
					<DeleteBackupPolicy
						backupPolicyId={policy.backupPolicyId}
						name={policy.name}
					/>
				</div>
			</div>
		</div>
	);
};
