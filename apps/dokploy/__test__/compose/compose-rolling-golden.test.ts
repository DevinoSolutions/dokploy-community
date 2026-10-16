import { readFileSync } from "node:fs";
import { getBuildComposeCommand } from "@dokploy/server/utils/builders/compose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GOLDEN_BASE_COMPOSE,
	GOLDEN_CASES,
	GOLDEN_REMOTE_BUILD,
} from "./golden-build-command-cases";

// The builder joins paths with node:path; pin it to posix so the fixture does
// not depend on the OS the test runs on.
vi.mock("node:path", async () => {
	const actual = await vi.importActual<typeof import("node:path")>("node:path");
	return { ...actual, ...actual.posix, default: actual.posix };
});
const domain = vi.hoisted(() => ({
	writeDomainsToCompose: vi.fn().mockResolvedValue(""),
	addDomainToCompose: vi.fn(),
}));
vi.mock("@dokploy/server/utils/docker/domain", () => domain);
vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/process/execAsync")
	>()),
	execAsyncRemote: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
	writeFileRemote: vi.fn().mockResolvedValue(undefined),
}));

/**
 * The rolling replace is opt-in: a compose that did not opt in must keep
 * getting exactly the scripts of `__fixtures__/build-command-golden.json`
 * (the same fixture the deploy guardrails' golden test uses), and the builder
 * must not even read the compose spec for it.
 */
const golden: Record<string, string> = JSON.parse(
	readFileSync(
		new URL("./__fixtures__/build-command-golden.json", import.meta.url),
		"utf8",
	),
);

const render = (name: string, overrides: Record<string, unknown>) => {
	const c = GOLDEN_CASES[name];
	if (!c) throw new Error(`Unknown golden case ${name}`);
	return getBuildComposeCommand(
		{ ...GOLDEN_BASE_COMPOSE, ...c.overrides, ...overrides } as never,
		{
			deploymentId: "dep-1",
			freshVolumes: c.options.freshVolumes,
			remoteBuild: c.options.remoteBuild ? GOLDEN_REMOTE_BUILD : undefined,
		},
	);
};

beforeEach(() => {
	domain.addDomainToCompose.mockReset();
});

describe("golden build command (rolling replace off)", () => {
	const offValues: Array<[string, Record<string, unknown>]> = [
		["no rollingReplace property", {}],
		["null", { rollingReplace: null }],
		["undefined", { rollingReplace: undefined }],
		["an empty object", { rollingReplace: {} }],
		[
			"disabled with services",
			{ rollingReplace: { enabled: false, services: ["web"] } },
		],
		[
			"enabled with no services",
			{ rollingReplace: { enabled: true, services: [] } },
		],
		[
			"malformed (bad timeout)",
			{
				rollingReplace: {
					enabled: true,
					services: ["web"],
					healthTimeoutSeconds: 1,
				},
			},
		],
		[
			"malformed (hostile service)",
			{ rollingReplace: { enabled: true, services: ["web;x"] } },
		],
		["a string", { rollingReplace: "on" }],
	];

	for (const name of Object.keys(GOLDEN_CASES)) {
		it.each(offValues)(
			`${name}: %s equals the pre-rolling script`,
			async (_label, overrides) => {
				expect(await render(name, overrides)).toBe(golden[name]);
				expect(domain.addDomainToCompose).not.toHaveBeenCalled();
			},
		);
	}

	it("guardrails and rolling off together: still the golden script", async () => {
		expect(
			await render("compose", {
				deployGuardrails: { phaseTimestamps: false },
				rollingReplace: null,
			}),
		).toBe(golden.compose);
	});

	it("an enabled setting does change the script", async () => {
		domain.addDomainToCompose.mockResolvedValue({
			services: {
				web: {
					image: "x",
					healthcheck: { test: ["CMD", "true"], interval: "5s" },
				},
			},
		});
		const script = await render("compose", {
			rollingReplace: { enabled: true, services: ["web"] },
		});
		expect(script).not.toBe(golden.compose);
		expect(script).toContain("dokploy_roll_run");
	});
});
