import { Play } from "lucide-react";
import { useState } from "react";
import { DrawerLogs } from "@/components/shared/drawer-logs";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { type LogLine, parseLogs } from "../docker/logs/utils";

interface Props {
	backupPolicyId: string;
	disabled?: boolean;
}

// Consumes `backupPolicy.runNow` — a subscription that emits one string log line
// per service (✓/✗) plus a final "N succeeded, M failed" summary. Mirrors how
// restore-backup consumes `restoreBackupWithLogs`: drive the subscription with
// `enabled`, append parsed lines to a DrawerLogs, and stop on the summary line.
export const RunBackupPolicy = ({ backupPolicyId, disabled }: Props) => {
	const [isRunning, setIsRunning] = useState(false);
	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [filteredLogs, setFilteredLogs] = useState<LogLine[]>([]);

	api.backupPolicy.runNow.useSubscription(
		{ backupPolicyId },
		{
			enabled: isRunning,
			onData(log) {
				if (!isDrawerOpen) {
					setIsDrawerOpen(true);
				}
				// Final summary line the router yields once every service ran.
				if (/^\d+ succeeded, \d+ failed(?:, \d+ skipped)?$/.test(log)) {
					setIsRunning(false);
				}
				setFilteredLogs((prev) => [...prev, ...parseLogs(log)]);
			},
			onError(error) {
				console.error("Backup policy run error:", error);
				setFilteredLogs((prev) => [
					...prev,
					...parseLogs(`Error: ${error.message}`),
				]);
				setIsRunning(false);
			},
		},
	);

	return (
		<>
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							isLoading={isRunning}
							disabled={disabled}
							onClick={() => {
								setFilteredLogs([]);
								setIsRunning(true);
								setIsDrawerOpen(true);
							}}
						>
							<Play className="size-4" />
							Run now
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						Run every backup this policy manages now
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<DrawerLogs
				isOpen={isDrawerOpen}
				onClose={() => {
					setIsDrawerOpen(false);
					setFilteredLogs([]);
					setIsRunning(false);
				}}
				filteredLogs={filteredLogs}
			/>
		</>
	);
};
