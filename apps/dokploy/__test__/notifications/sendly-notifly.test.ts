import {
	sendNotiflyNotification,
	sendSendlyNotification,
} from "@dokploy/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("sendSendlyNotification", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts to the Sendly emails endpoint with a bearer token", async () => {
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ success: true, data: {} }),
		});

		await sendSendlyNotification(
			{
				sendlyId: "sendly-1",
				apiKey: "sk_test123",
				fromAddress: "alerts@example.com",
				toAddresses: ["team@example.com"],
				baseUrl: "https://app.sendly.now",
			},
			"Test Email",
			"<p>Hi, From Dokploy</p>",
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://app.sendly.now/api/emails");
		expect(options?.method).toBe("POST");
		expect(options?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "Bearer sk_test123",
		});
		expect(JSON.parse(options?.body as string)).toEqual({
			from: "alerts@example.com",
			to: ["team@example.com"],
			subject: "Test Email",
			body: "<p>Hi, From Dokploy</p>",
		});
	});

	it("falls back to the default base URL when none is provided", async () => {
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ success: true, data: {} }),
		});

		await sendSendlyNotification(
			{
				sendlyId: "sendly-1",
				apiKey: "sk_test123",
				fromAddress: "alerts@example.com",
				toAddresses: ["team@example.com"],
				baseUrl: "",
			},
			"Subject",
			"body",
		);

		const [url] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://app.sendly.now/api/emails");
	});

	it("throws with the API error message when the request fails", async () => {
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: false,
			statusText: "Unauthorized",
			json: async () => ({ error: { message: "Invalid API key" } }),
		});

		await expect(
			sendSendlyNotification(
				{
					sendlyId: "sendly-1",
					apiKey: "sk_bad",
					fromAddress: "alerts@example.com",
					toAddresses: ["team@example.com"],
					baseUrl: "https://app.sendly.now",
				},
				"Subject",
				"body",
			),
		).rejects.toThrow("Invalid API key");
	});
});

describe("sendNotiflyNotification", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts to the Notifly events trigger endpoint with an ApiKey header", async () => {
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({ ok: true, text: async () => "" });

		await sendNotiflyNotification(
			{
				notiflyId: "notifly-1",
				apiKey: "ntf_test123",
				workflowKey: "dokploy-alerts",
				subscriberId: "dokploy",
				baseUrl: "https://api.notifly.io",
			},
			{ event: "test", message: "Hi, From Dokploy" },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.notifly.io/v1/events/trigger");
		expect(options?.method).toBe("POST");
		expect(options?.headers).toMatchObject({
			"Content-Type": "application/json",
			Authorization: "ApiKey ntf_test123",
		});
		expect(JSON.parse(options?.body as string)).toEqual({
			name: "dokploy-alerts",
			to: "dokploy",
			payload: { event: "test", message: "Hi, From Dokploy" },
		});
	});

	it("defaults the subscriber id to dokploy when none is set", async () => {
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({ ok: true, text: async () => "" });

		await sendNotiflyNotification(
			{
				notiflyId: "notifly-1",
				apiKey: "ntf_test123",
				workflowKey: "dokploy-alerts",
				subscriberId: null,
				baseUrl: "https://api.notifly.io",
			},
			{ event: "test" },
		);

		const [, options] = fetchMock.mock.calls[0]!;
		expect(JSON.parse(options?.body as string).to).toBe("dokploy");
	});

	it("throws when the Notifly API responds with a non-ok status", async () => {
		const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: false,
			statusText: "Forbidden",
			text: async () => "invalid api key",
		});

		await expect(
			sendNotiflyNotification(
				{
					notiflyId: "notifly-1",
					apiKey: "ntf_bad",
					workflowKey: "dokploy-alerts",
					subscriberId: "dokploy",
					baseUrl: "https://api.notifly.io",
				},
				{ event: "test" },
			),
		).rejects.toThrow("Forbidden");
	});
});
