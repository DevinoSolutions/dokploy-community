import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApplicationNested, Domain } from "@dokploy/server";
import { manageDomain, removeDomain } from "@dokploy/server";
import type { FileConfig } from "@dokploy/server/utils/traefik/file-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

// The remote host is a real `sh` working on a temp directory that stands in
// for /etc/dokploy, so the confined remote commands run for real (Linux only).
const remote = vi.hoisted(() => ({ root: "" }));

const runOnFakeHost = (command: string, stdin?: string) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(
			"sh",
			["-c", command.split("/etc/dokploy").join(remote.root)],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else {
				reject(
					Object.assign(new Error(stderr), {
						name: "ExecError",
						exitCode: code,
					}),
				);
			}
		});
		child.stdin.end(stdin ?? "");
	});

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	const delay = () => new Promise((r) => setTimeout(r, Math.random() * 10));
	return {
		...actual,
		execAsyncRemote: vi.fn(
			async (
				_serverId: string,
				command: string,
				_onData?: unknown,
				options?: { stdin?: string },
			) => {
				await delay();
				return runOnFakeHost(command, options?.stdin);
			},
		),
	};
});

const appName = "race-app";

const domainFor = (uniqueConfigKey: number): Domain =>
	({
		applicationId: "app-1",
		certificateType: "none",
		createdAt: "",
		domainId: `domain-${uniqueConfigKey}`,
		host: `d${uniqueConfigKey}.example.com`,
		https: false,
		path: null,
		port: 3000,
		customEntrypoint: null,
		serviceName: "",
		composeId: "",
		customCertResolver: null,
		domainType: "application",
		uniqueConfigKey,
		previewDeploymentId: "",
		internalPath: "/",
		stripPath: false,
		middlewares: null,
		forwardAuthEnabled: false,
		enabled: true,
	}) as unknown as Domain;

const keys = [1, 2, 3, 4, 5];

describe.each([
	["local", null, false],
	["remote", "server-1", process.platform === "win32"],
])("concurrent domain changes (%s)", (_label, serverId, skip) => {
	describe.skipIf(skip)("", () => {
		let cwd: string;
		const app = {
			appName,
			serverId,
			redirects: [],
			security: [],
		} as unknown as ApplicationNested;

		const readConfig = (): FileConfig => {
			const content = serverId
				? fs.readFileSync(
						path.join(remote.root, "traefik/dynamic", `${appName}.yml`),
						"utf8",
					)
				: fs.readFileSync(
						path.join(cwd, ".docker/traefik/dynamic", `${appName}.yml`),
						"utf8",
					);
			return parse(content ?? "") as FileConfig;
		};

		beforeEach(() => {
			cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-race-"));
			fs.mkdirSync(path.join(cwd, ".docker/traefik/dynamic"), {
				recursive: true,
			});
			vi.spyOn(process, "cwd").mockReturnValue(cwd);
			remote.root = path.join(cwd, "remote-root");
			fs.mkdirSync(path.join(remote.root, "traefik/dynamic"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(remote.root, "traefik/dynamic/middlewares.yml"),
				"http:\n  middlewares: {}\n",
			);
		});

		afterEach(() => {
			vi.restoreAllMocks();
			fs.rmSync(cwd, { recursive: true, force: true });
		});

		it("keeps every router when domains are created concurrently", async () => {
			await Promise.all(keys.map((k) => manageDomain(app, domainFor(k))));

			expect(Object.keys(readConfig().http?.routers ?? {}).sort()).toEqual(
				keys.map((k) => `${appName}-router-${k}`),
			);
		});

		it("removes every router when domains are deleted concurrently", async () => {
			for (const k of keys) await manageDomain(app, domainFor(k));

			await Promise.all(keys.slice(0, 4).map((k) => removeDomain(app, k)));

			expect(Object.keys(readConfig().http?.routers ?? {})).toEqual([
				`${appName}-router-5`,
			]);
		});
	});
});
