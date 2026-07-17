import {
	DatabaseBackup,
	FileArchive,
	Loader2,
	RotateCcw,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { DrawerLogs } from "@/components/shared/drawer-logs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	buildBackupListPrefix,
	countBackupFiles,
	parseBackupTimestamp,
} from "@/lib/backup-coverage";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import { formatBytes } from "../database/backups/restore-backup";
import { type LogLine, parseLogs } from "../docker/logs/utils";

type BackupContext = RouterOutputs["backup"]["backupContext"];

/** The subset of a coverage dump-backup entry the browser needs. */
export interface BrowseableBackup {
	backupId: string;
	destinationName: string;
	source: "policy" | "manual";
	policyName?: string;
}

interface Props {
	serviceName: string;
	serverId: string | null;
	dumpBackups: BrowseableBackup[];
}

/**
 * Backup Center browser: lists the real backup files present in the destination
 * bucket for a covered service (one section per backup config) and offers a
 * double-confirmed restore per file. Everything is lazy — nothing is fetched
 * until the dialog is opened.
 */
export const BackupBrowserDialog = ({
	serviceName,
	serverId,
	dumpBackups,
}: Props) => {
	const [open, setOpen] = useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					title="Browse backups in the bucket"
				>
					<DatabaseBackup className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<DatabaseBackup className="size-5 text-muted-foreground" />
						Backups · {serviceName}
					</DialogTitle>
					<DialogDescription>
						Files actually present in the destination bucket. Restoring a file
						overwrites the live database and cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<ScrollArea className="max-h-[60vh]">
					<div className="flex flex-col gap-4 pr-3">
						{dumpBackups.map((entry) => (
							<BackupConfigFiles
								key={entry.backupId}
								entry={entry}
								serverId={serverId}
								enabled={open}
							/>
						))}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
};

const BackupConfigFiles = ({
	entry,
	serverId,
	enabled,
}: {
	entry: BrowseableBackup;
	serverId: string | null;
	enabled: boolean;
}) => {
	const {
		data: context,
		isPending: isContextPending,
		error: contextError,
	} = api.backup.backupContext.useQuery(
		{ backupId: entry.backupId },
		{ enabled },
	);

	const {
		data: files = [],
		isPending: isFilesPending,
		isRefetching,
		error: filesError,
		refetch,
	} = api.backup.listBackupFiles.useQuery(
		{
			destinationId: context?.destinationId ?? "",
			search: context ? buildBackupListPrefix(context.prefix) : "",
			serverId: serverId ?? "",
		},
		{ enabled: enabled && !!context?.destinationId },
	);

	const backupFiles = files.filter((file) => !file.IsDir);
	const count = countBackupFiles(files);
	const error = contextError ?? filesError;
	const loading = isContextPending || (!!context && isFilesPending);

	return (
		<div className="rounded-lg border">
			<div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
				<div className="flex items-center gap-2">
					<FileArchive className="size-4 text-muted-foreground" />
					<span className="text-sm font-medium">
						{entry.destinationName || "Destination"}
					</span>
					<Badge variant={entry.source === "policy" ? "blue" : "blank"}>
						{entry.source === "policy"
							? `Policy${entry.policyName ? ` · ${entry.policyName}` : ""}`
							: "Manual"}
					</Badge>
					{context?.prefix ? (
						<span className="truncate text-xs text-muted-foreground">
							{context.prefix}
						</span>
					) : null}
				</div>
				<div className="flex items-center gap-2">
					{!loading && !error ? (
						count > 0 ? (
							<Badge variant="green">{count} in bucket</Badge>
						) : (
							<Badge variant="orange" className="gap-1">
								<TriangleAlert className="size-3" />
								Nothing in bucket
							</Badge>
						)
					) : null}
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 text-xs"
						disabled={!context?.destinationId || isRefetching}
						onClick={() => refetch()}
					>
						<Loader2
							className={isRefetching ? "size-3.5 animate-spin" : "hidden"}
						/>
						Refresh
					</Button>
				</div>
			</div>

			<div className="px-3 py-2">
				{loading ? (
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						Checking the bucket…
					</span>
				) : error ? (
					<AlertBlock type="error">
						{error.message || "Could not read the destination bucket."}
					</AlertBlock>
				) : count === 0 ? (
					<span className="text-xs text-muted-foreground">
						This backup is configured, but no files were found under its prefix.
						Run the backup to create one.
					</span>
				) : (
					<div className="flex flex-col divide-y">
						{backupFiles.map((file) => {
							const timestamp = parseBackupTimestamp(file.Name);
							return (
								<div
									key={file.Path}
									className="flex flex-wrap items-center justify-between gap-2 py-2"
								>
									<div className="flex min-w-0 flex-col">
										<span className="truncate text-sm">{file.Name}</span>
										<span className="text-xs text-muted-foreground">
											{formatBytes(file.Size)}
											{timestamp ? ` · ${timestamp.toLocaleString()}` : ""}
										</span>
									</div>
									{context?.canRestore ? (
										<RestoreFileButton
											context={context}
											backupFile={file.Path}
										/>
									) : null}
								</div>
							);
						})}
						{count >= 100 ? (
							<span className="py-2 text-xs text-muted-foreground">
								Showing the first 100 files.
							</span>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
};

const RestoreFileButton = ({
	context,
	backupFile,
}: {
	context: BackupContext;
	backupFile: string;
}) => {
	const [confirmStep, setConfirmStep] = useState(false);
	const [confirmName, setConfirmName] = useState("");
	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [logs, setLogs] = useState<LogLine[]>([]);
	const [isDeploying, setIsDeploying] = useState(false);

	// The token the user must retype to confirm — the target database name.
	const target = context.databaseName;

	api.backup.restoreBackupWithLogs.useSubscription(
		{
			databaseId: context.databaseId,
			databaseType: context.databaseType,
			databaseName: context.databaseName,
			backupFile,
			destinationId: context.destinationId,
			backupType: context.backupType,
			metadata:
				context.backupType === "compose"
					? {
							serviceName: context.serviceName ?? undefined,
							...(context.metadata ?? {}),
						}
					: undefined,
		},
		{
			enabled: isDeploying,
			onData(log) {
				if (!isDrawerOpen) setIsDrawerOpen(true);
				if (log === "Restore completed successfully!") setIsDeploying(false);
				setLogs((prev) => [...prev, ...parseLogs(log)]);
			},
			onError() {
				setIsDeploying(false);
			},
		},
	);

	return (
		<>
			{/* Step 1: acknowledge the destructive overwrite. */}
			<DialogAction
				title="Restore this backup?"
				description="This overwrites the live database with the contents of this backup file. The service must be running. This action cannot be undone."
				type="destructive"
				onClick={() => {
					setConfirmName("");
					setConfirmStep(true);
				}}
			>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					disabled={isDeploying}
				>
					<RotateCcw className="size-3.5" />
					Restore
				</Button>
			</DialogAction>

			{/* Step 2: type-to-confirm the database name. */}
			<Dialog open={confirmStep} onOpenChange={setConfirmStep}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Confirm restore</DialogTitle>
						<DialogDescription>
							Type{" "}
							<span className="font-mono font-semibold text-foreground">
								{target}
							</span>{" "}
							to confirm overwriting this database.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<span className="truncate text-xs text-muted-foreground">
							{backupFile}
						</span>
						<Input
							value={confirmName}
							onChange={(event) => setConfirmName(event.target.value)}
							placeholder={target}
						/>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirmStep(false)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							isLoading={isDeploying}
							disabled={confirmName.trim() !== target || isDeploying}
							onClick={() => {
								setConfirmStep(false);
								setLogs([]);
								setIsDeploying(true);
							}}
						>
							Restore
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<DrawerLogs
				isOpen={isDrawerOpen}
				onClose={() => {
					setIsDrawerOpen(false);
					setLogs([]);
					setIsDeploying(false);
				}}
				filteredLogs={logs}
			/>
		</>
	);
};
