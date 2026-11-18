import { beforeEach, describe, expect, it, vi } from "vitest";

// A stored watch-path list the validator refuses makes `shouldDeploy` deploy on
// every push. The form of the unit shows a notice, but nothing named the units
// that are affected; the server lists them once when it starts.
const mocks = vi.hoisted(() => ({
	applications: vi.fn(),
	composes: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findMany: mocks.applications },
			compose: { findMany: mocks.composes },
		},
	},
}));

const { findUnitsWithRefusedWatchPaths, logUnitsWithRefusedWatchPaths } =
	await import("@dokploy/server/utils/watch-paths/report-refused-watch-paths");

const app = (id: string, watchPaths: string[] | null, name = `App ${id}`) => ({
	applicationId: id,
	name,
	appName: `app-${id}`,
	watchPaths,
});
const stack = (id: string, watchPaths: string[] | null) => ({
	composeId: id,
	name: `Stack ${id}`,
	appName: `stack-${id}`,
	watchPaths,
});

beforeEach(() => {
	vi.restoreAllMocks();
	mocks.applications.mockReset();
	mocks.composes.mockReset();
});

describe("findUnitsWithRefusedWatchPaths", () => {
	it("returns the applications and composes whose stored list holds a refused pattern", async () => {
		mocks.applications.mockResolvedValue([
			app("ok", ["src/**", "!docs/**"]),
			app("bad", ["apps/{api,web}/**"]),
			app("none", null),
			app("empty", []),
		]);
		mocks.composes.mockResolvedValue([
			stack("c-bad", ["+(*)"]),
			stack("c-ok", ["a/**"]),
		]);

		const units = await findUnitsWithRefusedWatchPaths();

		expect(units.map((unit) => `${unit.kind}:${unit.id}`)).toEqual([
			"application:bad",
			"compose:c-bad",
		]);
	});

	it("reads only the columns it reports", async () => {
		mocks.applications.mockResolvedValue([]);
		mocks.composes.mockResolvedValue([]);

		await findUnitsWithRefusedWatchPaths();

		expect(mocks.applications.mock.calls[0]?.[0]).toEqual({
			columns: {
				applicationId: true,
				name: true,
				appName: true,
				watchPaths: true,
			},
		});
		expect(mocks.composes.mock.calls[0]?.[0]).toEqual({
			columns: { composeId: true, name: true, appName: true, watchPaths: true },
		});
	});
});

describe("logUnitsWithRefusedWatchPaths", () => {
	it("logs nothing when every stored list is allowed", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.applications.mockResolvedValue([app("ok", ["src/**"])]);
		mocks.composes.mockResolvedValue([]);

		await logUnitsWithRefusedWatchPaths();

		expect(warn).not.toHaveBeenCalled();
	});

	it("names each affected unit once, with its id and without its patterns", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.applications.mockResolvedValue([
			app("a1", ["apps/{api,web}/**"], "Web"),
		]);
		mocks.composes.mockResolvedValue([stack("c1", ["+(*)"])]);

		await logUnitsWithRefusedWatchPaths();

		const lines = warn.mock.calls.map((call) => String(call[0]));
		expect(lines[0]).toMatch(
			/2 unit\(s\) store watch paths that are not allowed/,
		);
		expect(lines).toContainEqual(
			expect.stringContaining('application "Web" (app-a1, id a1)'),
		);
		expect(lines).toContainEqual(
			expect.stringContaining('compose "Stack c1" (stack-c1, id c1)'),
		);
		expect(lines.join("\n")).not.toContain("+(*)");
	});

	it("caps the list and says how many more there are", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.applications.mockResolvedValue(
			Array.from({ length: 53 }, (_, i) => app(`a${i}`, ["+(*)"])),
		);
		mocks.composes.mockResolvedValue([]);

		await logUnitsWithRefusedWatchPaths();

		const lines = warn.mock.calls.map((call) => String(call[0]));
		expect(lines).toHaveLength(1 + 50 + 1);
		expect(lines.at(-1)).toMatch(/and 3 more/);
	});
});
