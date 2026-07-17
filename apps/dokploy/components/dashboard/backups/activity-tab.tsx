import copy from "copy-to-clipboard";
import { Activity, Copy, FolderClosed, HardDrive, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import { ShowDeploymentsModal } from "../application/deployments/show-deployments-modal";
import { ServiceTypeIcon } from "./service-type-icon";

type BackupRun =
	RouterOutputs["backupPolicy"]["recentActivity"]["runs"][number];

const statusDotClass = (status: string) => {
	switch (status) {
		case "done":
			return "bg-green-500";
		case "error":
			return "bg-red-500";
		case "running":
			return "bg-blue-500 animate-pulse";
		case "cancelled":
			return "bg-muted-foreground/60";
		default:
			return "bg-muted-foreground/40";
	}
};

const formatDate = (iso: string | null) => {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const ArtifactCell = ({ run }: { run: BackupRun }) => {
	if (run.artifactPath) {
		return (
			<button
				type="button"
				className="flex max-w-[22rem] items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
				title={`${run.artifactPath} (click to copy)`}
				onClick={() => {
					copy(run.artifactPath ?? "");
					toast.success("Artifact path copied to clipboard");
				}}
			>
				<span className="truncate font-mono">{run.artifactPath}</span>
				<Copy className="size-3 shrink-0" />
			</button>
		);
	}
	if (run.prefix) {
		return (
			<span
				className="flex max-w-[22rem] items-center gap-1.5 text-xs text-muted-foreground"
				title="Destination prefix (exact file not recorded in this run's log)"
			>
				<FolderClosed className="size-3 shrink-0" />
				<span className="truncate font-mono">{run.prefix}</span>
			</span>
		);
	}
	return <span className="text-muted-foreground">—</span>;
};

const RunRow = ({ run }: { run: BackupRun }) => {
	const modalType = run.kind === "volume" ? "volumeBackup" : "backup";
	const modalId = run.kind === "volume" ? run.volumeBackupId : run.backupId;
	return (
		<TableRow>
			<TableCell>
				<div className="flex items-center gap-2">
					{run.serviceType ? (
						<ServiceTypeIcon type={run.serviceType} />
					) : (
						<HardDrive className="size-4 text-muted-foreground" />
					)}
					<div className="flex flex-col">
						<span className="text-sm font-medium">{run.serviceName}</span>
						<span className="text-xs text-muted-foreground">
							{run.projectName}
							{run.environmentName ? ` · ${run.environmentName}` : ""}
							{run.kind === "volume" ? " · volume" : ""}
						</span>
					</div>
				</div>
			</TableCell>
			<TableCell>
				<span className="text-sm text-muted-foreground">
					{run.destinationName || "—"}
				</span>
			</TableCell>
			<TableCell>
				<Badge variant={run.source === "policy" ? "blue" : "blank"}>
					{run.source === "policy"
						? `Policy${run.policyName ? ` · ${run.policyName}` : ""}`
						: "Manual"}
				</Badge>
			</TableCell>
			<TableCell>
				<span className="flex items-center gap-2 text-sm">
					<span
						className={cn(
							"inline-block size-2 rounded-full",
							statusDotClass(run.status),
						)}
					/>
					<span className="capitalize text-muted-foreground">{run.status}</span>
				</span>
			</TableCell>
			<TableCell>
				<span className="text-xs text-muted-foreground">
					{formatDate(run.createdAt)}
				</span>
			</TableCell>
			<TableCell>
				<ArtifactCell run={run} />
			</TableCell>
			<TableCell className="text-right">
				{modalId ? (
					<ShowDeploymentsModal
						id={modalId}
						type={modalType}
						serverId={run.serverId ?? undefined}
					>
						<Button variant="ghost" size="sm" className="h-7 text-xs">
							Open log
						</Button>
					</ShowDeploymentsModal>
				) : null}
			</TableCell>
		</TableRow>
	);
};

export const ActivityTab = ({ serverId }: { serverId?: string }) => {
	const [limit, setLimit] = useState(50);
	const { data, isPending, isFetching } =
		api.backupPolicy.recentActivity.useQuery({ limit, serverId });

	const runs = data?.runs ?? [];

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex flex-row items-center gap-2 text-xl">
					<Activity className="size-6 text-muted-foreground" />
					Activity
				</CardTitle>
				<CardDescription>
					Recent backup runs on the selected server. Each row links to the full
					run log; the artifact column shows the uploaded file (or the
					destination prefix when the run log did not record an exact path).
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isPending ? (
					<div className="flex min-h-[20vh] items-center justify-center">
						<Loader2 className="size-6 animate-spin text-muted-foreground" />
					</div>
				) : runs.length === 0 ? (
					<div className="flex min-h-[20vh] flex-col items-center justify-center gap-3">
						<Activity className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No backup runs yet on this server
						</span>
					</div>
				) : (
					<>
						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Service</TableHead>
										<TableHead>Destination</TableHead>
										<TableHead>Source</TableHead>
										<TableHead>Status</TableHead>
										<TableHead>Started</TableHead>
										<TableHead>Artifact</TableHead>
										<TableHead />
									</TableRow>
								</TableHeader>
								<TableBody>
									{runs.map((run) => (
										<RunRow key={run.deploymentId} run={run} />
									))}
								</TableBody>
							</Table>
						</div>
						{data?.nextOffset !== null && data?.nextOffset !== undefined ? (
							<div className="flex justify-center">
								<Button
									variant="outline"
									size="sm"
									isLoading={isFetching}
									onClick={() => setLimit((current) => current + 50)}
								>
									Load more
								</Button>
							</div>
						) : null}
					</>
				)}
			</CardContent>
		</Card>
	);
};
