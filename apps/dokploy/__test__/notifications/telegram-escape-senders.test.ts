import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The domain verification and scheduled job failure messages go to Telegram as
 * HTML, so project, service, schedule and host names and the error text are
 * escaped: a `<` or `&` in them must not reach Telegram as markup.
 */

const mocks = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	findMany: vi.fn(),
	fetch: vi.fn(),
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

vi.mock("@dokploy/server/emails/emails/build-failed", () => ({
	default: (props: Record<string, unknown>) => ({ props }),
}));

vi.mock("@react-email/components", () => ({
	render: async () => "EMAIL",
}));

const { sendDomainVerificationFailedNotifications } = await import(
	"@dokploy/server/utils/notifications/domain-verification"
);
const { sendScheduleFailureNotifications } = await import(
	"@dokploy/server/utils/notifications/schedule-failure"
);

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

const telegramChannel = {
	...none,
	notificationType: "telegram",
	telegram: { botToken: "123456:token", chatId: "42", messageThreadId: null },
};

/** The text of the one Telegram message that was sent. */
const sentText = (): string => {
	const [, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
	return JSON.parse(String(init.body)).text;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.rows = [telegramChannel];
	mocks.findMany.mockImplementation(async () => mocks.rows);
	mocks.fetch.mockReset();
	mocks.fetch.mockResolvedValue({
		ok: true,
		status: 200,
		statusText: "OK",
		text: async () => "{}",
	});
	vi.stubGlobal("fetch", mocks.fetch);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("telegram escaping in the fork-only senders", () => {
	it("domain verification escapes names, host and reason", async () => {
		await sendDomainVerificationFailedNotifications({
			organizationId: "org-1",
			projectName: "<proj> & co",
			serviceName: "<svc>",
			host: "a&b.example.com",
			reason: "records <drifted> & gone",
			domainLink: "https://example.com/domains",
		});
		const text = sentText();
		expect(text).toContain("&lt;proj&gt; &amp; co");
		expect(text).toContain("&lt;svc&gt;");
		expect(text).toContain("a&amp;b.example.com");
		expect(text).toContain("records &lt;drifted&gt; &amp; gone");
		expect(text).not.toContain("<proj>");
		expect(text).not.toContain("<drifted>");
	});

	it("schedule failure escapes names and error text", async () => {
		await sendScheduleFailureNotifications({
			projectName: "<proj>",
			scheduleName: "a & b",
			scheduleType: "<type>",
			errorMessage: "boom <stack> & more",
			scheduleLink: "https://example.com/schedules",
			organizationId: "org-1",
		});
		const text = sentText();
		expect(text).toContain("&lt;proj&gt;");
		expect(text).toContain("a &amp; b");
		expect(text).toContain("&lt;type&gt;");
		expect(text).toContain("boom &lt;stack&gt; &amp; more");
		expect(text).not.toContain("<stack>");
	});

	it("schedule failure truncates a very long error", async () => {
		await sendScheduleFailureNotifications({
			projectName: "p",
			scheduleName: "s",
			scheduleType: "t",
			errorMessage: "x".repeat(10000),
			scheduleLink: "https://example.com/schedules",
			organizationId: "org-1",
		});
		expect(sentText().length).toBeLessThan(4096);
	});
});
