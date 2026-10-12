import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getTagAndPushCommand } from "@dokploy/server/utils/builders/compose-remote-build";
import {
	buildDockerPushWithRetry,
	DOCKER_PUSH_RETRY_DELAYS_SECONDS,
} from "@dokploy/server/utils/process/dockerPush";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs the generated shell in a real POSIX shell against a stub `docker` (and a
 * stub `sleep`, so the 15s / 45s backoff is observable without waiting): the
 * retry lives in shell, so only a shell can prove it.
 *
 * The stub fails `push` with `STUB_MSG` (exit 1) for the first
 * `STUB_FAIL_COUNT` calls and succeeds afterwards.
 */
const STUB_DOCKER = `#!/bin/sh
case " $* " in
	*" push "*) ;;
	*) exit 0 ;;
esac
n=$(cat "$STUB_DIR/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STUB_DIR/count"
echo "docker $*" >> "$STUB_DIR/calls"
if [ "$n" -le "\${STUB_FAIL_COUNT:-0}" ]; then
	echo "$STUB_MSG"
	exit 1
fi
echo "latest: digest: sha256:abc size: 1"
exit 0
`;

const STUB_SLEEP = `#!/bin/sh
echo "$1" >> "$STUB_DIR/sleeps"
`;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dokploy-push-retry-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const [name, body] of [
		["docker", STUB_DOCKER],
		["sleep", STUB_SLEEP],
	] as const) {
		writeFileSync(join(bin, name), body, { mode: 0o755 });
		chmodSync(join(bin, name), 0o755);
	}
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const lines = (file: string) => {
	try {
		return readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

const run = (
	script: string,
	{
		message,
		failCount,
		env = {},
	}: { message: string; failCount: number; env?: Record<string, string> },
) => {
	const result = spawnSync("sh", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			...env,
			PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
			STUB_DIR: dir,
			STUB_MSG: message,
			STUB_FAIL_COUNT: String(failCount),
		},
	});
	return {
		status: result.status,
		output: `${result.stdout}${result.stderr}`,
		pushes: lines("calls"),
		sleeps: lines("sleeps"),
	};
};

const FAILED = '|| { echo "❌ Error pushing image"; exit 1; }';
const push = (ref = "reg.example.com/acme/app:latest", configDir = "/cfg/r1") =>
	`${buildDockerPushWithRetry(ref, configDir)} ${FAILED}`;

// Each stub call is a process spawn (slow on Windows), hence the roomy timeout.
describe("docker push retry (shell)", { timeout: 60_000 }, () => {
	it("retries a 503 and succeeds on the third attempt", () => {
		const result = run(push(), {
			message: "received unexpected HTTP status: 503 ",
			failCount: 2,
		});
		expect(result.status).toBe(0);
		expect(result.pushes).toHaveLength(3);
		expect(result.sleeps).toEqual(DOCKER_PUSH_RETRY_DELAYS_SECONDS.map(String));
		expect(result.output).toContain(
			"Registry push failed with a transient error (attempt 1/3), retrying in 15s",
		);
		expect(result.output).toContain(
			"Registry push failed with a transient error (attempt 2/3), retrying in 45s",
		);
		expect(result.output).not.toContain("Error pushing image");
	});

	it("keeps the registry's own docker config on every attempt", () => {
		const result = run(push("reg.example.com/acme/app:latest", "/cfg/r1"), {
			message: "received unexpected HTTP status: 503 ",
			failCount: 2,
		});
		expect(result.pushes).toEqual(
			Array(3).fill(
				"docker --config /cfg/r1 push reg.example.com/acme/app:latest",
			),
		);
	});

	it("uses the default docker config when the registry has none", () => {
		const result = run(
			`${buildDockerPushWithRetry("reg.example.com/acme/app:latest")} ${FAILED}`,
			{ message: "received unexpected HTTP status: 502 ", failCount: 1 },
		);
		expect(result.status).toBe(0);
		expect(result.pushes).toEqual(
			Array(2).fill("docker push reg.example.com/acme/app:latest"),
		);
	});

	it("does not retry an unauthorized push", () => {
		const result = run(push(), {
			message: "unauthorized: authentication required",
			failCount: 99,
		});
		expect(result.status).not.toBe(0);
		expect(result.pushes).toHaveLength(1);
		expect(result.sleeps).toEqual([]);
		expect(result.output).toContain("unauthorized: authentication required");
		expect(result.output).toContain("❌ Error pushing image");
	});

	it.each([
		"denied: requested access to the resource is denied",
		"received unexpected HTTP status: 401 Unauthorized",
		"received unexpected HTTP status: 403 Forbidden",
		"manifest invalid: manifest invalid",
		"some failure nobody has heard of",
	])("does not retry: %s", (message) => {
		const result = run(push(), { message, failCount: 99 });
		expect(result.status).not.toBe(0);
		expect(result.pushes).toHaveLength(1);
	});

	it("gives up after three attempts and keeps the original error text", () => {
		const result = run(push(), {
			message: "received unexpected HTTP status: 500 Internal Server Error",
			failCount: 99,
		});
		expect(result.status).not.toBe(0);
		expect(result.pushes).toHaveLength(3);
		expect(result.sleeps).toEqual(["15", "45"]);
		const original = result.output.match(
			/received unexpected HTTP status: 500 Internal Server Error/g,
		);
		expect(original).toHaveLength(3);
		expect(result.output).toContain("❌ Error pushing image");
		expect(result.output).not.toContain("attempt 3/3");
	});

	it.each([
		"received unexpected HTTP status: 503 ",
		"received unexpected HTTP status: 504 Gateway Timeout",
		"error parsing HTTP 502 response body: 502 Bad Gateway",
		"read tcp 10.0.0.1:1234->10.0.0.2:443: read: connection reset by peer",
		"Put https://reg.example.com/v2/x/blobs/uploads/y: unexpected EOF",
		"Get https://reg.example.com/v2/: net/http: TLS handshake timeout",
		"dial tcp 10.0.0.2:443: i/o timeout",
	])("retries: %s", (message) => {
		const result = run(push(), { message, failCount: 1 });
		expect(result.status).toBe(0);
		expect(result.pushes).toHaveLength(2);
	});

	it("passes a shell-word reference through (the build policy's $TAG)", () => {
		const script = `${buildDockerPushWithRetry('"$DOKPLOY_BP_TAG"', "/cfg/r1", { rawShellRef: true })} ${FAILED}`;
		const result = run(script, {
			message: "received unexpected HTTP status: 503 ",
			failCount: 1,
			env: { DOKPLOY_BP_TAG: "reg.example.com/acme/app:abc123" },
		});
		expect(result.status).toBe(0);
		expect(result.pushes).toEqual(
			Array(2).fill(
				"docker --config /cfg/r1 push reg.example.com/acme/app:abc123",
			),
		);
	});

	it("shell-quotes the reference", () => {
		const script = `${buildDockerPushWithRetry("reg/x;touch pwned", "/cfg/r1")} ${FAILED}`;
		const result = run(script, { message: "", failCount: 0 });
		expect(result.status).toBe(0);
		expect(result.pushes).toEqual([
			"docker --config /cfg/r1 push reg/x;touch pwned",
		]);
	});

	it("retries every push of the compose build-server script", () => {
		const script = getTagAndPushCommand({
			images: [
				{
					service: "web",
					localImage: "app-web",
					ref: "reg.example.com/acme/app-web:dpl-1",
					latestRef: "reg.example.com/acme/app-web:latest",
				},
				{
					service: "api",
					localImage: "app-api",
					ref: "reg.example.com/acme/app-api:dpl-1",
					latestRef: "reg.example.com/acme/app-api:latest",
				},
			],
			registryLabel: "reg.example.com",
			configDir: "/cfg/r1",
		});
		// The first two pushes (web's) hit a 503 once; the rest are healthy.
		const result = run(script, {
			message: "received unexpected HTTP status: 503 ",
			failCount: 1,
		});
		expect(result.status).toBe(0);
		expect(result.pushes).toEqual([
			"docker --config /cfg/r1 push reg.example.com/acme/app-web:dpl-1",
			"docker --config /cfg/r1 push reg.example.com/acme/app-web:dpl-1",
			"docker --config /cfg/r1 push reg.example.com/acme/app-web:latest",
			"docker --config /cfg/r1 push reg.example.com/acme/app-api:dpl-1",
			"docker --config /cfg/r1 push reg.example.com/acme/app-api:latest",
		]);
		expect(result.output).toContain("✅ api pushed");
	});

	it("fails the compose build-server script when a push never recovers", () => {
		const script = getTagAndPushCommand({
			images: [
				{
					service: "web",
					localImage: "app-web",
					ref: "reg.example.com/acme/app-web:dpl-1",
					latestRef: "reg.example.com/acme/app-web:latest",
				},
			],
			registryLabel: "reg.example.com",
		});
		const result = run(script, {
			message: "received unexpected HTTP status: 500 Internal Server Error",
			failCount: 99,
		});
		expect(result.status).not.toBe(0);
		expect(result.pushes).toHaveLength(3);
		expect(result.output).toContain("❌ Error pushing image");
		expect(result.output).not.toContain("✅ web pushed");
	});
});
