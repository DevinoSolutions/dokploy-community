import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Snapvisor visual changes" notification event: which channels get it,
 * and what each provider's message says. Every message names the service,
 * environment, branch, short commit, the number of changed snapshots when
 * Snapvisor reported one, and links to the review. A failing channel is
 * logged without its secret and does not stop the others.
 */

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	findMany: vi.fn(),
	fetch: vi.fn(),
	sendMail: vi.fn(),
	renderFails: false,
}));

vi.mock("nodemailer", () => ({
	default: { createTransport: () => ({ sendMail: mocks.sendMail }) },
}));

// The template's JSX needs the build's automatic runtime, which vitest does not
// apply to the server package; what matters here is the data handed to it.
vi.mock("@dokploy/server/emails/emails/snapvisor-changes", () => ({
	default: (props: Record<string, unknown>) => ({ props }),
}));

vi.mock("@react-email/components", () => ({
	render: async (element: { props: Record<string, unknown> }) => {
		if (mocks.renderFails) throw new Error("render exploded");
		return `EMAIL ${JSON.stringify(element.props)}`;
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: new Proxy({} as Record<string, unknown>, {
			get: () => ({
				findMany: mocks.findMany,
				findFirst: vi.fn(async () => undefined),
			}),
		}),
	},
	dbUrl: "postgres://mock:mock@localhost:5432/mock",
}));

const { sendSnapvisorChangesNotifications, describeSnapvisorSnapshots } =
	await import("@dokploy/server/utils/notifications/snapvisor-changes");

const WEBHOOK_SECRET = "T000/B000/webhook-secret-ab12";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const REVIEW_URL = "https://app.snapvisor.io/my-team/web-app/builds/7";

const payload = {
	organizationId: "org-1",
	projectName: "Marketing",
	serviceName: "web-frontend",
	serviceType: "application",
	environmentName: "production",
	branch: "feature/login",
	commitSha: SHA,
	snapvisorProjectName: "web-app",
	changedSnapshots: 4,
	addedSnapshots: 1,
	removedSnapshots: 0,
	reviewUrl: REVIEW_URL,
};

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

const channel = (provider: string, connection: Record<string, unknown>) => ({
	...none,
	notificationType: provider,
	[provider]: connection,
});

const ok = () =>
	({
		ok: true,
		status: 200,
		statusText: "OK",
		text: async () => JSON.stringify({ code: 0 }),
	}) as unknown as Response;

/** Everything the sender put on the wire, as one searchable string. */
const sent = () =>
	JSON.stringify(
		mocks.fetch.mock.calls.map(([url, init]) => ({
			url,
			body: (init as RequestInit | undefined)?.body?.toString(),
		})),
	);

const expectFullMessage = (text: string) => {
	expect(text).toContain("web-frontend");
	expect(text).toContain("production");
	expect(text).toContain("feature/login");
	expect(text).toContain("0123456");
	expect(text).not.toContain(SHA);
	expect(text).toContain("4 changed");
	expect(text).toContain(REVIEW_URL);
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows = [];
	mocks.renderFails = false;
	mocks.findMany.mockImplementation(async () => mocks.rows);
	mocks.fetch.mockReset();
	mocks.fetch.mockResolvedValue(ok());
	vi.stubGlobal("fetch", mocks.fetch);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("who is notified", () => {
	it("looks for this organization's channels subscribed to the event", async () => {
		await sendSnapvisorChangesNotifications(payload);

		const { where } = mocks.findMany.mock.calls[0]?.[0] as { where: never };
		const query = new PgDialect().sqlToQuery(where);
		expect(query.sql).toContain('"snapvisorChanges"');
		expect(query.sql).toContain('"organizationId"');
		expect(query.params).toEqual([true, "org-1"]);
	});

	it("sends nothing when no channel is subscribed", async () => {
		mocks.rows = [];
		await sendSnapvisorChangesNotifications(payload);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.sendMail).not.toHaveBeenCalled();
	});
});

describe("provider messages", () => {
	it("slack", async () => {
		mocks.rows = [
			channel("slack", {
				webhookUrl: `https://hooks.slack.com/services/${WEBHOOK_SECRET}`,
				channel: "#ci",
			}),
		];
		await sendSnapvisorChangesNotifications(payload);

		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const text = sent();
		expect(text).toContain("Visual Changes Detected");
		expectFullMessage(text);
		expect(text).toContain(
			"<https://app.snapvisor.io/my-team/web-app/builds/7|",
		);
	});

	it("discord, with and without decoration", async () => {
		mocks.rows = [
			channel("discord", {
				webhookUrl: `https://discord.com/api/webhooks/${WEBHOOK_SECRET}`,
				decoration: true,
			}),
		];
		await sendSnapvisorChangesNotifications(payload);
		const decorated = sent();
		expect(decorated).toContain("Visual Changes Detected");
		expectFullMessage(decorated);

		mocks.fetch.mockClear();
		mocks.rows = [
			channel("discord", {
				webhookUrl: `https://discord.com/api/webhooks/${WEBHOOK_SECRET}`,
				decoration: false,
			}),
		];
		await sendSnapvisorChangesNotifications(payload);
		expectFullMessage(sent());
	});

	it("telegram, with a review button and escaped names", async () => {
		mocks.rows = [
			channel("telegram", { botToken: "123456:tg-secret", chatId: "431" }),
		];
		await sendSnapvisorChangesNotifications({
			...payload,
			serviceName: "web <b>&</b>",
		});

		const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.chat_id).toBe("431");
		expect(body.text).toContain("Visual Changes Detected");
		expect(body.text).toContain("web &lt;b&gt;&amp;&lt;/b&gt;");
		expect(body.text).toContain("feature/login");
		expect(body.text).toContain("4 changed");
		expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
			text: "Review in Snapvisor",
			url: REVIEW_URL,
		});
	});

	it("teams", async () => {
		mocks.rows = [
			channel("teams", {
				webhookUrl: `https://example.webhook.office.com/${WEBHOOK_SECRET}`,
			}),
		];
		await sendSnapvisorChangesNotifications(payload);
		expectFullMessage(sent());
		expect(sent()).toContain("Review in Snapvisor");
	});

	it("mattermost", async () => {
		mocks.rows = [
			channel("mattermost", {
				webhookUrl: `https://mm.example.com/hooks/${WEBHOOK_SECRET}`,
				channel: "ci",
				username: "",
			}),
		];
		await sendSnapvisorChangesNotifications(payload);
		expectFullMessage(sent());
	});

	it("lark", async () => {
		mocks.rows = [
			channel("lark", {
				webhookUrl: `https://open.larksuite.com/hook/${WEBHOOK_SECRET}`,
			}),
		];
		await sendSnapvisorChangesNotifications(payload);
		expectFullMessage(sent());
	});

	it("custom webhook gets structured fields", async () => {
		mocks.rows = [
			channel("custom", {
				endpoint: `https://hooks.example.com/${WEBHOOK_SECRET}`,
				headers: {},
			}),
		];
		await sendSnapvisorChangesNotifications(payload);

		const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toMatchObject({
			type: "snapvisor",
			status: "changes-detected",
			projectName: "Marketing",
			applicationName: "web-frontend",
			environmentName: "production",
			branch: "feature/login",
			commit: SHA,
			changedSnapshots: 4,
			reviewUrl: REVIEW_URL,
		});
	});

	it("ntfy, gotify and pushover", async () => {
		mocks.rows = [
			channel("ntfy", {
				serverUrl: "https://ntfy.example.com",
				topic: "deploys",
				priority: 3,
			}),
			channel("gotify", {
				serverUrl: "https://gotify.example.com",
				appToken: "gotify-secret",
				priority: 5,
				decoration: true,
			}),
			channel("pushover", {
				userKey: "u-key",
				apiToken: "a-token",
				priority: 0,
			}),
		];
		await sendSnapvisorChangesNotifications(payload);

		const calls = mocks.fetch.mock.calls as [string, RequestInit][];
		expect(calls).toHaveLength(3);
		const [ntfy, gotify, pushover] = calls;

		expect(ntfy?.[1].body).toContain("web-frontend");
		expect(ntfy?.[1].body).toContain("feature/login");
		expect(ntfy?.[1].body).toContain("4 changed");
		expect(
			(ntfy?.[1].headers as Record<string, string>)["X-Actions"],
		).toContain(REVIEW_URL);

		expectFullMessage(String(gotify?.[1].body));
		const form = new URLSearchParams(String(pushover?.[1].body));
		expect(form.get("title")).toBe("Visual Changes Detected");
		expectFullMessage(form.get("message") ?? "");
	});

	it("notifly", async () => {
		mocks.rows = [
			channel("notifly", {
				apiKey: "nk-secret",
				workflowKey: "deploys",
				subscriberId: "me",
				baseUrl: "https://api.notifly.io",
			}),
		];
		await sendSnapvisorChangesNotifications(payload);

		const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string).payload).toMatchObject({
			event: "snapvisor.changes",
			applicationName: "web-frontend",
			branch: "feature/login",
			changedSnapshots: 4,
			link: REVIEW_URL,
		});
	});

	it("email renders the same facts", async () => {
		mocks.rows = [
			channel("email", {
				smtpServer: "smtp.example.com",
				smtpPort: 587,
				username: "u",
				password: "p",
				fromAddress: "dokploy@example.com",
				toAddresses: ["team@example.com"],
			}),
		];
		await sendSnapvisorChangesNotifications(payload);

		expect(mocks.sendMail).toHaveBeenCalledTimes(1);
		const mail = mocks.sendMail.mock.calls[0]?.[0] as {
			subject: string;
			html: string;
		};
		expect(mail.subject).toBe("Snapvisor visual changes to review");
		expect(JSON.parse(mail.html.replace(/^EMAIL /, ""))).toMatchObject({
			projectName: "Marketing",
			serviceName: "web-frontend",
			environmentName: "production",
			branch: "feature/login",
			commit: "0123456",
			snapshotSummary: "4 changed, 1 added",
			reviewUrl: REVIEW_URL,
		});
	});

	it("leaves the snapshot line out when Snapvisor reported no counts", async () => {
		mocks.rows = [
			channel("slack", {
				webhookUrl: "https://hooks.slack.com/x",
				channel: "",
			}),
		];
		await sendSnapvisorChangesNotifications({
			...payload,
			changedSnapshots: null,
			addedSnapshots: null,
			removedSnapshots: null,
		});

		const text = sent();
		expect(text).toContain("feature/login");
		expect(text).not.toContain("Snapshots");
		expect(text).not.toContain("changed");
	});
});

describe("a failing channel", () => {
	it("is logged without its secret and does not stop the next channel", async () => {
		mocks.rows = [
			channel("slack", {
				webhookUrl: `https://hooks.slack.com/services/${WEBHOOK_SECRET}`,
				channel: "",
			}),
			channel("telegram", { botToken: "123456:tg-secret", chatId: "431" }),
		];
		mocks.fetch
			.mockRejectedValueOnce(
				new TypeError(`Failed to parse URL from ${WEBHOOK_SECRET}`),
			)
			.mockResolvedValueOnce(ok());

		await expect(
			sendSnapvisorChangesNotifications(payload),
		).resolves.toBeUndefined();

		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		const logged = JSON.stringify(
			(console.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
		);
		expect(logged).toContain("snapvisor changes");
		expect(logged).not.toContain("webhook-secret");
		expect(logged).not.toContain("tg-secret");
	});
});

describe("an email that cannot be rendered", () => {
	it("is logged without the error and does not stop the next channel", async () => {
		mocks.renderFails = true;
		mocks.rows = [
			channel("email", {
				smtpServer: "smtp.example.com",
				smtpPort: 587,
				username: "u",
				password: "p",
				fromAddress: "from@example.com",
				toAddresses: ["to@example.com"],
			}),
			channel("telegram", { botToken: "123456:tg-secret", chatId: "431" }),
		];

		await expect(
			sendSnapvisorChangesNotifications(payload),
		).resolves.toBeUndefined();

		expect(mocks.sendMail).not.toHaveBeenCalled();
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(
			(console.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
		);
		expect(logged).toContain("snapvisor changes");
		expect(logged).not.toContain("render exploded");
	});
});

describe("describeSnapvisorSnapshots", () => {
	it.each([
		[{ changed: 12, added: 2, removed: 1 }, "12 changed, 2 added, 1 removed"],
		[{ changed: 3, added: 0, removed: 0 }, "3 changed"],
		[{ changed: 0, added: 5, removed: null }, "5 added"],
		[{ changed: null, added: null, removed: null }, null],
		[{ changed: 0, added: 0, removed: 0 }, null],
	])("%j -> %s", (counts, expected) => {
		expect(describeSnapvisorSnapshots(counts)).toBe(expected);
	});
});
