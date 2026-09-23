import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	signDoDomainPayload,
	verifyDoDomainSignature,
} from "@dokploy/server/utils/dodomain/client";

/**
 * DoDomain signs `${t}.${rawBody}` with HMAC-SHA256 and sends
 * `x-dodomain-signature: t=<unixMs>,v1=<hex>` (DoDomain
 * packages/core/src/webhook.ts). The receiver must accept exactly that and
 * refuse everything else without throwing.
 */

const SECRET = "whsec_test_secret";
const NOW = 1_790_000_000_000;
const BODY = JSON.stringify({
	id: "del_1",
	type: "connection.verified",
	occurredAt: new Date(NOW).toISOString(),
	data: { domain: "app.customer.com", sessionId: "ses_1", connectionId: "c1" },
});

const header = (body = BODY, secret = SECRET, t = NOW) =>
	`t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("verifyDoDomainSignature", () => {
	it("accepts a signature DoDomain produced over the raw body", () => {
		expect(
			verifyDoDomainSignature(SECRET, BODY, header(), undefined, NOW),
		).toBe(true);
	});

	it("matches the header signDoDomainPayload builds", () => {
		expect(
			verifyDoDomainSignature(
				SECRET,
				BODY,
				signDoDomainPayload(SECRET, BODY, NOW),
				undefined,
				NOW,
			),
		).toBe(true);
	});

	it("tolerates whitespace around the header parts", () => {
		const [t, v1] = header().split(",");
		expect(
			verifyDoDomainSignature(SECRET, BODY, ` ${t} , ${v1} `, undefined, NOW),
		).toBe(true);
	});

	it("rejects a body that was modified after signing", () => {
		const tampered = BODY.replace("app.customer.com", "evil.example.com");
		expect(
			verifyDoDomainSignature(SECRET, tampered, header(), undefined, NOW),
		).toBe(false);
	});

	it("rejects a signature made with another secret", () => {
		expect(
			verifyDoDomainSignature(
				SECRET,
				BODY,
				header(BODY, "whsec_other"),
				undefined,
				NOW,
			),
		).toBe(false);
	});

	it("rejects a timestamp outside the 5 minute replay window", () => {
		const old = NOW - 5 * 60 * 1000 - 1;
		expect(
			verifyDoDomainSignature(
				SECRET,
				BODY,
				header(BODY, SECRET, old),
				undefined,
				NOW,
			),
		).toBe(false);
		const future = NOW + 5 * 60 * 1000 + 1;
		expect(
			verifyDoDomainSignature(
				SECRET,
				BODY,
				header(BODY, SECRET, future),
				undefined,
				NOW,
			),
		).toBe(false);
	});

	it("rejects a missing or empty header or secret", () => {
		expect(verifyDoDomainSignature(SECRET, BODY, null, undefined, NOW)).toBe(
			false,
		);
		expect(verifyDoDomainSignature(SECRET, BODY, "", undefined, NOW)).toBe(
			false,
		);
		expect(verifyDoDomainSignature("", BODY, header(), undefined, NOW)).toBe(
			false,
		);
	});

	it("returns false (never throws) on malformed v1 values", () => {
		const t = `t=${NOW}`;
		for (const v1 of [
			"",
			"abc",
			"Z".repeat(64),
			"A".repeat(64),
			// 64 characters, more than 64 bytes: must not reach timingSafeEqual.
			`${"é".repeat(2)}${"a".repeat(62)}`,
			`${"a".repeat(64)}0`,
		]) {
			expect(() =>
				verifyDoDomainSignature(SECRET, BODY, `${t},v1=${v1}`, undefined, NOW),
			).not.toThrow();
			expect(
				verifyDoDomainSignature(SECRET, BODY, `${t},v1=${v1}`, undefined, NOW),
			).toBe(false);
		}
	});

	it("rejects a header without a timestamp", () => {
		const v1 = header().split(",")[1];
		expect(verifyDoDomainSignature(SECRET, BODY, `${v1}`, undefined, NOW)).toBe(
			false,
		);
		expect(
			verifyDoDomainSignature(SECRET, BODY, `t=abc,${v1}`, undefined, NOW),
		).toBe(false);
	});
});
