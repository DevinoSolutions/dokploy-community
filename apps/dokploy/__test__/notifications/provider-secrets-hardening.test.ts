import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every notification provider secret is write-only: webhook URLs (Slack,
 * Discord, Teams, Lark, Mattermost), the Telegram bot token, the SMTP password,
 * the Resend key, the Gotify app token, the ntfy access token, the Pushover
 * keys and the Custom header values. They are masked on read, a blank or
 * omitted value keeps the stored one, the "Test Notification" button of the
 * edit form borrows the stored secret of the caller's own notification, and a
 * stored secret is never replayed against a server URL typed into the form.
 */

const mocks = vi.hoisted(() => ({
	notification: null as Record<string, unknown> | null,
	updates: [] as {
		table: string;
		values: Record<string, unknown>;
		bound: unknown[];
	}[],
	// Everything a sender put on the wire (fetch, SMTP transport, Resend key).
	sent: [] as string[],
	fetch: vi.fn(),
	findManyResult: null as Record<string, unknown>[] | null,
}));

const tableName = (table: unknown) => {
	const symbols = Object.getOwnPropertySymbols(table as object);
	const nameSymbol = symbols.find((s) => s.toString().includes("Name"));
	return nameSymbol
		? String((table as Record<symbol, unknown>)[nameSymbol])
		: "unknown";
};

// The values a drizzle condition binds, e.g. the id in eq(column, id).
const boundValues = (node: unknown): unknown[] => {
	if (!node || typeof node !== "object") return [];
	const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
	if (Array.isArray(chunks)) return chunks.flatMap(boundValues);
	return "value" in node && !Array.isArray((node as { value: unknown }).value)
		? [(node as { value: unknown }).value]
		: [];
};

vi.mock("nodemailer", () => ({
	default: {
		createTransport: (options: unknown) => {
			mocks.sent.push(`smtp ${JSON.stringify(options)}`);
			return { sendMail: async () => ({}) };
		},
	},
}));

vi.mock("resend", () => ({
	Resend: class {
		emails = { send: async () => ({ error: null }) };
		constructor(apiKey: string) {
			mocks.sent.push(`resend ${apiKey}`);
		}
	},
}));

vi.mock("@dokploy/server/db", () => {
	const tx = {
		query: {
			notifications: { findFirst: vi.fn(async () => mocks.notification) },
		},
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (condition: unknown) => {
					mocks.updates.push({
						table: tableName(table),
						values,
						bound: boundValues(condition),
					});
					return Promise.resolve([{ notificationId: "n-1" }]);
				},
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
								findMany: vi.fn(
									async () =>
										mocks.findManyResult ??
										(mocks.notification ? [mocks.notification] : []),
								),
							},
			}),
			transaction: vi.fn(async (run: (tx: unknown) => unknown) => run(tx)),
			execute: vi.fn(async () => []),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(async () => {}),
}));

const { notificationRouter } = await import(
	"@/server/api/routers/notification"
);
const { createCallerFactory } = await import("@/server/api/trpc");
const services = await import("@dokploy/server/services/notification");
const { sendBuildSuccessNotifications } = await import(
	"@dokploy/server/utils/notifications/build-success"
);
const { sendEmailNotification, sendResendNotification } = await import(
	"@dokploy/server/utils/notifications/utils"
);
const { redactSecrets } = await import("@/server/api/utils/redact-secrets");
const { maskHeaderValues } = await import(
	"@dokploy/server/utils/integrations/mask"
);

const caller = createCallerFactory(notificationRouter)({
	user: { id: "user-1", email: "owner@test.com", role: "owner" },
	session: { activeOrganizationId: "org-1" },
	req: {} as unknown,
	res: {} as unknown,
} as never);

type Procedure = (input: unknown) => Promise<unknown>;
const call = (name: string, input: unknown) =>
	(caller as unknown as Record<string, Procedure>)[name]?.(
		input,
	) as Promise<any>;

const RELATIONS = [
	"slack",
	"telegram",
	"discord",
	"email",
	"resend",
	"sendly",
	"notifly",
	"uptimelyChannel",
	"gotify",
	"ntfy",
	"mattermost",
	"custom",
	"lark",
	"pushover",
	"teams",
] as const;

type Case = {
	type: string;
	rowKey: (typeof RELATIONS)[number];
	idKey: string;
	row: Record<string, unknown>;
	/** Secret column -> its masked form on read. */
	secrets: Record<string, string>;
	/** Secret column -> value typed to replace it. */
	typed: Record<string, string>;
	/** A non-secret column and a new value for it. */
	plain: [string, unknown];
	update: (input: any) => Promise<unknown>;
	routerUpdate: string;
	routerTest: string;
	testInput: Record<string, unknown>;
	/** The secret is optional or structured: its flows have their own describe. */
	special?: boolean;
};

const cases: Case[] = [
	{
		type: "slack",
		rowKey: "slack",
		idKey: "slackId",
		row: {
			slackId: "slack-1",
			webhookUrl:
				"https://hooks.slack.com/services/T000/B000/slack-secret-ab12",
			channel: "#ops",
		},
		secrets: { webhookUrl: "https://hooks.slack.com/…ab12" },
		typed: {
			webhookUrl: "https://hooks.slack.com/services/NEW/NEW/typed-wxyz",
		},
		plain: ["channel", "#alerts"],
		update: services.updateSlackNotification,
		routerUpdate: "updateSlack",
		routerTest: "testSlackConnection",
		testInput: { channel: "#ops" },
	},
	{
		type: "discord",
		rowKey: "discord",
		idKey: "discordId",
		row: {
			discordId: "discord-1",
			webhookUrl: "https://discord.com/api/webhooks/111/discord-secret-cd34",
			decoration: true,
		},
		secrets: { webhookUrl: "https://discord.com/…cd34" },
		typed: { webhookUrl: "https://discord.com/api/webhooks/222/typed-wxyz" },
		plain: ["decoration", false],
		update: services.updateDiscordNotification,
		routerUpdate: "updateDiscord",
		routerTest: "testDiscordConnection",
		testInput: { decoration: true },
	},
	{
		type: "teams",
		rowKey: "teams",
		idKey: "teamsId",
		row: {
			teamsId: "teams-1",
			webhookUrl:
				"https://example.webhook.office.com/webhookb2/teams-secret-ef56",
		},
		secrets: { webhookUrl: "https://example.webhook.office.com/…ef56" },
		typed: {
			webhookUrl: "https://example.webhook.office.com/webhookb2/typed-wxyz",
		},
		plain: ["unused", undefined],
		update: services.updateTeamsNotification,
		routerUpdate: "updateTeams",
		routerTest: "testTeamsConnection",
		testInput: {},
	},
	{
		type: "lark",
		rowKey: "lark",
		idKey: "larkId",
		row: {
			larkId: "lark-1",
			webhookUrl:
				"https://open.larksuite.com/open-apis/bot/v2/hook/lark-secret-gh78",
		},
		secrets: { webhookUrl: "https://open.larksuite.com/…gh78" },
		typed: {
			webhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/typed-wxyz",
		},
		plain: ["unused", undefined],
		update: services.updateLarkNotification,
		routerUpdate: "updateLark",
		routerTest: "testLarkConnection",
		testInput: {},
	},
	{
		type: "mattermost",
		rowKey: "mattermost",
		idKey: "mattermostId",
		row: {
			mattermostId: "mattermost-1",
			webhookUrl: "https://mm.example.com/hooks/mattermost-secret-ij90",
			channel: "ops",
			username: "bot",
		},
		secrets: { webhookUrl: "https://mm.example.com/…ij90" },
		typed: { webhookUrl: "https://mm.example.com/hooks/typed-wxyz" },
		plain: ["channel", "alerts"],
		update: services.updateMattermostNotification,
		routerUpdate: "updateMattermost",
		routerTest: "testMattermostConnection",
		testInput: { channel: "ops", username: "bot" },
	},
	{
		type: "telegram",
		rowKey: "telegram",
		idKey: "telegramId",
		row: {
			telegramId: "telegram-1",
			botToken: "123456:telegram-secret-kl12",
			chatId: "431",
			messageThreadId: null,
		},
		secrets: { botToken: "••••kl12" },
		typed: { botToken: "999999:typed-wxyz" },
		plain: ["chatId", "777"],
		update: services.updateTelegramNotification,
		routerUpdate: "updateTelegram",
		routerTest: "testTelegramConnection",
		testInput: { chatId: "431", messageThreadId: "" },
	},
	{
		type: "resend",
		rowKey: "resend",
		idKey: "resendId",
		row: {
			resendId: "resend-1",
			apiKey: "re_resend-secret-mn34",
			fromAddress: "alerts@example.com",
			toAddresses: ["team@example.com"],
		},
		secrets: { apiKey: "••••mn34" },
		typed: { apiKey: "re_typed-wxyz" },
		plain: ["fromAddress", "other@example.com"],
		update: services.updateResendNotification,
		routerUpdate: "updateResend",
		routerTest: "testResendConnection",
		testInput: { fromAddress: "alerts@example.com", toAddresses: ["a@b.co"] },
	},
	{
		type: "gotify",
		rowKey: "gotify",
		idKey: "gotifyId",
		row: {
			gotifyId: "gotify-1",
			serverUrl: "https://gotify.example.com",
			appToken: "gotify-secret-app-token-op56",
			priority: 5,
			decoration: true,
		},
		secrets: { appToken: "••••op56" },
		typed: { appToken: "gotify-typed-wxyz" },
		plain: ["priority", 8],
		update: services.updateGotifyNotification,
		routerUpdate: "updateGotify",
		routerTest: "testGotifyConnection",
		testInput: { serverUrl: "https://gotify.example.com", priority: 5 },
	},
	{
		type: "ntfy",
		rowKey: "ntfy",
		idKey: "ntfyId",
		row: {
			ntfyId: "ntfy-1",
			serverUrl: "https://ntfy.example.com",
			topic: "ntfy-secret-topic-ab12",
			accessToken: "ntfy-secret-access-token-qr78",
			priority: 3,
		},
		secrets: { accessToken: "••••qr78", topic: "••••ab12" },
		typed: { accessToken: "ntfy-typed-wxyz" },
		plain: ["topic", "alerts"],
		update: services.updateNtfyNotification,
		routerUpdate: "updateNtfy",
		routerTest: "testNtfyConnection",
		testInput: {
			serverUrl: "https://ntfy.example.com",
			topic: "deploys",
			priority: 3,
		},
		special: true,
	},
	{
		type: "pushover",
		rowKey: "pushover",
		idKey: "pushoverId",
		row: {
			pushoverId: "pushover-1",
			userKey: "pushover-secret-user-key-st90",
			apiToken: "pushover-secret-api-token-uv12",
			priority: 0,
			retry: null,
			expire: null,
		},
		secrets: { userKey: "••••st90", apiToken: "••••uv12" },
		typed: {
			userKey: "pushover-typed-user-1234",
			apiToken: "pushover-typed-api-5678",
		},
		plain: ["priority", 1],
		update: services.updatePushoverNotification,
		routerUpdate: "updatePushover",
		routerTest: "testPushoverConnection",
		testInput: { priority: 0 },
	},
	{
		type: "email",
		rowKey: "email",
		idKey: "emailId",
		row: {
			emailId: "email-1",
			smtpServer: "smtp.example.com",
			smtpPort: 587,
			username: "mailer",
			password: "smtp-secret-password-wx34",
			fromAddress: "alerts@example.com",
			toAddresses: ["team@example.com"],
		},
		secrets: { password: "••••••••" },
		typed: { password: "smtp-typed-password" },
		plain: ["fromAddress", "other@example.com"],
		update: services.updateEmailNotification,
		routerUpdate: "updateEmail",
		routerTest: "testEmailConnection",
		testInput: {
			smtpServer: "smtp.example.com",
			smtpPort: 587,
			username: "mailer",
			fromAddress: "alerts@example.com",
			toAddresses: ["team@example.com"],
		},
		special: true,
	},
	{
		type: "custom",
		rowKey: "custom",
		idKey: "customId",
		row: {
			customId: "custom-1",
			endpoint:
				"https://hooks.example.com/ingest?token=custom-secret-endpoint-gh34",
			headers: {
				Authorization: "Bearer custom-secret-header-yz56",
				"X-Env": "prod",
			},
		},
		secrets: { endpoint: "https://hooks.example.com/…gh34" },
		typed: {},
		plain: ["endpoint", "https://hooks.example.com/ingest?token=new-ab12"],
		update: services.updateCustomNotification,
		routerUpdate: "updateCustom",
		routerTest: "testCustomConnection",
		testInput: { endpoint: "https://hooks.example.com/ingest" },
		special: true,
	},
];

const byType = (type: string) => {
	const found = cases.find((c) => c.type === type);
	if (!found) throw new Error(`no case ${type}`);
	return found;
};

const storedNotification = (
	c: Case,
	overrides: Record<string, unknown> = {},
) => ({
	notificationId: "n-1",
	name: `${c.type} channel`,
	notificationType: c.type,
	organizationId: "org-1",
	...Object.fromEntries(RELATIONS.map((relation) => [relation, null])),
	[c.rowKey]: { ...c.row },
	...overrides,
});

const leakOf = (secret: string) => secret.slice(0, -4);

const providerUpdate = (c: Case) =>
	mocks.updates.find((u) => u.table === c.type);

const wire = () => mocks.sent.join("\n");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.updates = [];
	mocks.sent = [];
	mocks.findManyResult = null;
	mocks.fetch.mockReset();
	mocks.fetch.mockImplementation(
		async (url: string, init: { body?: unknown } & Record<string, unknown>) => {
			mocks.sent.push(
				`fetch ${url} ${JSON.stringify({ ...init, body: String(init.body) })}`,
			);
			return { ok: true, status: 200, statusText: "OK", text: async () => "" };
		},
	);
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe.each(cases)("$type notification", (c) => {
	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	describe("secrets are masked on read", () => {
		it("notification.one never returns a secret and shows its masked form", async () => {
			const result = await call("one", { notificationId: "n-1" });
			const json = JSON.stringify(result);

			for (const [column, masked] of Object.entries(c.secrets)) {
				expect(json).not.toContain(leakOf(c.row[column] as string));
				expect(result[c.rowKey]).not.toHaveProperty(column);
				expect(result[c.rowKey][`${column}Masked`]).toBe(masked);
			}
			expect(result[c.rowKey][c.idKey]).toBe(c.row[c.idKey]);
		});

		it("notification.all never returns a secret and shows its masked form", async () => {
			const result = await call("all", undefined);
			const json = JSON.stringify(result);

			expect(result).toHaveLength(1);
			for (const [column, masked] of Object.entries(c.secrets)) {
				expect(json).not.toContain(leakOf(c.row[column] as string));
				expect(result[0][c.rowKey]).not.toHaveProperty(column);
				expect(result[0][c.rowKey][`${column}Masked`]).toBe(masked);
			}
		});

		it("masking does not touch the stored row the senders read", async () => {
			await call("one", { notificationId: "n-1" });
			await call("all", undefined);

			const row = (mocks.notification as Record<string, unknown>)[
				c.rowKey
			] as Record<string, unknown>;
			expect(row).toEqual(c.row);
		});

		it("keeps the other providers null", async () => {
			const result = await call("one", { notificationId: "n-1" });

			for (const relation of RELATIONS) {
				if (relation !== c.rowKey) expect(result[relation]).toBeNull();
			}
		});

		it("notification.one refuses another organization's notification", async () => {
			mocks.notification = storedNotification(c, { organizationId: "org-2" });

			await expect(
				call("one", { notificationId: "n-1" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		});
	});

	describe("update", () => {
		it("a name-only update does not touch the provider row", async () => {
			await expect(
				c.update({
					notificationId: "n-1",
					organizationId: "org-1",
					name: "Renamed",
				}),
			).resolves.toBeUndefined();

			expect(mocks.updates.map((u) => u.table)).toEqual(["notification"]);
		});

		it("derives the provider row from the notification, ignoring a client id", async () => {
			await c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				[c.idKey]: "provider-of-org-2",
				...(c.plain[0] === "unused"
					? { webhookUrl: (c.typed.webhookUrl as string) ?? "" }
					: { [c.plain[0]]: c.plain[1] }),
			});

			const update = providerUpdate(c);
			expect(update?.bound).toContain(c.row[c.idKey]);
			expect(update?.bound).not.toContain("provider-of-org-2");
		});

		it("refuses a notification of another organization and writes nothing", async () => {
			mocks.notification = storedNotification(c, { organizationId: "org-2" });

			await expect(
				c.update({
					notificationId: "n-1",
					organizationId: "org-1",
					name: "Hijack",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.updates).toEqual([]);
		});

		it("refuses a notification of another provider type and writes nothing", async () => {
			mocks.notification = storedNotification(c, {
				notificationType: c.type === "slack" ? "discord" : "slack",
			});

			await expect(
				c.update({
					notificationId: "n-1",
					organizationId: "org-1",
					name: "Wrong type",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.updates).toEqual([]);
		});

		it("through the router: another organization's notification is refused for every environment", async () => {
			mocks.notification = storedNotification(c, { organizationId: "org-2" });

			await expect(
				call(c.routerUpdate, { notificationId: "n-1", name: "Hijack" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.updates).toEqual([]);
		});

		it("through the router: a missing notification keeps its NOT_FOUND", async () => {
			mocks.notification = null;

			await expect(
				call(c.routerUpdate, { notificationId: "n-1", name: "Ghost" }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	});

	describe.skipIf(c.special)("secrets on update", () => {
		const blank = Object.fromEntries(
			Object.keys(c.secrets).map((k) => [k, ""]),
		);

		it("a blank secret keeps the stored one", async () => {
			await call(c.routerUpdate, {
				notificationId: "n-1",
				...blank,
				...(c.plain[0] === "unused" ? {} : { [c.plain[0]]: c.plain[1] }),
			});

			const update = providerUpdate(c);
			for (const column of Object.keys(c.secrets)) {
				expect(update?.values ?? {}).not.toHaveProperty(column);
			}
		});

		it("an omitted secret keeps the stored one", async () => {
			await call(c.routerUpdate, {
				notificationId: "n-1",
				...(c.plain[0] === "unused" ? {} : { [c.plain[0]]: c.plain[1] }),
			});

			const update = providerUpdate(c);
			for (const column of Object.keys(c.secrets)) {
				expect(update?.values ?? {}).not.toHaveProperty(column);
			}
		});

		it("a whitespace-only secret counts as blank", async () => {
			const spaces = Object.fromEntries(
				Object.keys(c.secrets).map((k) => [k, "   "]),
			);
			await call(c.routerUpdate, { notificationId: "n-1", ...spaces });

			const update = providerUpdate(c);
			for (const column of Object.keys(c.secrets)) {
				expect(update?.values ?? {}).not.toHaveProperty(column);
			}
		});

		it("a typed secret replaces the stored one", async () => {
			await call(c.routerUpdate, { notificationId: "n-1", ...c.typed });

			expect(providerUpdate(c)?.values).toMatchObject(c.typed);
		});

		it("replaces only the secret that was typed", async () => {
			const [first] = Object.keys(c.secrets);
			const only = { [first as string]: c.typed[first as string] };
			await call(c.routerUpdate, { notificationId: "n-1", ...only });

			expect(providerUpdate(c)?.values).toEqual(only);
		});
	});

	describe.skipIf(c.special)("Test Notification on the edit form", () => {
		const blank = Object.fromEntries(
			Object.keys(c.secrets).map((k) => [k, ""]),
		);
		const test = (input: Record<string, unknown>) =>
			call(c.routerTest, { ...c.testInput, ...input });

		it("a blank secret tests with the stored secret of the caller's notification", async () => {
			await expect(test({ ...blank, notificationId: "n-1" })).resolves.toBe(
				true,
			);

			for (const column of Object.keys(c.secrets)) {
				expect(wire()).toContain(c.row[column] as string);
			}
		});

		it("an omitted secret does the same", async () => {
			await expect(test({ notificationId: "n-1" })).resolves.toBe(true);

			for (const column of Object.keys(c.secrets)) {
				expect(wire()).toContain(c.row[column] as string);
			}
		});

		it("a typed secret is used as is and the stored one is not sent", async () => {
			await expect(test({ ...c.typed, notificationId: "n-1" })).resolves.toBe(
				true,
			);

			for (const column of Object.keys(c.secrets)) {
				expect(wire()).toContain(c.typed[column] as string);
				expect(wire()).not.toContain(c.row[column] as string);
			}
		});

		it("a typed secret works on create, without reading any stored notification", async () => {
			mocks.notification = null;

			await expect(test({ ...c.typed })).resolves.toBe(true);

			for (const column of Object.keys(c.secrets)) {
				expect(wire()).toContain(c.typed[column] as string);
			}
		});

		it("no secret and no notification is an error and sends nothing", async () => {
			await expect(test({ ...blank })).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("is required to test"),
			});
			expect(mocks.sent).toEqual([]);
		});

		it("will not borrow the secrets of another organization's notification", async () => {
			mocks.notification = storedNotification(c, { organizationId: "org-2" });

			await expect(
				test({ ...blank, notificationId: "n-1" }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.sent).toEqual([]);
		});

		it("a notification of another provider type has no secret to borrow", async () => {
			mocks.notification = storedNotification(c, {
				notificationType: "other",
				[c.rowKey]: null,
			});

			await expect(
				test({ ...blank, notificationId: "n-1" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.sent).toEqual([]);
		});

		it("an unknown notification id is refused", async () => {
			mocks.notification = null;

			await expect(
				test({ ...blank, notificationId: "nope" }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.sent).toEqual([]);
		});

		// Lark and Telegram swallow a sender failure, and Resend is not fetch.
		it.skipIf(["lark", "telegram", "resend"].includes(c.type))(
			"a failure that echoes the request does not hand the borrowed secret to the client",
			async () => {
				mocks.fetch.mockImplementationOnce(
					async (url: string, init: { body?: unknown }) => {
						throw new TypeError(
							`Failed to parse URL from ${url} ${JSON.stringify(init)}`,
						);
					},
				);

				const failure = await test({ ...blank, notificationId: "n-1" }).catch(
					(error: Error) => error,
				);

				expect(failure).toMatchObject({ code: "BAD_REQUEST" });
				for (const column of Object.keys(c.secrets)) {
					expect((failure as Error).message).not.toContain(
						c.row[column] as string,
					);
				}
			},
		);
	});
});

describe.each([
	["slack", "testSlackConnection", { channel: "#ops" }],
	["discord", "testDiscordConnection", { decoration: true }],
	["teams", "testTeamsConnection", {}],
])("%s: a stored webhook that cannot be parsed", (type, procedure, extra) => {
	const stored = "hooks.example.com/services/T000/B000/stored-secret-ab12";

	beforeEach(() => {
		const c = byType(type);
		mocks.notification = storedNotification(c, {
			[c.rowKey]: { ...c.row, webhookUrl: stored },
		});
		// What Node's fetch does with a URL that has no scheme.
		mocks.fetch.mockImplementation(async (url: string) => {
			throw new TypeError(`Failed to parse URL from ${url}`);
		});
	});

	it("a blank webhook on Test does not return the stored webhook in the error", async () => {
		const failure = await call(procedure, {
			...extra,
			webhookUrl: "",
			notificationId: "n-1",
		}).catch((error: Error) => error);

		expect(failure).toMatchObject({ code: "BAD_REQUEST" });
		expect((failure as Error).message).toContain("Failed to parse URL from");
		expect((failure as Error).message).not.toContain("stored-secret");
		expect((failure as Error).message).not.toContain(stored);
	});

	it("an omitted webhook does the same", async () => {
		const failure = await call(procedure, {
			...extra,
			notificationId: "n-1",
		}).catch((error: Error) => error);

		expect((failure as Error).message).not.toContain("stored-secret");
	});
});

describe("redactSecrets", () => {
	it("hides every occurrence of a secret", () => {
		expect(redactSecrets("a abcd b abcd c", ["abcd"])).toBe("a •••• b •••• c");
	});

	it("does not touch a secret shorter than four characters", () => {
		expect(redactSecrets("retry 1 of 1: 123", ["1", "abc", ""])).toBe(
			"retry 1 of 1: 123",
		);
		expect(redactSecrets("retry 1 of 1: 123", ["1234"])).toBe(
			"retry 1 of 1: 123",
		);
	});

	it("hides a secret of exactly four characters", () => {
		expect(redactSecrets("token=abcd", ["abcd"])).toBe("token=••••");
	});

	it("ignores values that are not strings", () => {
		expect(redactSecrets("null 42 undefined", [null, 42, undefined, {}])).toBe(
			"null 42 undefined",
		);
	});

	it("a short header value does not wipe the message of a failed Custom test", async () => {
		const c = byType("custom");
		mocks.notification = storedNotification(c, {
			custom: { ...c.row, headers: { "X-Retry": "1", "X-Env": "prod" } },
		});
		mocks.fetch.mockRejectedValueOnce(
			new Error("Failed after 1 retry: 1 of 1"),
		);

		const failure = await call("testCustomConnection", {
			endpoint: "",
			headers: { "X-Retry": "" },
			notificationId: "n-1",
		}).catch((error: Error) => error);

		expect((failure as Error).message).toBe("Failed after 1 retry: 1 of 1");
	});
});

describe("email: a password of only spaces is blank on Test too", () => {
	const c = byType("email");

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("borrows the stored password like Save keeps it", async () => {
		await expect(
			call("testEmailConnection", {
				...c.testInput,
				password: "   ",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(c.row.password as string);
	});

	it("a typed password is sent as typed, edge spaces included", async () => {
		await call("testEmailConnection", {
			...c.testInput,
			password: " pass word ",
			notificationId: "n-1",
		});

		expect(wire()).toContain(" pass word ");
		expect(wire()).not.toContain(c.row.password as string);
	});

	it("spaces are not sent to the server as the password", async () => {
		mocks.notification = storedNotification(c, {
			email: { ...c.row, password: "" },
		});

		await call("testEmailConnection", {
			...c.testInput,
			password: "   ",
			notificationId: "n-1",
		});

		expect(wire()).not.toContain('"pass":"   "');
	});
});

describe("webhook URLs keep scheme and host but never the path", () => {
	it("masks userinfo, path and query", async () => {
		const c = byType("teams");
		mocks.notification = storedNotification(c, {
			teams: {
				teamsId: "teams-1",
				webhookUrl:
					"https://user:pw@example.webhook.office.com/webhookb2/a/b?sig=topsecret-1234",
			},
		});

		const result = await call("one", { notificationId: "n-1" });

		expect(result.teams.webhookUrlMasked).toBe(
			"https://example.webhook.office.com/…1234",
		);
		expect(JSON.stringify(result)).not.toContain("topsecret");
		expect(JSON.stringify(result)).not.toContain("user:pw");
	});

	it("masks a value that is not a URL", async () => {
		const c = byType("slack");
		mocks.notification = storedNotification(c, {
			slack: {
				slackId: "slack-1",
				webhookUrl: "not-a-url-at-all",
				channel: "",
			},
		});

		const result = await call("one", { notificationId: "n-1" });

		expect(result.slack.webhookUrlMasked).toBe("••••-all");
	});
});

describe("webhook providers replace the URL only when a new one is typed", () => {
	it.each(["slack", "discord", "teams", "lark", "mattermost"])(
		"%s: a changed channel setting with a blank URL keeps the webhook",
		async (type) => {
			const c = byType(type);
			mocks.notification = storedNotification(c);

			await c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				webhookUrl: "",
				...(c.plain[0] === "unused" ? {} : { [c.plain[0]]: c.plain[1] }),
			});

			expect(providerUpdate(c)?.values ?? {}).not.toHaveProperty("webhookUrl");
		},
	);

	it("mattermost: the typed URL must be a URL", async () => {
		const c = byType("mattermost");
		mocks.notification = storedNotification(c);

		await expect(
			call("updateMattermost", { notificationId: "n-1", webhookUrl: "nope" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			call("updateMattermost", { notificationId: "n-1", webhookUrl: "" }),
		).resolves.toBeUndefined();
	});
});

describe("gotify: the app token is never replayed against another server", () => {
	const c = byType("gotify");
	const message = "Enter the app token again to change the Gotify URL.";

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("update: a changed server URL without a token is rejected and nothing is written", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				serverUrl: "https://attacker.example",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a blank token is the same as none", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				serverUrl: "https://attacker.example",
				appToken: "",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed server URL with a typed token is accepted", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://elsewhere.example",
			appToken: "typed-token",
		});

		expect(providerUpdate(c)?.values).toEqual({
			serverUrl: "https://elsewhere.example",
			appToken: "typed-token",
		});
	});

	it("update: the same URL (case, slash, userinfo, query) keeps the token without asking", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://user:pw@GOTIFY.example.com//?x=1",
		});

		expect(providerUpdate(c)?.values ?? {}).not.toHaveProperty("appToken");
	});

	it("update: another port or path is another server", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				serverUrl: "https://gotify.example.com:8443",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				serverUrl: "https://gotify.example.com/proxy",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("update through the router keeps the specific message", async () => {
		await expect(
			call("updateGotify", {
				notificationId: "n-1",
				serverUrl: "https://attacker.example",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
	});

	it("test: the stored token is not sent to a different server", async () => {
		await expect(
			call("testGotifyConnection", {
				serverUrl: "https://attacker.example",
				priority: 5,
				appToken: "",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.sent).toEqual([]);
	});

	it("test: a typed token may go to a different server", async () => {
		await expect(
			call("testGotifyConnection", {
				serverUrl: "https://elsewhere.example",
				priority: 5,
				appToken: "typed-token",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain("https://elsewhere.example/message");
		expect(wire()).toContain("typed-token");
		expect(wire()).not.toContain(c.row.appToken as string);
	});

	it("test: the stored token goes to the stored server", async () => {
		await call("testGotifyConnection", {
			serverUrl: "https://GOTIFY.example.com/",
			priority: 5,
			appToken: "",
			notificationId: "n-1",
		});

		expect(wire()).toContain(c.row.appToken as string);
	});
});

describe("ntfy: the access token is optional and never replayed against another server", () => {
	const c = byType("ntfy");
	const message = "Enter the access token again to change the ntfy URL.";

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("update: a blank or omitted token keeps the stored one", async () => {
		await call("updateNtfy", { notificationId: "n-1", accessToken: "" });
		await call("updateNtfy", { notificationId: "n-1", topic: "alerts" });

		for (const update of mocks.updates.filter((u) => u.table === "ntfy")) {
			expect(update.values).not.toHaveProperty("accessToken");
		}
	});

	it("update: a typed token replaces the stored one", async () => {
		await call("updateNtfy", {
			notificationId: "n-1",
			accessToken: "ntfy-typed-wxyz",
		});

		expect(providerUpdate(c)?.values).toEqual({
			accessToken: "ntfy-typed-wxyz",
		});
	});

	it("test: a blank token tests with the stored one of the caller's notification", async () => {
		await expect(
			call("testNtfyConnection", {
				...c.testInput,
				accessToken: "",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(c.row.accessToken as string);
	});

	it("test: a typed token is used as is", async () => {
		await call("testNtfyConnection", {
			...c.testInput,
			accessToken: "ntfy-typed-wxyz",
			notificationId: "n-1",
		});

		expect(wire()).toContain("ntfy-typed-wxyz");
		expect(wire()).not.toContain(c.row.accessToken as string);
	});

	it("test: will not borrow the token of another organization's notification", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("testNtfyConnection", {
				...c.testInput,
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.sent).toEqual([]);
	});

	it("test: a notification of another provider type has no token to borrow", async () => {
		mocks.notification = storedNotification(c, {
			notificationType: "other",
			ntfy: null,
		});

		await call("testNtfyConnection", {
			...c.testInput,
			notificationId: "n-1",
		});

		expect(wire()).not.toContain(c.row.accessToken as string);
	});

	it("update: a changed server URL without a token is rejected", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				serverUrl: "https://attacker.example",
				topic: "typed-topic",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed server URL with a typed token is accepted", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
			accessToken: "typed-token",
		});

		expect(providerUpdate(c)?.values).toEqual({
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
			accessToken: "typed-token",
		});
	});

	it("update: removing the stored token lets the server URL change", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
			clearAccessToken: true,
		});

		expect(providerUpdate(c)?.values).toEqual({
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
			accessToken: null,
		});
	});

	it("update: a typed token wins over the remove flag", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			accessToken: "typed-token",
			clearAccessToken: true,
		});

		expect(providerUpdate(c)?.values).toEqual({ accessToken: "typed-token" });
	});

	it("update: a topic without a token keeps the token", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			topic: "alerts",
			accessToken: "",
		});

		expect(providerUpdate(c)?.values).toEqual({ topic: "alerts" });
	});

	it("update: a public topic (no stored token) may move to another server", async () => {
		mocks.notification = storedNotification(c, {
			ntfy: { ...c.row, accessToken: null },
		});

		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
		});

		expect(providerUpdate(c)?.values).toEqual({
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
		});
	});

	it("test: the stored token is not sent to a different server", async () => {
		await expect(
			call("testNtfyConnection", {
				...c.testInput,
				serverUrl: "https://attacker.example",
				accessToken: "",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.sent).toEqual([]);
	});

	it("test: a public topic sends no token", async () => {
		mocks.notification = storedNotification(c, {
			ntfy: { ...c.row, accessToken: null },
		});

		await expect(
			call("testNtfyConnection", {
				...c.testInput,
				serverUrl: "https://elsewhere.example",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);
		expect(wire()).not.toContain("Bearer");
	});
});

describe("email: the SMTP password is never replayed against another server", () => {
	const c = byType("email");
	const message =
		"Enter the SMTP password again to change the SMTP server or port.";

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("update: a blank or omitted password keeps the stored one", async () => {
		await call("updateEmail", { notificationId: "n-1", password: "" });
		await call("updateEmail", {
			notificationId: "n-1",
			fromAddress: "other@example.com",
		});

		for (const update of mocks.updates.filter((u) => u.table === "email")) {
			expect(update.values).not.toHaveProperty("password");
		}
	});

	it("update: a typed password replaces the stored one, untrimmed", async () => {
		await call("updateEmail", { notificationId: "n-1", password: " pw " });

		expect(providerUpdate(c)?.values).toEqual({ password: " pw " });
	});

	it("test: will not borrow the password of another organization's notification", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("testEmailConnection", {
				...c.testInput,
				password: "",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.sent).toEqual([]);
	});

	it("test: a blank password with no stored password sends without authentication", async () => {
		mocks.notification = storedNotification(c, {
			email: { ...c.row, password: "" },
		});

		await expect(
			call("testEmailConnection", {
				...c.testInput,
				password: "",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);
		expect(wire()).not.toContain('"auth"');
	});

	it("update: a changed SMTP server without a password is rejected and nothing is written", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				smtpServer: "smtp.attacker.example",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed port is a changed server", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				smtpPort: 2525,
				password: "",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
	});

	it("update: a changed server with a typed password is accepted", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			smtpServer: "smtp.elsewhere.example",
			password: "typed-password",
		});

		expect(providerUpdate(c)?.values).toEqual({
			smtpServer: "smtp.elsewhere.example",
			password: "typed-password",
		});
	});

	it("update: the same server (any case) keeps the password", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			smtpServer: "SMTP.Example.com",
			smtpPort: 587,
			password: "",
		});

		expect(providerUpdate(c)?.values ?? {}).not.toHaveProperty("password");
	});

	it("update: a blank username removes the authentication and the password with it", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			smtpServer: "relay.elsewhere.example",
			username: "",
			password: "",
		});

		expect(providerUpdate(c)?.values).toEqual({
			smtpServer: "relay.elsewhere.example",
			username: "",
			password: "",
		});
	});

	it("update: a stored password with no username may move (it is never used)", async () => {
		mocks.notification = storedNotification(c, {
			email: { ...c.row, username: "" },
		});

		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			smtpServer: "relay.elsewhere.example",
		});

		expect(providerUpdate(c)?.values).toEqual({
			smtpServer: "relay.elsewhere.example",
		});
	});

	it("test: the stored password is not sent to a different server", async () => {
		await expect(
			call("testEmailConnection", {
				...c.testInput,
				smtpServer: "smtp.attacker.example",
				password: "",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.sent).toEqual([]);
	});

	it("test: the stored password goes to the stored server", async () => {
		await expect(
			call("testEmailConnection", {
				...c.testInput,
				smtpServer: "SMTP.example.com",
				password: "",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(c.row.password as string);
	});

	it("test: no username means no authentication, so no stored password is borrowed", async () => {
		await call("testEmailConnection", {
			...c.testInput,
			username: "",
			password: "",
			notificationId: "n-1",
		});

		expect(wire()).not.toContain(c.row.password as string);
	});

	it("test: a typed password to another server is allowed", async () => {
		await call("testEmailConnection", {
			...c.testInput,
			smtpServer: "smtp.elsewhere.example",
			password: "typed-password",
			notificationId: "n-1",
		});

		expect(wire()).toContain("typed-password");
		expect(wire()).not.toContain(c.row.password as string);
	});
});

describe("custom: header values are write-only and never replayed against another endpoint", () => {
	const c = byType("custom");
	const message =
		"Enter the header values again to change the Custom webhook URL.";
	const stored = c.row.headers as Record<string, string>;

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("notification.one masks every header value and keeps the names", async () => {
		const result = await call("one", { notificationId: "n-1" });

		expect(result.custom).not.toHaveProperty("headers");
		expect(result.custom.headersMasked).toEqual({
			Authorization: "••••yz56",
			"X-Env": "••••",
		});
		expect(result.custom).not.toHaveProperty("endpoint");
		expect(result.custom.endpointMasked).toBe(
			"https://hooks.example.com/…gh34",
		);
		expect(JSON.stringify(result)).not.toContain("custom-secret-header");
		expect(JSON.stringify(result)).not.toContain("custom-secret-endpoint");
	});

	it("notification.all masks them too", async () => {
		const result = await call("all", undefined);

		expect(JSON.stringify(result)).not.toContain("custom-secret-header");
		expect(result[0].custom.headersMasked).toHaveProperty("Authorization");
	});

	it("update: omitted headers keep every stored header", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			name: "Renamed",
		});

		expect(mocks.updates.map((u) => u.table)).toEqual(["notification"]);
	});

	it("update: a blank value keeps the stored value of that header", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			headers: { Authorization: "", "X-Env": "staging" },
		});

		expect(providerUpdate(c)?.values).toEqual({
			headers: { Authorization: stored.Authorization, "X-Env": "staging" },
		});
	});

	it("update: a typed value replaces it", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			headers: { Authorization: "Bearer typed", "X-Env": "" },
		});

		expect(providerUpdate(c)?.values).toEqual({
			headers: { Authorization: "Bearer typed", "X-Env": "prod" },
		});
	});

	it("update: a header left out of the map is removed, an empty map removes all", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			headers: { "X-Env": "" },
		});
		expect(providerUpdate(c)?.values).toEqual({ headers: { "X-Env": "prod" } });

		mocks.updates = [];
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			headers: {},
		});
		expect(providerUpdate(c)?.values).toEqual({ headers: {} });
	});

	it("update: a new header with a blank value is stored blank", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			headers: { "X-New": "" },
		});

		expect(providerUpdate(c)?.values).toEqual({ headers: { "X-New": "" } });
	});

	it("update: a changed endpoint with blank stored values is rejected and nothing is written", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				endpoint: "https://attacker.example/hook",
				headers: { Authorization: "" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed endpoint with omitted headers would also replay them, so it is rejected", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				endpoint: "https://attacker.example/hook",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed endpoint with every value typed again is accepted", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "https://elsewhere.example/hook",
			headers: { Authorization: "Bearer typed", "X-Env": "prod" },
		});

		expect(providerUpdate(c)?.values).toEqual({
			endpoint: "https://elsewhere.example/hook",
			headers: { Authorization: "Bearer typed", "X-Env": "prod" },
		});
	});

	it("update: a changed endpoint is fine once no stored header is left to replay", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "https://elsewhere.example/hook",
			headers: {},
		});

		expect(providerUpdate(c)?.values).toEqual({
			endpoint: "https://elsewhere.example/hook",
			headers: {},
		});
	});

	it("update: the same endpoint (case, slash, query) keeps the stored values", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "https://HOOKS.example.com/ingest/?x=1",
			headers: { Authorization: "" },
		});

		expect(providerUpdate(c)?.values).toMatchObject({
			headers: { Authorization: stored.Authorization },
		});
	});

	it("update: a header named __proto__ is data, not a prototype", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			headers: JSON.parse('{"__proto__": "x", "A": "1"}'),
		});

		const headers = providerUpdate(c)?.values.headers as Record<string, string>;
		expect(Object.keys(headers).sort()).toEqual(["A", "__proto__"]);
		expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
	});

	it("test: blank values are the stored ones", async () => {
		await expect(
			call("testCustomConnection", {
				endpoint: "https://hooks.example.com/ingest",
				headers: { Authorization: "", "X-Env": "" },
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(stored.Authorization as string);
	});

	it("test: the stored values are not sent to a different endpoint", async () => {
		await expect(
			call("testCustomConnection", {
				endpoint: "https://attacker.example/hook",
				headers: { Authorization: "" },
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.sent).toEqual([]);
	});

	it("test: typed values go anywhere", async () => {
		await call("testCustomConnection", {
			endpoint: "https://attacker.example/hook",
			headers: { Authorization: "Bearer typed" },
			notificationId: "n-1",
		});

		expect(wire()).toContain("Bearer typed");
		expect(wire()).not.toContain(stored.Authorization as string);
	});

	it("test: without a notification id blank values stay blank", async () => {
		mocks.notification = null;

		await call("testCustomConnection", {
			endpoint: "https://hooks.example.com/ingest",
			headers: { Authorization: "" },
		});

		expect(wire()).not.toContain(stored.Authorization as string);
	});

	it("test: will not borrow another organization's headers", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("testCustomConnection", {
				endpoint: "https://hooks.example.com/ingest",
				headers: { Authorization: "" },
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.sent).toEqual([]);
	});
});

describe("pushover: both keys are independent write-only secrets", () => {
	const c = byType("pushover");

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("update: typing one key leaves the other stored", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			userKey: "",
			apiToken: "pushover-typed-api-5678",
		});

		expect(providerUpdate(c)?.values).toEqual({
			apiToken: "pushover-typed-api-5678",
		});
	});

	it("test: a typed user key with the stored API token", async () => {
		await call("testPushoverConnection", {
			priority: 0,
			userKey: "pushover-typed-user-1234",
			apiToken: "",
			notificationId: "n-1",
		});

		expect(wire()).toContain("pushover-typed-user-1234");
		expect(wire()).toContain(c.row.apiToken as string);
		expect(wire()).not.toContain(c.row.userKey as string);
	});
});

describe("sending still uses the stored secrets", () => {
	it.each([
		"slack",
		"discord",
		"teams",
		"lark",
		"mattermost",
		"gotify",
		"ntfy",
		"pushover",
		"telegram",
		"custom",
	])(
		"%s: the sender reads the secret from the stored row, not from the masked view",
		async (type) => {
			const c = byType(type);
			const row = storedNotification(c, { appDeploy: true });
			mocks.findManyResult = [row];

			// The view the UI gets must not be what the senders are fed.
			mocks.notification = row;
			const view = await call("one", { notificationId: "n-1" });
			expect(view[c.rowKey]).not.toEqual(row[c.rowKey as keyof typeof row]);

			await sendBuildSuccessNotifications({
				projectName: "Devino",
				applicationName: "web",
				applicationType: "application",
				buildLink: "https://dokploy.test/d",
				organizationId: "org-1",
				domains: [],
				environmentName: "production",
			});

			const secrets =
				type === "custom"
					? [
							(c.row.headers as Record<string, string>).Authorization as string,
							c.row.endpoint as string,
						]
					: Object.keys(c.secrets).map((column) => c.row[column] as string);
			expect(secrets.length).toBeGreaterThan(0);
			for (const secret of secrets) expect(wire()).toContain(secret);
		},
	);

	it("email and resend: the stored password and key reach the transport", async () => {
		const email = byType("email");
		const resend = byType("resend");

		await sendEmailNotification(email.row as never, "s", "<p>h</p>");
		await sendResendNotification(resend.row as never, "s", "<p>h</p>");

		expect(wire()).toContain(email.row.password as string);
		expect(wire()).toContain(resend.row.apiKey as string);
	});
});

describe("maskHeaderValues", () => {
	it("masks string values and hides a value that is not a string instead of throwing", () => {
		const headers = {
			Authorization: "Bearer secret-token-ab12",
			"X-Null": null,
			"X-Number": 42,
			"X-Object": { nested: "secret" },
			"X-Short": "ab",
		} as unknown as Record<string, string>;

		expect(maskHeaderValues(headers)).toEqual({
			Authorization: "••••ab12",
			"X-Null": "••••",
			"X-Number": "••••",
			"X-Object": "••••",
			"X-Short": "••••",
		});
	});

	it("handles a missing header map", () => {
		expect(maskHeaderValues(null)).toEqual({});
	});

	it("notification.one survives a stored null header value", async () => {
		const c = byType("custom");
		mocks.notification = storedNotification(c, {
			custom: { ...c.row, headers: { Authorization: null, "X-Env": "prod" } },
		});

		const result = await call("one", { notificationId: "n-1" });

		expect(result.custom.headersMasked).toEqual({
			Authorization: "••••",
			"X-Env": "••••",
		});
	});
});

describe("email: a password of only spaces is blank", () => {
	const c = byType("email");

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("keeps the stored password", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			fromAddress: "other@example.com",
			password: "   ",
		});

		expect(providerUpdate(c)?.values).toEqual({
			fromAddress: "other@example.com",
		});
	});

	it("does not count as the password typed again for a changed SMTP server", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				smtpServer: "smtp.attacker.example",
				password: "   ",
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message:
				"Enter the SMTP password again to change the SMTP server or port.",
		});
		expect(mocks.updates).toEqual([]);
	});

	it("a typed password is stored as typed, edge spaces included", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			password: " pass word ",
		});

		expect(providerUpdate(c)?.values).toEqual({ password: " pass word " });
	});
});

describe("ntfy: the topic is a write-only secret", () => {
	const c = byType("ntfy");
	const storedTopic = c.row.topic as string;
	const message = "Enter the topic again to change the ntfy server URL.";
	// A test that names no topic of its own.
	const { topic: _topic, ...testWithoutTopic } = c.testInput;

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("notification.one and .all show the masked topic and never the topic", async () => {
		const one = await call("one", { notificationId: "n-1" });
		const all = await call("all", undefined);

		expect(one.ntfy).not.toHaveProperty("topic");
		expect(one.ntfy.topicMasked).toBe("••••ab12");
		expect(all[0].ntfy.topicMasked).toBe("••••ab12");
		expect(JSON.stringify([one, all])).not.toContain("ntfy-secret-topic");
	});

	it("masks nothing for a row without a topic", async () => {
		mocks.notification = storedNotification(c, {
			ntfy: { ...c.row, topic: "" },
		});

		const one = await call("one", { notificationId: "n-1" });

		expect(one.ntfy.topicMasked).toBeNull();
	});

	it("update: a blank, whitespace or omitted topic keeps the stored one", async () => {
		await call("updateNtfy", { notificationId: "n-1", topic: "" });
		await call("updateNtfy", { notificationId: "n-1", topic: "   " });
		await call("updateNtfy", { notificationId: "n-1", priority: 4 });

		for (const update of mocks.updates.filter((u) => u.table === "ntfy")) {
			expect(update.values).not.toHaveProperty("topic");
		}
	});

	it("update: a typed topic replaces it", async () => {
		await call("updateNtfy", { notificationId: "n-1", topic: " new-topic " });

		expect(providerUpdate(c)?.values).toEqual({ topic: "new-topic" });
	});

	it("update: a changed server URL needs the topic typed again, and writes nothing", async () => {
		await expect(
			c.update({
				notificationId: "n-1",
				organizationId: "org-1",
				serverUrl: "https://attacker.example",
				topic: "",
				accessToken: "typed-token",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: a changed server URL with the topic typed again is accepted", async () => {
		mocks.notification = storedNotification(c, {
			ntfy: { ...c.row, accessToken: null },
		});

		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
		});

		expect(providerUpdate(c)?.values).toEqual({
			serverUrl: "https://elsewhere.example",
			topic: "typed-topic",
		});
	});

	it("update: the same server URL (case, slash) keeps the topic", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			serverUrl: "https://NTFY.example.com/",
			topic: "",
		});

		expect(providerUpdate(c)?.values).toEqual({
			serverUrl: "https://NTFY.example.com/",
		});
	});

	it("update: another organization's notification is refused", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("updateNtfy", { notificationId: "n-1", topic: "hijack" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updates).toEqual([]);
	});

	it("test: a blank topic tests with the stored one of the caller's notification", async () => {
		await expect(
			call("testNtfyConnection", {
				...testWithoutTopic,
				topic: "",
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(`https://ntfy.example.com/${storedTopic}`);
	});

	it("test: a typed topic is used as is", async () => {
		await call("testNtfyConnection", {
			...testWithoutTopic,
			topic: "typed-topic",
			notificationId: "n-1",
		});

		expect(wire()).toContain("https://ntfy.example.com/typed-topic");
		expect(wire()).not.toContain(storedTopic);
	});

	it("test: a blank topic without a notification has nothing to borrow", async () => {
		await expect(
			call("testNtfyConnection", { ...testWithoutTopic, topic: "" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.sent).toEqual([]);
	});

	it("test: the stored topic is not sent to a different server", async () => {
		await expect(
			call("testNtfyConnection", {
				...testWithoutTopic,
				serverUrl: "https://attacker.example",
				topic: "",
				accessToken: "typed-token",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.sent).toEqual([]);
	});

	it("test: will not borrow the topic of another organization's notification", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("testNtfyConnection", {
				...testWithoutTopic,
				topic: "",
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.sent).toEqual([]);
	});

	it("test: removing the token still borrows the topic but not the token", async () => {
		await expect(
			call("testNtfyConnection", {
				...testWithoutTopic,
				topic: "",
				clearAccessToken: true,
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(storedTopic);
		expect(wire()).not.toContain("Bearer");
	});

	it("test: a failure that echoes the stored topic and token does not hand them to the client", async () => {
		mocks.fetch.mockRejectedValueOnce(
			new Error(
				`Failed to parse URL from https://ntfy.example.com/${storedTopic} (${c.row.accessToken})`,
			),
		);

		const failure = await call("testNtfyConnection", {
			...testWithoutTopic,
			topic: "",
			notificationId: "n-1",
		}).catch((error: Error) => error);

		expect(failure).toMatchObject({ code: "BAD_REQUEST" });
		expect((failure as Error).message).not.toContain(storedTopic);
		expect((failure as Error).message).not.toContain(
			c.row.accessToken as string,
		);
		expect((failure as Error).message).toContain("Failed to parse URL");
	});
});

describe("custom: the endpoint is a write-only secret", () => {
	const c = byType("custom");
	const storedEndpoint = c.row.endpoint as string;
	const stored = c.row.headers as Record<string, string>;
	const message =
		"Enter the header values again to change the Custom webhook URL.";

	beforeEach(() => {
		mocks.notification = storedNotification(c);
	});

	it("notification.one and .all show the masked endpoint and never the endpoint", async () => {
		const one = await call("one", { notificationId: "n-1" });
		const all = await call("all", undefined);

		expect(one.custom).not.toHaveProperty("endpoint");
		expect(one.custom.endpointMasked).toBe("https://hooks.example.com/…gh34");
		expect(all[0].custom.endpointMasked).toBe(
			"https://hooks.example.com/…gh34",
		);
		expect(JSON.stringify([one, all])).not.toContain("custom-secret-endpoint");
		expect(JSON.stringify([one, all])).not.toContain("token=");
	});

	it("update: a blank, whitespace or omitted endpoint keeps the stored one", async () => {
		await c.update({ notificationId: "n-1", organizationId: "org-1" });
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "",
		});
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "   ",
			headers: { "X-Env": "staging" },
		});

		for (const update of mocks.updates.filter((u) => u.table === "custom")) {
			expect(update.values).not.toHaveProperty("endpoint");
		}
	});

	it("update: a blank endpoint does not make the stored header values re-typed", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "",
			headers: { Authorization: "" },
		});

		expect(providerUpdate(c)?.values).toEqual({
			headers: { Authorization: stored.Authorization },
		});
	});

	it("update: a typed endpoint on the same host and path replaces it and keeps the header values", async () => {
		await c.update({
			notificationId: "n-1",
			organizationId: "org-1",
			endpoint: "https://hooks.example.com/ingest?token=rotated-cd56",
			headers: { Authorization: "" },
		});

		expect(providerUpdate(c)?.values).toEqual({
			endpoint: "https://hooks.example.com/ingest?token=rotated-cd56",
			headers: { Authorization: stored.Authorization },
		});
	});

	it("update: a typed endpoint elsewhere needs the header values typed again", async () => {
		await expect(
			call("updateCustom", {
				notificationId: "n-1",
				endpoint: "https://attacker.example/hook",
				headers: { Authorization: "" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.updates).toEqual([]);
	});

	it("update: another organization's notification is refused", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("updateCustom", {
				notificationId: "n-1",
				endpoint: "https://attacker.example/hook",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.updates).toEqual([]);
	});

	it("test: a blank endpoint tests with the stored one and its stored header values", async () => {
		await expect(
			call("testCustomConnection", {
				endpoint: "",
				headers: { Authorization: "", "X-Env": "" },
				notificationId: "n-1",
			}),
		).resolves.toBe(true);

		expect(wire()).toContain(storedEndpoint);
		expect(wire()).toContain(stored.Authorization as string);
	});

	it("test: a blank endpoint with no headers sent still borrows the stored endpoint", async () => {
		await call("testCustomConnection", { notificationId: "n-1" });

		expect(wire()).toContain(storedEndpoint);
		expect(wire()).not.toContain(stored.Authorization as string);
	});

	it("test: a blank endpoint without a notification has nothing to borrow", async () => {
		await expect(
			call("testCustomConnection", { endpoint: "" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.sent).toEqual([]);
	});

	it("test: a typed endpoint elsewhere does not get the stored header values", async () => {
		await expect(
			call("testCustomConnection", {
				endpoint: "https://attacker.example/hook",
				headers: { Authorization: "" },
				notificationId: "n-1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST", message });
		expect(mocks.sent).toEqual([]);
	});

	it("test: will not borrow the endpoint of another organization's notification", async () => {
		mocks.notification = storedNotification(c, { organizationId: "org-2" });

		await expect(
			call("testCustomConnection", { endpoint: "", notificationId: "n-1" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.sent).toEqual([]);
	});

	it("test: a failure that echoes the stored endpoint and header values does not hand them to the client", async () => {
		mocks.fetch.mockRejectedValueOnce(
			new Error(
				`Failed to parse URL from ${storedEndpoint} with ${stored.Authorization}`,
			),
		);

		const failure = await call("testCustomConnection", {
			endpoint: "",
			headers: { Authorization: "" },
			notificationId: "n-1",
		}).catch((error: Error) => error);

		expect(failure).toMatchObject({ code: "BAD_REQUEST" });
		expect((failure as Error).message).not.toContain("custom-secret");
		expect((failure as Error).message).toContain("Failed to parse URL");
	});
});

describe("create: a failure logs the error name, never the error", () => {
	it("keeps the bound provider secret out of the log and the client message", async () => {
		const { db } = await import("@dokploy/server/db");
		const secret = "https://hooks.slack.com/services/T0/B0/leaked-secret-ab12";
		vi.mocked(db.transaction).mockRejectedValueOnce(
			Object.assign(
				new Error(
					`insert into "slack" ("webhookUrl") values ($1) -- params: ${secret}`,
				),
				{ name: "DrizzleQueryError" },
			),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const failure = await call("createSlack", {
			name: "Slack",
			webhookUrl: secret,
			channel: "#ops",
			appBuildError: true,
			databaseBackup: true,
			dokployBackup: true,
			volumeBackup: true,
			dokployRestart: true,
			appDeploy: true,
			dockerCleanup: true,
			scheduleFailure: true,
			serverThreshold: true,
		}).catch((e: Error) => e);

		const logged = JSON.stringify([log.mock.calls, error.mock.calls]);
		log.mockRestore();
		error.mockRestore();

		expect(failure).toMatchObject({
			code: "BAD_REQUEST",
			message: "Error creating the notification",
		});
		expect(logged).not.toContain("leaked-secret");
		expect(logged).toContain("DrizzleQueryError");
	});
});
