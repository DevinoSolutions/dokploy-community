import { IS_CLOUD } from "@dokploy/server/constants";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Destination } from "@dokploy/server/services/destination";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { ExecError, execAsync, execAsyncRemote } from "../process/execAsync";
import { redactRcloneCredentials } from "./redact";
import {
	buildRcloneCommand,
	getBackupFolder,
	getRclonePathAndFlags,
	isDestinationEncrypted,
	isGenericRcloneDestination,
} from "./utils";

export interface RcloneFile {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	ModTime?: string;
	Tier?: string;
	Hashes?: {
		MD5?: string;
		SHA1?: string;
	};
}

// How long a download link stays valid. The browser starts the request as soon
// as it gets the link, and S3 only checks the expiry when the request starts.
const DOWNLOAD_LINK_EXPIRY = "5m";
const DOWNLOAD_LINK_TIMEOUT_MS = 30_000;

// A dump is named by the backup run (`<timestamp>.sql.gz`, `.bson.gz`, or
// `webserver-backup-<timestamp>.zip`) and sits directly under the backup
// folder, so a file name is a single path segment: no separator, no control
// character, no leading dot.
const MAX_FILE_NAME_LENGTH = 255;

const isSingleSegmentName = (fileName: string) => {
	if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) {
		return false;
	}
	if (fileName.startsWith(".")) return false;
	for (const char of fileName) {
		const code = char.charCodeAt(0);
		if (char === "/" || char === "\\" || code < 0x20 || code === 0x7f) {
			return false;
		}
	}
	return true;
};

export const getBackupFileExtensions = (
	backup: Pick<BackupSchedule, "databaseType">,
) =>
	backup.databaseType === "web-server"
		? ([".zip"] as const)
		: ([".sql.gz", ".bson.gz"] as const);

export const isBackupFileName = (
	backup: Pick<BackupSchedule, "databaseType">,
	fileName: string,
) =>
	isSingleSegmentName(fileName) &&
	getBackupFileExtensions(backup).some(
		(extension) =>
			fileName.length > extension.length && fileName.endsWith(extension),
	);

// `rclone link` signs a link for S3-compatible remotes only. A generic rclone
// remote or an SFTP/FTP server has no such link, and an encrypted destination
// would hand out the ciphertext.
export const isDownloadableDestination = (destination: Destination) =>
	!isGenericRcloneDestination(destination) &&
	!["sftp", "ftp"].includes(destination.provider || "") &&
	!isDestinationEncrypted(destination);

const getErrorDetail = (error: unknown) =>
	error instanceof ExecError
		? error.stderr || (error.serverId ? error.message : "")
		: String(error);

export const getBackupDownloadUrl = async ({
	backup,
	destination,
	serverId,
	fileName,
}: {
	backup: BackupSchedule;
	destination: Destination;
	serverId: string | null;
	fileName: string;
}) => {
	if (!isBackupFileName(backup, fileName)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid backup file name",
		});
	}
	if (!serverId && IS_CLOUD) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
	}
	if (!isDownloadableDestination(destination)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Downloads are only available for unencrypted S3 destinations. Restore the backup instead.",
		});
	}

	// The key is the backup's own folder plus a single file name. A folder with
	// a dot segment (the prefix is free text) could leave it, so it is refused.
	const folder = getBackupFolder(backup);
	if (
		folder.split("/").some((segment) => segment === "." || segment === "..")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid backup folder",
		});
	}

	try {
		const {
			flags: rcloneFlags,
			path,
			envVars,
		} = await getRclonePathAndFlags(destination, `${folder}${fileName}`);
		const command = buildRcloneCommand(
			`rclone link --expire ${DOWNLOAD_LINK_EXPIRY} ${rcloneFlags.join(" ")} --retries 1 --low-level-retries 1 --contimeout 10s --timeout 30s ${quote([path])}`,
			envVars,
		);
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command, undefined, {
					signal: AbortSignal.timeout(DOWNLOAD_LINK_TIMEOUT_MS),
				})
			: await execAsync(command, { timeout: DOWNLOAD_LINK_TIMEOUT_MS });
		const url = stdout.trim().split("\n").pop();
		if (!url || !/^https?:\/\//.test(url)) {
			throw new Error("rclone link returned no URL");
		}
		return { url };
	} catch (error) {
		const detail = getErrorDetail(error);
		if (/object not found/i.test(detail)) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Backup file not found",
			});
		}
		// The detail can carry the command line with the destination keys.
		console.error("rclone link failed:", redactRcloneCredentials(detail));
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Could not generate the download link",
		});
	}
};
