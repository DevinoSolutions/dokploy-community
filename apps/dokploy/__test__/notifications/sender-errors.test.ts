import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A transport error can carry the request it failed on ("Failed to parse URL
 * from <webhook>"), so the senders log only its name, a machine code and the
 * host of the target. The error the caller gets is unchanged (the Test button
 * redacts it), and the Lark and Telegram senders throw instead of swallowing a
 * failure, like the other senders.
 */

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	fetch: vi.fn(),
	sendMail: vi.fn(),
}));

vi.mock("nodemailer", () => ({
	default: { createTransport: () => ({ sendMail: mocks.sendMail }) },
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: new Proxy({} as Record<string, unknown>, {
			get: () => ({
				findMany: vi.fn(async () => mocks.rows),
				findFirst: vi.fn(async () => undefined),
			}),
		}),
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

const { describeSenderError, logSenderError } = await import(
	"@dokploy/server/utils/notifications/log-error"
);
const senders = await import("@dokploy/server/utils/notifications/utils");
const { sendBuildSuccessNotifications } = await import(
	"@dokploy/server/utils/notifications/build-success"
);

const WEBHOOK_SECRET = "T000/B000/webhook-secret-ab12";
const TOKEN_SECRET = "123456:telegram-secret-kl12";

const spies = () => ({
	log: vi.spyOn(console, "log").mockImplementation(() => {}),
	error: vi.spyOn(console, "error").mockImplementation(() => {}),
	warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
	info: vi.spyOn(console, "info").mockImplementation(() => {}),
});

const logged = (s: ReturnType<typeof spies>) =>
	JSON.stringify(
		[s.log, s.error, s.warn, s.info].map((spy) =>
			spy.mock.calls.map((call) =>
				call.map((arg) =>
					arg instanceof Error ? `${arg.name}: ${arg.message}` : arg,
				),
			),
		),
	);

const failWith = (message: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new TypeError(message), extra);

const response = (
	status: number,
	statusText: string,
	body: unknown = "",
): Response =>
	({
		ok: status >= 200 && status < 300,
		status,
		statusText,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	}) as unknown as Response;

let console_: ReturnType<typeof spies>;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows = [];
	mocks.fetch.mockReset();
	vi.stubGlobal("fetch", mocks.fetch);
	console_ = spies();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("describeSenderError", () => {
	it("names the error and the host, nothing else", () => {
		expect(
			describeSenderError(
				failWith(`Failed to parse URL from https://x.test/${WEBHOOK_SECRET}`),
				`https://user:pass@hooks.slack.com:8443/services/${WEBHOOK_SECRET}?token=abc#frag`,
			),
		).toBe("TypeError to hooks.slack.com:8443");
	});

	it("adds a machine code from the error or its cause", () => {
		expect(
			describeSenderError(failWith("fetch failed", { code: "ECONNRESET" })),
		).toBe("TypeError ECONNRESET");
		expect(
			describeSenderError(
				failWith("fetch failed", { cause: { code: "ENOTFOUND" } }),
				"https://hooks.slack.com/x",
			),
		).toBe("TypeError ENOTFOUND to hooks.slack.com");
	});

	it("ignores a code that is not a machine code", () => {
		expect(
			describeSenderError(failWith("x", { code: `bad ${WEBHOOK_SECRET}` })),
		).toBe("TypeError");
	});

	it("logs no host for a target that is not a URL", () => {
		expect(
			describeSenderError(failWith("x"), `hooks.slack.com/${WEBHOOK_SECRET}`),
		).toBe("TypeError");
	});

	it("handles something that is not an Error", () => {
		expect(describeSenderError("a string with a secret", undefined)).toBe(
			"string",
		);
		expect(describeSenderError(undefined)).toBe("undefined");
	});

	it("logSenderError prints one line without the message", () => {
		logSenderError(
			"slack",
			failWith(`Failed to parse URL from ${WEBHOOK_SECRET}`),
			"https://hooks.slack.com/x",
		);

		expect(console_.error).toHaveBeenCalledTimes(1);
		expect(console_.error).toHaveBeenCalledWith(
			"[notifications] slack failed: TypeError to hooks.slack.com",
		);
	});
});

describe("senders log no secret and rethrow the same error", () => {
	const webhook = `https://hooks.example.com/services/${WEBHOOK_SECRET}`;
	const cases: [string, () => Promise<unknown>, string][] = [
		[
			"slack",
			() => senders.sendSlackNotification({ webhookUrl: webhook } as never, {}),
			"Failed to send slack notification",
		],
		[
			"discord",
			() =>
				senders.sendDiscordNotification({ webhookUrl: webhook } as never, {}),
			"Failed to send discord notification",
		],
		[
			"teams",
			() =>
				senders.sendTeamsNotification({ webhookUrl: webhook } as never, {
					title: "t",
				}),
			"Failed to send Teams notification",
		],
		[
			"lark",
			() => senders.sendLarkNotification({ webhookUrl: webhook } as never, {}),
			"Failed to send Lark notification",
		],
		[
			"custom",
			() =>
				senders.sendCustomNotification(
					{
						endpoint: webhook,
						headers: { Authorization: "Bearer hdr-ab12" },
					} as never,
					{},
				),
			"Failed to parse URL",
		],
		[
			"sendly",
			() =>
				senders.sendSendlyNotification(
					{
						apiKey: "sendly-key-ab12",
						baseUrl: webhook,
						fromAddress: "a@b.co",
						toAddresses: ["c@d.co"],
					} as never,
					"s",
					"<p>h</p>",
				),
			"Failed to send Sendly notification",
		],
		[
			"notifly",
			() =>
				senders.sendNotiflyNotification(
					{ apiKey: "notifly-key-ab12", baseUrl: webhook } as never,
					{},
				),
			"Could not reach Notifly",
		],
	];

	it.each(cases)("%s", async (_name, run, thrownPrefix) => {
		mocks.fetch.mockRejectedValue(
			failWith(`Failed to parse URL from ${webhook}`, {
				cause: { code: "ERR_INVALID_URL" },
			}),
		);

		const failure = await run().catch((error: Error) => error);

		// The caller still gets the message (the Test button redacts it).
		expect((failure as Error).message).toContain(thrownPrefix);
		expect((failure as Error).message).toContain(WEBHOOK_SECRET);
		// The log has the name, the code and the host only.
		const output = logged(console_);
		expect(output).not.toContain(WEBHOOK_SECRET);
		expect(output).not.toContain("services/");
		expect(output).not.toContain("Failed to parse URL");
		expect(output).not.toContain("hdr-ab12");
		expect(output).toContain("TypeError");
		expect(output).toContain("hooks.example.com");
	});

	it("telegram never logs the bot token that is in the request URL", async () => {
		mocks.fetch.mockRejectedValue(
			failWith(
				`Failed to parse URL from https://api.telegram.org/bot${TOKEN_SECRET}/sendMessage`,
			),
		);

		await senders
			.sendTelegramNotification(
				{ botToken: TOKEN_SECRET, chatId: "1" } as never,
				"hi",
			)
			.catch(() => {});

		const output = logged(console_);
		expect(output).not.toContain("telegram-secret");
		expect(output).toContain("api.telegram.org");
	});

	it("email, with an SMTP server that is not a URL, logs the server host only", async () => {
		mocks.sendMail.mockRejectedValue(
			failWith("Invalid login: 535 smtp-password-secret-zz99", {
				code: "EAUTH",
			}),
		);

		const failure = await senders
			.sendEmailNotification(
				{
					smtpServer: "smtp.example.com",
					smtpPort: 587,
					username: "u",
					password: "smtp-password-secret-zz99",
					fromAddress: "a@b.co",
					toAddresses: ["c@d.co"],
				} as never,
				"s",
				"<p>h</p>",
			)
			.catch((error: Error) => error);

		expect((failure as Error).message).toContain("smtp-password-secret-zz99");
		const output = logged(console_);
		expect(output).not.toContain("smtp-password-secret");
		expect(output).toContain("EAUTH");
		expect(output).toContain("smtp.example.com");
	});
});

describe("telegram throws when the call fails", () => {
	const connection = { botToken: TOKEN_SECRET, chatId: "431" } as never;

	it("on a network error", async () => {
		mocks.fetch.mockRejectedValue(failWith("fetch failed"));

		await expect(
			senders.sendTelegramNotification(connection, "hi"),
		).rejects.toThrow("Failed to send Telegram notification fetch failed");
	});

	it("on a refused message, with Telegram's reason", async () => {
		mocks.fetch.mockResolvedValue(
			response(400, "Bad Request", {
				ok: false,
				description: "Bad Request: chat not found",
			}),
		);

		await expect(
			senders.sendTelegramNotification(connection, "hi"),
		).rejects.toThrow(
			"Failed to send Telegram notification: Bad Request: chat not found",
		);
		expect(console_.error).toHaveBeenCalledWith(
			"[notifications] telegram failed: HTTP 400 from api.telegram.org",
		);
	});

	it("on a refusal without a body, with the status text", async () => {
		mocks.fetch.mockResolvedValue(response(502, "Bad Gateway"));

		await expect(
			senders.sendTelegramNotification(connection, "hi"),
		).rejects.toThrow("Failed to send Telegram notification: Bad Gateway");
	});

	it("caps a long reason", async () => {
		mocks.fetch.mockResolvedValue(
			response(400, "Bad Request", { description: "x".repeat(500) }),
		);

		const failure = await senders
			.sendTelegramNotification(connection, "hi")
			.catch((error: Error) => error);

		expect((failure as Error).message.length).toBeLessThan(260);
	});

	it("not on success", async () => {
		mocks.fetch.mockResolvedValue(response(200, "OK", { ok: true }));

		await expect(
			senders.sendTelegramNotification(connection, "hi"),
		).resolves.toBeUndefined();
		expect(console_.error).not.toHaveBeenCalled();
	});
});

describe("lark throws when the call fails", () => {
	const connection = {
		webhookUrl: `https://open.larksuite.com/open-apis/bot/v2/hook/${WEBHOOK_SECRET}`,
	} as never;

	it("on a network error", async () => {
		mocks.fetch.mockRejectedValue(failWith("fetch failed"));

		await expect(senders.sendLarkNotification(connection, {})).rejects.toThrow(
			"Failed to send Lark notification fetch failed",
		);
	});

	it("on a non-2xx response", async () => {
		mocks.fetch.mockResolvedValue(response(404, "Not Found"));

		await expect(senders.sendLarkNotification(connection, {})).rejects.toThrow(
			"Failed to send Lark notification: Not Found",
		);
		expect(console_.error).toHaveBeenCalledWith(
			"[notifications] lark failed: HTTP 404 from open.larksuite.com",
		);
	});

	it("on a 200 that carries an error code (a refused webhook)", async () => {
		mocks.fetch.mockResolvedValue(
			response(200, "OK", { code: 19001, msg: "param invalid: token invalid" }),
		);

		await expect(senders.sendLarkNotification(connection, {})).rejects.toThrow(
			"Failed to send Lark notification: param invalid: token invalid",
		);
		expect(logged(console_)).not.toContain(WEBHOOK_SECRET);
	});

	it.each([
		["code 0", { code: 0, msg: "success" }],
		["the legacy success shape", { StatusCode: 0, StatusMessage: "success" }],
		["an empty body", ""],
		["a body that is not JSON", "ok"],
	])("not on a 200 with %s", async (_name, body) => {
		mocks.fetch.mockResolvedValue(response(200, "OK", body));

		await expect(
			senders.sendLarkNotification(connection, {}),
		).resolves.toBeUndefined();
		expect(console_.error).not.toHaveBeenCalled();
	});
});

describe("a failing Lark or Telegram sender does not break the event flow", () => {
	const none = Object.fromEntries(
		[
			"email",
			"discord",
			"telegram",
			"slack",
			"resend",
			"sendly",
			"notifly",
			"gotify",
			"ntfy",
			"mattermost",
			"custom",
			"lark",
			"pushover",
			"teams",
		].map((key) => [key, null]),
	);
	const deploy = () =>
		sendBuildSuccessNotifications({
			projectName: "Devino",
			applicationName: "web",
			applicationType: "application",
			buildLink: "https://dokploy.test/d",
			organizationId: "org-1",
			domains: [],
			environmentName: "production",
		});

	it("telegram: the deploy notification resolves and logs no token", async () => {
		mocks.rows = [
			{
				...none,
				notificationType: "telegram",
				telegram: { botToken: TOKEN_SECRET, chatId: "431" },
			},
		];
		mocks.fetch.mockResolvedValue(response(401, "Unauthorized"));

		await expect(deploy()).resolves.toBeUndefined();

		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const output = logged(console_);
		expect(output).toContain("HTTP 401 from api.telegram.org");
		expect(output).not.toContain("telegram-secret");
	});

	it("lark: the deploy notification resolves and logs no webhook", async () => {
		mocks.rows = [
			{
				...none,
				notificationType: "lark",
				lark: {
					webhookUrl: `https://open.larksuite.com/open-apis/bot/v2/hook/${WEBHOOK_SECRET}`,
				},
			},
		];
		mocks.fetch.mockRejectedValue(failWith("fetch failed"));

		await expect(deploy()).resolves.toBeUndefined();

		const output = logged(console_);
		expect(output).toContain("open.larksuite.com");
		expect(output).not.toContain(WEBHOOK_SECRET);
	});

	it("one failing notification does not stop the next one", async () => {
		mocks.rows = [
			{
				...none,
				notificationType: "telegram",
				telegram: { botToken: TOKEN_SECRET, chatId: "431" },
			},
			{
				...none,
				notificationType: "slack",
				slack: {
					webhookUrl: "https://hooks.slack.com/services/ok",
					channel: "c",
				},
			},
		];
		mocks.fetch
			.mockResolvedValueOnce(response(500, "Server Error"))
			.mockResolvedValueOnce(response(200, "OK"));

		await expect(deploy()).resolves.toBeUndefined();

		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});
});

describe("the notification code never logs a raw error", () => {
	const dir = fileURLToPath(
		new URL(
			"../../../../packages/server/src/utils/notifications/",
			import.meta.url,
		),
	);

	it("has no console call outside the safe logger", () => {
		const offenders = readdirSync(dir)
			.filter((file) => file.endsWith(".ts") && file !== "log-error.ts")
			.filter((file) =>
				/console\./.test(readFileSync(join(dir, file), "utf8")),
			);

		expect(offenders).toEqual([]);
	});
});
