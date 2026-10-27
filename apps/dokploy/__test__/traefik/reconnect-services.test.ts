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

// What reconnectServicesToTraefik writes for one compose.
const connectLine = (app: string) =>
	`out=$(docker network connect ${app} $(docker ps --filter "name=dokploy-traefik" -q) 2>&1) || case "$out" in *"already exists"*) echo "Traefik is already connected to ${app}";; *) echo "Skipped ${app}: $out";; esac`;

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
			`${connectLine("first-compose")}\n` +
				`${connectLine("second-compose")}\n`,
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments on a remote server", async () => {
		mocks.findMany.mockResolvedValue([{ appName: "remote-compose" }]);

		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-id",
			`${connectLine("remote-compose")}\n`,
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	// A stale isolated-compose row whose network is gone used to fail the whole
	// Traefik update through the exit code of the last command. The generated
	// script is run for real, with a docker stub that answers like the engine.
	const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
	it.skipIf(!hasSh)(
		"runs to exit code 0 and says why a network was skipped",
		async () => {
			mocks.findMany.mockResolvedValue([
				{ appName: "live-compose" },
				{ appName: "joined-compose" },
				{ appName: "gone-compose" },
			]);
			await reconnectServicesToTraefik();
			const script = mocks.execAsync.mock.calls[0]?.[0] as string;

			const dir = mkdtempSync(join(tmpdir(), "t9412-"));
			try {
				writeFileSync(
					join(dir, "docker"),
					[
						"#!/bin/sh",
						'if [ "$1" = ps ]; then echo traefikid; exit 0; fi',
						'case "$3" in',
						"live-compose) exit 0 ;;",
						'joined-compose) echo "Error response from daemon: endpoint with name dokploy-traefik already exists in network joined-compose"; exit 1 ;;',
						'*) echo "Error response from daemon: network $3 not found"; exit 1 ;;',
						"esac",
					].join("\n"),
				);
				chmodSync(join(dir, "docker"), 0o755);
				const run = spawnSync("sh", ["-c", script], {
					encoding: "utf8",
					env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
				});

				expect(run.status).toBe(0);
				expect(run.stdout.trim().split("\n")).toEqual([
					"Traefik is already connected to joined-compose",
					'Skipped gone-compose: Error response from daemon: network gone-compose not found',
				]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

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
