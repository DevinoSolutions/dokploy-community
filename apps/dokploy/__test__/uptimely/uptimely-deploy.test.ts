import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deploy-time Uptimely hooks: the heartbeat ping and the incident channel.
 * The Uptimely client and the database are faked; the real hooks run.
 */

const HEARTBEAT_KEY = "11111111-2222-4333-8444-555555555555";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RESOLVED_STATE = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	clientOptions: [] as { apiKey: string; baseUrl: string }[],
	heartbeatLink: null as Record<string, unknown> | null,
	linkLookupError: null as Error | null,
	channels: [] as Record<string, unknown>[],
	openIncident: null as Record<string, unknown> | null,
	inserted: [] as Record<string, unknown>[],
	deletes: 0,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			uptimelyMonitorLink: {
				findFirst: vi.fn(async () => {
					if (mocks.linkLookupError) throw mocks.linkLookupError;
					return mocks.heartbeatLink ?? undefined;
				}),
			},
			notifications: { findMany: vi.fn(async () => mocks.channels) },
			uptimelyChannelIncident: {
				findFirst: vi.fn(async () => mocks.openIncident ?? undefined),
			},
		},
		insert: vi.fn(() => ({
			values: (row: Record<string, unknown>) => {
				mocks.inserted.push(row);
				return { onConflictDoNothing: async () => undefined };
			},
		})),
		delete: vi.fn(() => ({
			where: async () => {
				mocks.deletes++;
			},
		})),
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

vi.mock("@dokploy/server/utils/uptimely/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/uptimely/client")
	>()),
	createUptimelyClient: vi.fn(
		(options: { apiKey: string; baseUrl: string }) => {
			mocks.clientOptions.push(options);
			return { callTool: mocks.callTool };
		},
	),
}));

const {
	pingUptimelyDeployHeartbeat,
	reportDeployFailureToUptimely,
	reportDeploySuccessToUptimely,
	reportDeploySuccessToUptimelyIncidents,
	resetUptimelyResolvedStateCache,
} = await import("@dokploy/server/services/uptimely-deploy");
const { pingUptimelyHeartbeat, uptimelyHeartbeatUrl } = await import(
	"@dokploy/server/utils/uptimely/heartbeat"
);

const context = {
	organizationId: "org-1",
	serviceType: "application" as const,
	serviceId: "app-1",
	projectName: "Devino",
	serviceName: "web",
};

const channel = (overrides: Record<string, unknown> = {}) => ({
	name: "Uptimely incidents",
	uptimelyChannel: {
		uptimelyChannelId: "chan-1",
		apiKey: "channel-api-key",
		projectId: PROJECT,
		baseUrl: "https://uptimely.test",
		resolvedStateId: null,
		...overrides,
	},
});

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	resetUptimelyResolvedStateCache();
	mocks.callTool.mockReset();
	mocks.clientOptions = [];
	mocks.heartbeatLink = null;
	mocks.linkLookupError = null;
	mocks.channels = [];
	mocks.openIncident = null;
	mocks.inserted = [];
	mocks.deletes = 0;
	fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

const loggedText = () =>
	errorSpy.mock.calls
		.map((call: unknown[]) => call.map(String).join(" "))
		.join("\n");

describe("pingUptimelyHeartbeat", () => {
	it("GETs <baseUrl>/heartbeat/<key> with a short timeout and no redirects", async () => {
		const ok = await pingUptimelyHeartbeat({
			baseUrl: "https://uptimely.test/",
			secretKey: HEARTBEAT_KEY,
			label: "application web",
		});

		expect(ok).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`https://uptimely.test/heartbeat/${HEARTBEAT_KEY}`);
		expect(uptimelyHeartbeatUrl("https://uptimely.test///", "k")).toBe(
			"https://uptimely.test/heartbeat/k",
		);
		expect(init.method).toBe("GET");
		expect(init.redirect).toBe("error");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("never throws and never logs the key when the request fails", async () => {
		fetchMock.mockRejectedValue(
			new Error(
				`connect ECONNREFUSED https://uptimely.test/heartbeat/${HEARTBEAT_KEY}`,
			),
		);

		await expect(
			pingUptimelyHeartbeat({
				baseUrl: "https://uptimely.test",
				secretKey: HEARTBEAT_KEY,
				label: "application web",
			}),
		).resolves.toBe(false);

		expect(errorSpy).toHaveBeenCalled();
		expect(loggedText()).toContain("application web");
		expect(loggedText()).not.toContain(HEARTBEAT_KEY);
	});

	it("reports a refused ping without throwing or logging the key", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));

		await expect(
			pingUptimelyHeartbeat({
				baseUrl: "https://uptimely.test",
				secretKey: HEARTBEAT_KEY,
				label: "application web",
			}),
		).resolves.toBe(false);
		expect(loggedText()).toContain("404");
		expect(loggedText()).not.toContain(HEARTBEAT_KEY);
	});

	it("gives up after the timeout instead of hanging the caller", async () => {
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "TimeoutError")),
					);
				}),
		);

		await expect(
			pingUptimelyHeartbeat({
				baseUrl: "https://uptimely.test",
				secretKey: HEARTBEAT_KEY,
				label: "application web",
				timeoutMs: 20,
			}),
		).resolves.toBe(false);
	});
});

describe("pingUptimelyDeployHeartbeat", () => {
	const link = (overrides: Record<string, unknown> = {}) => ({
		linkId: "link-1",
		kind: "heartbeat",
		heartbeatKey: HEARTBEAT_KEY,
		integration: {
			organizationId: "org-1",
			baseUrl: "https://uptimely.test",
		},
		...overrides,
	});

	it("pings when a heartbeat is linked and its key is known", async () => {
		mocks.heartbeatLink = link();

		await expect(pingUptimelyDeployHeartbeat(context)).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`https://uptimely.test/heartbeat/${HEARTBEAT_KEY}`,
		);
	});

	it("does nothing when no heartbeat is linked", async () => {
		await expect(pingUptimelyDeployHeartbeat(context)).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does nothing while the secret key is still unknown", async () => {
		mocks.heartbeatLink = link({ heartbeatKey: null });

		await expect(pingUptimelyDeployHeartbeat(context)).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not ping a link that belongs to another organization", async () => {
		mocks.heartbeatLink = link({
			integration: {
				organizationId: "org-2",
				baseUrl: "https://uptimely.test",
			},
		});

		await expect(pingUptimelyDeployHeartbeat(context)).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("swallows a failing ping and a failing lookup", async () => {
		mocks.heartbeatLink = link();
		fetchMock.mockRejectedValue(new Error("network down"));
		await expect(pingUptimelyDeployHeartbeat(context)).resolves.toBe(false);

		mocks.linkLookupError = new Error("database down");
		await expect(pingUptimelyDeployHeartbeat(context)).resolves.toBe(false);
		expect(loggedText()).not.toContain(HEARTBEAT_KEY);
	});
});

describe("reportDeployFailureToUptimely", () => {
	beforeEach(() => {
		mocks.channels = [channel()];
	});

	it("declares an incident for the failed service and remembers it", async () => {
		mocks.callTool.mockResolvedValue({ incidentId: "inc-1", declared: true });

		await reportDeployFailureToUptimely(context, {
			errorMessage: "docker build exited 1",
			buildLink: "https://dokploy.test/deployments",
		});

		expect(mocks.clientOptions).toEqual([
			{ apiKey: "channel-api-key", baseUrl: "https://uptimely.test" },
		]);
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		const [tool, args] = mocks.callTool.mock.calls[0] as [
			string,
			Record<string, string>,
		];
		expect(tool).toBe("uptimely_incident_declare");
		expect(args.projectId).toBe(PROJECT);
		expect(args.title).toBe("Deploy failed: Devino/web");
		expect(args.description).toContain("docker build exited 1");
		expect(args.description).toContain("https://dokploy.test/deployments");
		expect(mocks.inserted).toEqual([
			{
				uptimelyChannelId: "chan-1",
				serviceKey: "application:app-1",
				incidentId: "inc-1",
			},
		]);
	});

	it("does not declare a second incident while one is still open", async () => {
		mocks.openIncident = {
			channelIncidentId: "ci-1",
			incidentId: "inc-1",
		};
		mocks.callTool.mockResolvedValue({ state: { isResolvedState: false } });

		await reportDeployFailureToUptimely(context, {
			errorMessage: "again",
			buildLink: "",
		});

		expect(mocks.callTool.mock.calls.map((c) => c[0])).toEqual([
			"uptimely_incident_get",
		]);
		expect(mocks.inserted).toEqual([]);
	});

	it("declares again when the remembered incident was resolved in Uptimely", async () => {
		mocks.openIncident = {
			channelIncidentId: "ci-1",
			incidentId: "inc-old",
		};
		mocks.callTool.mockImplementation(async (tool: string) =>
			tool === "uptimely_incident_get"
				? { state: { isResolvedState: true } }
				: { incidentId: "inc-new", declared: true },
		);

		await reportDeployFailureToUptimely(context, {
			errorMessage: "boom",
			buildLink: "",
		});

		expect(mocks.callTool.mock.calls.map((c) => c[0])).toEqual([
			"uptimely_incident_get",
			"uptimely_incident_declare",
		]);
		expect(mocks.deletes).toBe(1);
		expect(mocks.inserted[0]).toMatchObject({ incidentId: "inc-new" });
	});

	it("skips organizations without an Uptimely channel", async () => {
		mocks.channels = [];

		await reportDeployFailureToUptimely(context, {
			errorMessage: "boom",
			buildLink: "",
		});

		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("logs, and does not throw, when Uptimely has AI writes switched off", async () => {
		mocks.callTool.mockRejectedValue(
			Object.assign(new Error("AI write operations are disabled"), {
				code: "AI_WRITE_OPS_DISABLED",
				settingsUrl: "https://uptimely.test/settings",
			}),
		);

		await expect(
			reportDeployFailureToUptimely(context, {
				errorMessage: "boom",
				buildLink: "",
			}),
		).resolves.toBeUndefined();

		expect(loggedText()).toContain("AI write operations are disabled");
		expect(loggedText()).not.toContain("channel-api-key");
		expect(mocks.inserted).toEqual([]);
	});
});

describe("reportDeploySuccessToUptimelyIncidents", () => {
	beforeEach(() => {
		mocks.channels = [channel()];
		mocks.openIncident = { channelIncidentId: "ci-1", incidentId: "inc-1" };
	});

	it("resolves the open incident of the service, learning the Resolved state", async () => {
		mocks.callTool.mockImplementation(async (tool: string) =>
			tool === "uptimely_incident_list"
				? {
						incidents: [
							{ state: { id: "state-open", name: "Identified" } },
							{ state: { id: RESOLVED_STATE, name: "Resolved" } },
						],
					}
				: { changed: true },
		);

		await reportDeploySuccessToUptimelyIncidents(context);

		expect(mocks.callTool.mock.calls.map((c) => c[0])).toEqual([
			"uptimely_incident_list",
			"uptimely_incident_state_change",
		]);
		expect(mocks.callTool.mock.calls[1]?.[1]).toMatchObject({
			projectId: PROJECT,
			incidentId: "inc-1",
			incidentStateId: RESOLVED_STATE,
		});
		expect(mocks.deletes).toBe(1);
	});

	it("uses the configured Resolved state id without asking Uptimely", async () => {
		mocks.channels = [channel({ resolvedStateId: RESOLVED_STATE })];
		mocks.callTool.mockResolvedValue({ changed: true });

		await reportDeploySuccessToUptimelyIncidents(context);

		expect(mocks.callTool.mock.calls.map((c) => c[0])).toEqual([
			"uptimely_incident_state_change",
		]);
		expect(mocks.callTool.mock.calls[0]?.[1]).toMatchObject({
			incidentStateId: RESOLVED_STATE,
		});
	});

	it("does nothing when the service has no open incident", async () => {
		mocks.openIncident = null;

		await reportDeploySuccessToUptimelyIncidents(context);

		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(mocks.deletes).toBe(0);
	});

	it("keeps the incident for the next success when it cannot be resolved", async () => {
		mocks.callTool.mockImplementation(async (tool: string) => {
			if (tool === "uptimely_incident_list") return { incidents: [] };
			// Today the state input is a UUID, so the name fallback is refused.
			throw new Error("INVALID_INPUT: incidentStateId must be a UUID");
		});

		await expect(
			reportDeploySuccessToUptimelyIncidents(context),
		).resolves.toBeUndefined();

		expect(loggedText()).toContain("Resolved incident state");
		expect(mocks.deletes).toBe(0);
	});

	it("falls back to the state name when no Resolved state id can be found", async () => {
		mocks.callTool.mockImplementation(async (tool: string) =>
			tool === "uptimely_incident_list" ? { incidents: [] } : { changed: true },
		);

		await reportDeploySuccessToUptimelyIncidents(context);

		const change = mocks.callTool.mock.calls.find(
			(c) => c[0] === "uptimely_incident_state_change",
		);
		expect(change?.[1]).toMatchObject({ incidentStateId: "resolved" });
		expect(mocks.deletes).toBe(1);
	});

	it("keeps the incident when Uptimely rejects the state id", async () => {
		mocks.channels = [channel({ resolvedStateId: RESOLVED_STATE })];
		mocks.callTool.mockResolvedValue({
			changed: false,
			reason: "state_not_found",
		});

		await reportDeploySuccessToUptimelyIncidents(context);

		expect(mocks.deletes).toBe(0);
		expect(loggedText()).toContain("Resolved");
	});
});

describe("a failure followed by a success", () => {
	it("declares on failure and resolves on the next success of the same service", async () => {
		mocks.channels = [channel()];
		mocks.callTool.mockImplementation(async (tool: string) => {
			if (tool === "uptimely_incident_declare") {
				return { incidentId: "inc-7", declared: true };
			}
			if (tool === "uptimely_incident_list") {
				return {
					incidents: [{ state: { id: RESOLVED_STATE, name: "Resolved" } }],
				};
			}
			return { changed: true };
		});

		await reportDeployFailureToUptimely(context, {
			errorMessage: "boom",
			buildLink: "",
		});
		expect(mocks.inserted[0]).toMatchObject({
			serviceKey: "application:app-1",
			incidentId: "inc-7",
		});

		// The row the failure stored is what the success finds.
		mocks.openIncident = { channelIncidentId: "ci-7", incidentId: "inc-7" };
		await reportDeploySuccessToUptimely(context);

		const changed = mocks.callTool.mock.calls.find(
			(c) => c[0] === "uptimely_incident_state_change",
		);
		expect(changed?.[1]).toMatchObject({
			incidentId: "inc-7",
			incidentStateId: RESOLVED_STATE,
		});
		expect(mocks.deletes).toBe(1);
	});
});
