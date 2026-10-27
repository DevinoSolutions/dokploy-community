import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { reconnectServicesToTraefik } from "@dokploy/server/services/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: {
				findMany: mocks.findMany,
			},
		},
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

// What reconnectServicesToTraefik writes for the given composes.
const reconnectScript = (...apps: string[]) =>
	`id=$(docker ps --filter "name=^dokploy-traefik$" -q)\n` +
	`if [ -z "$id" ]; then\n` +
	`echo "Traefik is not running; skipped reconnecting isolated composes"\n` +
	`else\n` +
	apps
		.map(
			(app) =>
				`out=$(docker network connect ${app} "$id" 2>&1) || case "$out" in *"already exists in network"*|*"already attached to network"*) echo "Traefik is already connected to ${app}";; *) echo "Skipped ${app}: $(printf '%s' "$out" | head -n 1)";; esac\n`,
		)
		.join("") +
	`fi\n`;

describe("reconnectServicesToTraefik", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findMany.mockResolvedValue([]);
		mocks.execAsync.mockResolvedValue({ stdout: "", stderr: "" });
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });
	});

	it("does not execute an empty local command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik();

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("does not execute an empty remote command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments to the local Traefik network", async () => {
		mocks.findMany.mockResolvedValue([
			{ appName: "first-compose" },
			{ appName: "second-compose" },
		]);

		await reconnectServicesToTraefik();

		expect(mocks.execAsync).toHaveBeenCalledOnce();
		expect(mocks.execAsync).toHaveBeenCalledWith(
			reconnectScript("first-compose", "second-compose"),
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments on a remote server", async () => {
		mocks.findMany.mockResolvedValue([{ appName: "remote-compose" }]);

		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-id",
			reconnectScript("remote-compose"),
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	// A stale isolated-compose row whose network is gone used to fail the whole
	// Traefik update through the exit code of the last command. The generated
	// script is run for real, with a docker stub that answers like the engine.
	const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;

	// Runs the generated script for real, with a docker stub that answers like
	// the engine. `ps` prints the stub's Traefik id (empty when Traefik is down).
	const runScript = async (apps: string[], stub: string[], psOutput = "tid") => {
		mocks.findMany.mockResolvedValue(apps.map((appName) => ({ appName })));
		await reconnectServicesToTraefik();
		const script = mocks.execAsync.mock.calls[0]?.[0] as string;
		const dir = mkdtempSync(join(tmpdir(), "t9412-"));
		try {
			writeFileSync(
				join(dir, "docker"),
				[
					"#!/bin/sh",
					`if [ "$1" = ps ]; then echo "${psOutput}"; exit 0; fi`,
					'if [ "$4" != "tid" ]; then echo "unexpected id $4"; exit 9; fi',
					'case "$3" in',
					...stub,
					"esac",
				].join("\n"),
			);
			chmodSync(join(dir, "docker"), 0o755);
			const run = spawnSync("sh", ["-c", script], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
			});
			return { status: run.status, lines: run.stdout.trim().split("\n") };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it.skipIf(!hasSh)("runs to exit code 0 and says why a network was skipped", async () => {
		const result = await runScript(
			["live-compose", "joined-compose", "gone-compose"],
			[
				"live-compose) exit 0 ;;",
				'joined-compose) echo "Error response from daemon: endpoint with name dokploy-traefik already exists in network joined-compose"; exit 1 ;;',
				'*) echo "Error response from daemon: network $3 not found"; exit 1 ;;',
			],
		);

		expect(result.status).toBe(0);
		expect(result.lines).toEqual([
			"Traefik is already connected to joined-compose",
			"Skipped gone-compose: Error response from daemon: network gone-compose not found",
		]);
	});

	it.skipIf(!hasSh)("counts the overlay wording as already connected", async () => {
		const result = await runScript(
			["overlay-compose"],
			[
				'*) echo "Error response from daemon: dokploy-traefik is already attached to network overlay-compose"; exit 1 ;;',
			],
		);

		expect(result.status).toBe(0);
		expect(result.lines).toEqual(["Traefik is already connected to overlay-compose"]);
	});

	// Not Docker's already-connected wording, so Traefik is not connected there.
	it.skipIf(!hasSh)("skips, not connects, on an unrelated already-exists error and logs only its first line", async () => {
		const result = await runScript(
			["broken-compose"],
			[
				'*) printf "%s\\n%s\\n" "Error response from daemon: could not add service state for endpoint dokploy-traefik to cluster on UpdateDNSNames: cannot create entry in table endpoint_table, already exists" "second line"; exit 1 ;;',
			],
		);

		expect(result.status).toBe(0);
		expect(result.lines).toEqual([
			"Skipped broken-compose: Error response from daemon: could not add service state for endpoint dokploy-traefik to cluster on UpdateDNSNames: cannot create entry in table endpoint_table, already exists",
		]);
	});

	it.skipIf(!hasSh)("does not connect anything while Traefik is not running", async () => {
		const result = await runScript(
			["live-compose"],
			['*) echo "connect must not run"; exit 1 ;;'],
			"",
		);

		expect(result.status).toBe(0);
		expect(result.lines).toEqual([
			"Traefik is not running; skipped reconnecting isolated composes",
		]);
	});

	it("logs what the script printed", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		mocks.findMany.mockResolvedValue([{ appName: "gone-compose" }]);
		mocks.execAsync.mockResolvedValue({
			stdout: "Skipped gone-compose: network gone-compose not found\n",
			stderr: "",
		});

		await reconnectServicesToTraefik();

		expect(log).toHaveBeenCalledWith(
			"Skipped gone-compose: network gone-compose not found",
		);
		log.mockRestore();
	});
});
