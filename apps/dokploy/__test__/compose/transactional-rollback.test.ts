import {
	getBackupCurrentDeploymentCommand,
	getBuildComposeCommand,
	getComposeBackupDir,
	getComposeEnvFilePath,
	getComposeFilePath,
	getRollbackMarkerProbeCommand,
	LAST_GOOD_COMPOSE_BAK,
	LAST_GOOD_ENV_BAK,
	PRE_DEPLOY_COMPOSE_BAK,
	PRE_DEPLOY_ENV_BAK,
	ROLLBACK_OK_MARKER,
} from "@dokploy/server/utils/builders/compose";
import { describe, expect, it, vi } from "vitest";

// Isolate the command builder from the compose-file I/O performed by
// writeDomainsToCompose; we only care about the shell script it emits.
vi.mock("@dokploy/server/utils/docker/domain", () => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
}));

const baseCompose = {
	appName: "my-app",
	sourceType: "github",
	command: "",
	composePath: "./docker-compose.yml",
	composeType: "docker-compose",
	createEnvFile: true,
	isolatedDeployment: false,
	isolatedNetworkMtu: null,
	pullImagesOnDeploy: false,
	randomize: false,
	suffix: "",
	serverId: null,
	env: "",
	mounts: [],
	domains: [],
	environment: { project: { env: "" }, env: "" },
} as unknown as Parameters<typeof getBuildComposeCommand>[0];

/**
 * shell-quote escapes with backslashes when a value needs no full quoting
 * (`^MARKER\:id\$`). Strip the escapes before asserting on the *logical* shell
 * token so the assertions do not depend on shell-quote's chosen style.
 */
const unescape = (value: string) => value.replace(/\\(.)/g, "$1");

const build = (
	overrides: Record<string, unknown> = {},
	options: Parameters<typeof getBuildComposeCommand>[1] = {
		deploymentId: "dep_123",
	},
) => getBuildComposeCommand({ ...baseCompose, ...overrides } as any, options);

describe("compose transactional deploy — path resolution", () => {
	it("keeps the snapshot directory outside code/ so a clone cannot wipe it", () => {
		const dir = getComposeBackupDir(baseCompose as any);

		expect(dir.replace(/\\/g, "/")).toContain("/my-app/.deploy-backup");
		expect(dir.replace(/\\/g, "/")).not.toContain("/code/");
	});

	it("resolves the compose file the deploy actually runs (raw ignores composePath)", () => {
		const git = getComposeFilePath({
			...baseCompose,
			composePath: "./deploy/docker-compose.yml",
		} as any).replace(/\\/g, "/");
		const raw = getComposeFilePath({
			...baseCompose,
			sourceType: "raw",
			composePath: "./deploy/docker-compose.yml",
		} as any).replace(/\\/g, "/");

		expect(git).toContain("/my-app/code/deploy/docker-compose.yml");
		// Raw services always write to code/docker-compose.yml.
		expect(raw).toContain("/my-app/code/docker-compose.yml");
	});

	it("resolves .env next to the compose file, matching --env-file", () => {
		const env = getComposeEnvFilePath({
			...baseCompose,
			composePath: "./deploy/docker-compose.yml",
		} as any).replace(/\\/g, "/");

		expect(env).toContain("/my-app/code/deploy/.env");
	});

	it("gives previews their own snapshot directory via the isolated appName", () => {
		const dir = getComposeBackupDir({
			...baseCompose,
			appName: "my-app-pr-42-abc",
		} as any).replace(/\\/g, "/");

		expect(dir).toContain("/my-app-pr-42-abc/.deploy-backup");
	});
});

describe("backupCurrentDeployment command", () => {
	const command = getBackupCurrentDeploymentCommand(baseCompose as any);

	it("snapshots both the compose file and the .env before the deploy", () => {
		expect(command).toContain(PRE_DEPLOY_COMPOSE_BAK);
		expect(command).toContain(PRE_DEPLOY_ENV_BAK);
		expect(command).toContain("mkdir -p");
	});

	it("aborts the deploy when the snapshot cannot be taken", () => {
		// Two copies plus the mkdir; a deploy must never proceed half-snapshotted.
		expect(command.match(/\|\| exit 1/g)?.length).toBe(3);
	});

	it("drops a stale snapshot when the corresponding file is absent", () => {
		expect(command).toContain('echo "No previous compose file found"');
		expect(command).toContain('echo "No previous env file found"');
		expect(command.match(/rm -f /g)?.length).toBe(2);
	});

	it("shell-quotes a hostile composePath instead of interpolating it raw", () => {
		const hostile = getBackupCurrentDeploymentCommand({
			...baseCompose,
			composePath: './x.yml"; touch /tmp/pwned; #',
		} as any);

		// Every occurrence of the injected payload stays inside a single-quoted
		// shell word, so the `;` can never terminate the `cp` invocation.
		expect(hostile).toMatch(/cp '[^']*x\.yml"; touch [^']*pwned[^']*'/);
		expect(hostile).not.toMatch(/[^'][^']*x\.yml"; touch [^']*pwned[^']*\n/);
	});
});

describe("rollback marker probe", () => {
	it("anchors the marker and binds it to the deployment id", () => {
		const probe = unescape(
			getRollbackMarkerProbeCommand("/var/log/dep.log", "dep_123"),
		);

		expect(probe).toContain(`^${ROLLBACK_OK_MARKER}:dep_123$`);
		expect(probe).toContain("grep -q");
		expect(probe).toContain("LIVE_OK");
		expect(probe).toContain("LIVE_FAILED");
	});

	it("does not match a marker written by another deployment", () => {
		const probe = unescape(
			getRollbackMarkerProbeCommand("/var/log/dep.log", "dep_123"),
		);

		expect(probe).not.toContain(`${ROLLBACK_OK_MARKER}:dep_999`);
	});

	it("shell-quotes a hostile log path", () => {
		const probe = getRollbackMarkerProbeCommand(
			'/var/log/a b"; rm -rf /; #.log',
			"dep_123",
		);

		expect(probe).toMatch(/'\/var\/log\/a b"; rm -rf \/; #\.log'/);
	});
});

describe("getBuildComposeCommand — rollback decision logic", () => {
	it("wraps a docker-compose deploy in restore + last-good persistence", async () => {
		const command = await build();

		expect(command).toContain("Restoring previous working deployment");
		expect(command).toContain(LAST_GOOD_COMPOSE_BAK);
		expect(command).toContain(PRE_DEPLOY_COMPOSE_BAK);
		expect(unescape(command)).toContain(`${ROLLBACK_OK_MARKER}:dep_123`);
	});

	it("prefers the last-good snapshot over the pre-deploy one", async () => {
		const command = await build();
		const restore = command.slice(command.indexOf("RESTORE_FILES_OK=1"));

		expect(restore.indexOf(LAST_GOOD_COMPOSE_BAK)).toBeLessThan(
			restore.indexOf(PRE_DEPLOY_COMPOSE_BAK),
		);
		expect(restore.indexOf(LAST_GOOD_ENV_BAK)).toBeLessThan(
			restore.indexOf(PRE_DEPLOY_ENV_BAK),
		);
	});

	it("never emits the marker unless the files were actually restored", async () => {
		const command = await build();

		// The `docker ... && echo MARKER` line only runs inside the
		// RESTORE_FILES_OK guard.
		expect(command).toContain('if [ "$RESTORE_FILES_OK" = "1" ]; then');
		expect(command).toContain(
			'echo "Warning: ⚠️ No previous release to restore, leaving the stack as-is"',
		);
		const plain = unescape(command);
		const guardIndex = plain.indexOf('if [ "$RESTORE_FILES_OK" = "1" ]');
		expect(guardIndex).toBeGreaterThan(-1);
		expect(plain.indexOf(`${ROLLBACK_OK_MARKER}:dep_123`)).toBeGreaterThan(
			guardIndex,
		);
	});

	it("treats a missing .env restore as a failed rollback when createEnvFile is on", async () => {
		const command = await build({ createEnvFile: true });

		expect(command).toContain('if [ "$RESTORE_ENV_OK" = "0" ] && { [ "1" = "1" ]');
	});

	it("tolerates a missing .env when the service does not generate one", async () => {
		const command = await build({ createEnvFile: false });

		expect(command).toContain('if [ "$RESTORE_ENV_OK" = "0" ] && { [ "0" = "1" ]');
	});

	it("restores without --build so the known-good artifact is not rebuilt", async () => {
		const command = await build();
		const restoreLine = command
			.split("\n")
			.find((line) => line.includes("docker compose") && line.includes("&& echo"));

		expect(restoreLine).toBeDefined();
		expect(restoreLine).not.toContain("--build");
		// The forward deploy still builds.
		expect(command).toContain("--build");
	});

	it("restores without --pull always so a bad tag is not re-pulled", async () => {
		const command = await build({ pullImagesOnDeploy: true });
		const restoreLine = command
			.split("\n")
			.find((line) => line.includes("docker compose") && line.includes("&& echo"));

		expect(restoreLine).toBeDefined();
		expect(restoreLine).not.toContain("--pull always");
		expect(command).toContain("--pull always");
	});

	it("refreshes the last-good snapshot only after a successful deploy", async () => {
		const command = await build();
		const persistIndex = command.indexOf(`${LAST_GOOD_COMPOSE_BAK}`);
		const deployedIndex = command.indexOf("Docker Compose Deployed");

		expect(command).toContain("Could not refresh the last-good snapshot");
		expect(command.lastIndexOf(LAST_GOOD_COMPOSE_BAK)).toBeLessThan(
			deployedIndex,
		);
		expect(persistIndex).toBeGreaterThan(-1);
	});

	it("drops the last-good snapshot entirely when it cannot be refreshed", async () => {
		const command = await build();

		expect(command).toMatch(
			new RegExp(`rm -f [^\\n]*${LAST_GOOD_COMPOSE_BAK}[^\\n]*${LAST_GOOD_ENV_BAK}`),
		);
	});

	it("shell-quotes snapshot paths built from a hostile composePath", async () => {
		const command = await build({
			composePath: './x.yml"; touch /tmp/pwned; #',
		});

		expect(command).toMatch(/cp '[^']*last-good-docker-compose.yml.bak' '/);
	});
});

describe("getBuildComposeCommand — when rollback is switched off", () => {
	it("skips the transactional wrapper for swarm stacks", async () => {
		const command = await build({ composeType: "stack" });

		expect(command).toContain("stack deploy");
		expect(command).not.toContain("Restoring previous working deployment");
		expect(command).not.toContain(ROLLBACK_OK_MARKER);
		expect(command).not.toContain(LAST_GOOD_COMPOSE_BAK);
	});

	it("skips the transactional wrapper for a fresh-volumes deploy", async () => {
		const command = await build({}, {
			deploymentId: "dep_123",
			freshVolumes: true,
		});

		// `down --volumes` already destroyed the state the rollback would
		// restore, so bringing the old release back would boot it on empty
		// volumes while reporting the service as live.
		expect(command).not.toContain("Restoring previous working deployment");
		expect(command).not.toContain(ROLLBACK_OK_MARKER);
		expect(command).not.toContain(LAST_GOOD_COMPOSE_BAK);
	});

	it("still wraps a normal deploy when freshVolumes is explicitly false", async () => {
		const command = await build({}, {
			deploymentId: "dep_123",
			freshVolumes: false,
		});

		expect(command).toContain("Restoring previous working deployment");
	});

	it("emits an unattributable marker when no deployment id is supplied", async () => {
		const command = unescape(await build({}, {}));

		expect(command).toContain(ROLLBACK_OK_MARKER);
		expect(command).not.toContain(`${ROLLBACK_OK_MARKER}:`);
	});
});
