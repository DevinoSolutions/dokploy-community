import {
	escapeHtml,
	formatTelegramErrorMessage,
} from "@dokploy/server/utils/notifications/utils";
import { describe, expect, it } from "vitest";

/**
 * Telegram messages are sent with parse_mode HTML, so user data (names, error
 * output) is escaped first, and a long error is cut below Telegram's 4096
 * character limit without splitting an entity or a surrogate pair.
 */

describe("escapeHtml", () => {
	it("escapes the characters Telegram's HTML parser treats as markup", () => {
		expect(escapeHtml("<b>a & b</b>")).toBe("&lt;b&gt;a &amp; b&lt;/b&gt;");
	});

	it("escapes an ampersand once", () => {
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});

	it("leaves plain text unchanged", () => {
		expect(escapeHtml("my-app_1")).toBe("my-app_1");
	});
});

describe("formatTelegramErrorMessage", () => {
	it("escapes a short message and does not truncate it", () => {
		expect(formatTelegramErrorMessage("a < b")).toBe("a &lt; b");
	});

	it("keeps a message of exactly 3000 characters", () => {
		const message = "x".repeat(3000);
		expect(formatTelegramErrorMessage(message)).toBe(message);
	});

	it("truncates a long message to 3000 characters plus an ellipsis", () => {
		const result = formatTelegramErrorMessage("x".repeat(5000));
		expect(result).toBe(`${"x".repeat(3000)}…`);
	});

	it("does not cut an escaped entity in half", () => {
		// "&amp;" starts at index 2999, so the cut at 3000 falls inside it.
		const result = formatTelegramErrorMessage(
			`${"x".repeat(2999)}&${"y".repeat(100)}`,
		);
		expect(result).toBe(`${"x".repeat(2999)}…`);
		expect(result).not.toMatch(/&[a-z]*…$/);
	});

	it("does not split a surrogate pair", () => {
		const result = formatTelegramErrorMessage(
			`${"x".repeat(2999)}😀${"y".repeat(100)}`,
		);
		expect(result).toBe(`${"x".repeat(2999)}…`);
	});

	it("keeps an entity that ends exactly at the limit", () => {
		// "&amp;" occupies indexes 2995-2999, so it is complete at the cut.
		const message = `${"x".repeat(2995)}&${"y".repeat(100)}`;
		expect(formatTelegramErrorMessage(message)).toBe(
			`${"x".repeat(2995)}&amp;…`,
		);
	});
});
