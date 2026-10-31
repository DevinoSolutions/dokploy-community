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

import {
	pruneComposeBuildRegistry,
	resetRegistryRetentionState,
} from "@dokploy/server/services/compose-registry-retention";

const PASSWORD = 'S3cr3t"pa$$\\word';
const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
/** An index entry for a single-platform image manifest. */
const img = (n: number) => ({ mediaType: OCI_MANIFEST, digest: digest(n) });
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
	/**
	 * GET bodies of these tags lose this many characters at the end, the way
	 * curl's max-time cuts a transfer: status and marker are still written
	 */
	cutBodyOf?: Record<string, number>;
	/** send `Content-Length` (of the whole body) on manifest GETs */
	announceLength?: boolean;
	/** manifest GET/HEAD of these tags carries a second `Docker-Content-Digest` */
	duplicateDigestFor?: Record<string, string>;
	/** the build server's lock is held by a job this test does not drive */
	jobBusy?: boolean;
	/** the delete job's session never reports back (its output is lost) */
	jobSilent?: boolean;
	/** a started job keeps running (and holds the lock) until `finishJob` */
	jobDeferred?: boolean;
	/** the job's result file is gone (build server rebooted, /tmp cleaned) */
	jobResultLost?: boolean;
	/** the last delete job that was started */
	job?: { token: string; blocks: string[]; running: boolean; result: string };
	/** called for every request the registry receives, before it answers */
	onRequest?: (method: string, url: string) => void;
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
		registry.onRequest?.(method, url.href);

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
				// a tag, or a digest some tag in the repository still points at
				const resolved =
					repo[reference] ??
					(Object.values(repo).includes(reference) ? reference : undefined);
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
				} else if (resolved) {
					const whole = registry.bodies[resolved] ?? "{}";
					const second = registry.duplicateDigestFor?.[reference];
					headers = `HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${resolved}\r\n${
						second ? `Docker-Content-Digest: ${second}\r\n` : ""
					}${
						registry.announceLength && method !== "HEAD"
							? `Content-Length: ${Buffer.byteLength(whole)}\r\n`
							: ""
					}\r\n`;
					const cut = registry.cutBodyOf?.[reference] ?? 0;
					body = method === "HEAD" ? "" : whole.slice(0, whole.length - cut);
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

/** Runs a started job's DELETEs one after the other and files its result. */
const finishJob = (registry: FakeRegistry) => {
	const job = registry.job;
	if (!job?.running) return;
	job.running = false;
	job.result = `@@DPL-JOB ${job.token}\n${job.blocks
		.map((block) => answerBlock(registry, block))
		.join("")}`;
};

/**
 * What the build server prints for the job commands (start and status). The
 * job's lock, its result file and its serial DELETEs are modelled here; `null`
 * for an ordinary curl session.
 */
const jobReply = (
	registry: FakeRegistry,
	command: string,
	stdin: string,
): string | null => {
	const isStart = command.includes("@@DPL-STARTED");
	const isStatus = command.includes("@@DPL-IDLE") && !isStart;
	if (!isStart && !isStatus) return null;
	if (registry.noCurl) return "@@DPL-NOCURL\n";
	const running = registry.jobBusy || registry.job?.running;
	if (isStatus) {
		if (running) return "@@DPL-BUSY\n";
		return `@@DPL-IDLE\n${registry.jobResultLost ? "" : (registry.job?.result ?? "")}`;
	}
	if (running) return "@@DPL-BUSY\n";
	const end = "# @@DPL-END";
	// A config that does not end in the marker was cut off: the job never runs it.
	if (!stdin.trimEnd().endsWith(end)) return "@@DPL-LATE\n";
	const token = /sh "\$L" "\$R" ([a-f0-9]+)/.exec(command)?.[1] as string;
	registry.job = {
		token,
		blocks: blocksOf(stdin.trimEnd().slice(0, -end.length)),
		running: true,
		result: "",
	};
	if (!registry.jobDeferred) finishJob(registry);
	return registry.jobSilent ? "" : "@@DPL-STARTED\n";
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
						jobReply(registry, command, record.stdin) ??
							(registry.noCurl ? "@@DPL-NOCURL\n" : answer(registry, record.stdin)),
					);
				},
				abort: () => {},
			};
		},
	);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slow = {
	active: 0,
	maxActive: 0,
	aborted: 0,
	/** DELETE sessions open right now, and the most sessions of any kind open alongside one */
	deleting: 0,
	maxAlongsideDelete: 0,
};

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
			let deleting = false;
			const close = () => {
				if (!open) return;
				open = false;
				slow.active -= 1;
				if (deleting) slow.deleting -= 1;
			};
			slow.active += 1;
			slow.maxActive = Math.max(slow.maxActive, slow.active);
			if (slow.deleting > 0) {
				slow.maxAlongsideDelete = Math.max(slow.maxAlongsideDelete, slow.active);
			}
			let reject: (error: Error) => void = () => {};
			const aborted = new Promise<never>((_, rejectAborted) => {
				reject = rejectAborted;
			});
			aborted.catch(() => {});
			return {
				write: async (data: Buffer) => {
					record.stdin += data.toString("utf8");
					if (!deleting && /request = "DELETE"/.test(record.stdin)) {
						deleting = true;
						slow.deleting += 1;
						slow.maxAlongsideDelete = Math.max(slow.maxAlongsideDelete, slow.active);
					}
				},
				end: async () => {
					const reply = jobReply(registry, command, record.stdin);
					if (reply !== null) {
						options?.onStdout?.(reply);
						close();
						return;
					}
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
	resetRegistryRetentionState();
	mocks.logLines.length = 0;
	sessions.length = 0;
	slow.active = 0;
	slow.maxActive = 0;
	slow.aborted = 0;
	slow.deleting = 0;
	slow.maxAlongsideDelete = 0;
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
			"deletes 1 old image manifest (2 dpl- tags) from 1 repository",
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
			bodies: { [digest(6)]: JSON.stringify({ manifests: [img(7)] }) },
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
		// a DELETE here is estimated at 1.3 s + 80 ms x 621 tags = 51 s, so one job
		// stops at 11 of them (about ten minutes) instead of the 50 the cap allows;
		// oldest first
		expect(registry.deleted).toHaveLength(11);
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
			"the tag listing may be incomplete, its Link header points the next page somewhere other than this repository's tag listing on this registry",
		);
	});

	describe("a tag on a page it did not read keeps its digest", () => {
		const lines = () => mocks.logLines.join("\n");
		// Sorted, the first page (6 tags) is a1-a6; z-kept, z-new and latest are
		// on the second. z-kept is kept (2nd newest) and shares digest 1 with the
		// oldest, a1. Read whole, digest 1 stays and 2 and 3 go. From page one
		// alone a1 would look deletable, and deleting digest 1 deletes z-kept.
		const paged: Row[] = [
			{ id: "a1", age: 100, digest: 1 },
			{ id: "a2", age: 90, digest: 2 },
			{ id: "a3", age: 80, digest: 3 },
			{ id: "a4", age: 70, digest: 4 },
			{ id: "a5", age: 60, digest: 5 },
			{ id: "a6", age: 50, digest: 6 },
			{ id: "z-kept", age: 2, digest: 1 },
			{ id: "z-new", age: 1, digest: 9 },
		];
		const pagedSetup = (pageLink: (next: string) => string) =>
			setup({
				rows: paged,
				current: [tagOf("z-new")],
				registryOverrides: { pageSize: 6, pageLink },
			});
		const keptIntact = (registry: FakeRegistry) => {
			expect(registry.deleted).not.toContain(`${PREFIX}/my-app-web@${digest(1)}`);
			expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("z-kept")]).toBe(digest(1));
		};

		it("reads a Link header whose quoted parameter has a comma", async () => {
			const registry = pagedSetup((next) => `<${next}>; title="page, two"; rel="next"`);
			await run();
			expect(registry.requests.filter((r) => r.url.includes("/tags/list"))).toHaveLength(2);
			expect([...registry.deleted].sort()).toEqual([
				`${PREFIX}/my-app-web@${digest(2)}`,
				`${PREFIX}/my-app-web@${digest(3)}`,
			]);
			keptIntact(registry);
			expect(lines()).not.toContain("Warning");
		});

		for (const [what, pageLink, reason] of [
			[
				"an unparsable Link header",
				(next: string) => `<${next}>; rel="next"; title="unterminated`,
				"its Link header cannot be parsed",
			],
			[
				"a Link header without rel=next",
				(next: string) => `<${next}>; rel="last"`,
				"its Link header names no next page",
			],
			[
				"two Link headers naming different next pages",
				(next: string) =>
					`<${next}>; rel="next"\r\nLink: </v2/${PREFIX}/my-app-web/tags/list?last=${tagOf("a1")}&n=6>; rel="next"`,
				"the response has more than one Link header",
			],
			[
				"two Link headers, only one of them naming a next page",
				(next: string) =>
					`<${next}>; rel="next"\r\nLink: </v2/${PREFIX}/my-app-web/tags/list?n=6>; rel="first"`,
				"the response has more than one Link header",
			],
			[
				"a next page on another host",
				(next: string) => `<https://evil.test${next}>; rel="next"`,
				"its Link header points the next page somewhere other than this repository's tag listing on this registry",
			],
		] as const) {
			it(`skips the repository on ${what}, deleting nothing`, async () => {
				const registry = pagedSetup(pageLink);
				await run();
				expect(registry.deleted).toEqual([]);
				expect(registry.requests.some((r) => r.method !== "GET")).toBe(false);
				expect(registry.requests.filter((r) => r.url.includes("/tags/list"))).toHaveLength(1);
				keptIntact(registry);
				expect(lines()).toContain(
					`Warning: ⚠️ Build registry cleanup skipped ${PREFIX}/my-app-web: the tag listing may be incomplete, ${reason}`,
				);
			});
		}

		it("skips the repository when the page limit leaves pages unread", async () => {
			// 14 old tags, a page per tag: z-kept lands on page 15, never read
			const rows: Row[] = [
				...Array.from({ length: 14 }, (_, index) => ({
					id: `a${String(index).padStart(2, "0")}`,
					age: 200 - index,
					digest: index + 1,
				})),
				{ id: "z-kept", age: 2, digest: 1 },
				{ id: "z-new", age: 1, digest: 99 },
			];
			const registry = setup({
				rows,
				current: [tagOf("z-new")],
				registryOverrides: { pageSize: 1 },
			});
			await run();
			expect(registry.deleted).toEqual([]);
			expect(registry.requests.some((r) => r.method !== "GET")).toBe(false);
			expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("z-kept")]).toBe(digest(1));
			expect(lines()).toContain("nothing is pruned from a partial listing");
		});
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
		// 65 doomed, 20 dangling: the first wave of 60 holds the 20 dangling and
		// the 40 oldest real ones; one wave per repository per run
		expect(registry.deleted).toHaveLength(40);
		expect(registry.deleted).not.toContain(`${PREFIX}/my-app-web@${digest(1)}`);
		expect(registry.deleted[0]).toBe(`${PREFIX}/my-app-web@${digest(21)}`);

		// the next run finishes the other 5 without asking about the dangling
		// tags again
		registry.requests.length = 0;
		await run();
		expect(registry.deleted).toHaveLength(45);
		const asked = registry.requests
			.filter((r) => r.method === "HEAD" && r.url.includes("/manifests/dpl-"))
			.map((r) => r.url.split("/manifests/")[1]);
		expect(asked.some((tag) => dangling.includes(tag as string))).toBe(false);
		expect(asked).toHaveLength(5);
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

	describe("a deploy that started during the prune and already finished", () => {
		const quick = () => ({
			deploymentId: "quick",
			createdAt: new Date().toISOString(),
			status: "done",
		});

		it("stops the prune before its first DELETE", async () => {
			// it shows up after the check before the listing: done, not running,
			// but created after the protection snapshot was read
			const registry = setup({ rows: eight, current: [tagOf("c3")] });
			const done = await mocks.findAllDeploymentsByComposeId();
			mocks.findAllDeploymentsByComposeId
				.mockResolvedValueOnce(done)
				.mockImplementation(async () => [...done, quick()]);
			await run();
			expect(registry.deleted).toEqual([]);
			expect(registry.requests.some((r) => r.method === "DELETE")).toBe(false);
			expect(mocks.logLines.join("\n")).toContain(
				"Build registry cleanup stopped: another deployment of this compose started.",
			);
		});

		it("defers the prune when it is already there at the first check", async () => {
			const registry = setup({ rows: eight, current: [tagOf("c3")] });
			const done = await mocks.findAllDeploymentsByComposeId();
			mocks.findAllDeploymentsByComposeId.mockImplementation(async () => [...done, quick()]);
			await run();
			expect(registry.requests).toEqual([]);
			expect(mocks.logLines.join("\n")).toContain(
				"deferred: another deployment of this compose is running or has just started",
			);
		});

		it("a deploy that finished before the prune began does not stop it", async () => {
			const registry = setup({ rows: eight, current: [tagOf("c3")] });
			const done = await mocks.findAllDeploymentsByComposeId();
			mocks.findAllDeploymentsByComposeId.mockImplementation(async () => [
				...done,
				{
					deploymentId: "earlier",
					createdAt: new Date(Date.now() - 60_000).toISOString(),
					status: "done",
				},
			]);
			await run();
			expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
		});
	});

	describe("a kept index whose children may be indexes themselves", () => {
		// c3 / latest (digest 6) are an index of x5's image (5) and of child 7;
		// child 7 is itself an index of digest 8, which is the old b2's. Only
		// reading index 7 would protect 8: the repository is skipped instead.
		for (const [what, child] of [
			["an OCI index", { mediaType: "application/vnd.oci.image.index.v1+json", digest: digest(7) }],
			[
				"a Docker manifest list",
				{
					mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
					digest: digest(7),
				},
			],
			["no media type", { digest: digest(7) }],
			["an unknown media type", { mediaType: "application/x-unknown", digest: digest(7) }],
		] as const) {
			it(`skips the repository when a child has ${what}`, async () => {
				const registry = setup({
					rows: eight.map((row) => (row.id === "b2" ? { ...row, digest: 8 } : row)),
					current: [tagOf("c3")],
					bodies: {
						[digest(6)]: JSON.stringify({ manifests: [img(5), child] }),
						[digest(7)]: JSON.stringify({ manifests: [img(8)] }),
					},
				});
				await run();
				expect(registry.deleted).toEqual([]);
				expect(registry.requests.some((r) => r.method === "DELETE")).toBe(false);
				expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("b2")]).toBe(digest(8));
				expect(mocks.logLines.join("\n")).toContain(
					`Warning: ⚠️ Build registry cleanup skipped ${PREFIX}/my-app-web: the kept tag ${tagOf("c3")} is an index whose children may be indexes themselves`,
				);
			});
		}
	});

	describe("a repeated header the logic relies on", () => {
		it("a kept tag answering with two digests counts as unresolved", async () => {
			const registry = setup({
				rows: eight,
				current: [tagOf("c3")],
				registryOverrides: { duplicateDigestFor: { [tagOf("c3")]: digest(1) } },
			});
			await run();
			expect(registry.deleted).toEqual([]);
			expect(mocks.logLines.join("\n")).toContain(
				`Build registry cleanup left ${PREFIX}/my-app-web for the next deploy: 1 kept tag did not resolve in time or came back cut off or ambiguous.`,
			);
		});

		it("an old tag answering with two digests is never deleted", async () => {
			// q9 (digest 1) is doomed and answers its HEAD with the header twice;
			// b2 (digest 7) is doomed too and answers normally
			const registry = setup({
				rows: eight.map((row) => (row.id === "b2" ? { ...row, digest: 7 } : row)),
				current: [tagOf("c3")],
				registryOverrides: { duplicateDigestFor: { [tagOf("q9")]: digest(1) } },
			});
			await run();
			expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(7)}`]);
			expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("q9")]).toBe(digest(1));
		});
	});

	it("checks again for a concurrent deploy right before it starts the job", async () => {
		const registry = setup({ rows: series(125), current: [tagOf("t124")] });
		const done = await mocks.findAllDeploymentsByComposeId();
		mocks.findAllDeploymentsByComposeId
			.mockResolvedValueOnce(done) // before listing
			.mockResolvedValue([
				...done,
				{
					deploymentId: "late",
					createdAt: new Date().toISOString(),
					status: "running",
				},
			]);
		await run();
		// everything was planned, and nothing was handed to the build server
		expect(registry.requests.some((r) => r.method === "DELETE")).toBe(false);
		expect(sessions.some((s) => /request = "DELETE"/.test(s.stdin))).toBe(false);
		expect(registry.job).toBeUndefined();
		expect(mocks.logLines.join("\n")).toContain(
			"stopped: another deployment of this compose started",
		);
	});

	it("looks for a concurrent deploy right before the job session opens, and only then", async () => {
		const registry = setup({ rows: series(125), current: [tagOf("t124")] });
		const done = await mocks.findAllDeploymentsByComposeId();
		const events: string[] = [];
		mocks.findAllDeploymentsByComposeId.mockImplementation(async () => {
			events.push("check");
			return done;
		});
		const open = mocks.openRemoteInputSession.getMockImplementation() as (
			...args: unknown[]
		) => Promise<unknown>;
		mocks.openRemoteInputSession.mockImplementation(async (...args: unknown[]) => {
			events.push(`open ${sessions.length}`);
			return open(...args);
		});
		await run();

		const kindOf = (index: number) =>
			/request = "DELETE"/.test(sessions[index]?.stdin ?? "") ? "DELETE" : "other";
		const opens = events.filter((event) => event.startsWith("open "));
		const deleteOpens = opens.filter((event) => kindOf(Number(event.slice(5))) === "DELETE");
		// one job session; the checks are the one before the listing and the one
		// right before that session, with no other session in between
		expect(deleteOpens).toHaveLength(1);
		expect(events.filter((event) => event === "check")).toHaveLength(2);
		expect(events[events.indexOf(deleteOpens[0] as string) - 1]).toBe("check");
		expect(events.at(-1)).toBe(deleteOpens[0]);
		expect(registry.deleted).toHaveLength(50);
	});

	it("settles a job whose start answer was lost on the next run", async () => {
		// the job started, but its answer never came back
		const registry = setup({
			rows: series(125),
			current: [tagOf("t124")],
			registryOverrides: { jobSilent: true },
		});
		await run();
		expect(mocks.logLines.join("\n")).toContain(
			"sent a background job to the build server (it did not confirm in time that it started)",
		);
		expect(registry.deleted).toHaveLength(50);

		registry.jobSilent = false;
		mocks.logLines.length = 0;
		await run();
		expect(mocks.logLines.join("\n")).toContain(
			"50 of 50 old image manifests confirmed gone",
		);
		// and it carried on with the next 50
		expect(registry.deleted).toHaveLength(100);
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

/**
 * Like `installRegistry`, but a session `cut` picks an offset for is cut off
 * there: it prints that much of its output and then hangs until it is dropped,
 * as a session aborted mid-response does.
 */
const installCuttingRegistry = (
	registry: FakeRegistry,
	cut: (stdin: string, output: string) => number | undefined,
) => {
	mocks.openRemoteInputSession.mockImplementation(
		async (
			_serverId: string,
			command: string,
			options?: { onStdout?: (text: string) => void },
		) => {
			const record = { command, stdin: "" };
			sessions.push(record);
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
					const reply = jobReply(registry, command, record.stdin);
					if (reply !== null) {
						options?.onStdout?.(reply);
						return;
					}
					const output = answer(registry, record.stdin);
					const at = cut(record.stdin, output);
					if (at === undefined) {
						options?.onStdout?.(output);
						return;
					}
					options?.onStdout?.(output.slice(0, at));
					await aborted;
				},
				abort: () => {
					slow.aborted += 1;
					reject(new Error("Remote command was aborted"));
				},
			};
		},
	);
};

/** The session that resolves the kept tags: GETs of manifests. */
const isKeptSession = (stdin: string) =>
	/\/manifests\//.test(stdin) && /^include$/m.test(stdin) && !/^head$/m.test(stdin);

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
		expect(lines()).toContain("deletes 25 old image manifests (25 dpl- tags)");
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

	it("never runs the DELETE job alongside any other session", async () => {
		const registry = setup({ rows: series(125), current: [tagOf("t124")] });
		installSlowRegistry(registry, { delayMs: 2 });
		await run();
		expect(registry.deleted).toHaveLength(50);
		// resolving still uses three sessions at once...
		expect(slow.maxActive).toBe(3);
		// ...deleting is one job that carries all 50, run strictly one by one
		expect(sessions.filter((s) => /request = "DELETE"/.test(s.stdin))).toHaveLength(1);
		expect(slow.maxAlongsideDelete).toBe(1);
	});

	it("runs at most three read sessions at once, twenty requests each", async () => {
		const registry = setup({ rows: series(125), current: [tagOf("t124")] });
		installSlowRegistry(registry, { delayMs: 2 });
		await run();
		expect(registry.deleted).toHaveLength(50);
		expect(slow.maxActive).toBeGreaterThan(1);
		expect(slow.maxActive).toBeLessThanOrEqual(3);
		for (const session of sessions) {
			if (/request = "DELETE"/.test(session.stdin)) continue;
			expect(blocksOf(session.stdin).length).toBeLessThanOrEqual(20);
		}
	});

	describe("a session dropped in the middle of a kept tag's response", () => {
		// c3 and latest (digest 6) are an index whose child is b2's digest 7. In
		// resolve order the kept tags are k7 m1 a0 x5 c3 latest: c3 is id 4.
		const indexed = () =>
			setup({
				rows: eight.map((row) => (row.id === "b2" ? { ...row, digest: 7 } : row)),
				current: [tagOf("c3")],
				bodies: {
					[digest(6)]: JSON.stringify({
						schemaVersion: 2,
						manifests: [img(7), img(8)],
					}),
				},
			});
		const responseStart = (output: string, id: number) =>
			id === 0 ? 0 : output.indexOf(`\n@@DPL ${id - 1} `) + `\n@@DPL ${id - 1} 200\n`.length;
		const expectLeftAlone = (registry: FakeRegistry) => {
			expect(registry.deleted).toEqual([]);
			expect(registry.requests.some((r) => r.method === "DELETE")).toBe(false);
			expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("b2")]).toBe(digest(7));
			expect(lines()).toContain(
				`Build registry cleanup left ${PREFIX}/my-app-web for the next deploy: 2 kept tags did not resolve in time or came back cut off or ambiguous.`,
			);
			expect(lines()).not.toContain("Warning");
		};
		const cuts: Record<string, (output: string) => number> = {
			"inside its headers": (output) => responseStart(output, 4) + 20,
			"inside its index body": (output) =>
				output.indexOf("\r\n\r\n", responseStart(output, 4)) + 4 + 40,
			"inside its marker": (output) => output.indexOf("\n@@DPL 4 ") + 6,
		};
		for (const [where, at] of Object.entries(cuts)) {
			it(`${where}: the tag counts as unresolved and the repository is left alone`, async () => {
				const registry = indexed();
				installCuttingRegistry(registry, (stdin, output) =>
					isKeptSession(stdin) ? at(output) : undefined,
				);
				await run({ batchTimeoutMs: 200 });
				expect(slow.aborted).toBe(1);
				expectLeftAlone(registry);
			});
		}

		it("a body curl itself cut short (max-time keeps status and marker) never unprotects a child", async () => {
			const registry = indexed();
			registry.cutBodyOf = { [tagOf("c3")]: 30 };
			await run();
			expect(registry.deleted).toEqual([]);
			expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("b2")]).toBe(digest(7));
			expect(lines()).toContain("1 kept tag did not resolve in time");
		});

		it("a body shorter than its Content-Length counts as unresolved even when it still parses", async () => {
			const registry = indexed();
			// the index gets trailing whitespace; losing only that leaves valid JSON
			registry.bodies[digest(6)] = `${registry.bodies[digest(6)]}\n\n`;
			registry.announceLength = true;
			registry.cutBodyOf = { [tagOf("c3")]: 2 };
			await run();
			expect(registry.deleted).toEqual([]);
			expect(lines()).toContain("1 kept tag did not resolve in time");
		});

		it("with nothing cut, the same repository is pruned and the child stays", async () => {
			const registry = indexed();
			registry.announceLength = true;
			await run();
			expect(registry.deleted).toEqual([`${PREFIX}/my-app-web@${digest(1)}`]);
			expect(registry.repos[`${PREFIX}/my-app-web`]?.[tagOf("b2")]).toBe(digest(7));
		});
	});

	it("stops reading at the time budget, starts the job with what it found, and leaves the rest for the next deploy", async () => {
		const registry = twoRepos(series(45));
		const realNow = Date.now.bind(Date);
		let clock: { mockRestore: () => void } | undefined;
		// the time to read ends (3 s before the 45 s budget) as api's first
		// manifest is asked for, with the budget itself not yet spent
		registry.onRequest = (_method, url) => {
			if (url.includes("/my-app-api/manifests/")) {
				clock ??= vi.spyOn(Date, "now").mockImplementation(() => realNow() + 44_000);
			}
		};
		try {
			await run();
		} finally {
			clock?.mockRestore();
		}
		registry.onRequest = undefined;
		// web's 40 went out in the job; api was not started
		expect(registry.deleted).toHaveLength(40);
		expect(registry.deleted.every((entry) => entry.includes("my-app-web@"))).toBe(true);
		expect(lines()).toContain("deletes 40 old image manifests (40 dpl- tags) from 1 repository");
		expect(lines()).toContain("stopped reading at the time budget");
		expect(lines()).not.toContain("Warning");

		// The next deploy settles the job, then starts with api, where this one
		// stopped, even though web has a new old tag (no deployment row: it ranks
		// oldest) again.
		(registry.repos[`${PREFIX}/my-app-web`] as Record<string, string>)["dpl-gone-row"] =
			digest(500);
		registry.requests.length = 0;
		mocks.logLines.length = 0;
		await run();
		const kept = registry.requests.filter(
			(r) => r.method === "GET" && r.url.includes("/manifests/"),
		);
		expect(kept[0]?.url).toContain("my-app-api/manifests/");
		expect(registry.deleted).toHaveLength(81);
		expect(registry.deleted).toContain(`${PREFIX}/my-app-web@${digest(500)}`);
		expect(lines()).toContain("40 of 40 old image manifests confirmed gone");
		expect(lines()).toContain("deletes 41 old image manifests (41 dpl- tags) from 2 repositories");
	});

	it("takes the repositories in turn, so one big backlog cannot starve the others", async () => {
		const rows = series(65);
		const registry = twoRepos(rows);
		const api = registry.repos[`${PREFIX}/my-app-api`] as Record<string, string>;
		for (const row of rows.slice(0, 20)) delete api[tagOf(row.id)];
		// web has 60 old tags (more than one job takes), api 40
		await run({ entity: { ...entity, composeId: "cap-rotation" } });
		expect(registry.deleted).toHaveLength(50);
		expect(registry.deleted.every((entry) => entry.includes("my-app-web@"))).toBe(true);

		registry.requests.length = 0;
		await run({ entity: { ...entity, composeId: "cap-rotation" } });
		const kept = registry.requests.filter(
			(r) => r.method === "GET" && r.url.includes("/manifests/"),
		);
		expect(kept[0]?.url).toContain("my-app-api/manifests/");
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

	it("405: delete disabled is reported once the job's answers are read", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { deleteStatus: 405 },
		});
		await expect(run()).resolves.toBeUndefined();
		expect(registry.deleted).toEqual([]);
		// the deploy that sends the DELETEs cannot know
		expect(warned()).not.toContain("Warning");
		await expect(run()).resolves.toBeUndefined();
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
			"Build registry cleanup stopped at the time budget before starting a deletion job; it continues on the next deploy.",
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

describe("deletes go out as one detached, serial job (T-10203)", () => {
	const lines = () => mocks.logLines.join("\n");
	const deleteSessions = () => sessions.filter((s) => /request = "DELETE"/.test(s.stdin));

	it("hands every DELETE to one job: long max-time, one session, a lock in its command, no secret", async () => {
		const registry = setup({ rows: series(30), current: [tagOf("t029")] });
		await run();
		const jobs = deleteSessions();
		expect(jobs).toHaveLength(1);
		const job = jobs[0] as { command: string; stdin: string };
		// the config is only run by the job once it ends in the marker
		expect(job.stdin.trimEnd().endsWith("# @@DPL-END")).toBe(true);
		const blocks = blocksOf(job.stdin.replace("# @@DPL-END", ""));
		expect(blocks).toHaveLength(25);
		for (const block of blocks) {
			expect(block).toContain('request = "DELETE"');
			expect(block).toContain("max-time = 240");
		}
		// reads keep their short limit
		for (const session of sessions) {
			if (session === job) continue;
			expect(session.stdin).not.toContain("max-time = 240");
		}
		expect(job.command).toMatch(/dokploy-registry-prune-[a-f0-9]{16}\.lock/);
		expect(job.command).not.toContain("S3cr3t");
		expect(job.command).not.toContain("ci:");
		expect(lines()).not.toContain("S3cr3t");
		expect(registry.deleted).toHaveLength(25);
	});

	it("says the DELETEs were sent, and confirms them on the next run", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		await run();
		expect(lines()).toContain("Deletions are sent, not yet confirmed: the next deploy checks them.");
		expect(lines()).not.toContain("removed");
		expect(lines()).not.toContain("not confirmed in time");
		expect(registry.deleted).toHaveLength(1);

		mocks.logLines.length = 0;
		await run();
		expect(lines()).toContain("1 of 1 old image manifest confirmed gone");
		expect(lines()).not.toContain("Warning");
	});

	it("never starts a second job while one is running, from the same compose or another", async () => {
		const registry = setup({
			rows: series(30),
			current: [tagOf("t029")],
			registryOverrides: { jobDeferred: true },
		});
		await run();
		const first = registry.job?.token;
		expect(registry.job?.running).toBe(true);
		expect(registry.deleted).toEqual([]);
		expect(deleteSessions()).toHaveLength(1);

		// the same compose, next deploy: it asks, finds the job running, and
		// plans nothing new (no read of the registry beyond the API check)
		mocks.logLines.length = 0;
		registry.requests.length = 0;
		await run();
		expect(lines()).toContain("still running on the build server (25 old image manifests sent)");
		expect(deleteSessions()).toHaveLength(1);
		expect(registry.requests.every((r) => r.url.endsWith("/v2/"))).toBe(true);

		// another compose on the same registry: the lock refuses its job
		mocks.logLines.length = 0;
		await run({ entity: { ...entity, composeId: "c2" } });
		expect(lines()).toContain(
			"a deletion job is still running on the build server for this registry",
		);
		expect(registry.job?.token).toBe(first);
		expect(registry.deleted).toEqual([]);

		// once the job is over the next deploy settles it
		finishJob(registry);
		mocks.logLines.length = 0;
		await run();
		expect(registry.deleted).toHaveLength(25);
		expect(lines()).toContain("25 of 25 old image manifests confirmed gone");
	});

	it("reports the job's answers and what is still there", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { deleteStatus: 500 },
		});
		await run();
		expect(registry.deleted).toEqual([]);

		registry.deleteStatus = undefined;
		mocks.logLines.length = 0;
		await run();
		expect(lines()).toContain(
			"0 of 1 old image manifest confirmed gone, 1 still present (retried below)",
		);
		expect(lines()).toContain("HTTP 500 x1");
		expect(lines()).not.toContain("Warning");
		// and it was sent again
		expect(registry.deleted).toHaveLength(1);
	});

	it("a DELETE that timed out is not read as an unreachable registry", async () => {
		const registry = setup({
			rows: eight,
			current: [tagOf("c3")],
			registryOverrides: { deleteStatus: 0 },
		});
		await run();
		registry.deleteStatus = undefined;
		mocks.logLines.length = 0;
		await run();
		expect(lines()).toContain("no answer x1");
		expect(lines()).not.toContain("Warning");
	});

	it("confirms against the registry when the job's result file is gone", async () => {
		const registry = setup({ rows: eight, current: [tagOf("c3")] });
		await run();
		registry.jobResultLost = true;
		mocks.logLines.length = 0;
		await run();
		expect(lines()).toContain("1 of 1 old image manifest confirmed gone");
		expect(lines()).not.toContain("DELETE answers");
		expect(lines()).not.toContain("Warning");
	});

	it("takes the repositories in turn: five repositories with big backlogs are all reached", async () => {
		const rows = series(75);
		const names = ["web", "docs", "landing", "mastra", "workers"];
		const repoOf = (name: string) => `${PREFIX}/my-app-${name}`;
		const registry = setup({
			rows,
			current: [tagOf("t074")],
			extraRepos: Object.fromEntries(
				names.slice(1).map((name, index) => [
					repoOf(name),
					{
						...Object.fromEntries(
							rows.map((row) => [tagOf(row.id), digest(1000 * (index + 1) + row.digest)]),
						),
						latest: digest(1000 * (index + 1) + 75),
					},
				]),
			),
		});
		mocks.execAsync.mockResolvedValue({
			stdout: `@@DPL-FILE /f0\n${buildComposeOverrideYaml(
				names.map((name) => ({ service: name, image: ref(`my-app-${name}`, tagOf("t074")) })),
				"docker-compose",
			)}\n@@DPL-FILE /f1\n\n@@DPL-FILE /f2\n\n`,
			stderr: "",
		});

		const touched: string[] = [];
		let seen = 0;
		for (let index = 0; index < 5; index++) {
			await run();
			const fresh = registry.deleted.slice(seen);
			seen = registry.deleted.length;
			// one run's job is 50 manifests of one repository
			expect(fresh).toHaveLength(50);
			const repos = new Set(fresh.map((entry) => entry.split("@")[0]));
			expect(repos.size).toBe(1);
			touched.push([...repos][0] as string);
		}
		expect(touched).toEqual(names.map(repoOf));
	});

	it("does not spend its HEAD waves on dangling tags again", async () => {
		const rows = series(155);
		const registry = setup({ rows, current: [tagOf("t154")] });
		const repo = registry.repos[`${PREFIX}/my-app-web`] as Record<string, string>;
		// the 100 oldest tags are listed, their manifests are gone
		const dangling = rows.slice(0, 100).map((row) => tagOf(row.id));
		registry.staleListed = dangling;
		for (const tag of dangling) delete repo[tag];
		const tagHeads = () =>
			registry.requests
				.filter((r) => r.method === "HEAD" && r.url.includes("/manifests/dpl-"))
				.map((r) => r.url.split("/manifests/")[1] as string);

		await run();
		// two waves: 60 dangling, then 40 dangling and 20 real ones
		expect(tagHeads()).toHaveLength(120);
		expect(registry.deleted).toHaveLength(20);

		registry.requests.length = 0;
		await run();
		// only the 30 real ones left are asked about
		expect(tagHeads()).toHaveLength(30);
		expect(tagHeads().some((tag) => dangling.includes(tag))).toBe(false);
		expect(registry.deleted).toHaveLength(50);
	});

	it("does not spend its HEAD waves on tags that share a kept tag's digest again", async () => {
		const shared: Row[] = Array.from({ length: 70 }, (_, index) => ({
			id: `s${index}`,
			age: 2000 - index,
			digest: 999,
		}));
		const free: Row[] = Array.from({ length: 20 }, (_, index) => ({
			id: `f${index}`,
			age: 1000 - index,
			digest: index + 1,
		}));
		const newest: Row = { id: "n0", age: 1, digest: 999 };
		const registry = setup({
			rows: [...shared, ...free, newest],
			current: [tagOf("n0")],
		});
		const tagHeads = () =>
			registry.requests.filter(
				(r) => r.method === "HEAD" && r.url.includes("/manifests/dpl-"),
			);

		await run();
		// 70 shared tags in two waves, then the 16 free ones that are not among
		// the five newest
		expect(tagHeads()).toHaveLength(86);
		expect(registry.deleted).toHaveLength(16);

		registry.requests.length = 0;
		await run();
		// nothing but shared tags is left, and they are not asked about again
		expect(tagHeads()).toHaveLength(0);
		expect(registry.deleted).toHaveLength(16);
	});
});
