import { DatabaseBackup, Download, FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	buildBackupListPrefix,
	parseBackupTimestamp,
} from "@/lib/backup-coverage";
import { api } from "@/utils/api";
import { formatBytes } from "./restore-backup";

// The link is a bearer URL to a whole dump: it is opened without a Referer and
// without keeping a handle on the new page.
const openDownload = (url: string) => {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.rel = "noreferrer noopener";
	anchor.referrerPolicy = "no-referrer";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
};

interface Props {
	backupId: string;
}

export const ShowBackupFiles = ({ backupId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);

	// The same lookup the Backup Center uses: the backup's context, then the
	// files under its prefix.
	const {
		data: context,
		isLoading: isContextLoading,
		error: contextError,
	} = api.backup.backupContext.useQuery({ backupId }, { enabled: isOpen });

	const {
		data: listedFiles,
		isLoading: isFilesLoading,
		error: filesError,
	} = api.backup.listBackupFiles.useQuery(
		{
			destinationId: context?.destinationId ?? "",
			search: context
				? buildBackupListPrefix(
						`${context.libsqlAppName ? `${context.libsqlAppName}/` : ""}${context.prefix}`,
					)
				: "",
			serverId: context?.serverId ?? "",
		},
		{ enabled: isOpen && !!context?.destinationId },
	);

	// Only the extensions the server will sign a link for.
	const dumpExtension =
		context?.databaseType === "web-server"
			? /\.zip$/
			: /\.(sql\.gz|bson\.gz)$/;
	const files = listedFiles?.filter(
		(file) => !file.IsDir && dumpExtension.test(file.Name),
	);
	const isLoading = isContextLoading || (!!context && isFilesLoading);
	const error = contextError ?? filesError;
	const isError = !!error;
	// A dump is the whole database: downloading takes the restore permission.
	const canDownload = !!context?.canRestore;

	const download = api.backup.getDownloadUrl.useMutation({
		onSuccess: ({ url }) => {
			openDownload(url);
			// Drop the link from the mutation cache once it is used.
			download.reset();
		},
		onError: (error) => toast.error(error.message),
	});

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<TooltipProvider delayDuration={0}>
				<Tooltip>
					<TooltipTrigger asChild>
						<DialogTrigger asChild>
							<Button variant="ghost" size="icon" className="size-8">
								<FolderOpen className="size-4" />
							</Button>
						</DialogTrigger>
					</TooltipTrigger>
					<TooltipContent>Backup Files</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Backup Files</DialogTitle>
					<DialogDescription>
						Files stored in the destination for this backup.
					</DialogDescription>
				</DialogHeader>

				{error && <AlertBlock type="error">{error.message}</AlertBlock>}

				{isLoading && (
					<div className="flex items-center justify-center py-16">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					</div>
				)}

				{!isLoading && !isError && files?.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-3 py-16">
						<DatabaseBackup className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No backup files found yet
						</span>
					</div>
				)}

				{!isError && !!files?.length && (
					<ScrollArea className="h-[60vh]">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>File</TableHead>
									<TableHead>Date</TableHead>
									<TableHead>Size</TableHead>
									<TableHead className="w-16" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{files.map((file) => (
									<TableRow key={file.Path}>
										<TableCell className="font-medium break-all">
											{file.Name}
										</TableCell>
										<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
											{parseBackupTimestamp(file.Name)?.toLocaleString() ?? "—"}
										</TableCell>
										<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
											{formatBytes(file.Size)}
										</TableCell>
										<TableCell>
											<Button
												variant="ghost"
												size="icon"
												className="size-8"
												disabled={!canDownload || download.isPending}
												onClick={() =>
													download.mutate({ backupId, fileName: file.Name })
												}
											>
												{download.isPending &&
												download.variables?.fileName === file.Name ? (
													<Loader2 className="size-4 animate-spin" />
												) : (
													<Download className="size-4" />
												)}
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</ScrollArea>
				)}
			</DialogContent>
		</Dialog>
	);
};
