import { readZipEntry } from "@dokploy/server/services/gha-connect/zip";
import { describe, expect, it } from "vitest";
import { buildZip } from "./zip-fixture";

const NAME = "dokploy-release.json";
const text = (r: ReturnType<typeof readZipEntry>) =>
	r.ok ? r.bytes.toString("utf8") : null;

describe("readZipEntry", () => {
	it("reads a deflated entry", () => {
		const zip = buildZip([{ name: NAME, data: '{"a":1}'.repeat(50) }]);
		expect(text(readZipEntry(zip, NAME, 4096))).toBe('{"a":1}'.repeat(50));
	});

	it("reads a stored entry", () => {
		const zip = buildZip([{ name: NAME, data: '{"a":1}', method: 0 }]);
		expect(text(readZipEntry(zip, NAME, 4096))).toBe('{"a":1}');
	});

	it("finds the entry among others and matches the name exactly", () => {
		const zip = buildZip([
			{ name: "other.txt", data: "x" },
			{ name: `sub/${NAME}`, data: "nested" },
			{ name: NAME, data: "the one" },
		]);
		expect(text(readZipEntry(zip, NAME, 4096))).toBe("the one");
	});

	it("says so when the entry is missing", () => {
		const zip = buildZip([{ name: "other.txt", data: "x" }]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toMatch(/no entry named/);
	});

	it("refuses an entry whose declared size is above the limit", () => {
		const zip = buildZip([{ name: NAME, data: "x".repeat(5000) }]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result).toMatchObject({ ok: false });
	});

	it("stops inflating at the limit when the declared size lies", () => {
		const zip = buildZip([
			{ name: NAME, data: "x".repeat(1_000_000), declaredSize: 10 },
		]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result).toMatchObject({ ok: false });
	});

	it("refuses a wrong checksum", () => {
		const zip = buildZip([{ name: NAME, data: "hello", crc: 1234 }]);
		const result = readZipEntry(zip, NAME, 4096);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toMatch(/checksum/);
	});

	it("refuses an encrypted entry", () => {
		const zip = buildZip([{ name: NAME, data: "hello", flags: 1 }]);
		expect(readZipEntry(zip, NAME, 4096)).toMatchObject({ ok: false });
	});

	it("refuses bytes that are not a zip, and a truncated zip", () => {
		expect(readZipEntry(new Uint8Array(10), NAME, 4096).ok).toBe(false);
		expect(readZipEntry(Buffer.from("x".repeat(100)), NAME, 4096).ok).toBe(
			false,
		);
		const zip = buildZip([{ name: NAME, data: "hello" }]);
		expect(readZipEntry(zip.subarray(0, zip.length - 10), NAME, 4096).ok).toBe(
			false,
		);
	});
});
