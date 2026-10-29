import { buildComposeOverrideYaml } from "@dokploy/server/utils/builders/compose-remote-build";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	openRemoteInputSession: vi.fn(),
	findRegistryByIdWithCredentials: vi.fn(),
	findAllDeploymentsByComposeId: vi.fn(),
	logLines: [] as string[],
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	openRemoteInputSession: mocks.openRemoteInputSession,
}));
vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: mocks.findRegistryByIdWithCredentials,
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	findAllDeploymentsByComposeId: mocks.findAllDeploymentsByComposeId,
}));
vi.mock("@dokploy/server/services/compose-build-server", () => ({
	createDeploymentLogWriter: () => ({
		push: (text: string) => void mocks.logLines.push(text),
		line: (text: string) => void mocks.logLines.push(text),
		close: async () => {},
	}),
}));

import { pruneComposeBuildRegistry } from "@dokploy/server/services/compose-registry-retention";

const PASSWORD = 'S3cr3t"pa$$\\word';
const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const REGISTRY = "localhost:5000";
const PREFIX = "acme";

const entity = {
	appName: "my-app",
	composeId: "c1",
	serverId: null,
	sourceType: "git",
	composePath: "docker-compose.yml",
	buildServerId: "build-1",
	buildRegistryId: "reg-1",
};
const deployment = { logPath: "/logs/my-app.log", deploymentId: "current" };

/** A registry:2 stand-in: repo -> tag -> digest, plus the manifests' bodies. */
interface FakeRegistry {
	repos: Record<string, Record<string, string>>;
	bodies: Record<string, string>;
	deleted: string[];
	/** status for DELETE, default 202 */
	deleteStatus?: number;
	/** status for /v2/ , default 200 */
	pingStatus?: number;
	/** HEAD/GET of these tags fail with 500 */
	brokenTags?: string[];
	/** which scheme answers; the other one cannot connect */
	scheme: "http" | "https" | "none";
	noCurl?: boolean;
	sessionError?: Error;
	/** `Link` header on every tag listing: the registry paged or truncated it */
	listingLink?: string;
	/** tags that exist but are left out of the listing */
	hideFromListing?: string[];
	/** tags the listing names that no longer resolve (HEAD/GET 404) */
	staleListed?: string[];
	/** per-digest DELETE status, overrides `deleteStatus` */
	deleteStatusFor?: (digest: string) => number | undefined;
	/** pages tag listings at this many tags (sorted, `last` + `Link`, like distribution v3) */
	pageSize?: number;
	/** replaces the `Link` header of a paged listing */
	pageLink?: (next: string) => string;
	requests: { method: string; url: string }[];
}

const unquote = (value: string) => value.replace(/\\(.)/g, "$1");
const field = (block: string, key: string) => {
	const match = new RegExp(`^${key} = "((?:[^"\\\\]|\\\\.)*)"$`, "m").exec(block);
	return match ? unquote(match[1] as string) : undefined;
};

const blocksOf = (config: string) => config.trim().split("\nnext\n");

/** Reads the curl config the way curl would and answers like the registry. */
const answer = (registry: FakeRegistry, config: string) =>
	blocksOf(config)
		.map((block) => answerBlock(registry, block))
		.join("");

/** One request of a curl config, answered; the text curl prints for it. */
const answerBlock = (registry: FakeRegistry, block: string) => {
	let out = "";
	{
		const id = Number(/@@DPL (\d+) /.exec(block)?.[1]);
		const url = new URL(field(block, "url") as string);
		const method = /^head$/m.test(block)
			? "HEAD"
			: (field(block, "request") ?? "GET");
		const authorized = field(block, "user") === `ci:${PASSWORD}`;
		registry.requests.push({ method, url: url.href });

		let status = 200;
		let headers = "";
		let body = "";
		const include = /^include$/m.test(block);
		const path = decodeURIComponent(url.pathname);
		if (url.protocol.slice(0, -1) !== registry.scheme) {
			status = 0;
		} else if (!authorized) {
			status = 401;
		} else if (path === "/v2/") {
			status = registry.pingStatus ?? 200;
		} else {
			const tagsMatch = /^\/v2\/(.+)\/tags\/list$/.exec(path);
			const manifestMatch = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(path);
			if (tagsMatch) {
				const repo = registry.repos[tagsMatch[1] as string];
				status = repo ? 200 : 404;
				const hidden = new Set(registry.hideFromListing ?? []);
				let tags = repo
					? [
							...Object.keys(repo).filter((tag) => !hidden.has(tag)),
							...(registry.staleListed ?? []),
						]
					: null;
				let link = registry.listingLink;
				if (tags && registry.pageSize) {
					const last = url.searchParams.get("last");
					const sorted = [...tags].sort();
					const from = last === null ? 0 : sorted.findIndex((tag) => tag > last);
					tags = from === -1 ? [] : sorted.slice(from, from + registry.pageSize);
					const more = from !== -1 && from + registry.pageSize < sorted.length;
					if (more) {
						const next = `/v2/${tagsMatch[1]}/tags/list?last=${encodeURIComponent(
							tags[tags.length - 1] as string,
						)}&n=${registry.pageSize}`;
						link = registry.pageLink
							? registry.pageLink(next)
							: `<${next}>; rel="next"`;
					}
				}
				body = JSON.stringify({ name: tagsMatch[1], tags });
				headers = `HTTP/1.1 200 OK\r\n${link ? `Link: ${link}\r\n` : ""}\r\n`;
			} else if (manifestMatch) {
				const repoName = manifestMatch[1] as string;
				const reference = manifestMatch[2] as string;
				const repo = registry.repos[repoName] ?? {};
				if (method === "DELETE") {
					status =
						registry.deleteStatusFor?.(reference) ?? registry.deleteStatus ?? 202;
					if (status === 202) {
						registry.deleted.push(`${repoName}@${reference}`);
						for (const tag of Object.keys(repo)) {
							if (repo[tag] === reference) delete repo[tag];
						}
					}
				} else if (registry.brokenTags?.includes(reference)) {
					status = 500;
				} else if (repo[reference]) {
					headers = `HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${repo[reference]}\r\n\r\n`;
					body = method === "HEAD" ? "" : (registry.bodies[repo[reference] as string] ?? "{}");
				} else {
					status = 404;
				}
			}
		}
		const printed =
			status === 0
				? ""
				: method === "HEAD"
					? headers
					: include
						? headers + body
						: body;
		out += `${printed}\n@@DPL ${id} ${String(status).padStart(3, "0")}\n`;
	}
	return out;
};

const sessions: { command: string; stdin: string }[] = [];

const installRegistry = (registry: FakeRegistry) => {
	mocks.openRemoteInputSession.mockImplementation(
		async (
			serverId: string,
			command: string,
			options?: { onStdout?: (text: string) => void },
		) => {
			if (registry.sessionError) throw registry.sessionError;
			const record = { command, stdin: "" };
			sessions.push(record);
			expect(serverId).toBe("build-1");
			return {
				write: async (data: Buffer) => {
					record.stdin += data.toString("utf8");
				},
				end: async () => {
					options?.onStdout?.(
						registry.noCurl ? "@@DPL-NOCURL\n" : answer(registry, record.stdin),
					);
				},
				abort: () => {},
			};
		},
	);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slow = { active: 0, maxActive: 0, aborted: 0 };

/**
 * Like `installRegistry`, but every request takes `delayMs` and answers one
 * after the other, as one serial curl does. A request `hangs` matches never
 * answers: the curl behind it is stuck until its session is dropped, and
 * nothing after it in the same session is answered either.
 */
const installSlowRegistry = (
	registry: FakeRegistry,
	{
		delayMs,
		hangs,
	}: { delayMs: number; hangs?: (method: string, url: string) => boolean },
) => {
	mocks.openRemoteInputSession.mockImplementation(
		async (
			_serverId: string,
			command: string,
			options?: { onStdout?: (text: string) => void },
		) => {
			const record = { command, stdin: "" };
			sessions.push(record);
			let dropped = false;
			let open = true;
			const close = () => {
				if (!open) return;
				open = false;
				slow.active -= 1;
			};
			slow.active += 1;
			slow.maxActive = Math.max(slow.maxActive, slow.active);
			let reject: (error: Error) => void = () => {};
			const aborted = new Promise<never>((_, rejectAborted) => {
				reject = rejectAborted;
			});
			aborted.catch(() => {});
			return {
				write: async (data: Buffer) => {
					record.stdin += data.toString("utf8");
				},
				end: async () => {
					const curl = (async () => {
						for (const block of blocksOf(record.stdin)) {
							const url = field(block, "url") as string;
							const method = /^head$/m.test(block)
								? "HEAD"
								: (field(block, "request") ?? "GET");
							if (hangs?.(method, url)) await new Promise(() => {});
							await sleep(delayMs);
							if (dropped) return;
							options?.onStdout?.(answerBlock(registry, block));
						}
					})();
					try {
						await Promise.race([curl, aborted]);
					} finally {
						close();
					}
				},
				abort: () => {
					dropped = true;
					slow.aborted += 1;
					close();
					reject(new Error("Remote command was aborted"));
				},
			};
		},
	);
};

interface Row {
	id: string;
	/** how long before "now" its deployment was created */
	age: number;
	digest: number;
}

const NOW = Date.parse("2026-10-07T12:00:00Z");
const tagOf = (id: string) => `dpl-${id}`;
const ref = (repo: string, tag: string) => `${REGISTRY}/${PREFIX}/${repo}:${tag}`;

/**
 * Builds the registry and the serving host for one service repository
 * `my-app-web`: `rows` are the dpl- tags (oldest first by age), `latest`
 * resolves to the digest of the newest.
 */
const setup = ({
	rows,
	current,
	lastGood = [],
	preDeploy = [],
	extraRepos = {},
	bodies = {},
	registryOverrides = {},
	deploymentRows,
}: {
	rows: Row[];
	current: string[];
	lastGood?: string[];
	preDeploy?: string[];
	extraRepos?: Record<string, Record<string, string>>;
	bodies?: Record<string, string>;
	registryOverrides?: Partial<FakeRegistry>;
	deploymentRows?: {
		deploymentId: string;
		createdAt: string;
		status: string;
	}[];
}) => {
	const repo = `${PREFIX}/my-app-web`;
	const tags: Record<string, string> = {};
	for (const row of rows) tags[tagOf(row.id)] = digest(row.digest);
	const newest = [...rows].sort((a, b) => a.age - b.age)[0];
	if (newest) tags.latest = digest(newest.digest);
	const registry: FakeRegistry = {
		repos: { [repo]: tags, ...extraRepos },
		bodies,
		deleted: [],
		scheme: "http",
		requests: [],
		...registryOverrides,
	};
	installRegistry(registry);

	const files = [current, lastGood, preDeploy].map((tagsOfFile) =>
		tagsOfFile.length === 0
			? ""
			: buildComposeOverrideYaml(
					tagsOfFile.map((tag) => ({
						service: "web",
						image: ref("my-app-web", tag),
					})),
					"docker-compose",
				),
	);
	mocks.execAsync.mockResolvedValue({
		stdout: files.map((content, index) => `@@DPL-FILE /f${index}\n${content}\n`).join(""),
		stderr: "",
	});
	mocks.findAllDeploymentsByComposeId.mockResolvedValue(
		deploymentRows ?? [
			...rows.map((row) => ({
				deploymentId: row.id,
				createdAt: new Date(NOW - row.age * 60_000).toISOString(),
				status: "done",
			})),
			{
				deploymentId: "current",
				createdAt: new Date(NOW).toISOString(),
				status: "done",
			},
		],
	);
	return registry;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.logLines.length = 0;
	sessions.length = 0;
	slow.active = 0;
	slow.maxActive = 0;
	slow.aborted = 0;
	mocks.findRegistryByIdWithCredentials.mockResolvedValue({
		registryId: "reg-1",
		registryType: "selfHosted",
		registryUrl: REGISTRY,
		username: "ci",
		password: PASSWORD,
		imagePrefix: PREFIX,
	});
});

const run = (extra: Record<string, unknown> = {}) =>
	pruneComposeBuildRegistry({ entity, deployment, ...extra });

// Eight deployments, oldest first. Ids are random on purpose: sorted as text
// they are not in age order.
const eight: Row[] = [
	{ id: "q9", age: 80, digest: 1 },
	{ id: "b2", age: 70, digest: 1 }, // unchanged service: same digest as q9
	{ id: "zz", age: 60, digest: 2 },
	{ id: "k7", age: 50, digest: 3 },
	{ id: "m1", age: 40, digest: 2 }, // shares zz's digest and is kept
	{ id: "a0", age: 30, digest: 4 },
	{ id: "x5", age: 20, digest: 5 },
	{ id: "c3", age: 10, digest: 6 }, // newest: shares its digest with latest
];

describe("pruneComposeBuildRegistry", () => {
	it("deletes the digests of old dpl- tags no kept tag resolves to", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		await run();

		// q9 and b2 share digest 1 and nothing kept uses it: deleted, once.
		// zz shares digest 2 with the kept m1: held back.
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
		expect(registry.repos[`${PREFIX}/my-app-web`]).toMatchObject({
			latest: digest(6),
			[tagOf("zz")]: digest(2),
			[tagOf("m1")]: digest(2),
		});
		expect(mocks.logLines.join("\n")).toContain(
			"removed 1 old image manifest (2 dpl- tags)",
		);
	});

	it("never deletes the digest that latest shares with the newest dpl- tag", async () => {
		// Six tags, one old: the old tag shares its digest with latest.
		const rows: Row[] = [
			{ id: "old", age: 90, digest: 9 },
			{ id: "a", age: 50, digest: 1 },
			{ id: "b", age: 40, digest: 2 },
			{ id: "c", age: 30, digest: 3 },
			{ id: "d", age: 20, digest: 4 },
			{ id: "e", age: 10, digest: 9 },
		];
		const registry = setup({ rows, current: [tagOf("e")] });
		await run();
		expect(registry.deleted).toEqual([]);
		expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("old")]).toBe(digest(9));
	});

	it("does nothing and makes no delete call with fewer than five dpl- tags", async () => {
		const registry = setup({ rows: eight.slice(-4), current: [tagOf("c3")] });
		await run();
		expect(registry.deleted).toEqual([]);
		expect(registry.requests.some((r) => r.method === "DELETE")).toBe(false);
		expect(mocks.logLines).toEqual([]);
	});

	it("keeps the tags of the last-good override even when older than the five newest", async () => {
		const rows = eight.map((row) =>
			row.id === "b2" ? { ...row, digest: 7 } : row,
		);
		const registry = setup({
			rows,
			current: [tagOf("c3")],
			lastGood: [tagOf("q9")], // the oldest tag is the rollback target
		});
		await run();
		// q9 stays (protected), so does its digest; b2 (digest 7) is the only
		// deletable one; zz shares digest 2 with m1.
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(7)}`]);
		expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("q9")]).toBe(digest(1));
	});

	it("keeps the pre-deploy snapshot's tags too", async () => {
		const rows = eight.map((row) =>
			row.id === "b2" ? { ...row, digest: 7 } : row,
		);
		const registry = setup({
			rows,
			current: [tagOf("c3")],
			preDeploy: [tagOf("b2")],
		});
		await run();
		expect(registry.deleted).not.toContain(`${PREFIX}/my-app-web@${digest(7)}`);
	});

	it("keeps a digest that a kept manifest list contains", async () => {
		const rows = eight.map((row) =>
			row.id === "b2" ? { ...row, digest: 7 } : row,
		);
		// the kept c3 / latest tag is an index whose child is b2's digest
		const registry = setup({
			rows,
			current: [tagOf("c3")],
			bodies: { [digest(6)]: JSON.stringify({ manifests: [{ digest: digest(7) }] }) },
		});
		await run();
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
	});

	it("treats services that share one image as one repository", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		// web and worker run the same pushed image: one override entry per service
		const yaml = buildComposeOverrideYaml(
			[
				{ service: "web", image: ref("my-app-web", tagOf("c3")) },
				{ service: "worker", image: ref("my-app-web", tagOf("c3")) },
			],
			"docker-compose",
		);
		mocks.execAsync.mockResolvedValue({
			stdout: `@@DPL-FILE /f0\n${yaml}\n@@DPL-FILE /f1\n\n@@DPL-FILE /f2\n\n`,
			stderr: "",
		});
		await run();
		const listings = registry.requests.filter((r) => r.url.includes("/tags/list"));
		expect(listings).toHaveLength(1);
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
	});

	it("processes every service repository of the compose", async () => {
		const api = Object.fromEntries(
			eight.map((row) => [tagOf(row.id), digest(100 + row.digest)]),
		);
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			extraRepos: { [`${PREFIX}/my-app-api`]: { ...api, latest: digest(106) } },
		});
		mocks.execAsync.mockResolvedValue({
			stdout: `@@DPL-FILE /f0\n${buildComposeOverrideYaml(
				[
					{ service: "web", image: ref("my-app-web", tagOf("c3")) },
					{ service: "api", image: ref("my-app-api", tagOf("c3")) },
				],
				"docker-compose",
			)}\n@@DPL-FILE /f1\n\n@@DPL-FILE /f2\n\n`,
			stderr: "",
		});
		mocks.findAllDeploymentsByComposeId.mockResolvedValue([
			...eight.map((row) => ({
				deploymentId: row.id,
				createdAt: new Date(NOW - row.age * 60_000).toISOString(),
				status: "done",
			})),
		]);
		await run();
		expect(registry.deleted.sort()).toEqual([
			`${PREFIX}/my-app-api@${digest(101)}`,
			`${PREFIX}/my-app-web@${digest(1)}`,
		]);
	});

	it("leaves repositories alone that no override of this compose references", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			// another compose whose app name merely starts the same way
			extraRepos: {
				[`${PREFIX}/my-app-web-extra`]: Object.fromEntries(
					eight.map((row) => [tagOf(row.id), digest(200 + row.digest)]),
				),
			},
		});
		await run();
		expect(registry.requests.every((r) => !r.url.includes("my-app-web-extra"))).toBe(
			true,
		);
	});

	it("ignores references that point at a different registry", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		mocks.execAsync.mockResolvedValue({
			stdout: `@@DPL-FILE /f0\n${buildComposeOverrideYaml(
				[{ service: "web", image: `other.example.com/${PREFIX}/my-app-web:${tagOf("c3")}` }],
				"docker-compose",
			)}\n`,
			stderr: "",
		});
		await run();
		expect(registry.requests).toEqual([]);
	});

	it("skips a repository when a kept tag cannot be read", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { brokenTags: ["latest"] },
		});
		await run();
		expect(registry.deleted).toEqual([]);
		expect(mocks.logLines.join("\n")).toContain("could not read the kept tag latest");
	});

	it("falls back to https when the tunnelled http endpoint is not there", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { scheme: "https" },
		});
		await run();
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
		expect(registry.requests.filter((r) => r.url.includes("/tags/list"))[0]?.url).toMatch(
			/^https:/,
		);
	});

	it("bounds the manifests deleted per run", async () => {
		const many: Row[] = Array.from({ length: 80 }, (_, index) => ({
			id: `t${index}`,
			age: 1000 - index,
			digest: index + 1,
		}));
		const registry = setup({ rows: many, current: [tagOf("t79")] });
		await run();
		expect(registry.deleted).toHaveLength(50);
		// oldest first
		expect(registry.deleted[0]).toBe(`${PREFIX}/my-app-web@${digest(1)}`);
	});

	it("defers while another deployment of the compose is running", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			deploymentRows: [
				{ deploymentId: "current", createdAt: new Date(NOW).toISOString(), status: "done" },
				{
					deploymentId: "other",
					createdAt: new Date(Date.now() - 60_000).toISOString(),
					status: "running",
				},
			],
		});
		await run();
		expect(registry.requests).toEqual([]);
		expect(mocks.logLines.join("\n")).toContain("another deployment of this compose is running");
	});

	it("does not delete when a deploy starts while the cleanup is running", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		const done = await mocks.findAllDeploymentsByComposeId();
		mocks.findAllDeploymentsByComposeId
			.mockResolvedValueOnce(done)
			.mockResolvedValue([
				...done,
				{
					deploymentId: "late",
					createdAt: new Date().toISOString(),
					status: "running",
				},
			]);
		await run();
		expect(registry.deleted).toEqual([]);
		expect(registry.requests.some((r) => r.method === "DELETE")).toBe(false);
		expect(mocks.logLines.join("\n")).toContain("another deployment of this compose started");
	});

	it("follows a paged tag listing through its Link headers", async () => {
		// 9 tags (8 dpl- + latest), 3 per page: three pages
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { pageSize: 3 },
		});
		await run();
		const listings = registry.requests.filter((r) => r.url.includes("/tags/list"));
		expect(listings).toHaveLength(3);
		expect(listings[1]?.url).toBe(
			`http://${REGISTRY}/v2/${PREFIX}/my-app-web/tags/list?last=${tagOf("c3")}&n=3`,
		);
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
		expect(mocks.logLines.join("\n")).not.toContain("Warning");
	});

	it("prunes a repository with more than 500 tags", async () => {
		const many: Row[] = Array.from({ length: 620 }, (_, index) => ({
			id: `t${String(index).padStart(3, "0")}`,
			age: 10_000 - index,
			digest: index + 1,
		}));
		const registry = setup({
			rows: many,
			current: [tagOf("t619")],
			registryOverrides: { pageSize: 250 },
		});
		await run();
		expect(registry.requests.filter((r) => r.url.includes("/tags/list"))).toHaveLength(3);
		// the cap, oldest first
		expect(registry.deleted).toHaveLength(50);
		expect(registry.deleted[0]).toBe(`${PREFIX}/my-app-web@${digest(1)}`);
		// only the waves it needed were resolved, not all 615 old tags
		expect(registry.requests.filter((r) => r.method === "HEAD").length).toBeLessThanOrEqual(60);
	});

	it("skips a repository whose listing has more pages than it follows, and says so", async () => {
		const many: Row[] = Array.from({ length: 25 }, (_, index) => ({
			id: `t${String(index).padStart(2, "0")}`,
			age: 1000 - index,
			digest: index + 1,
		}));
		const registry = setup({
			rows: many,
			current: [tagOf("t24")],
			registryOverrides: { pageSize: 2 },
		});
		await run();
		expect(registry.deleted).toEqual([]);
		expect(registry.requests.filter((r) => r.url.includes("/tags/list"))).toHaveLength(10);
		expect(registry.requests.some((r) => r.method !== "GET")).toBe(false);
		expect(mocks.logLines.join("\n")).toContain(
			`skipped ${PREFIX}/my-app-web: its tag listing has more than 10 pages (20 tags so far)`,
		);
	});

	it("never follows a Link to another host (the request would carry the credentials)", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: {
				pageSize: 3,
				pageLink: (next) => `<https://evil.test${next}>; rel="next"`,
			},
		});
		await run();
		expect(registry.deleted).toEqual([]);
		expect(registry.requests.some((r) => r.url.includes("evil.test"))).toBe(false);
		expect(sessions.some((s) => s.stdin.includes("evil.test"))).toBe(false);
		expect(mocks.logLines.join("\n")).toContain(
			"links to a next page that is not this repository's listing",
		);
	});

	it("skips a repository whose listing links back to a page it already read", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: {
				listingLink: '</v2/acme/my-app-web/tags/list?last=dpl-x5&n=1000>; rel="next"',
			},
		});
		await run();
		expect(registry.deleted).toEqual([]);
		expect(registry.requests.some((r) => r.method !== "GET")).toBe(false);
		expect(mocks.logLines.join("\n")).toContain("paged in a loop");
	});

	it("protects a tag the release files name even when the listing omits it", async () => {
		// q9 (digest 1) is the rollback target but is missing from the listing;
		// b2 (doomed) shares its digest. Deleting b2's digest would delete q9.
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			lastGood: [tagOf("q9")],
			registryOverrides: { hideFromListing: [tagOf("q9")] },
		});
		await run();
		expect(registry.deleted).not.toContain(`${PREFIX}/my-app-web@${digest(1)}`);
		expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("q9")]).toBe(digest(1));
		expect(
			registry.requests.some((r) => r.url.endsWith(`/manifests/${tagOf("q9")}`)),
		).toBe(true);
	});

	it("resolves latest even when the listing omits it", async () => {
		// latest points at digest 1, which only the doomed q9 / b2 also use, and
		// the listing hides it: only resolving it protects the digest.
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { hideFromListing: ["latest"] },
		});
		(registry.repos[`${PREFIX}/my-app-web`] as Record<string, string>).latest =
			digest(1);
		await run();
		expect(registry.deleted).toEqual([]);
	});

	it("skips the repository when a tag a release file names is gone (404)", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			lastGood: [tagOf("vanished")],
		});
		await run();
		expect(registry.deleted).toEqual([]);
		expect(mocks.logLines.join("\n")).toContain(
			`could not read the kept tag ${tagOf("vanished")} (HTTP 404)`,
		);
	});

	it("skips the repository when a listed kept tag no longer resolves (404)", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { staleListed: [tagOf("zzz-newer")] },
		});
		// the stale tag has no deployment row, so it ranks oldest and is doomed:
		// the same tag as a *kept* one is the case that matters
		mocks.findAllDeploymentsByComposeId.mockResolvedValue([
			...eight.map((row) => ({
				deploymentId: row.id,
				createdAt: new Date(NOW - row.age * 60_000).toISOString(),
				status: "done",
			})),
			{
				deploymentId: "zzz-newer",
				createdAt: new Date(NOW + 60_000).toISOString(),
				status: "done",
			},
		]);
		await run();
		expect(registry.deleted).toEqual([]);
		expect(mocks.logLines.join("\n")).toContain(
			`could not read the kept tag ${tagOf("zzz-newer")} (HTTP 404)`,
		);
	});

	it("ignores a dangling doomed tag and does not count it against the cap", async () => {
		const many: Row[] = Array.from({ length: 70 }, (_, index) => ({
			id: `t${index}`,
			age: 1000 - index,
			digest: index + 1,
		}));
		const registry = setup({ rows: many, current: [tagOf("t69")] });
		// the 20 oldest tags are listed but their manifests are gone
		const repo = registry.repos[`${PREFIX}/my-app-web`] as Record<string, string>;
		const dangling = many.slice(0, 20).map((row) => tagOf(row.id));
		registry.staleListed = dangling;
		for (const tag of dangling) delete repo[tag];
		await run();
		// 65 doomed, 20 dangling: all 45 real ones fit under the cap of 50
		expect(registry.deleted).toHaveLength(45);
		expect(registry.deleted).not.toContain(`${PREFIX}/my-app-web@${digest(1)}`);
		expect(registry.deleted[0]).toBe(`${PREFIX}/my-app-web@${digest(21)}`);
	});

	it("does not spend the cap on digests held back by a kept tag", async () => {
		// 60 old tags share the digest of the newest (latest); 30 more are free
		const shared: Row[] = Array.from({ length: 60 }, (_, index) => ({
			id: `s${index}`,
			age: 2000 - index,
			digest: 999,
		}));
		const free: Row[] = Array.from({ length: 30 }, (_, index) => ({
			id: `f${index}`,
			age: 1000 - index,
			digest: index + 1,
		}));
		const newest: Row = { id: "n0", age: 1, digest: 999 };
		const registry = setup({
			rows: [...shared, ...free, newest],
			current: [tagOf("n0")],
		});
		await run();
		// 60 held-back tags come first in age order and would eat the whole cap
		// if they counted; the 26 doomed free tags (4 of 30 are among the 5
		// newest) all go
		expect(registry.deleted).toHaveLength(26);
		expect(registry.deleted).not.toContain(`${PREFIX}/my-app-web@${digest(999)}`);
	});

	it("checks for a concurrent deploy before every delete batch", async () => {
		const many: Row[] = Array.from({ length: 125 }, (_, index) => ({
			id: `t${index}`,
			age: 2000 - index,
			digest: index + 1,
		}));
		// the first 50 deletions are all "already gone": nothing counts against
		// the cap, so a second batch would follow
		const registry = setup({
			rows: many,
			current: [tagOf("t124")],
			registryOverrides: {
				deleteStatusFor: (d) =>
					Number.parseInt(d.slice(7), 16) <= 50 ? 404 : undefined,
			},
		});
		const done = await mocks.findAllDeploymentsByComposeId();
		mocks.findAllDeploymentsByComposeId
			.mockResolvedValueOnce(done) // before listing
			.mockResolvedValueOnce(done) // before the first batch
			.mockResolvedValue([
				...done,
				{
					deploymentId: "late",
					createdAt: new Date().toISOString(),
					status: "running",
				},
			]);
		await run();
		expect(registry.requests.filter((r) => r.method === "DELETE")).toHaveLength(50);
		expect(mocks.logLines.join("\n")).toContain(
			"stopped: another deployment of this compose started",
		);
	});

	it("never overlaps two prunes of the same compose", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		// hold the first prune inside its first file read
		let release: (value: { stdout: string; stderr: string }) => void = () => {};
		const first = new Promise<{ stdout: string; stderr: string }>((resolve) => {
			release = resolve;
		});
		const initial = await mocks.execAsync();
		mocks.execAsync.mockReturnValueOnce(first);
		const one = run();
		await run(); // second one returns at once: the compose is in flight
		expect(mocks.openRemoteInputSession).not.toHaveBeenCalled();
		release(initial);
		await one;
		expect(registry.deleted).toHaveLength(1);
		// and it is released afterwards: the next prune runs again
		mocks.openRemoteInputSession.mockClear();
		await run();
		expect(mocks.openRemoteInputSession).toHaveBeenCalled();
	});

	it("is not blocked by an abandoned 'running' row", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			deploymentRows: [
				...eight.map((row) => ({
					deploymentId: row.id,
					createdAt: new Date(NOW - row.age * 60_000).toISOString(),
					status: "done",
				})),
				{
					deploymentId: "stale",
					createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
					status: "running",
				},
			],
		});
		await run();
		expect(registry.deleted).toHaveLength(1);
	});
});

/** `count` deployments, oldest first, one distinct digest each (1..count). */
const series = (count: number): Row[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `t${String(index).padStart(3, "0")}`,
		age: 10_000 - index,
		digest: index + 1,
	}));

/** `rows` in two service repositories: web (digests n) and api (digests 1000 + n). */
const twoRepos = (rows: Row[]) => {
	const newest = [...rows].sort((a, b) => a.age - b.age)[0] as Row;
	const api = Object.fromEntries(
		rows.map((row) => [tagOf(row.id), digest(1000 + row.digest)]),
	);
	const registry = setup({
		rows,
		current: [tagOf(newest.id)],
		extraRepos: {
			[`${PREFIX}/my-app-api`]: { ...api, latest: digest(1000 + newest.digest) },
		},
	});
	mocks.execAsync.mockResolvedValue({
		stdout: `@@DPL-FILE /f0\n${buildComposeOverrideYaml(
			[
				{ service: "web", image: ref("my-app-web", tagOf(newest.id)) },
				{ service: "api", image: ref("my-app-api", tagOf(newest.id)) },
			],
			"docker-compose",
		)}\n@@DPL-FILE /f1\n\n@@DPL-FILE /f2\n\n`,
		stderr: "",
	});
	return registry;
};

describe("a slow registry", () => {
	const lines = () => mocks.logLines.join("\n");

	it("keeps what a batch answered before it ran out of time, and never deletes what did not answer", async () => {
		// 45 deployments: 40 old tags, resolved in two batches of 20. The HEAD
		// of t005 hangs: the first batch answers t000-t004 and is dropped, so
		// t005-t019 are unknown; the second batch answers in full.
		const rows = series(45);
		const registry = setup({ rows, current: [tagOf("t044")] });
		installSlowRegistry(registry, {
			delayMs: 1,
			hangs: (method, url) =>
				method === "HEAD" && url.endsWith(`/manifests/${tagOf("t005")}`),
		});
		await run({ batchTimeoutMs: 300 });

		const answered = [
			...Array.from({ length: 5 }, (_, index) => index),
			...Array.from({ length: 20 }, (_, index) => 20 + index),
		];
		expect([...registry.deleted].sort()).toEqual(
			answered.map((index) => `${PREFIX}/my-app-web@${digest(index + 1)}`).sort(),
		);
		const repo = registry.repos[`${PREFIX}/my-app-web`] as Record<string, string>;
		for (let index = 5; index < 20; index++) {
			expect(repo[tagOf(rows[index]?.id as string)]).toBe(digest(index + 1));
		}
		expect(slow.aborted).toBe(1);
		expect(lines()).toContain("removed 25 old image manifests (25 dpl- tags)");
		expect(lines()).not.toContain("Warning");
		expect(lines()).not.toContain("aborted");
	});

	it("leaves a repository alone when a kept tag does not resolve in time, and still prunes the next one", async () => {
		const registry = twoRepos(eight);
		installSlowRegistry(registry, {
			delayMs: 1,
			hangs: (method, url) =>
				method === "GET" && url.endsWith(`/${PREFIX}/my-app-web/manifests/latest`),
		});
		await run({ batchTimeoutMs: 300 });
		expect(registry.deleted).toEqual([`${PREFIX}/my-app-api@${digest(1001)}`]);
		expect(registry.requests.some((r) => r.method === "HEAD" && r.url.includes("my-app-web"))).toBe(
			false,
		);
		expect(lines()).toContain(
			`Build registry cleanup left ${PREFIX}/my-app-web for the next deploy: `,
		);
		expect(lines()).toContain("did not resolve in time");
		expect(lines()).not.toContain("Warning");
	});

	it("runs at most three curl sessions at once, twenty requests each", async () => {
		const registry = setup({ rows: series(125), current: [tagOf("t124")] });
		installSlowRegistry(registry, { delayMs: 2 });
		await run();
		expect(registry.deleted).toHaveLength(50);
		expect(slow.maxActive).toBeGreaterThan(1);
		expect(slow.maxActive).toBeLessThanOrEqual(3);
		for (const session of sessions) {
			expect(blocksOf(session.stdin).length).toBeLessThanOrEqual(20);
		}
	});

	it("stops at the time budget with what it removed, and leaves the rest for the next deploy", async () => {
		const registry = twoRepos(series(45));
		const realNow = Date.now.bind(Date);
		let clock: { mockRestore: () => void } | undefined;
		// the budget runs out while the first round of deletions is on the wire
		registry.deleteStatusFor = () => {
			clock ??= vi
				.spyOn(Date, "now")
				.mockImplementation(() => realNow() + 3_600_000);
			return undefined;
		};
		try {
			await run();
		} finally {
			clock?.mockRestore();
		}
		// every web deletion already sent went through; api was not started
		expect(registry.deleted).toHaveLength(40);
		expect(registry.deleted.every((entry) => entry.includes("my-app-web@"))).toBe(true);
		expect(registry.requests.some((r) => r.url.includes("my-app-api/manifests"))).toBe(false);
		expect(lines()).toContain(
			"Build registry cleanup stopped at the time budget: removed 40 old image manifests (40 dpl- tags) from 1 repository; the rest continues on the next deploy.",
		);
		expect(lines()).not.toContain("Warning");

		// The next deploy starts with api, where this one stopped, even though
		// web has a new old tag (no deployment row: it ranks oldest) again.
		registry.deleteStatusFor = undefined;
		(registry.repos[`${PREFIX}/my-app-web`] as Record<string, string>)["dpl-gone-row"] =
			digest(500);
		registry.requests.length = 0;
		mocks.logLines.length = 0;
		await run();
		const manifestRequests = registry.requests.filter((r) => r.url.includes("/manifests/"));
		expect(manifestRequests[0]?.url).toContain("my-app-api/manifests/");
		expect(registry.deleted).toHaveLength(81);
		expect(registry.deleted).toContain(`${PREFIX}/my-app-web@${digest(500)}`);
		expect(lines()).toContain("removed 41 old image manifests (41 dpl- tags) from 2 repositories");
	});

	it("starts the next run after the repository that used up the deletion cap", async () => {
		// web has 60 old tags (more than the cap), api 40
		const rows = series(65);
		const registry = twoRepos(rows);
		const api = registry.repos[`${PREFIX}/my-app-api`] as Record<string, string>;
		for (const row of rows.slice(0, 20)) delete api[tagOf(row.id)];
		await run({ entity: { ...entity, composeId: "cap-rotation" } });
		expect(registry.deleted).toHaveLength(50);
		expect(registry.deleted.every((entry) => entry.includes("my-app-web@"))).toBe(true);

		registry.requests.length = 0;
		await run({ entity: { ...entity, composeId: "cap-rotation" } });
		const manifestRequests = registry.requests.filter((r) => r.url.includes("/manifests/"));
		expect(manifestRequests[0]?.url).toContain("my-app-api/manifests/");
		// api's 40, then web's last 10
		expect(registry.deleted).toHaveLength(100);
		expect(registry.deleted.slice(50, 90).every((entry) => entry.includes("my-app-api@"))).toBe(
			true,
		);
	});
});

describe("units without a build server", () => {
	it("does no I/O at all", async () => {
		await pruneComposeBuildRegistry({
			entity: { ...entity, buildServerId: null, buildRegistryId: null },
			deployment,
		});
		await pruneComposeBuildRegistry({
			entity: { ...entity, buildServerId: null },
			deployment,
		});
		expect(mocks.findRegistryByIdWithCredentials).not.toHaveBeenCalled();
		expect(mocks.findAllDeploymentsByComposeId).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.openRemoteInputSession).not.toHaveBeenCalled();
		expect(mocks.logLines).toEqual([]);
	});
});

describe("failures never fail the deploy", () => {
	const warned = () => mocks.logLines.join("\n");

	it("401: warns and deletes nothing", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { pingStatus: 401 },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(registry.deleted).toEqual([]);
		expect(warned()).toContain("Warning");
		expect(warned()).toContain("401");
	});

	it("wrong stored credentials answer 401 too", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		mocks.findRegistryByIdWithCredentials.mockResolvedValue({
			registryType: "selfHosted",
			registryUrl: REGISTRY,
			username: "ci",
			password: "wrong",
		});
		await expect(run()).resolves.toBeUndefined();
		expect(registry.deleted).toEqual([]);
		expect(warned()).toContain("refused the stored credentials");
	});

	it("405: delete disabled is reported once and stops", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { deleteStatus: 405 },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(registry.deleted).toEqual([]);
		expect(warned()).toContain("REGISTRY_STORAGE_DELETE_ENABLED");
		expect(warned().match(/Warning/g)).toHaveLength(1);
	});

	it("registry without the v2 API (404 on the check)", async () => {
		setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { pingStatus: 404 },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(warned()).toContain("Warning");
	});

	it("unreachable registry", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { scheme: "none" },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(registry.deleted).toEqual([]);
		expect(warned()).toContain("could not be reached");
	});

	it("the SSH session itself fails", async () => {
		setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { sessionError: new Error("ssh: connection reset") },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(warned()).toContain("connection reset");
	});

	it("curl is missing on the build server", async () => {
		setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { noCurl: true },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(warned()).toContain("curl is not installed");
	});

	it("reading the release files fails", async () => {
		setup({ rows: eight, current: [tagOf("c3")] });
		mocks.execAsync.mockRejectedValue(new Error("boom"));
		await expect(run()).resolves.toBeUndefined();
		expect(warned()).toContain("boom");
		expect(mocks.openRemoteInputSession).not.toHaveBeenCalled();
	});

	it("the deployment table is unavailable", async () => {
		setup({ rows: eight, current: [tagOf("c3")] });
		mocks.findAllDeploymentsByComposeId.mockRejectedValue(new Error("db down"));
		await expect(run()).resolves.toBeUndefined();
		expect(warned()).toContain("db down");
	});

	it("the registry row is gone", async () => {
		setup({ rows: eight, current: [tagOf("c3")] });
		mocks.findRegistryByIdWithCredentials.mockRejectedValue(new Error("Registry not found"));
		await expect(run()).resolves.toBeUndefined();
		expect(warned()).toContain("Registry not found");
	});

	it("stops at a spent time budget without a warning", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		await expect(run({ budgetMs: 0 })).resolves.toBeUndefined();
		expect(registry.deleted).toEqual([]);
		expect(warned()).toContain(
			"Build registry cleanup stopped at the time budget before removing anything; it continues on the next deploy.",
		);
		expect(warned()).not.toContain("Warning");
	});

	it("skips ECR registries", async () => {
		setup({ rows: eight, current: [tagOf("c3")] });
		mocks.findRegistryByIdWithCredentials.mockResolvedValue({
			registryType: "awsEcr",
			registryUrl: "123.dkr.ecr.eu-west-1.amazonaws.com",
		});
		await run();
		expect(mocks.openRemoteInputSession).not.toHaveBeenCalled();
		expect(warned()).toContain("AWS ECR");
	});

	it("skips a registry without a url", async () => {
		setup({ rows: eight, current: [tagOf("c3")] });
		mocks.findRegistryByIdWithCredentials.mockResolvedValue({
			registryType: "cloud",
			registryUrl: "",
		});
		await run();
		expect(mocks.openRemoteInputSession).not.toHaveBeenCalled();
	});
});

describe("credentials", () => {
	it("travel on stdin only: never in a command, an argument or a log line", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		await run();
		expect(registry.deleted).toHaveLength(1);

		// every session was authenticated through its stdin config...
		expect(sessions.length).toBeGreaterThanOrEqual(4);
		for (const session of sessions) {
			expect(session.stdin).toContain("user = ");
			expect(session.stdin).toContain("ci:");
		}
		// ...and the password is in none of the commands that were executed
		const commands = [
			...sessions.map((s) => s.command),
			...mocks.execAsync.mock.calls.map((call) => String(call[0])),
			...mocks.execAsyncRemote.mock.calls.map((call) => String(call[1])),
			...mocks.openRemoteInputSession.mock.calls.map((call) => String(call[1])),
		];
		for (const command of commands) {
			expect(command).not.toContain(PASSWORD);
			expect(command).not.toContain("S3cr3t");
		}
		expect(mocks.logLines.join("\n")).not.toContain("S3cr3t");
	});

	it("are redacted from a failure message", async () => {
		setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: {
				sessionError: new Error(`curl said no to ${PASSWORD}`),
			},
		});
		await run();
		expect(mocks.logLines.join("\n")).not.toContain("S3cr3t");
		expect(mocks.logLines.join("\n")).toContain("***");
	});
});
