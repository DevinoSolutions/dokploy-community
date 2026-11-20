import { describe, expect, it, vi } from "vitest";

/**
 * The lane classifier of the deploy queue (T-12497). A job is `pull` only when it
 * provably builds nothing; every doubt, error and unknown is `build`. The rules
 * run over injected readers, so no database is involved.
 */

vi.mock("@dokploy/server/db", () => ({ db: { query: {} } }));
vi.mock("@dokploy/server/db/schema", () => ({ applications: {}, compose: {} }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import {
	classifyDeployJob,
	composeFileIsPullOnly,
	type LaneApplicationRow,
	type LaneComposeRow,
	type LaneReaders,
	MAX_PULL_COMPOSE_BYTES,
	PULL_LANE_DEFAULT_CONCURRENCY,
	resolvePullConcurrency,
} from "../../server/queues/deploy-lane";
import type { DeploymentJob } from "../../server/queues/queue-types";

const appJob = (extra: Record<string, unknown> = {}) =>
	({
		applicationId: "app-1",
		titleLog: "t",
		descriptionLog: "",
		type: "deploy",
		applicationType: "application",
		...extra,
	}) as DeploymentJob;

const previewJob = () =>
	({
		applicationId: "app-1",
		titleLog: "t",
		descriptionLog: "",
		type: "deploy",
		applicationType: "application-preview",
		previewDeploymentId: "pv-1",
	}) as DeploymentJob;

const composeJob = () =>
	({
		composeId: "comp-1",
		titleLog: "t",
		descriptionLog: "",
		type: "deploy",
		applicationType: "compose",
	}) as DeploymentJob;

const composePreviewJob = () =>
	({
		composeId: "comp-1",
		titleLog: "t",
		descriptionLog: "",
		type: "deploy",
		applicationType: "compose-preview",
		previewDeploymentId: "pv-1",
	}) as DeploymentJob;

const dockerApp: LaneApplicationRow = {
	sourceType: "docker",
	buildServerId: null,
};

const IMAGE_ONLY = `services:
  web:
    image: nginx:1.27
  db:
    image: postgres:16
`;

const rawCompose = (
	composeFile: string | null,
	extra: Partial<LaneComposeRow> = {},
): LaneComposeRow => ({
	sourceType: "raw",
	buildServerId: null,
	command: "",
	composeFile,
	...extra,
});

const readers = (rows: {
	application?: LaneApplicationRow | null;
	compose?: LaneComposeRow | null;
}) => {
	const readApplication = vi.fn(async () => rows.application);
	const readCompose = vi.fn(async () => rows.compose);
	return { readApplication, readCompose } satisfies LaneReaders;
};

describe("classifyDeployJob: applications", () => {
	const cases: Array<[string, LaneApplicationRow | null | undefined, string]> =
		[
			["a Docker-image app with no build server", dockerApp, "pull"],
			[
				"a Docker-image app WITH a build server (the pull runs on the build host)",
				{ sourceType: "docker", buildServerId: "build-1" },
				"build",
			],
			[
				"a github-sourced app",
				{ sourceType: "github", buildServerId: null },
				"build",
			],
			[
				"a git-sourced app",
				{ sourceType: "git", buildServerId: null },
				"build",
			],
			[
				"a github-actions-sourced app (not proven to skip the build path)",
				{ sourceType: "github-actions", buildServerId: null },
				"build",
			],
			[
				"a Docker-image app whose build server column is not null-or-id",
				{
					sourceType: "docker",
					buildServerId: undefined as unknown as null,
				},
				"build",
			],
			["a missing row", null, "build"],
			["an undefined row", undefined, "build"],
		];

	it.each(cases)("%s -> %s", async (_name, row, lane) => {
		const r = readers({ application: row });
		await expect(classifyDeployJob(appJob(), r)).resolves.toBe(lane);
		expect(r.readApplication).toHaveBeenCalledWith("app-1");
		expect(r.readCompose).not.toHaveBeenCalled();
	});

	it("a redeploy follows the same rule as a deploy", async () => {
		const r = readers({ application: dockerApp });
		await expect(
			classifyDeployJob(appJob({ type: "redeploy" }), r),
		).resolves.toBe("pull");
	});

	it("a deploy-hook pinned image is a pull without reading anything", async () => {
		const r = readers({ application: null });
		await expect(
			classifyDeployJob(
				appJob({ pinnedImage: { ref: "r/x", tag: "v1", digest: "sha256:ab" } }),
				r,
			),
		).resolves.toBe("pull");
		expect(r.readApplication).not.toHaveBeenCalled();
	});

	it("a database error is a build", async () => {
		const r = {
			readApplication: vi.fn(async () => {
				throw new Error("db down");
			}),
			readCompose: vi.fn(),
		};
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		await expect(classifyDeployJob(appJob(), r)).resolves.toBe("build");
		debug.mockRestore();
	});

	it("a reader that throws synchronously is a build", async () => {
		const r = {
			readApplication: vi.fn(() => {
				throw new Error("sync");
			}),
			readCompose: vi.fn(),
		};
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		await expect(classifyDeployJob(appJob(), r)).resolves.toBe("build");
		debug.mockRestore();
	});
});

describe("classifyDeployJob: previews", () => {
	it("a preview of a Docker-image app pulls", async () => {
		const r = readers({ application: dockerApp });
		await expect(classifyDeployJob(previewJob(), r)).resolves.toBe("pull");
		expect(r.readApplication).toHaveBeenCalledWith("app-1");
	});

	it("a preview of a git app clones and builds", async () => {
		const r = readers({
			application: { sourceType: "github", buildServerId: null },
		});
		await expect(classifyDeployJob(previewJob(), r)).resolves.toBe("build");
	});

	it("a preview of a Docker-image app with a build server is a build", async () => {
		const r = readers({
			application: { sourceType: "docker", buildServerId: "b1" },
		});
		await expect(classifyDeployJob(previewJob(), r)).resolves.toBe("build");
	});

	it("a compose preview always needs a clone", async () => {
		const r = readers({ compose: rawCompose(IMAGE_ONLY) });
		await expect(classifyDeployJob(composePreviewJob(), r)).resolves.toBe(
			"build",
		);
		expect(r.readCompose).not.toHaveBeenCalled();
	});
});

describe("classifyDeployJob: composes", () => {
	it("a raw image-only compose with no build server and no command pulls", async () => {
		const r = readers({ compose: rawCompose(IMAGE_ONLY) });
		await expect(classifyDeployJob(composeJob(), r)).resolves.toBe("pull");
		expect(r.readCompose).toHaveBeenCalledWith("comp-1");
		expect(r.readApplication).not.toHaveBeenCalled();
	});

	const cases: Array<[string, LaneComposeRow | null | undefined]> = [
		[
			"a build: block",
			rawCompose(`services:
  web:
    image: nginx
    build: .
`),
		],
		[
			"a build: block with context",
			rawCompose(`services:
  web:
    image: nginx
    build:
      context: ./app
`),
		],
		[
			"flow-style {build: .} (the regex misses it)",
			rawCompose("services:\n  web: {image: nginx, build: .}\n"),
		],
		[
			"JSON compose with a build key (the regex misses it)",
			rawCompose('{"services":{"web":{"image":"nginx","build":"."}}}'),
		],
		[
			"a service that inherits build through a merge anchor",
			rawCompose(`x-base: &base
  image: nginx
  build: .
services:
  web:
    <<: *base
`),
		],
		[
			"a service with extends",
			rawCompose(`services:
  web:
    image: nginx
    extends:
      file: other.yml
      service: web
`),
		],
		[
			"a top-level include",
			rawCompose(`include:
  - other.yml
services:
  web:
    image: nginx
`),
		],
		[
			"a service without an image",
			rawCompose(`services:
  web:
    image: nginx
  worker:
    command: ["run"]
`),
		],
		[
			"a service with an empty image",
			rawCompose(`services:
  web:
    image: ""
`),
		],
		[
			"a service that is not an object",
			rawCompose(`services:
  web: nginx
`),
		],
		["a compose with no services", rawCompose("version: '3'\n")],
		["a compose with an empty services map", rawCompose("services: {}\n")],
		["invalid YAML", rawCompose("services:\n  web: [unclosed\n")],
		[
			"two YAML documents",
			rawCompose(`services:
  web:
    image: nginx
---
services:
  web:
    build: .
`),
		],
		["an empty file", rawCompose("")],
		["a null file", rawCompose(null)],
		[
			"a file over 256 KB",
			rawCompose(`${IMAGE_ONLY}# ${"x".repeat(MAX_PULL_COMPOSE_BYTES)}\n`),
		],
		["a custom command", rawCompose(IMAGE_ONLY, { command: "docker run x" })],
		["a build server", rawCompose(IMAGE_ONLY, { buildServerId: "build-1" })],
		[
			"a git-sourced compose, even with an image-only file",
			rawCompose(IMAGE_ONLY, { sourceType: "git" }),
		],
		[
			"a github-sourced compose",
			rawCompose(IMAGE_ONLY, { sourceType: "github" }),
		],
		[
			"a github-actions-sourced compose",
			rawCompose(IMAGE_ONLY, { sourceType: "github-actions" }),
		],
		["a missing row", null],
		["an undefined row", undefined],
	];

	it.each(cases)("%s -> build", async (_name, row) => {
		const r = readers({ compose: row });
		await expect(classifyDeployJob(composeJob(), r)).resolves.toBe("build");
	});

	it("a database error is a build", async () => {
		const r = {
			readApplication: vi.fn(),
			readCompose: vi.fn(async () => {
				throw new Error("db down");
			}),
		};
		const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
		await expect(classifyDeployJob(composeJob(), r)).resolves.toBe("build");
		debug.mockRestore();
	});

	it("a file with more aliases than the cap is a build", () => {
		const withAliases = (count: number) => {
			const items = Array.from({ length: count }, () => "      - *a").join(
				"\n",
			);
			return `x-a: &a nginx\nservices:\n  web:\n    image: nginx\n    labels:\n${items}\n`;
		};
		expect(composeFileIsPullOnly(withAliases(50))).toBe(true);
		expect(composeFileIsPullOnly(withAliases(150))).toBe(false);
	});

	it("an unknown job type is a build and reads nothing", async () => {
		const r = readers({ application: dockerApp });
		await expect(
			classifyDeployJob({ applicationType: "mystery" } as never, r),
		).resolves.toBe("build");
		expect(r.readApplication).not.toHaveBeenCalled();
		expect(r.readCompose).not.toHaveBeenCalled();
	});
});

describe("composeFileIsPullOnly", () => {
	it("accepts a merge anchor that only carries an image", () => {
		expect(
			composeFileIsPullOnly(`x-base: &base
  image: nginx
services:
  a:
    <<: *base
  b:
    <<: *base
`),
		).toBe(true);
	});

	it("accepts a flow-style service with only an image", () => {
		expect(composeFileIsPullOnly("services:\n  web: {image: nginx}\n")).toBe(
			true,
		);
	});

	it("accepts a JSON compose that builds nothing", () => {
		expect(
			composeFileIsPullOnly('{"services":{"web":{"image":"nginx"}}}'),
		).toBe(true);
	});

	it("refuses a build key the line regex alone would also catch", () => {
		expect(
			composeFileIsPullOnly("services:\n  web:\n    image: x\n    build: .\n"),
		).toBe(false);
	});

	it("is exactly at the size limit still readable, one byte over is not", () => {
		const pad = (n: number) => `# ${"x".repeat(n)}\n`;
		const base = IMAGE_ONLY;
		const room = MAX_PULL_COMPOSE_BYTES - Buffer.byteLength(base);
		expect(composeFileIsPullOnly(base + pad(room - 3))).toBe(true);
		expect(composeFileIsPullOnly(base + pad(room))).toBe(false);
	});

	it("measures bytes, not characters", () => {
		const emoji = "\u{1F600}".repeat(MAX_PULL_COMPOSE_BYTES / 4 + 1);
		expect(composeFileIsPullOnly(`${IMAGE_ONLY}# ${emoji}\n`)).toBe(false);
	});

	it("refuses anything that is not a string", () => {
		expect(composeFileIsPullOnly(undefined)).toBe(false);
		expect(composeFileIsPullOnly(42)).toBe(false);
	});
});

describe("resolvePullConcurrency", () => {
	const env = (value?: string) =>
		value === undefined ? {} : { DOKPLOY_PULL_LANE_CONCURRENCY: value };

	it("defaults to 4 per partition", () => {
		expect(PULL_LANE_DEFAULT_CONCURRENCY).toBe(4);
		expect(resolvePullConcurrency("p", env())).toBe(4);
		expect(resolvePullConcurrency(undefined, env(""))).toBe(4);
		expect(resolvePullConcurrency(undefined, env("   "))).toBe(4);
	});

	it("reads the env var", () => {
		expect(resolvePullConcurrency("p", env("7"))).toBe(7);
		expect(resolvePullConcurrency("p", env(" 2 "))).toBe(2);
		expect(resolvePullConcurrency("p", env("2.9"))).toBe(2);
	});

	it("0 turns the lane off", () => {
		expect(resolvePullConcurrency("p", env("0"))).toBe(0);
	});

	it("clamps to 0..16", () => {
		expect(resolvePullConcurrency("p", env("99"))).toBe(16);
		expect(resolvePullConcurrency("p", env("16"))).toBe(16);
		expect(resolvePullConcurrency("p", env("-3"))).toBe(0);
	});

	it("falls back to the default on garbage", () => {
		expect(resolvePullConcurrency("p", env("lots"))).toBe(4);
		expect(resolvePullConcurrency("p", env("NaN"))).toBe(4);
		expect(resolvePullConcurrency("p", env("Infinity"))).toBe(4);
	});
});
