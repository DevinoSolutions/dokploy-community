import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	MANIFEST_MAX_BYTES,
	parseReleaseManifest,
} from "@dokploy/server/services/gha-connect/manifest";
import {
	allowedNamespaces,
	canonicalRepository,
	checkImageRepository,
} from "@dokploy/server/services/gha-connect/namespace";
import { describe, expect, it } from "vitest";

const dir = path.resolve(__dirname, "fixtures");
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const index = JSON.parse(read("index.json")) as Array<{
	file: string;
	ok: boolean;
	code?: string;
}>;

describe("vendored fixtures from DevinoSolutions/dokploy-release", () => {
	it("lists every fixture file and no other", () => {
		const onDisk = ["valid", "invalid"]
			.flatMap((sub) =>
				readdirSync(path.join(dir, sub)).map((f) => `${sub}/${f}`),
			)
			.sort();
		expect(index.map((e) => e.file).sort()).toEqual(onDisk);
	});

	it("matches the pinned hash in SOURCE.json (re-vendor on purpose, never edit)", () => {
		const source = JSON.parse(read("SOURCE.json")) as { sha256: string };
		const hash = createHash("sha256");
		for (const entry of [...index].sort((a, b) =>
			a.file.localeCompare(b.file),
		)) {
			hash
				.update(entry.file)
				.update("\0")
				.update(read(entry.file))
				.update("\0");
		}
		hash.update(read("index.json"));
		expect(hash.digest("hex")).toBe(source.sha256);
	});

	it.each(index.map((e) => [e.file, e] as const))("%s", (_file, entry) => {
		const result = parseReleaseManifest(read(entry.file));
		if (entry.ok) {
			expect(result.ok).toBe(true);
		} else {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe(entry.code);
		}
	});
});

describe("parseReleaseManifest", () => {
	const valid = () => JSON.parse(read("valid/multi-service-pull.json"));

	it("returns the services with their images split into repository and digest", () => {
		const result = parseReleaseManifest(valid());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.manifest.releaseId).toBe("gh-9876543210.1");
		expect(result.manifest.source.runAttempt).toBe(1);
		const web = result.manifest.services.find((s) => s.key === "web");
		expect(web?.composePath).toBe("docker-compose.prod.yml");
		expect(web?.images[0]).toEqual({
			name: "web",
			composeService: "web",
			ref: `registry.example.com/acme/shop/web@sha256:${"e".repeat(64)}`,
			repository: "registry.example.com/acme/shop/web",
			digest: `sha256:${"e".repeat(64)}`,
		});
	});

	it("reads the tunnel mirror's real image names and keeps them inside the connection's namespace", () => {
		const result = parseReleaseManifest(read("valid/tunnel-mirror.json"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const image = result.manifest.services[0]?.images[0];
		expect(image?.repository).toBe(
			"localhost:5000/registry.devino.ca/voicelabs/web",
		);
		const registryPrefix = "localhost:5000/registry.devino.ca";
		const namespaces = allowedNamespaces({
			owner: "DevinoSolutions",
			repo: "voicelabs",
			registryPrefix,
		});
		expect(namespaces).toEqual([
			"ghcr.io/devinosolutions/voicelabs/",
			"localhost:5000/registry.devino.ca/voicelabs/",
		]);
		expect(
			checkImageRepository({
				repository: image?.repository ?? "",
				namespaces,
				currentRepositories: [],
			}),
		).toEqual({ ok: true });
		expect(
			canonicalRepository({
				repository: image?.repository ?? "",
				owner: "DevinoSolutions",
				registryPrefix,
			}),
		).toBe("ghcr.io/devinosolutions/voicelabs/web");
	});

	it("accepts a manifest object as well as its text", () => {
		expect(parseReleaseManifest(valid()).ok).toBe(true);
		expect(parseReleaseManifest(JSON.stringify(valid())).ok).toBe(true);
	});

	it("refuses text that is not JSON", () => {
		const result = parseReleaseManifest("{nope");
		expect(result).toMatchObject({ ok: false, code: "invalid-json" });
	});

	it("refuses a manifest above the size limit before parsing it", () => {
		const result = parseReleaseManifest(" ".repeat(MANIFEST_MAX_BYTES + 1));
		expect(result).toMatchObject({ ok: false, code: "invalid" });
	});

	it("refuses migrations only when a service really asks for one", () => {
		const manifest = valid();
		manifest.services[0].migrations = null;
		expect(parseReleaseManifest(manifest).ok).toBe(true);
		delete manifest.services[0].migrations;
		expect(parseReleaseManifest(manifest).ok).toBe(true);
		manifest.services[0].migrations = { command: "x" };
		expect(parseReleaseManifest(manifest)).toMatchObject({
			ok: false,
			code: "migrations-unsupported",
		});
	});
});

describe("parseReleaseManifest: the image cap", () => {
	const withImages = (count: number, perService = count) => {
		const manifest = JSON.parse(read("valid/multi-service-pull.json"));
		const services = [];
		let n = 0;
		while (n < count) {
			const images = [];
			for (let i = 0; i < perService && n < count; i += 1, n += 1) {
				images.push({
					name: `i${n}`,
					composeService: `i${n}`,
					ref: `registry.example.com/acme/shop/i${n}@sha256:${"e".repeat(64)}`,
				});
			}
			services.push({ key: `s${services.length}`, images });
		}
		manifest.services = services;
		manifest.release.services = services.map((s) => s.key);
		return manifest;
	};

	it("accepts 64 images and refuses 65, in one service or spread over several", () => {
		expect(parseReleaseManifest(withImages(64)).ok).toBe(true);
		expect(parseReleaseManifest(withImages(64, 8)).ok).toBe(true);
		expect(parseReleaseManifest(withImages(65))).toMatchObject({
			ok: false,
			code: "invalid",
		});
		expect(parseReleaseManifest(withImages(65, 8))).toMatchObject({
			ok: false,
			code: "invalid",
		});
	});
});
