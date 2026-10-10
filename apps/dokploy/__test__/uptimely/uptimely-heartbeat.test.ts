import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deploy heartbeat linking: creating the Incoming Request monitor, storing
 * (or asking for) its secret key, and unlinking. The Uptimely client and the
 * database are faked; the real service code runs.
 */

const HEARTBEAT_KEY = "11111111-2222-4333-8444-555555555555";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	existingLink: null as Record<string, unknown> | null,
	inserted: [] as Record<string, unknown>[],
	updates: [] as Record<string, unknown>[],
	deleteReturning: [] as unknown[],
	deletes: 0,
	findApplicationById: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const tableMock = () => ({
		findFirst: vi.fn(async () => undefined),
		findMany: vi.fn(async () => []),
	});
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) =>
					table === "uptimelyMonitorLink"
						? {
								findFirst: vi.fn(async () => mocks.existingLink ?? undefined),
								findMany: vi.fn(async () => []),
							}
						: tableMock(),
			}),
			insert: vi.fn(() => ({
				values: (row: Record<string, unknown>) => ({
					returning: async () => {
						const stored = { linkId: "link-1", ...row };
						mocks.inserted.push(stored);
						return [stored];
					},
				}),
			})),
			update: vi.fn(() => ({
				set: (values: Record<string, unknown>) => {
					mocks.updates.push(values);
					return { where: async () => undefined };
				},
			})),
			delete: vi.fn(() => ({
				where: () => ({
					returning: async () => {
						mocks.deletes++;
						return mocks.deleteReturning;
					},
				}),
			})),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/uptimely/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/uptimely/client")
	>()),
	createUptimelyClient: vi.fn(() => ({ callTool: mocks.callTool })),
}));

vi.mock("@dokploy/server/services/application", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/application")
	>()),
	findApplicationById: mocks.findApplicationById,
}));

const {
	extractUptimelyHeartbeatKey,
	linkUptimelyHeartbeat,
	setUptimelyHeartbeatKey,
	unlinkUptimelyHeartbeat,
	unlinkUptimelyService,
} = await import("@dokploy/server/services/uptimely");
const {
	apiCreateUptimelyChannel,
	apiSetUptimelyHeartbeatKey,
	apiUptimelyHeartbeat,
	parseUptimelyHeartbeatKey,
} = await import("@dokploy/server/db/schema");

const integration = {
	uptimelyId: "upt-1",
	organizationId: "org-1",
	name: "Uptimely",
	apiKey: "key",
	projectId: PROJECT,
	baseUrl: "https://uptimely.test",
	statusPageSlug: null,
	createdAt: new Date(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.callTool.mockReset();
	mocks.existingLink = null;
	mocks.inserted = [];
	mocks.updates = [];
	mocks.deleteReturning = [];
	mocks.deletes = 0;
	mocks.findApplicationById.mockResolvedValue({
		applicationId: "app-1",
		name: "web",
		environment: { project: { name: "Devino", organizationId: "org-1" } },
	});
});

describe("linkUptimelyHeartbeat", () => {
	it("creates an Incoming Request monitor and stores it as a heartbeat link", async () => {
		mocks.callTool.mockResolvedValue({
			monitorId: "mon-1",
			slug: "m-1",
			name: "Devino/web deploy heartbeat",
			monitorType: "Incoming Request",
			created: true,
		});

		const result = await linkUptimelyHeartbeat({
			integration,
			serviceType: "application",
			serviceId: "app-1",
		});

		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		const [tool, args] = mocks.callTool.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(tool).toBe("uptimely_monitor_create");
		expect(args).toMatchObject({
			projectId: PROJECT,
			monitorType: "Incoming Request",
			name: "Devino/web deploy heartbeat",
		});
		// A heartbeat monitor takes no target.
		expect(args).not.toHaveProperty("url");
		expect(args).not.toHaveProperty("host");
		expect(mocks.inserted).toEqual([
			expect.objectContaining({
				uptimelyId: "upt-1",
				serviceType: "application",
				serviceId: "app-1",
				monitorId: "mon-1",
				kind: "heartbeat",
				heartbeatKey: null,
			}),
		]);
		expect(result.created).toBe(true);
	});

	it("keeps the secret key when Uptimely returns one", async () => {
		mocks.callTool.mockResolvedValue({
			monitorId: "mon-1",
			slug: "m-1",
			name: "x",
			monitorType: "Incoming Request",
			created: true,
			heartbeatUrl: `https://uptimely.test/heartbeat/${HEARTBEAT_KEY}`,
		});

		await linkUptimelyHeartbeat({
			integration,
			serviceType: "application",
			serviceId: "app-1",
		});

		expect(mocks.inserted[0]).toMatchObject({ heartbeatKey: HEARTBEAT_KEY });
	});

	it("does not create a second monitor for a service that already has one", async () => {
		mocks.existingLink = { linkId: "link-0", kind: "heartbeat" };

		const result = await linkUptimelyHeartbeat({
			integration,
			serviceType: "application",
			serviceId: "app-1",
		});

		expect(result.created).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(mocks.inserted).toEqual([]);
	});

	it("refuses a service of another organization before calling Uptimely", async () => {
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "app-1",
			name: "web",
			environment: { project: { name: "Other", organizationId: "org-2" } },
		});

		await expect(
			linkUptimelyHeartbeat({
				integration,
				serviceType: "application",
				serviceId: "app-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("surfaces the Uptimely refusal (AI writes off) and stores nothing", async () => {
		mocks.callTool.mockRejectedValue(
			Object.assign(new Error("AI write operations are disabled"), {
				code: "AI_WRITE_OPS_DISABLED",
			}),
		);

		await expect(
			linkUptimelyHeartbeat({
				integration,
				serviceType: "application",
				serviceId: "app-1",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "AI write operations are disabled",
		});
		expect(mocks.inserted).toEqual([]);
	});
});

describe("setUptimelyHeartbeatKey", () => {
	it("stores the key from a bare key or a pasted heartbeat URL", async () => {
		mocks.existingLink = { linkId: "link-1", kind: "heartbeat" };

		for (const pasted of [
			HEARTBEAT_KEY.toUpperCase(),
			`https://app.getuptimely.com/heartbeat/${HEARTBEAT_KEY}`,
			`https://app.getuptimely.com/api/incoming-request/${HEARTBEAT_KEY}`,
		]) {
			await setUptimelyHeartbeatKey({
				integration,
				serviceType: "application",
				serviceId: "app-1",
				key: pasted,
			});
		}

		expect(mocks.updates).toEqual([
			{ heartbeatKey: HEARTBEAT_KEY },
			{ heartbeatKey: HEARTBEAT_KEY },
			{ heartbeatKey: HEARTBEAT_KEY },
		]);
	});

	it("needs an existing heartbeat link and a readable key", async () => {
		await expect(
			setUptimelyHeartbeatKey({
				integration,
				serviceType: "application",
				serviceId: "app-1",
				key: HEARTBEAT_KEY,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		mocks.existingLink = { linkId: "link-1", kind: "heartbeat" };
		await expect(
			setUptimelyHeartbeatKey({
				integration,
				serviceType: "application",
				serviceId: "app-1",
				key: "not a key",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updates).toEqual([]);
	});
});

describe("unlinking", () => {
	it("unlinkUptimelyHeartbeat deletes the heartbeat link row", async () => {
		mocks.deleteReturning = [{ linkId: "link-1" }];

		const removed = await unlinkUptimelyHeartbeat({
			integration,
			serviceType: "compose",
			serviceId: "cmp-1",
		});

		expect(removed).toHaveLength(1);
		expect(mocks.deletes).toBe(1);
		// There is no monitor-delete tool in Uptimely; nothing is called.
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("unlinkUptimelyService leaves the opt-in heartbeat link alone", async () => {
		const { PgDialect } = await import("drizzle-orm/pg-core");
		const { db } = await import("@dokploy/server/db");
		const where = vi.fn(() => ({ returning: async () => [] }));
		vi.mocked(db.delete).mockReturnValueOnce({ where } as never);

		await unlinkUptimelyService({
			integration,
			serviceType: "application",
			serviceId: "app-1",
		});

		const condition = (where.mock.calls[0] as unknown[])[0] as never;
		const { sql: text, params } = new PgDialect().sqlToQuery(condition);
		expect(text).toContain('"kind" <>');
		expect(params).toContain("heartbeat");
	});
});

describe("heartbeat key parsing and input validation", () => {
	it("parses bare keys and heartbeat URLs, rejects everything else", () => {
		expect(parseUptimelyHeartbeatKey(` ${HEARTBEAT_KEY} `)).toBe(HEARTBEAT_KEY);
		expect(
			parseUptimelyHeartbeatKey(
				`https://uptimely.test/heartbeat/${HEARTBEAT_KEY}?x=1`,
			),
		).toBe(HEARTBEAT_KEY);
		expect(
			parseUptimelyHeartbeatKey("https://uptimely.test/heartbeat/abc"),
		).toBe(null);
		expect(
			parseUptimelyHeartbeatKey(`https://uptimely.test/other/${HEARTBEAT_KEY}`),
		).toBe(null);
		expect(parseUptimelyHeartbeatKey("")).toBe(null);
	});

	it("reads a key out of the field names a create result might use", () => {
		expect(
			extractUptimelyHeartbeatKey({ incomingRequestSecretKey: HEARTBEAT_KEY }),
		).toBe(HEARTBEAT_KEY);
		expect(extractUptimelyHeartbeatKey({ monitorId: "m" })).toBeNull();
		expect(extractUptimelyHeartbeatKey({ secretKey: "short" })).toBeNull();
	});

	it("limits the heartbeat to applications and compose services", () => {
		expect(
			apiUptimelyHeartbeat.safeParse({ serviceType: "redis", serviceId: "r" })
				.success,
		).toBe(false);
		expect(
			apiUptimelyHeartbeat.safeParse({ serviceType: "compose", serviceId: "c" })
				.success,
		).toBe(true);
		expect(
			apiSetUptimelyHeartbeatKey.safeParse({
				serviceType: "application",
				serviceId: "a",
				key: "nope",
			}).success,
		).toBe(false);
		expect(
			apiSetUptimelyHeartbeatKey.safeParse({
				serviceType: "application",
				serviceId: "a",
				key: HEARTBEAT_KEY,
			}).success,
		).toBe(true);
	});

	it("validates the Uptimely notification channel input", () => {
		const valid = {
			name: "Uptimely incidents",
			appDeploy: false,
			appBuildError: true,
			databaseBackup: false,
			volumeBackup: false,
			dokployRestart: false,
			dokployBackup: false,
			dockerCleanup: false,
			serverThreshold: false,
			scheduleFailure: false,
			apiKey: " key ",
			projectId: PROJECT,
			baseUrl: "https://app.getuptimely.com/",
		};
		const parsed = apiCreateUptimelyChannel.parse(valid);
		expect(parsed.apiKey).toBe("key");
		expect(parsed.baseUrl).toBe("https://app.getuptimely.com");

		for (const bad of [
			{ projectId: "not-a-uuid" },
			{ apiKey: "  " },
			{ baseUrl: "ftp://uptimely.test" },
			{ resolvedStateId: "not-a-uuid" },
		]) {
			expect(
				apiCreateUptimelyChannel.safeParse({ ...valid, ...bad }).success,
			).toBe(false);
		}
		expect(
			apiCreateUptimelyChannel.safeParse({ ...valid, resolvedStateId: "" })
				.success,
		).toBe(true);
	});
});
