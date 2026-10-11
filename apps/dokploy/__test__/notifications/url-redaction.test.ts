import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The non-secret URLs of the notification providers (Gotify/ntfy `serverUrl`,
 * Sendly/Notifly/Uptimely `baseUrl`) are returned as stored, except that a URL
 * which carries userinfo, a query or a fragment comes back redacted: those are
 * where a pasted `https://user:pass@host` or `?token=...` ends up. A plain URL
 * is unchanged, so the edit form still shows it. The form sends the redacted
 * URL back untouched when it is not edited: that echo keeps the stored URL and
 * is not a URL change.
 */

const mocks = vi.hoisted(() => ({
	notification: null as Record<string, unknown> | null,
	updates: [] as {
		table: string;
		values: Record<string, unknown>;
		bound: unknown[];
	}[],
	fetch: vi.fn(),
	// The base URL each Uptimely client was created for.
	clientUrls: [] as string[],
	// What the Uptimely client throws, when set.
	clientFailure: null as string | null,
	// The API key each Uptimely client was created with.
	clientKeys: [] as string[],
	// "<resource>:<action>" pairs the caller's role does not grant.
	denied: [] as string[],
}));

const tableName = (table: unknown) => {
	const symbols = Object.getOwnPropertySymbols(table as object);
	const nameSymbol = symbols.find((s) => s.toString().includes("Name"));
	return nameSymbol
		? String((table as Record<symbol, unknown>)[nameSymbol])
		: "unknown";
};

vi.mock("@dokploy/server/db", () => {
	const tx = {
		query: {
			notifications: { findFirst: vi.fn(async () => mocks.notification) },
		},
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					mocks.updates.push({ table: tableName(table), values, bound: [] });
					const result = Promise.resolve([{ notificationId: "n-1" }]);
					return Object.assign(result, { returning: () => result });
				},
			}),
		}),
		delete: () => ({
			where: () => ({
				// biome-ignore lint/suspicious/noThenProperty: awaited like a drizzle query
				then: (resolve: (value: unknown) => void) => resolve(undefined),
			}),
		}),
	};
	return {
		db: {
			query: new Proxy({} as Record<string, unknown>, {
				get: (_target, table) =>
					table === "member"
						? {
								findFirst: vi.fn(async () => ({
									id: "member-1",
									userId: "user-1",
									organizationId: "org-1",
									role: "owner",
									accessedServices: [],
									accessedProjects: [],
									accessedEnvironments: [],
									user: { id: "user-1" },
								})),
								findMany: vi.fn(async () => []),
							}
						: {
								findFirst: vi.fn(async () => mocks.notification ?? undefined),
								findMany: vi.fn(async () =>
									mocks.notification ? [mocks.notification] : [],
								),
							},
			}),
			transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@dokploy/server/utils/uptimely/client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/utils/uptimely/client")
	>()),
	createUptimelyClient: vi.fn(
		(options: { baseUrl: string; apiKey: string }) => {
			mocks.clientUrls.push(options.baseUrl);
			mocks.clientKeys.push(options.apiKey);
			return {
				callTool: async () => {
					if (mocks.clientFailure) throw new Error(mocks.clientFailure);
					return {
						projects: [{ id: "22222222-2222-4222-8222-222222222222" }],
					};
				},
			};
		},
	),
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

vi.mock("@dokploy/server/services/permission", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/services/permission")
		>();
	const { TRPCError } = await import("@trpc/server");
	return {
		...actual,
		checkPermission: vi.fn(
			async (
				ctx: Parameters<typeof actual.checkPermission>[0],
				permissions: Record<string, string[]>,
			) => {
				for (const [resource, actions] of Object.entries(permissions)) {
					for (const action of actions) {
						if (mocks.denied.includes(`${resource}:${action}`)) {
							throw new TRPCError({
								code: "UNAUTHORIZED",
								message: "Permission denied",
							});
						}
					}
				}
				return actual.checkPermission(ctx, permissions as never);
			},
		),
	};
});

const { notificationRouter } = await import(
	"@/server/api/routers/notification"
);
const { createCallerFactory } = await import("@/server/api/trpc");
const services = await import("@dokploy/server/services/notification");
const {
	containsUrlRedaction,
	isRedactedUrlEcho,
	isSameIntegrationBaseUrl,
	redactUrl,
	uptimelyHeartbeatUrl,
	uptimelyMcpUrl,
} = await import("@dokploy/server");

const caller = createCallerFactory(notificationRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

describe("redactUrl", () => {
	it.each([
		"https://gotify.example.com",
		"https://gotify.example.com/",
		"http://gotify.example.com:8080/push",
		"https://app.sendly.now/api",
		"https://host.example/a@b",
		"https://host.example/?flag=",
		"gotify.example.com/push",
		"not a url",
		"",
	])("leaves the plain URL %j unchanged", (url) => {
		expect(redactUrl(url)).toBe(url);
	});

	it("hides the userinfo, user and password", () => {
		expect(redactUrl("https://amin:hunter2@gotify.example.com/push")).toBe(
			"https://••••@gotify.example.com/push",
		);
		expect(redactUrl("https://token@ntfy.example.com")).toBe(
			"https://••••@ntfy.example.com/",
		);
	});

	it("hides every query value and keeps the keys", () => {
		expect(
			redactUrl("https://ntfy.example.com/?auth=abcdef&priority=5&flag="),
		).toBe("https://ntfy.example.com/?auth=••••&priority=••••&flag=");
	});

	it("hides a bare query token", () => {
		expect(redactUrl("https://ntfy.example.com?abcdef123456")).toBe(
			"https://ntfy.example.com/?••••",
		);
	});

	it("hides a fragment", () => {
		expect(redactUrl("https://ntfy.example.com/#access_token=abc")).toBe(
			"https://ntfy.example.com/#••••",
		);
	});

	it("handles userinfo, query and fragment together, keeping the path", () => {
		expect(redactUrl("https://u:p@host.example:8443/a/b?k=v#f")).toBe(
			"https://••••@host.example:8443/a/b?k=••••#••••",
		);
	});

	it("never contains the original secrets", () => {
		const redacted = redactUrl(
			"https://amin:hunter2@host.example/p?token=s3cr3t#frag-secret",
		);
		for (const secret of ["amin", "hunter2", "s3cr3t", "frag-secret"]) {
			expect(redacted).not.toContain(secret);
		}
	});

	it("is idempotent", () => {
		const once = redactUrl("https://u:p@host.example/p?token=abc#f");
		expect(redactUrl(once)).toBe(once);
	});

	describe("fails closed", () => {
		it("redacts a URL with a line break in the fragment, query or userinfo", () => {
			for (const url of [
				"https://u:p@h/x#a\nb",
				"https://u:p@h/x?k=a\nb#f",
				"https://u:p@h/x#\n",
				"https://u:p@h/x\r\n?k=v",
			]) {
				const redacted = redactUrl(url);
				expect(redacted).not.toContain("u:p");
				expect(redacted).not.toMatch(/=v|=a/);
				expect(redacted).toContain("••••");
			}
		});

		it.each([
			"//u:p@host.example/x",
			"u:p@host.example/push?k=v",
			"ht!tp://u:p@host.example",
			"https://u:p@",
			"https://[::1/x?k=v",
			"/relative?token=abc",
			"just a token#secret",
		])(
			"masks the value %j, which does not parse as an http(s) URL",
			(value) => {
				const redacted = redactUrl(value);
				expect(redacted).toBe("••••");
			},
		);

		it("shows the host that fetch calls when a backslash ends the authority", () => {
			expect(redactUrl("https://evil.com\\@trusted.com/x?t=1")).toBe(
				"https://evil.com/@trusted.com/x?t=••••",
			);
			expect(redactUrl("https://trusted.com\\@evil.com/x#frag")).toBe(
				"https://trusted.com/@evil.com/x#••••",
			);
		});

		it("is linear: huge or hostile values finish fast and never come back raw", () => {
			const size = 1_000_000;
			const hostile = [
				`https://${"a".repeat(size)}#\n`,
				`https://${"a".repeat(size)}@host.example/x`,
				`https://u:p@host.example/${"/".repeat(size)}x?k=v`,
				`${"a".repeat(size)}#\n`,
				`${"@".repeat(size)}`,
				`https://host.example/?${"&".repeat(size)}`,
			];
			for (const value of hostile) {
				const started = performance.now();
				const redacted = redactUrl(value);
				isRedactedUrlEcho(value, value);
				isRedactedUrlEcho(`${"/".repeat(size)}x`, value);
				expect(performance.now() - started).toBeLessThan(250);
				expect(redacted).not.toContain("u:p");
				expect(redacted).not.toContain("k=v");
			}
		});
	});
});

describe("isRedactedUrlEcho", () => {
	const stored = "https://u:p@host.example/p?token=abc";

	it("is true for the redacted form of the stored URL", () => {
		expect(isRedactedUrlEcho(redactUrl(stored), stored)).toBe(true);
	});

	it("ignores whitespace and trailing slashes around the echo", () => {
		expect(
			isRedactedUrlEcho(
				` ${redactUrl("https://u:p@host.example")}/ `,
				"https://u:p@host.example",
			),
		).toBe(true);
	});

	it("is false for a different URL", () => {
		expect(isRedactedUrlEcho("https://attacker.example", stored)).toBe(false);
		expect(
			isRedactedUrlEcho("https://••••@attacker.example/p?token=••••", stored),
		).toBe(false);
	});

	it("is false when the stored URL had nothing to redact", () => {
		expect(
			isRedactedUrlEcho("https://host.example", "https://host.example"),
		).toBe(false);
	});

	it("is not a URL change for the re-enter-the-key rules", () => {
		expect(isSameIntegrationBaseUrl(redactUrl(stored), stored)).toBe(true);
	});
});

describe("stored URLs with a long run of slashes", () => {
	const size = 1_000_000;
	const slashes = "/".repeat(size);

	it("isSameIntegrationBaseUrl compares them in linear time", () => {
		for (const [a, b] of [
			[`https://host.example${slashes}`, "https://host.example"],
			[`host.example${slashes}`, `host.example${slashes}x`],
			[`https://host.example/${slashes}x`, `https://host.example/${slashes}x/`],
		] as const) {
			const started = performance.now();
			isSameIntegrationBaseUrl(a, b);
			isSameIntegrationBaseUrl(b, a);
			expect(performance.now() - started).toBeLessThan(250);
		}
		expect(
			isSameIntegrationBaseUrl(
				`https://host.example${slashes}`,
				"https://host.example",
			),
		).toBe(true);
	});

	it("the Uptimely URLs built from a stored base URL are linear too", () => {
		const started = performance.now();
		expect(uptimelyMcpUrl(`https://host.example${slashes}`)).toBe(
			"https://host.example/api/mcp",
		);
		expect(uptimelyHeartbeatUrl(`https://host.example${slashes}`, "key")).toBe(
			"https://host.example/heartbeat/key",
		);
		expect(performance.now() - started).toBeLessThan(250);
	});
});

describe("containsUrlRedaction", () => {
	it("spots the redaction mark", () => {
		expect(containsUrlRedaction("https://••••@host.example")).toBe(true);
		expect(containsUrlRedaction("https://host.example/?k=••••")).toBe(true);
		expect(containsUrlRedaction("https://host.example")).toBe(false);
	});
});

type Provider = {
	type: string;
	rowKey: string;
	urlKey: string;
	stored: string;
	redacted: string;
	row: Record<string, unknown>;
	update: (input: never) => Promise<unknown>;
	routerUpdate: string;
	test: (input: Record<string, unknown>) => Promise<unknown>;
	secretKey: string;
};

const providers: Provider[] = [
	{
		type: "sendly",
		rowKey: "sendly",
		urlKey: "baseUrl",
		stored: "https://amin:hunter2@app.sendly.now/base?apikey=s3cr3t",
		redacted: "https://••••@app.sendly.now/base?apikey=••••",
		row: {
			sendlyId: "sendly-1",
			apiKey: "sendly-secret-api-key-1234",
			fromAddress: "alerts@example.com",
			toAddresses: ["team@example.com"],
		},
		update: services.updateSendlyNotification,
		routerUpdate: "updateSendly",
		test: (input: Record<string, unknown>) =>
			caller.testSendlyConnection({
				fromAddress: "alerts@example.com",
				toAddresses: ["team@example.com"],
				...input,
			} as never),
		secretKey: "apiKey",
	},
	{
		type: "notifly",
		rowKey: "notifly",
		urlKey: "baseUrl",
		stored: "https://amin:hunter2@api.notifly.io?workspace=s3cr3t",
		redacted: "https://••••@api.notifly.io/?workspace=••••",
		row: {
			notiflyId: "notifly-1",
			apiKey: "notifly-secret-api-key-5678",
			workflowKey: "dokploy",
			subscriberId: null,
		},
		update: services.updateNotiflyNotification,
		routerUpdate: "updateNotifly",
		test: (input: Record<string, unknown>) =>
			caller.testNotiflyConnection({
				workflowKey: "dokploy",
				subscriberId: "",
				...input,
			} as never),
		secretKey: "apiKey",
	},
	{
		type: "uptimely",
		rowKey: "uptimelyChannel",
		urlKey: "baseUrl",
		stored: "https://amin:hunter2@uptimely.example/api?key=s3cr3t",
		redacted: "https://••••@uptimely.example/api?key=••••",
		row: {
			uptimelyChannelId: "uptimely-1",
			apiKey: "uptimely-secret-api-key-9012",
			projectId: "22222222-2222-4222-8222-222222222222",
			resolvedStateId: null,
		},
		update: services.updateUptimelyChannelNotification,
		routerUpdate: "updateUptimely",
		test: (input: Record<string, unknown>) =>
			caller.testUptimelyConnection({
				projectId: "22222222-2222-4222-8222-222222222222",
				...input,
			} as never),
		secretKey: "apiKey",
	},
	{
		type: "gotify",
		rowKey: "gotify",
		urlKey: "serverUrl",
		stored: "https://amin:hunter2@gotify.example.com/push?token=s3cr3t",
		redacted: "https://••••@gotify.example.com/push?token=••••",
		row: {
			gotifyId: "gotify-1",
			appToken: "gotify-secret-app-token-3456",
			priority: 5,
			decoration: true,
		},
		update: services.updateGotifyNotification,
		routerUpdate: "updateGotify",
		test: (input: Record<string, unknown>) =>
			caller.testGotifyConnection({ priority: 5, ...input } as never),
		secretKey: "appToken",
	},
	{
		type: "ntfy",
		rowKey: "ntfy",
		urlKey: "serverUrl",
		stored: "https://amin:hunter2@ntfy.example.com/?auth=s3cr3t",
		redacted: "https://••••@ntfy.example.com/?auth=••••",
		row: {
			ntfyId: "ntfy-1",
			topic: "ntfy-secret-topic-7890",
			accessToken: "ntfy-secret-access-token-1357",
			priority: 3,
		},
		update: services.updateNtfyNotification,
		routerUpdate: "updateNtfy",
		test: (input: Record<string, unknown>) =>
			caller.testNtfyConnection({ priority: 3, ...input } as never),
		secretKey: "topic",
	},
];

const storedNotification = (p: Provider) => ({
	notificationId: "n-1",
	name: `${p.type} channel`,
	notificationType: p.type,
	organizationId: "org-1",
	slack: null,
	telegram: null,
	discord: null,
	email: null,
	resend: null,
	sendly: null,
	notifly: null,
	uptimelyChannel: null,
	gotify: null,
	ntfy: null,
	mattermost: null,
	custom: null,
	lark: null,
	pushover: null,
	teams: null,
	[p.rowKey]: { ...p.row, [p.urlKey]: p.stored },
});

// The stored secrets of each provider's row, which the Test button borrows.
const wireSecrets: Record<string, string[]> = {
	sendly: ["sendly-secret-api-key-1234"],
	notifly: ["notifly-secret-api-key-5678"],
	uptimely: ["uptimely-secret-api-key-9012"],
	gotify: ["gotify-secret-app-token-3456"],
	ntfy: ["ntfy-secret-topic-7890", "ntfy-secret-access-token-1357"],
};

// Everything the senders put on the wire: requests and Uptimely clients.
const wire = () => JSON.stringify([mocks.fetch.mock.calls, mocks.clientKeys]);

const urlSentOnTheWire = () =>
	mocks.clientUrls.at(-1) ?? String(mocks.fetch.mock.calls.at(-1)?.[0]);
const providerUpdate = (p: Provider) =>
	mocks.updates.find(
		(u) => u.table === (p.type === "uptimely" ? "uptimely_channel" : p.type),
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updates = [];
	mocks.clientUrls = [];
	mocks.clientFailure = null;
	mocks.clientKeys = [];
	mocks.denied = [];
	mocks.fetch.mockReset();
	mocks.fetch.mockResolvedValue({
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({
			success: true,
			data: {},
			result: { projects: [{ id: "22222222-2222-4222-8222-222222222222" }] },
		}),
		text: async () => "",
	});
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(providers)("$type URL", (p) => {
	beforeEach(() => {
		mocks.notification = storedNotification(p);
	});

	it("notification.one returns the redacted URL, never the userinfo or query", async () => {
		const result = await caller.one({ notificationId: "n-1" });
		const row = (result as unknown as Record<string, Record<string, unknown>>)[
			p.rowKey
		];

		expect(row?.[p.urlKey]).toBe(p.redacted);
		const json = JSON.stringify(result);
		for (const secret of ["hunter2", "s3cr3t"]) {
			expect(json).not.toContain(secret);
		}
	});

	it("notification.all returns the redacted URL too", async () => {
		const result = await caller.all();
		const row = (
			result[0] as unknown as Record<string, Record<string, unknown>>
		)[p.rowKey];

		expect(row?.[p.urlKey]).toBe(p.redacted);
		expect(JSON.stringify(result)).not.toContain("hunter2");
	});

	it("a plain stored URL comes back unchanged", async () => {
		mocks.notification = storedNotification({
			...p,
			stored: "https://plain.example.com/base",
		});

		const result = await caller.one({ notificationId: "n-1" });

		expect(
			(result as unknown as Record<string, Record<string, unknown>>)[
				p.rowKey
			]?.[p.urlKey],
		).toBe("https://plain.example.com/base");
	});

	it("masking does not touch the stored row the senders read", async () => {
		await caller.one({ notificationId: "n-1" });
		await caller.all();

		const row = (
			mocks.notification as unknown as Record<string, Record<string, unknown>>
		)[p.rowKey];
		expect(row?.[p.urlKey]).toBe(p.stored);
	});

	describe("update", () => {
		it("the redacted URL echoed back keeps the stored URL, without a key", async () => {
			await p.update({
				notificationId: "n-1",
				organizationId: "org-1",
				[p.urlKey]: p.redacted,
				name: "Renamed",
			} as never);

			expect(providerUpdate(p)?.values ?? {}).not.toHaveProperty(p.urlKey);
		});

		it("the echo through the router keeps the stored URL too", async () => {
			await (
				caller as unknown as Record<
					string,
					(input: unknown) => Promise<unknown>
				>
			)[p.routerUpdate]?.({
				notificationId: "n-1",
				[p.urlKey]: p.redacted,
				name: "Renamed",
			});

			expect(providerUpdate(p)?.values ?? {}).not.toHaveProperty(p.urlKey);
			expect(JSON.stringify(mocks.updates)).not.toContain("••••@");
		});

		it("the echo does not erase the secret that goes with it", async () => {
			await p.update({
				notificationId: "n-1",
				organizationId: "org-1",
				[p.urlKey]: p.redacted,
				[p.secretKey]: "",
			} as never);

			expect(providerUpdate(p)?.values ?? {}).not.toHaveProperty(p.secretKey);
		});

		it("a different URL is still a change that needs the secret again", async () => {
			await expect(
				p.update({
					notificationId: "n-1",
					organizationId: "org-1",
					[p.urlKey]: "https://attacker.example",
				} as never),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.updates).toEqual([]);
		});

		it("a typed URL is written as typed", async () => {
			await p.update({
				notificationId: "n-1",
				organizationId: "org-1",
				[p.urlKey]: "https://elsewhere.example/base",
				...(p.type === "ntfy"
					? { topic: "typed-topic-wxyz", clearAccessToken: true }
					: { [p.secretKey]: "typed-secret-wxyz" }),
			} as never);

			expect(providerUpdate(p)?.values).toMatchObject({
				[p.urlKey]: "https://elsewhere.example/base",
			});
		});

		it("an edited redacted URL is refused instead of storing the mask", async () => {
			await expect(
				p.update({
					notificationId: "n-1",
					organizationId: "org-1",
					[p.urlKey]: p.redacted.replace(/\.[a-z]+(\/|$|\?)/, ".test$1"),
					[p.secretKey]: "typed-secret-wxyz",
				} as never),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: services.REDACTED_URL_MESSAGE,
			});
			expect(mocks.updates).toEqual([]);
		});
	});

	describe("Test Notification", () => {
		const input = (extra: Record<string, unknown>) => ({
			[p.urlKey]: p.redacted,
			notificationId: "n-1",
			...extra,
		});

		it("the echoed URL is tested against the stored URL with the stored secret", async () => {
			await expect(p.test(input({}))).resolves.toBe(true);

			const url = urlSentOnTheWire();
			expect(url).not.toContain("••••");
			expect(url).toContain(new URL(p.stored).host);
			for (const secret of wireSecrets[p.type] ?? []) {
				expect(wire()).toContain(secret);
			}
		});

		it("the echo of another organization's notification is refused and nothing is sent", async () => {
			mocks.notification = {
				...storedNotification(p),
				organizationId: "org-2",
			};

			await expect(p.test(input({}))).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect(mocks.clientUrls).toEqual([]);
		});

		it("the echo needs the update permission, a create-only role is refused and nothing is sent", async () => {
			mocks.denied = ["notification:update"];

			await expect(p.test(input({}))).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect(mocks.clientUrls).toEqual([]);
		});

		it("a masked URL that is not the echo of the stored one is refused before any request", async () => {
			await expect(
				p.test(
					input({
						[p.urlKey]: "https://••••@attacker.example/?k=••••",
						[p.secretKey]: "typed-secret-wxyz",
					}),
				),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: services.REDACTED_URL_MESSAGE,
			});
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect(mocks.clientUrls).toEqual([]);
		});

		it("a masked URL without a notification to resolve it is refused", async () => {
			await expect(
				p.test(
					input({ notificationId: undefined, [p.secretKey]: "typed-wxyz" }),
				),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: services.REDACTED_URL_MESSAGE,
			});
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect(mocks.clientUrls).toEqual([]);
		});

		it("a failed test does not echo the stored userinfo or query", async () => {
			const failureText = `Failed to parse URL from ${p.stored}`;
			mocks.fetch.mockRejectedValue(new Error(failureText));
			mocks.clientFailure = failureText;

			const failure = await p.test(input({})).catch((error: Error) => error);

			expect(failure).toMatchObject({ code: "BAD_REQUEST" });
			expect((failure as Error).message).not.toContain("hunter2");
			expect((failure as Error).message).not.toContain("s3cr3t");
		});
	});
});
