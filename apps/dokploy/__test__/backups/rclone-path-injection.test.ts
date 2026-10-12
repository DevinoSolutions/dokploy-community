import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	apiCreateBackup,
	apiRestoreBackup,
	apiUpdateBackup,
	createVolumeBackupSchema,
	updateVolumeBackupSchema,
} from "@dokploy/server/db/schema";
import { apiCreateBackupPolicy } from "@dokploy/server/db/schema/backup-policy";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import { keepLatestNBackups } from "@dokploy/server/utils/backups";
import {
	buildRcloneRcatCommand,
	getBackupCommand,
	getComposeContainerCommand,
	getRclonePathAndFlags,
	getServiceContainerCommand,
	normalizeS3Path,
} from "@dokploy/server/utils/backups/utils";
import { backupVolume } from "@dokploy/server/utils/volume-backups/backup";
import { restoreVolume } from "@dokploy/server/utils/volume-backups/restore";
import { quote } from "shell-quote";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every case spawns bash a few times, which is slow on Windows.
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	root: "",
}));

vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationById: vi.fn(() =>
		Promise.resolve({
			destinationId: "dest-1",
			provider: "AWS",
			accessKey: "ak",
			secretAccessKey: "sk",
			region: "us-east-1",
			endpoint: "https://s3.example.com",
			bucket: "my-bucket",
			additionalFlags: [],
			encryptionEnabled: false,
		}),
	),
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: vi.fn(() =>
		Promise.resolve({ appName: "stack-app", composeType: "stack" }),
	),
}));

vi.mock("@dokploy/server", () => ({
	findApplicationById: vi.fn().mockResolvedValue({ appName: "test-app" }),
	findComposeById: vi.fn().mockResolvedValue({
		appName: "test-compose",
		composeType: "docker-compose",
	}),
	findDestinationById: vi.fn().mockResolvedValue({
		provider: "AWS",
		bucket: "my-bucket",
		accessKey: "ak",
		secretAccessKey: "sk",
		region: "us-east-1",
		endpoint: "https://s3.example.com",
		additionalFlags: [],
	}),
	paths: vi.fn(() => ({ VOLUME_BACKUPS_PATH: "/tmp/volume-backups" })),
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/constants")>()),
	paths: () => ({
		VOLUME_BACKUPS_PATH: `${mocks.root}/volume-backups`,
		VOLUME_BACKUP_LOCK_PATH: `${mocks.root}/lock`,
	}),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

// Git Bash on Windows wants /c/Users/... instead of C:\Users\...
const toPosix = (value: string) =>
	value
		.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
		.replace(/\\/g, "/");

const root = mkdtempSync(path.join(tmpdir(), "dokploy-rclone-inject-"));
mocks.root = toPosix(root);
const bin = path.join(root, "bin");
const argsLog = path.join(root, "args.log");
// Payloads run with the temp root as cwd, so a relative `touch pwned` lands here.
const marker = path.join(root, "pwned");

// Stubs for the binaries the generated commands call. They record their argv
// (NUL-separated words, each call ended by a \u0001 word) and never touch the network or
// docker. `rclone lsf` lists files so the retention pipeline reaches delete.
const stub = (name: string, body: string) => {
	const file = path.join(bin, name);
	writeFileSync(file, `#!/bin/bash\n${body}\n`);
	chmodSync(file, 0o755);
};

beforeAll(() => {
	mkdirSync(path.join(root, "volume-backups"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	const record = `{ printf '%s\\0' "$@"; printf '\\1\\0'; } >> '${toPosix(argsLog)}'`;
	stub(
		"rclone",
		`if [ "$1" = lsf ]; then printf '%s\\n' a.sql.gz b.sql.gz c.sql.gz d.sql.gz; exit 0; fi\n${record}`,
	);
	stub("docker", record);
	// Only the log readers call tail with a file; the retention pipeline pipes
	// `tail -n +N` and gets the real binary.
	stub("tail", `case "$*" in *+*) exec /usr/bin/tail "$@" ;; esac\n${record}`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// Runs a generated command in bash with the stubs first on PATH. Returns the
// recorded calls; a command that executed injected code leaves `marker` behind.
const runStubbed = (command: string) => {
	rmSync(argsLog, { force: true });
	rmSync(marker, { force: true });
	try {
		execFileSync(
			"bash",
			["-c", `export PATH='${toPosix(bin)}':"$PATH"\n${command}`],
			{ stdio: "ignore", cwd: root },
		);
	} catch {
		// Exit status is irrelevant here, only what ran and with which arguments.
	}
	const calls = existsSync(argsLog)
		? readFileSync(argsLog, "utf8")
				.split("\u0001\0")
				.filter(Boolean)
				.map((call) => call.split("\0").filter(Boolean))
		: [];
	return { calls, pwned: existsSync(marker) };
};

const payloads = [
	"x$(touch pwned)",
	"x`touch pwned`",
	`x"; touch pwned; echo "`,
	`x'; touch pwned; '`,
	"x; touch pwned",
	"x\ntouch pwned\n",
	"x$(touch pwned)/y z",
];

const s3Destination = {
	provider: "AWS",
	bucket: "my-bucket",
	accessKey: "ak",
	secretAccessKey: "sk",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	additionalFlags: [],
	encryptionEnabled: false,
	encryptionKey: null,
	filenameEncryption: "off",
	directoryNameEncryption: false,
	encryptionPassword2: null,
};

describe("rclone rcat destination built from the backup prefix", () => {
	const upload = async (prefix: string) => {
		const {
			flags,
			path: destination,
			envVars,
		} = await getRclonePathAndFlags(
			// biome-ignore lint/suspicious/noExplicitAny: minimal destination fixture
			s3Destination as any,
			`${normalizeS3Path(prefix)}2026-10-12.sql.gz`,
		);
		return {
			destination,
			command: buildRcloneRcatCommand(flags, destination, envVars),
		};
	};

	for (const payload of payloads) {
		it(`keeps ${JSON.stringify(payload)} inert`, async () => {
			const { command, destination } = await upload(payload);
			const { calls, pwned } = runStubbed(command);

			expect(pwned).toBe(false);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.[0]).toBe("rcat");
			// The whole path is one literal argument, byte for byte.
			expect(calls[0]?.at(-1)).toBe(destination);
			expect(destination).toContain(normalizeS3Path(payload));
		});
	}

	it("passes an ordinary prefix to rclone unchanged", async () => {
		const { command, destination } = await upload("daily/pg");
		expect(destination).toBe(":s3:my-bucket/daily/pg/2026-10-12.sql.gz");
		const { calls } = runStubbed(command);
		expect(calls[0]).toEqual([
			"rcat",
			"--s3-provider=AWS",
			"--s3-access-key-id=ak",
			"--s3-secret-access-key=sk",
			"--s3-region=us-east-1",
			"--s3-endpoint=https://s3.example.com",
			"--s3-no-check-bucket",
			"--s3-force-path-style",
			":s3:my-bucket/daily/pg/2026-10-12.sql.gz",
		]);
	});

	it("keeps the partial-upload cleanup swap working", async () => {
		const { command } = await upload("daily/pg");
		expect(command.replace("rclone rcat ", "rclone deletefile ")).toMatch(
			/^rclone deletefile /,
		);
	});

	it("shell-quotes a hostile bucket the same way", async () => {
		const { flags, path: destination } = await getRclonePathAndFlags(
			// biome-ignore lint/suspicious/noExplicitAny: minimal destination fixture
			{ ...s3Destination, bucket: "b$(touch pwned)" } as any,
			"f.sql.gz",
		);
		const { calls, pwned } = runStubbed(
			buildRcloneRcatCommand(flags, destination),
		);
		expect(pwned).toBe(false);
		expect(calls[0]?.at(-1)).toBe(":s3:b$(touch pwned)/f.sql.gz");
	});
});

describe("backup retention", () => {
	const retention = async (prefix: string) => {
		mocks.execAsync.mockReset();
		await keepLatestNBackups(
			{
				destinationId: "dest-1",
				prefix,
				keepLatestCount: 2,
				databaseType: "postgres",
			} as BackupSchedule,
			null,
		);
		return mocks.execAsync.mock.calls[0]?.[0] as string;
	};

	for (const payload of payloads) {
		it(`keeps ${JSON.stringify(payload)} inert`, async () => {
			const command = await retention(payload);
			const { calls, pwned } = runStubbed(command);

			expect(pwned).toBe(false);
			const deletes = calls.filter((call) => call[0] === "delete");
			// Four files listed, two kept.
			expect(deletes).toHaveLength(2);
			const prefix = `${normalizeS3Path(payload)}`;
			expect(deletes.map((call) => call.at(-1))).toEqual([
				`:s3:my-bucket/${prefix}b.sql.gz`,
				`:s3:my-bucket/${prefix}a.sql.gz`,
			]);
		});
	}

	it("lists and deletes under an ordinary prefix", async () => {
		const command = await retention("daily/pg");
		const { calls } = runStubbed(command);
		expect(calls.filter((call) => call[0] === "delete")).toEqual([
			expect.arrayContaining([":s3:my-bucket/daily/pg/b.sql.gz"]),
			expect.arrayContaining([":s3:my-bucket/daily/pg/a.sql.gz"]),
		]);
	});
});

describe("docker label filters", () => {
	it("keeps a hostile compose service name inert", () => {
		for (const type of ["docker-compose", "stack"] as const) {
			const { calls, pwned } = runStubbed(
				`CID=$(${getComposeContainerCommand("app", "web$(touch pwned)`touch pwned`", type)})`,
			);
			expect(pwned).toBe(false);
			expect(calls).toHaveLength(1);
			expect(calls[0]).toContain(
				type === "stack"
					? "label=com.docker.swarm.service.name=app_web$(touch pwned)`touch pwned`"
					: "label=com.docker.compose.service=web$(touch pwned)`touch pwned`",
			);
		}
	});

	it("builds the same filters for ordinary names", () => {
		const { calls } = runStubbed(
			`${getComposeContainerCommand("app", "web", "docker-compose")}; ${getServiceContainerCommand("my-app")}`,
		);
		expect(calls).toEqual([
			[
				"ps",
				"-q",
				"--filter",
				"status=running",
				"--filter",
				"label=com.docker.compose.project=app",
				"--filter",
				"label=com.docker.compose.service=web",
			],
			[
				"ps",
				"-q",
				"--filter",
				"status=running",
				"--filter",
				"label=com.docker.swarm.service.name=my-app",
			],
		]);
	});
});

describe("volume backups", () => {
	const volumeBackup = (overrides: Record<string, unknown>) =>
		({
			serviceType: "application",
			volumeName: "my-volume",
			turnOff: false,
			prefix: "",
			destinationId: "dest-1",
			appName: "vb-app",
			application: { appName: "my-app", serverId: null },
			...overrides,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fixture for command builder
		}) as any;

	for (const payload of payloads) {
		it(`keeps prefix and volume name ${JSON.stringify(payload)} inert`, async () => {
			const script = (await backupVolume(
				volumeBackup({ prefix: payload, volumeName: payload }),
			)) as string;
			const { calls, pwned } = runStubbed(script);

			expect(pwned).toBe(false);
			const upload = calls.find((call) => call[0] === "copyto");
			expect(upload?.at(-1)).toContain(
				`:s3:my-bucket/${normalizeS3Path(payload)}`,
			);
			const run = calls.find((call) => call[0] === "run");
			expect(run).toContain(`${payload}:/volume_data`);
		});
	}

	it("keeps a hostile compose service name inert while the service is stopped", async () => {
		for (const composeType of ["stack", "docker-compose"]) {
			const { findComposeById } = await import(
				"@dokploy/server/services/compose"
			);
			vi.mocked(findComposeById).mockResolvedValueOnce({
				appName: "stack-app",
				composeType,
				// biome-ignore lint/suspicious/noExplicitAny: minimal compose fixture
			} as any);
			const script = (await backupVolume(
				volumeBackup({
					serviceType: "compose",
					turnOff: true,
					serviceName: "web$(touch pwned)`touch pwned`",
					application: undefined,
					compose: { appName: "stack-app", composeId: "c1", serverId: null },
				}),
			)) as string;
			const { pwned } = runStubbed(script);
			expect(pwned).toBe(false);
		}
	});

	it("refuses restore names a shell would interpret or that leave the volume directory", async () => {
		const bs = String.fromCharCode(92);
		const newline = String.fromCharCode(10);
		for (const name of [
			"a$(touch pwned).tar",
			"a`id`.tar",
			'a".tar',
			`a${bs}b.tar`,
			`a${newline}b.tar`,
			"../../etc/cron.d/x.tar",
			"a/../../b.tar",
			"/etc/cron.d/x.tar",
			"my-app/vol.sql.gz",
			"my-app/vol.tar.gz",
		]) {
			await expect(
				restoreVolume("app-1", "dest-1", "my-volume", name, "", "application"),
			).rejects.toThrow("Invalid backup file name");
		}
	});

	it("restores names that look unusual but are safe", async () => {
		// The command is built and run with stubbed docker and rclone; the inner
		// script is then run for real against temp directories.
		for (const name of [
			"my-app/my-volume-2026-10-12T00-00-00-000Z.tar",
			"Bob's backups/vol-1.tar",
			"a b/vol;touch pwned.tar",
			"x&y/(vol).tar",
			"a..b/vol.tar",
		]) {
			const command = await restoreVolume(
				"app-1",
				"dest-1",
				"my-volume",
				name,
				"",
				"application",
			);
			const { calls, pwned } = runStubbed(command);
			expect(pwned).toBe(false);

			const run = calls.find((call) => call[0] === "run");
			expect(run).toContain(`BACKUP_FILE_NAME=${name}`);
			const script = run?.at(-1) ?? "";
			expect(script).toContain('tar xf "/backup/$BACKUP_FILE_NAME" .');

			// Run the inner script the way the container would, with the volume
			// and backup directories pointed at temp dirs.
			const volumeDir = path.join(root, "restore-volume");
			const backupDir = path.join(root, "restore-backup");
			rmSync(volumeDir, { recursive: true, force: true });
			rmSync(backupDir, { recursive: true, force: true });
			mkdirSync(volumeDir, { recursive: true });
			mkdirSync(path.join(backupDir, path.dirname(name)), { recursive: true });
			writeFileSync(path.join(root, "payload.txt"), "data");
			// Relative paths inside bash: GNU tar reads `C:` as a remote host.
			execFileSync("bash", [
				"-c",
				'mkdir -p "$1/restore-src" && cp "$1/payload.txt" "$1/restore-src/" && cd "$1" && tar cf "$2" -C restore-src .',
				"_",
				toPosix(root),
				`restore-backup/${name}`,
			]);
			execFileSync(
				"bash",
				[
					"-c",
					script
						.replace("/volume_data", toPosix(volumeDir))
						.replace("/backup", toPosix(backupDir)),
				],
				{ cwd: root, env: { ...process.env, BACKUP_FILE_NAME: name } },
			);
			expect(readFileSync(path.join(volumeDir, "payload.txt"), "utf8")).toBe(
				"data",
			);
			expect(existsSync(marker)).toBe(false);
		}
	});

	it("keeps the restore echo lines and rclone path inert", async () => {
		const command = await restoreVolume(
			"app-1",
			"dest-1",
			"my-volume",
			"a b/vol;touch pwned.tar",
			"",
			"application",
		);
		const { calls, pwned } = runStubbed(command);
		expect(pwned).toBe(false);
		const download = calls.find((call) => call[0] === "copyto");
		expect(download?.at(-2)).toBe(":s3:my-bucket/a b/vol;touch pwned.tar");
	});

	it("ignores a client-supplied app name", async () => {
		const input = {
			name: "vb",
			volumeName: "my-volume",
			prefix: "p",
			serviceType: "application",
			cronExpression: "0 0 * * *",
			destinationId: "dest-1",
			appName: "x$(touch pwned)",
		} as const;
		const created = createVolumeBackupSchema.safeParse(input);
		expect(created.success).toBe(true);
		expect(created.data).not.toHaveProperty("appName");
		const updated = updateVolumeBackupSchema.safeParse({
			...input,
			volumeBackupId: "vb-1",
			appName: "$(id)",
		});
		expect(updated.success).toBe(true);
		expect(updated.data).not.toHaveProperty("appName");
	});
});

describe("log paths", () => {
	const hostile = "/logs/app/a$(touch pwned)`touch pwned`.log";

	it("reads a log tail without evaluating the path", async () => {
		const { readBackupLogTail } = await import(
			"@dokploy/server/utils/backups/log-tail"
		);
		mocks.execAsync.mockReset();
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		await readBackupLogTail(hostile, null);
		const command = mocks.execAsync.mock.calls[0]?.[0] as string;
		const { calls, pwned } = runStubbed(command);
		expect(pwned).toBe(false);
		expect(calls[0]?.at(-1)).toBe(hostile);
	});

	it("reads a deployment error tail over ssh without evaluating the path", async () => {
		const { getDeploymentErrorMessage } = await import(
			"@dokploy/server/services/deployment"
		);
		mocks.execAsyncRemote.mockReset();
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
		await getDeploymentErrorMessage({
			logPath: hostile,
			serverId: "server-1",
			fallback: "none",
		});
		const command = mocks.execAsyncRemote.mock.calls[0]?.[1] as string;
		const { calls, pwned } = runStubbed(command);
		expect(pwned).toBe(false);
		expect(calls[0]?.at(-1)).toBe(hostile);
	});

	it("appends backup progress to a quoted log path", () => {
		const script = getBackupCommand(
			{
				backupType: "database",
				databaseType: "postgres",
				database: "app",
				postgres: { appName: "pg", databaseUser: "u" },
				destination: { provider: "AWS" },
				// biome-ignore lint/suspicious/noExplicitAny: minimal backup fixture
			} as any,
			"rclone rcat :s3:b/x.sql.gz",
			hostile,
		);
		expect(script).toContain(`>> ${quote([hostile])};`);
		expect(script).not.toContain(`>> ${hostile}`);
	});
});

describe("backup path validation", () => {
	const valid = [
		"daily/pg",
		"my app/db 1",
		"backups/prod's",
		"prefix-with_dots.v1/Ünïcode",
		"/leading/and/trailing/",
	];
	const invalid = [
		"x$(id)",
		"x`id`",
		'x"y',
		"x\\y",
		"x\ny",
		"x\ry",
		"x\ty",
		"x\0y",
		"x\u007fy",
	];

	const baseBackup = {
		schedule: "0 0 * * *",
		enabled: true,
		destinationId: "dest-1",
		keepLatestCount: 3,
		database: "app",
		databaseType: "postgres",
		backupType: "database",
		postgresId: "pg-1",
		serviceName: null,
		metadata: null,
		includeEncryptionKey: false,
	} as const;

	it("accepts ordinary prefixes on create, update and for volume backups", () => {
		for (const prefix of valid) {
			expect(apiCreateBackup.safeParse({ ...baseBackup, prefix }).success).toBe(
				true,
			);
			expect(
				apiUpdateBackup.safeParse({
					...baseBackup,
					prefix,
					backupId: "b-1",
				}).success,
			).toBe(true);
			expect(
				createVolumeBackupSchema.safeParse({
					name: "vb",
					volumeName: "my-volume",
					prefix,
					serviceType: "application",
					appName: "vb-app",
					cronExpression: "0 0 * * *",
					destinationId: "dest-1",
				}).success,
			).toBe(true);
			expect(
				apiCreateBackupPolicy.safeParse({
					name: "p",
					scopeType: "organization",
					scopeIds: [],
					serviceTypeFilter: [],
					destinationId: "dest-1",
					schedule: "0 0 * * *",
					prefix,
				}).success,
			).toBe(true);
		}
	});

	it("rejects shell syntax and control characters", () => {
		for (const prefix of invalid) {
			expect(apiCreateBackup.safeParse({ ...baseBackup, prefix }).success).toBe(
				false,
			);
			expect(
				apiUpdateBackup.safeParse({
					...baseBackup,
					prefix,
					backupId: "b-1",
				}).success,
			).toBe(false);
			expect(
				createVolumeBackupSchema.safeParse({
					name: "vb",
					volumeName: "my-volume",
					prefix,
					serviceType: "application",
					appName: "vb-app",
					cronExpression: "0 0 * * *",
					destinationId: "dest-1",
				}).success,
			).toBe(false);
			expect(
				apiCreateBackupPolicy.safeParse({
					name: "p",
					scopeType: "organization",
					scopeIds: [],
					serviceTypeFilter: [],
					destinationId: "dest-1",
					schedule: "0 0 * * *",
					prefix,
				}).success,
			).toBe(false);
		}
	});

	it("rejects an empty backup prefix as before", () => {
		expect(
			apiCreateBackup.safeParse({ ...baseBackup, prefix: "" }).success,
		).toBe(false);
	});

	it("rejects shell syntax in compose service names", () => {
		const compose = { ...baseBackup, backupType: "compose", prefix: "p" };
		expect(
			apiCreateBackup.safeParse({ ...compose, serviceName: "web" }).success,
		).toBe(true);
		expect(
			apiCreateBackup.safeParse({ ...compose, serviceName: "web$(id)" })
				.success,
		).toBe(false);
	});

	it("rejects shell syntax in the restore service name", () => {
		const restore = {
			databaseId: "pg-1",
			databaseType: "postgres",
			backupType: "compose",
			databaseName: "app",
			backupFile: "daily/pg/x.sql.gz",
			destinationId: "dest-1",
		} as const;
		expect(
			apiRestoreBackup.safeParse({
				...restore,
				metadata: { serviceName: "web" },
			}).success,
		).toBe(true);
		expect(
			apiRestoreBackup.safeParse({
				...restore,
				metadata: { serviceName: "web`id`" },
			}).success,
		).toBe(false);
	});
});
