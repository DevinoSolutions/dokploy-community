import { shouldDeploy } from "@dokploy/server";
import {
	MAX_CHANGED_FILE_LENGTH,
	WATCH_PATH_MATCH_OPTIONS,
} from "@dokploy/server/utils/watch-paths/should-deploy";
import micromatch from "micromatch";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("shouldDeploy", () => {
	it("should deploy when no watch paths are configured", () => {
		expect(shouldDeploy(null, ["src/index.ts"])).toBe(true);
		expect(shouldDeploy([], ["src/index.ts"])).toBe(true);
	});

	it("should deploy when watch paths match modified files", () => {
		expect(shouldDeploy(["src/**"], ["src/index.ts"])).toBe(true);
		expect(shouldDeploy(["apps/web/**"], ["apps/web/page.tsx"])).toBe(true);
	});

	it("should not deploy when watch paths do not match", () => {
		expect(shouldDeploy(["src/**"], ["docs/readme.md"])).toBe(false);
	});

	it("should apply multiple negated watch paths as one pattern set", () => {
		const watchPaths = ["!CHANGELOG.md", "!VERSION", "!tests/**"];

		expect(shouldDeploy(watchPaths, ["CHANGELOG.md"])).toBe(false);
		expect(shouldDeploy(watchPaths, ["VERSION"])).toBe(false);
		expect(shouldDeploy(watchPaths, ["tests/unit/example.test.ts"])).toBe(
			false,
		);
	});

	it("should deploy when a changed file remains after exclusions", () => {
		const watchPaths = ["!CHANGELOG.md", "!VERSION", "!tests/**"];

		expect(shouldDeploy(watchPaths, ["VERSION", "src/index.ts"])).toBe(true);
	});

	it("should combine positive and negated watch paths", () => {
		const watchPaths = ["src/**", "!src/**/*.test.ts"];

		expect(shouldDeploy(watchPaths, ["src/index.ts"])).toBe(true);
		expect(shouldDeploy(watchPaths, ["src/index.test.ts"])).toBe(false);
		expect(shouldDeploy(watchPaths, ["docs/readme.md"])).toBe(false);
	});

	it("should not throw when modified files contain non-string values", () => {
		expect(() =>
			shouldDeploy(["src/**"], ["src/index.ts", undefined, null] as any),
		).not.toThrow();
		expect(
			shouldDeploy(["src/**"], ["src/index.ts", undefined, null] as any),
		).toBe(true);
	});

	it("should not throw when modified files are undefined or null", () => {
		expect(() => shouldDeploy(["src/**"], undefined)).not.toThrow();
		expect(() => shouldDeploy(["src/**"], null)).not.toThrow();
		expect(shouldDeploy(["src/**"], undefined)).toBe(false);
		expect(shouldDeploy(["src/**"], null)).toBe(false);
	});

	it("should not throw when every modified file is non-string", () => {
		expect(() =>
			shouldDeploy(["src/**"], [undefined, undefined] as any),
		).not.toThrow();
		expect(shouldDeploy(["src/**"], [undefined, undefined] as any)).toBe(false);
	});
});

// picomatch GHSA-fc5q-39xc-vjpf. Measured locally (micromatch 4.0.8 on
// picomatch 2.3.2, Node 24) against this exact LONG input: without
// WATCH_PATH_MATCH_OPTIONS, micromatch([LONG], ["+(*)"]) and ["*(*)"] were
// still running when killed at 30 s (at 30 characters they already pass 10 s);
// with the options they took 2 ms and 18 ms. The (a|aa) shapes do not blow up
// on this picomatch version and are kept as regression cases.
const LONG = `${"a".repeat(4096)}/`;
const MS = 500;

const timed = <T>(run: () => T) => {
	const started = performance.now();
	const value = run();
	return { value, ms: performance.now() - started };
};

describe("shouldDeploy with hostile watch paths", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("matches with extglob and brace parsing turned off", () => {
		expect(WATCH_PATH_MATCH_OPTIONS).toEqual({
			noextglob: true,
			nobrace: true,
		});
	});

	it.each(["+(*)", "*(*)", "*(a|aa)", "*(*(a|aa))b"])(
		"the matcher alone returns %s on a long path within the time limit",
		(pattern) => {
			const { value, ms } = timed(() =>
				micromatch([LONG], [pattern], WATCH_PATH_MATCH_OPTIONS),
			);
			expect(value).toEqual([]);
			expect(ms).toBeLessThan(MS);
		},
	);

	it.each([
		["+(*)"],
		["*(*)"],
		["src/**", "*(a|aa)"],
		["src/**/*.{ts,tsx}"],
		["(a+)+b"],
		["*a*a*a*b"],
		["**/a/**/a/**/b"],
	])(
		"a stored list holding %s is ignored: it deploys, logs, and returns quickly",
		(...watchPaths) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { value, ms } = timed(() => shouldDeploy(watchPaths, [LONG]));
			expect(value).toBe(true);
			expect(ms).toBeLessThan(MS);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toMatch(
				/ignoring the stored watch paths and deploying/,
			);
		},
	);

	it("a valid list is unaffected by one long path", () => {
		const { value, ms } = timed(() =>
			shouldDeploy(
				["src/**", "**/*.config.*"],
				[`${"a".repeat(4000)}/b`, "a".repeat(4000)],
			),
		);
		expect(value).toBe(false);
		expect(ms).toBeLessThan(MS);
	});

	it("ignores changed paths longer than PATH_MAX", () => {
		const tooLong = `src/${"a".repeat(MAX_CHANGED_FILE_LENGTH)}`;
		expect(shouldDeploy(["src/**"], [tooLong])).toBe(false);
		expect(shouldDeploy(["src/**"], [tooLong, "src/index.ts"])).toBe(true);
	});

	it("keeps literal + and @ in plain globs working", () => {
		expect(
			shouldDeploy(["src/routes/**/+page.svelte"], ["src/routes/a/+page.svelte"]),
		).toBe(true);
		expect(shouldDeploy(["c++/**"], ["c++/main.cpp"])).toBe(true);
		expect(shouldDeploy(["packages/@scope/**"], ["packages/@scope/x.ts"])).toBe(
			true,
		);
	});
});
