import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Destination } from "@dokploy/server/services/destination";
import { ExecError } from "@dokploy/server/utils/process/execAsync";
import { parse } from "shell-quote";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<object>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

const SECRET = "wJalrXUtnFEMI-secret-key";
const ACCESS_KEY = "AKIAEXAMPLEACCESSKEY";
const URL_OUT = "https://s3.local/bucket/db/file.sql.gz?X-Amz-Signature=abc\n";

const destination = {
	destinationId: "dest-1",
	organizationId: "org-1",
	bucket: "bucket",
	accessKey: ACCESS_KEY,
	secretAccessKey: SECRET,
	region: "us-east-1",
	endpoint: "http://s3.local",
	provider: "Minio",
	additionalFlags: [],
	encryptionEnabled: false,
	encryptionKey: null,
} as unknown as Destination;

const baseBackup = {
	backupId: "backup-1",
	destinationId: "dest-1",
	backupType: "database",
	databaseType: "postgres",
	prefix: "/db/",
	appName: "web",
	postgresId: "pg-1",
	postgres: { appName: "pg-app", serverId: null },
} as unknown as BackupSchedule;

const loadModule = async (isCloud = false) => {
	vi.resetModules();
	vi.doMock("@dokploy/server/constants", async (importOriginal) => ({
		...(await importOriginal<object>()),
		IS_CLOUD: isCloud,
	}));
	return await import("@dokploy/server/utils/backups/files");
};

const download = async (
	overrides: {
		backup?: BackupSchedule;
		destination?: Destination;
		serverId?: string | null;
		fileName?: string;
		isCloud?: boolean;
	} = {},
) => {
	const { getBackupDownloadUrl } = await loadModule(overrides.isCloud);
	return getBackupDownloadUrl({
		backup: overrides.backup ?? baseBackup,
		destination: overrides.destination ?? destination,
		serverId: overrides.serverId ?? null,
		fileName: overrides.fileName ?? "2026-10-24T10-00-00-000Z.sql.gz",
	});
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execAsync.mockResolvedValue({ stdout: URL_OUT, stderr: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stdout: URL_OUT, stderr: "" });
});

describe("getBackupFolder", () => {
	// utils.ts pulls in the whole backup runner graph; load it once, outside the
	// 5s test budget, so a loaded machine does not time the first test out.
	beforeAll(async () => {
		await import("@dokploy/server/utils/backups/utils");
	}, 60_000);

	it("is the normalized prefix for every kind but libsql", async () => {
		const { getBackupFolder } = await import(
			"@dokploy/server/utils/backups/utils"
		);
		expect(getBackupFolder(baseBackup)).toBe("db/");
		expect(
			getBackupFolder({ ...baseBackup, prefix: "" } as BackupSchedule),
		).toBe("");
		expect(
			getBackupFolder({
				...baseBackup,
				backupType: "compose",
				prefix: "/a/b",
				compose: { appName: "stack" },
			} as unknown as BackupSchedule),
		).toBe("a/b/");
	});

	it("keeps a libsql dump under the app name, like the backup run", async () => {
		const { getBackupFolder } = await import(
			"@dokploy/server/utils/backups/utils"
		);
		expect(
			getBackupFolder({
				...baseBackup,
				databaseType: "libsql",
				libsql: { appName: "libsql-app" },
			} as unknown as BackupSchedule),
		).toBe("libsql-app/db/");
	});
});

describe("isBackupFileName", () => {
	it("accepts the dumps a backup run writes", async () => {
		const { isBackupFileName } = await loadModule();
		const database = { databaseType: "postgres" } as BackupSchedule;
		const instance = { databaseType: "web-server" } as BackupSchedule;
		expect(isBackupFileName(database, "2026-10-24T10-00-00-000Z.sql.gz")).toBe(
			true,
		);
		expect(isBackupFileName(database, "2026-10-24T10-00-00-000Z.bson.gz")).toBe(
			true,
		);
		expect(isBackupFileName(database, "my dump (final).sql.gz")).toBe(true);
		expect(
			isBackupFileName(instance, "webserver-backup-2026-10-24T10-00-00Z.zip"),
		).toBe(true);
	});

	it("refuses anything that is not one dump file name", async () => {
		const { isBackupFileName } = await loadModule();
		const database = { databaseType: "postgres" } as BackupSchedule;
		const refused = [
			"../other.sql.gz",
			"..",
			"../../etc/passwd",
			"/etc/passwd",
			"/abs.sql.gz",
			"sub/file.sql.gz",
			"other-prefix/file.sql.gz",
			"..\\file.sql.gz",
			"a\\b.sql.gz",
			":s3:other-bucket/file.sql.gz",
			".hidden.sql.gz",
			".sql.gz",
			"file.txt",
			"file.sql",
			"file.zip",
			"file.sql.gz\n",
			"fi\nle.sql.gz",
			"fi\0le.sql.gz",
			"fi\x1ble.sql.gz",
			"",
			`${"a".repeat(260)}.sql.gz`,
		];
		for (const name of refused) {
			expect(isBackupFileName(database, name), JSON.stringify(name)).toBe(
				false,
			);
		}
	});

	it("keeps the instance backup to zip and the databases to dumps", async () => {
		const { isBackupFileName } = await loadModule();
		const database = { databaseType: "mysql" } as BackupSchedule;
		const instance = { databaseType: "web-server" } as BackupSchedule;
		expect(isBackupFileName(instance, "x.sql.gz")).toBe(false);
		expect(isBackupFileName(instance, "x.bson.gz")).toBe(false);
		expect(isBackupFileName(database, "x.zip")).toBe(false);
	});
});

describe("getBackupDownloadUrl", () => {
	it("returns the link of one file in the backup folder, and nothing else", async () => {
		const result = await download();

		expect(result).toEqual({ url: URL_OUT.trim() });
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(mocks.execAsync).toHaveBeenCalledTimes(1);
		const [command, options] = mocks.execAsync.mock.calls[0] as [
			string,
			{ timeout?: number },
		];
		expect(command).toContain("rclone link --expire 5m");
		// The key is the backup's own folder plus the file name.
		const tokens = parse(command);
		expect(tokens.every((token) => typeof token === "string")).toBe(true);
		expect(tokens.at(-1)).toBe(":s3:bucket/db/2026-10-24T10-00-00-000Z.sql.gz");
		// The transfer is bounded in time.
		expect(options.timeout).toBeGreaterThan(0);
		expect(command).toContain("--timeout 30s");
	});

	it("runs on the server of the service, with a time limit", async () => {
		await download({ serverId: "srv-1" });

		expect(mocks.execAsync).not.toHaveBeenCalled();
		const [serverId, command, , options] = mocks.execAsyncRemote.mock
			.calls[0] as [string, string, unknown, { signal?: AbortSignal }];
		expect(serverId).toBe("srv-1");
		expect(command).toContain("rclone link");
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it("hands the file name to the shell as one inert argument", async () => {
		const fileName = "x $(touch pwned) `id` ; echo hi | cat > f &.sql.gz";
		await download({ fileName });

		const [command] = mocks.execAsync.mock.calls[0] as [string];
		const tokens = parse(command, () => "ENV-EXPANDED");
		expect(tokens.every((token) => typeof token === "string")).toBe(true);
		expect(tokens.at(-1)).toBe(`:s3:bucket/db/${fileName}`);
		// Single-quoted, not left as shell words.
		expect(command.endsWith(`'${tokens.at(-1)}'`)).toBe(true);
	});

	it("quotes a hostile backup prefix too", async () => {
		await download({
			backup: {
				...baseBackup,
				prefix: "p; touch pwned #",
			} as BackupSchedule,
		});

		const [command] = mocks.execAsync.mock.calls[0] as [string];
		const tokens = parse(command);
		expect(tokens.every((token) => typeof token === "string")).toBe(true);
		expect(tokens.at(-1)).toBe(
			":s3:bucket/p; touch pwned #/2026-10-24T10-00-00-000Z.sql.gz",
		);
	});

	it("never builds a key outside the backup folder", async () => {
		const { getBackupDownloadUrl } = await loadModule();
		for (const fileName of [
			"../other.sql.gz",
			"../../etc/passwd",
			"/abs.sql.gz",
			"other-prefix/file.sql.gz",
			":s3:other-bucket/file.sql.gz",
			"file.txt",
		]) {
			await expect(
				getBackupDownloadUrl({
					backup: baseBackup,
					destination,
					serverId: null,
					fileName,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("refuses a prefix that would leave the backup folder", async () => {
		for (const prefix of ["../other", "a/../../b", "./x", "a/./b"]) {
			await expect(
				download({ backup: { ...baseBackup, prefix } as BackupSchedule }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("only links S3 destinations that are not encrypted", async () => {
		const refused = [
			{ provider: "sftp" },
			{ provider: "ftp" },
			{ provider: "GenericRclone" },
			{ encryptionEnabled: true, encryptionKey: "key" },
		];
		for (const override of refused) {
			await expect(
				download({
					destination: { ...destination, ...override } as Destination,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("refuses a backup that is not on a server in the cloud", async () => {
		await expect(download({ isCloud: true })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("answers a missing file with not found", async () => {
		mocks.execAsync.mockRejectedValue(
			new ExecError("Command execution failed", {
				command: "rclone link",
				stderr: "Failed to link: object not found",
			}),
		);

		await expect(download()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Backup file not found",
		});
	});

	it("keeps the credentials out of the error, the logs and the answer", async () => {
		const logged: string[] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
			logged.push(args.map(String).join(" "));
		});
		mocks.execAsync.mockRejectedValue(
			new ExecError("Command execution failed", {
				command: `rclone link --s3-access-key-id=${ACCESS_KEY} --s3-secret-access-key=${SECRET}`,
				stderr: `Failed: --s3-access-key-id=${ACCESS_KEY} --s3-secret-access-key=${SECRET} refused at 10.0.0.5`,
			}),
		);

		const error = await download().catch((e: unknown) => e);

		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			message: "Could not generate the download link",
		});
		const text = JSON.stringify({
			message: (error as Error).message,
			cause: (error as { cause?: unknown }).cause ?? null,
			logged,
		});
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(ACCESS_KEY);
		expect(logged.length).toBeGreaterThan(0);
		spy.mockRestore();
	});

	it("does not pass a result that is not a link", async () => {
		mocks.execAsync.mockResolvedValue({ stdout: "oops\n", stderr: "" });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(download()).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Could not generate the download link",
		});
		spy.mockRestore();
	});

	it("answers a failure on the server the same way", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.execAsyncRemote.mockRejectedValue(
			new Error(`ssh failed with ${SECRET}`),
		);

		const error = await download({ serverId: "srv-1" }).catch(
			(e: unknown) => e,
		);

		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			message: "Could not generate the download link",
		});
		expect(JSON.stringify((error as Error).message)).not.toContain(SECRET);
		spy.mockRestore();
	});
});
