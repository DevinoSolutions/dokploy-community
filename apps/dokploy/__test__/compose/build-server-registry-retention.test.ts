import { spawn, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRegistryCurlConfig,
	buildRegistryDeleteJobCommand,
	buildRegistryDeleteJobConfig,
	buildRegistryJobStatusCommand,
	buildRegistryPruneStopCommand,
	curlConfigQuote,
	getManifestChildDigests,
	getNestedIndexReason,
	getNextTagsPageUrl,
	getReadFilesCommand,
	getRegistryApiBases,
	getRegistryJobKey,
	getRegistryLockKey,
	hasRepeatedHeader,
	isBodyTruncated,
	isLoopbackHost,
	mapDeploymentTagTimes,
	parseOverrideImages,
	parseRegistryEndpoint,
	parseRegistryImageRef,
	parseRegistryJobOutput,
	parseRegistryResponses,
	parseTagList,
	planRepoTags,
	REGISTRY_CURL_COMMAND,
	RELIED_ON_HEADERS,
	type RegistryResponse,
	selectDigestsToDelete,
	splitFileOutput,
} from "@dokploy/server/utils/builders/compose-registry-retention";
import { buildComposeOverrideYaml } from "@dokploy/server/utils/builders/compose-remote-build";
import { quote } from "shell-quote";
import { describe, expect, it } from "vitest";

/**
 * Retention for the `dpl-` tags of a compose build registry: the pure part.
 * Which tags and digests may go, how the registry is addressed, and the curl
 * config / command the build server runs. The orchestration is covered by
 * build-server-registry-retention-service.test.ts.
 */

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
/** An index entry for a single-platform image manifest. */
const img = (n: number) => ({ mediaType: OCI_MANIFEST, digest: digest(n) });

describe("planRepoTags", () => {
	const now = Date.parse("2026-10-07T12:00:00Z");
	const minutesAgo = (m: number) => now - m * 60_000;
	const none = new Set<string>();

	it("keeps everything when there are fewer than five dpl- tags", () => {
		const plan = planRepoTags({
			tags: ["latest", "dpl-a", "dpl-b", "dpl-c"],
			protectedTags: none,
			tagTimes: new Map([
				["dpl-a", minutesAgo(30)],
				["dpl-b", minutesAgo(20)],
				["dpl-c", minutesAgo(10)],
			]),
		});
		expect(plan.doomedTags).toEqual([]);
		expect(plan.keptTags).toEqual(["latest", "dpl-a", "dpl-b", "dpl-c"]);
	});

	it("orders by deployment creation time, not by the tag text", () => {
		// Ids are random: alphabetical order says the opposite of the clock.
		const times = new Map([
			["dpl-zzz", minutesAgo(70)], // oldest
			["dpl-yyy", minutesAgo(60)],
			["dpl-mmm", minutesAgo(50)],
			["dpl-aaa", minutesAgo(40)],
			["dpl-bbb", minutesAgo(30)],
			["dpl-ccc", minutesAgo(20)],
			["dpl-ddd", minutesAgo(10)], // newest
		]);
		const plan = planRepoTags({
			tags: ["latest", ...times.keys()],
			protectedTags: none,
			tagTimes: times,
		});
		// Oldest first, and the two oldest are the alphabetically *last* ones.
		expect(plan.doomedTags).toEqual(["dpl-zzz", "dpl-yyy"]);
		expect(plan.keptTags).toEqual([
			"latest",
			"dpl-mmm",
			"dpl-aaa",
			"dpl-bbb",
			"dpl-ccc",
			"dpl-ddd",
		]);
	});

	it("never dooms latest or any tag that is not a dpl- tag", () => {
		const times = new Map(
			["a", "b", "c", "d", "e", "f"].map((id, index) => [
				`dpl-${id}`,
				minutesAgo(100 - index),
			]),
		);
		const plan = planRepoTags({
			tags: ["latest", "v1", "manual", ...times.keys()],
			protectedTags: none,
			tagTimes: times,
		});
		expect(plan.doomedTags).toEqual(["dpl-a"]);
		expect(plan.keptTags).toEqual(
			expect.arrayContaining(["latest", "v1", "manual"]),
		);
	});

	it("keeps a last-good tag that is older than the five newest", () => {
		const times = new Map(
			["a", "b", "c", "d", "e", "f", "g"].map((id, index) => [
				`dpl-${id}`,
				minutesAgo(100 - index),
			]),
		);
		const plan = planRepoTags({
			tags: ["latest", ...times.keys()],
			// the rollback snapshot still points at the oldest tag
			protectedTags: new Set(["dpl-a"]),
			tagTimes: times,
		});
		expect(plan.doomedTags).toEqual(["dpl-b"]);
		expect(plan.keptTags).toContain("dpl-a");
	});

	it("keeps the tag the current release runs even when its deployment row is gone", () => {
		const times = new Map(
			["b", "c", "d", "e", "f", "g"].map((id, index) => [
				`dpl-${id}`,
				minutesAgo(100 - index),
			]),
		);
		const plan = planRepoTags({
			tags: ["latest", "dpl-old", ...times.keys()],
			protectedTags: new Set(["dpl-old"]),
			tagTimes: times,
		});
		expect(plan.keptTags).toContain("dpl-old");
		expect(plan.doomedTags).toEqual(["dpl-b"]);
	});

	it("ranks tags without a deployment row older than every known one", () => {
		const times = new Map(
			["a", "b", "c"].map((id, index) => [`dpl-${id}`, minutesAgo(30 - index)]),
		);
		const plan = planRepoTags({
			tags: ["latest", "dpl-x", "dpl-y", "dpl-z", "dpl-a", "dpl-b", "dpl-c"],
			protectedTags: none,
			tagTimes: times,
		});
		// 3 known + the 2 unknown that sort last by text fill the five slots
		expect(plan.keptTags).toEqual(
			expect.arrayContaining(["dpl-a", "dpl-b", "dpl-c", "dpl-z", "dpl-y"]),
		);
		expect(plan.doomedTags).toEqual(["dpl-x"]);
	});

	it("does not count a protected tag twice and honors a custom keep", () => {
		const times = new Map(
			["a", "b", "c", "d"].map((id, index) => [
				`dpl-${id}`,
				minutesAgo(100 - index),
			]),
		);
		const plan = planRepoTags({
			tags: [...times.keys()],
			protectedTags: new Set(["dpl-d"]),
			tagTimes: times,
			keep: 2,
		});
		expect(plan.doomedTags).toEqual(["dpl-a", "dpl-b"]);
	});
});

describe("mapDeploymentTagTimes", () => {
	it("maps the tag a deployment pushed to its creation time", () => {
		const times = mapDeploymentTagTimes([
			{ deploymentId: "abc_-X", createdAt: "2026-10-07T10:00:00.000Z" },
			{ deploymentId: "bad", createdAt: "not a date" },
		]);
		expect(times.get("dpl-abc_-X")).toBe(Date.parse("2026-10-07T10:00:00.000Z"));
		expect(times.has("dpl-bad")).toBe(false);
	});
});

describe("selectDigestsToDelete", () => {
	it("keeps a digest that latest (or any kept tag) still resolves to", () => {
		// latest and the newest dpl- tag share a digest; so does an old dpl- tag
		// of a service that did not change.
		const result = selectDigestsToDelete({
			doomedDigests: new Map([
				["dpl-old1", digest(1)],
				["dpl-old2", digest(2)],
			]),
			protectedDigests: new Set([digest(1)]),
		});
		expect(result.deleteDigests).toEqual([digest(2)]);
		expect(result.deleteTags).toEqual(["dpl-old2"]);
		expect(result.heldBack).toEqual([{ tag: "dpl-old1", digest: digest(1) }]);
	});

	it("deletes a digest shared only by doomed tags once", () => {
		const result = selectDigestsToDelete({
			doomedDigests: new Map([
				["dpl-a", digest(7)],
				["dpl-b", digest(7)],
				["dpl-c", digest(8)],
			]),
			protectedDigests: new Set([digest(9)]),
		});
		expect(result.deleteDigests).toEqual([digest(7), digest(8)]);
		expect(result.deleteTags).toEqual(["dpl-a", "dpl-b", "dpl-c"]);
	});

	it("protects every doomed tag of a digest when one kept tag shares it", () => {
		const result = selectDigestsToDelete({
			doomedDigests: new Map([
				["dpl-a", digest(7)],
				["dpl-b", digest(7)],
			]),
			protectedDigests: new Set([digest(7)]),
		});
		expect(result.deleteDigests).toEqual([]);
		expect(result.heldBack).toHaveLength(2);
	});
});

describe("getManifestChildDigests", () => {
	it("lists the children of an index and nothing for a plain manifest", () => {
		expect(
			getManifestChildDigests(
				JSON.stringify({
					manifests: [img(3), img(4)],
				}),
			),
		).toEqual([digest(3), digest(4)]);
		expect(
			getManifestChildDigests(JSON.stringify({ layers: [], config: {} })),
		).toEqual([]);
	});

	it("refuses an index whose children may be indexes themselves", () => {
		const index = (child: Record<string, unknown>) =>
			JSON.stringify({ manifests: [img(3), child] });
		for (const [child, reason] of [
			[
				{ mediaType: "application/vnd.oci.image.index.v1+json", digest: digest(4) },
				"a child is application/vnd.oci.image.index.v1+json",
			],
			[
				{
					mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
					digest: digest(4),
				},
				"a child is application/vnd.docker.distribution.manifest.list.v2+json",
			],
			[{ digest: digest(4) }, "a child has no media type"],
			[{ mediaType: "", digest: digest(4) }, "a child has no media type"],
			[{ mediaType: "text/plain", digest: digest(4) }, "a child is text/plain"],
		] as const) {
			expect(getNestedIndexReason(index(child))).toBe(reason);
			expect(getManifestChildDigests(index(child))).toBeNull();
		}
		// both single-platform manifest types are leaves
		const leaves = JSON.stringify({
			manifests: [
				img(3),
				{
					mediaType: "application/vnd.docker.distribution.manifest.v2+json",
					digest: digest(4),
				},
			],
		});
		expect(getNestedIndexReason(leaves)).toBeNull();
		expect(getManifestChildDigests(leaves)).toEqual([digest(3), digest(4)]);
		// a plain manifest, or a body it cannot read, names no nested child
		expect(getNestedIndexReason(JSON.stringify({ layers: [] }))).toBeNull();
		expect(getNestedIndexReason("{")).toBeNull();
	});

	it("answers null, never 'no children', for a body it cannot read whole", () => {
		const index = JSON.stringify({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.index.v1+json",
			manifests: [img(3), img(4)],
		});
		// cut anywhere: inside the list, inside a digest, before the end
		for (const cut of [10, index.indexOf(digest(4)) + 20, index.length - 1]) {
			expect(getManifestChildDigests(index.slice(0, cut))).toBeNull();
		}
		expect(getManifestChildDigests("")).toBeNull();
		expect(getManifestChildDigests("not json")).toBeNull();
		expect(getManifestChildDigests("[]")).toBeNull();
		expect(getManifestChildDigests('{"manifests":{}}')).toBeNull();
		// an entry whose digest is unreadable protects something unknown
		expect(
			getManifestChildDigests(
				JSON.stringify({ manifests: [img(3), { mediaType: OCI_MANIFEST, digest: "bogus" }] }),
			),
		).toBeNull();
		expect(
			getManifestChildDigests(JSON.stringify({ manifests: [img(3), { mediaType: OCI_MANIFEST }] })),
		).toBeNull();
	});
});

describe("image references", () => {
	it("splits registry, repository and tag", () => {
		expect(parseRegistryImageRef("localhost:5000/acme/my-app-web:dpl-x1")).toEqual(
			{ host: "localhost:5000", repo: "acme/my-app-web", tag: "dpl-x1" },
		);
		expect(parseRegistryImageRef("Reg.Example.com/acme/a:latest")).toEqual({
			host: "reg.example.com",
			repo: "acme/a",
			tag: "latest",
		});
	});

	it("rejects references that are not host/repo:tag", () => {
		expect(parseRegistryImageRef("nginx:latest")).toBeNull();
		expect(parseRegistryImageRef("acme/app")).toBeNull();
		expect(parseRegistryImageRef("reg.io/acme/app@sha256:abc")).toBeNull();
		expect(parseRegistryImageRef("reg.io/a b/app:t")).toBeNull();
		expect(parseRegistryImageRef("")).toBeNull();
	});

	it("reads the images out of a generated override", () => {
		const yaml = buildComposeOverrideYaml(
			[
				{ service: "web", image: "localhost:5000/acme/app-web:dpl-1" },
				{ service: "api", image: "localhost:5000/acme/app-api:dpl-1" },
			],
			"docker-compose",
		);
		expect(parseOverrideImages(yaml)).toEqual([
			"localhost:5000/acme/app-web:dpl-1",
			"localhost:5000/acme/app-api:dpl-1",
		]);
		expect(parseOverrideImages("::: not yaml :::\n\t- [")).toEqual([]);
		expect(parseOverrideImages("")).toEqual([]);
	});
});

describe("registry addressing", () => {
	it("tries http then https for a loopback (tunnelled) registry", () => {
		expect(getRegistryApiBases(parseRegistryEndpoint("localhost:5000")!)).toEqual(
			["http://localhost:5000", "https://localhost:5000"],
		);
		expect(isLoopbackHost("127.0.0.1:5000")).toBe(true);
		expect(isLoopbackHost("[::1]:5000")).toBe(true);
	});

	it("never sends credentials over plain http to a remote host unless asked to", () => {
		expect(
			getRegistryApiBases(parseRegistryEndpoint("reg.example.com")!),
		).toEqual(["https://reg.example.com"]);
		expect(
			getRegistryApiBases(parseRegistryEndpoint("http://reg.internal:5000/")!),
		).toEqual(["http://reg.internal:5000"]);
		expect(isLoopbackHost("reg.example.com")).toBe(false);
	});

	it("rejects an empty or hostile registry url", () => {
		expect(parseRegistryEndpoint("")).toBeNull();
		expect(parseRegistryEndpoint(null)).toBeNull();
		expect(parseRegistryEndpoint('reg" --evil')).toBeNull();
		// userinfo would move the real host: https://reg.example.com@evil.test
		expect(parseRegistryEndpoint("reg.example.com@evil.test")).toBeNull();
		expect(parseRegistryEndpoint("https://user:pw@reg.example.com")).toBeNull();
	});
});

describe("tag listing pages", () => {
	const base = "https://reg.example.com";
	const repo = "acme/app";
	const next = (link: string | undefined) => getNextTagsPageUrl(base, repo, link);
	const nextUrl = (url: string) => ({ kind: "next", url });

	it("follows a relative or absolute rel=next link on the same origin", () => {
		expect(next('</v2/acme/app/tags/list?last=dpl-b&n=1000>; rel="next"')).toEqual(
			nextUrl("https://reg.example.com/v2/acme/app/tags/list?last=dpl-b&n=1000"),
		);
		expect(next("<https://reg.example.com/v2/acme/app/tags/list?last=x>; rel=next")).toEqual(
			nextUrl("https://reg.example.com/v2/acme/app/tags/list?last=x"),
		);
		// several links, the next one second
		expect(
			next(
				'</v2/acme/app/tags/list?n=10>; rel="first", </v2/acme/app/tags/list?last=y&n=10>; rel="next"',
			),
		).toEqual(nextUrl("https://reg.example.com/v2/acme/app/tags/list?last=y&n=10"));
	});

	it("reads quoted parameters with commas, any rel case and several rel values", () => {
		const url = "https://reg.example.com/v2/acme/app/tags/list?last=x";
		for (const link of [
			'</v2/acme/app/tags/list?last=x>; title="page, two"; rel="next"',
			'</v2/acme/app/tags/list?last=x>; title="a \\"quoted, comma\\""; rel="next"',
			'</v2/acme/app/tags/list?last=x>; REL="Next"',
			'</v2/acme/app/tags/list?last=x>; rel="prefetch next"',
			'</v2/acme/app/tags/list?n=1>; rel="first"; title="x, y", </v2/acme/app/tags/list?last=x>;rel=next',
		]) {
			expect(next(link)).toEqual(nextUrl(url));
		}
	});

	it("only a response without a Link header is the last page", () => {
		expect(next(undefined)).toEqual({ kind: "complete" });
	});

	it("fails closed on a Link header it cannot use", () => {
		for (const [link, reason] of [
			["", "names no next page"],
			['</v2/acme/app/tags/list?n=10>; rel="prev"', "names no next page"],
			['</v2/acme/app/tags/list?last=x>; rel="next"; title="unterminated', "cannot be parsed"],
			['</v2/acme/app/tags/list?last=x; rel="next"', "cannot be parsed"],
			['/v2/acme/app/tags/list?last=x; rel="next"', "cannot be parsed"],
			[
				'</v2/acme/app/tags/list?last=x>; rel="next", </v2/acme/app/tags/list?last=y>; rel="next"',
				"more than one next page",
			],
		] as const) {
			const result = next(link);
			expect(result.kind).toBe("unusable");
			expect(result.kind === "unusable" && result.reason).toContain(reason);
		}
	});

	it("refuses a next page the credentials must not go to", () => {
		for (const link of [
			'<https://evil.test/v2/acme/app/tags/list?last=x>; rel="next"',
			'<http://reg.example.com/v2/acme/app/tags/list?last=x>; rel="next"',
			'<https://reg.example.com:444/v2/acme/app/tags/list?last=x>; rel="next"',
			'<//evil.test/v2/acme/app/tags/list>; rel="next"',
			'<https://u:p@reg.example.com/v2/acme/app/tags/list>; rel="next"',
			'</v2/acme/other/tags/list?last=x>; rel="next"',
			'</v2/acme/app/manifests/latest>; rel="next"',
			'</v2/acme/%E0%A4%A/tags/list>; rel="next"',
		]) {
			const result = next(link);
			expect(result.kind).toBe("unusable");
			expect(result.kind === "unusable" && result.reason).toContain(
				"somewhere other than this repository's tag listing",
			);
		}
	});

	it("parses a tag list body", () => {
		expect(parseTagList('{"name":"acme/app","tags":["latest","dpl-a","bad tag"]}')).toEqual([
			"latest",
			"dpl-a",
		]);
		expect(parseTagList('{"name":"acme/app","tags":null}')).toEqual([]);
		expect(parseTagList("not json")).toBeNull();
		expect(parseTagList('{"tags":"latest"}')).toBeNull();
	});
});

describe("curl config and command", () => {
	const password = 'p"a\\ss$`word;|&';

	it("puts the password in the stdin config only, never in the command", () => {
		const config = buildRegistryCurlConfig({
			requests: [{ id: 0, method: "GET", url: "http://localhost:5000/v2/" }],
			username: "ci",
			password,
		});
		expect(config).toContain('user = "ci:p\\"a\\\\ss$`word;|&"');
		expect(REGISTRY_CURL_COMMAND).not.toContain(password);
		expect(REGISTRY_CURL_COMMAND).toContain("--config -");
		expect(REGISTRY_CURL_COMMAND).not.toMatch(/(--user|-u )/);
	});

	it("builds one block per request with the right options", () => {
		const config = buildRegistryCurlConfig({
			requests: [
				{ id: 0, method: "HEAD", url: "http://r/v2/a/manifests/t", manifest: true },
				{
					id: 1,
					method: "GET",
					url: "http://r/v2/a/manifests/u",
					manifest: true,
					includeHeaders: true,
				},
				{ id: 2, method: "DELETE", url: "http://r/v2/a/manifests/sha256:x" },
			],
			username: "ci",
			password: "pw",
		});
		const blocks = config.trim().split("\nnext\n");
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toMatch(/^head$/m);
		expect(blocks[0]).toContain("Accept: application/vnd.docker.distribution.manifest.v2+json");
		expect(blocks[1]).toMatch(/^include$/m);
		expect(blocks[2]).toContain('request = "DELETE"');
		expect(blocks[2]).not.toContain("Accept");
		for (const [id, block] of blocks.entries()) {
			expect(block).toMatch(/^globoff$/m);
			expect(block).toContain(`@@DPL ${id} %{http_code}`);
		}
	});

	it("omits credentials for an anonymous registry", () => {
		const config = buildRegistryCurlConfig({
			requests: [{ id: 0, method: "GET", url: "http://r/v2/" }],
			username: "",
			password: "",
		});
		expect(config).not.toContain("user =");
	});

	it("refuses values with line breaks", () => {
		expect(() => curlConfigQuote("a\nb")).toThrow();
		expect(() =>
			buildRegistryCurlConfig({
				requests: [{ id: 0, method: "GET", url: "http://r/v2/" }],
				username: "ci",
				password: "line1\nline2",
			}),
		).toThrow();
	});

	it("parses responses by request id", () => {
		const out = [
			'{"tags":["a"]}',
			"@@DPL 0 200",
			`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(1)}\r\nContent-Type: x\r\n\r\n`,
			"@@DPL 1 200",
			`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(2)}\r\n\r\n{"manifests":[]}`,
			"@@DPL 2 200",
			"",
			"@@DPL 3 000",
			"",
		].join("\n");
		const responses = parseRegistryResponses(out);
		expect(responses.get(0)).toMatchObject({ status: 200, body: '{"tags":["a"]}' });
		expect(responses.get(1)?.headers["docker-content-digest"]).toBe(digest(1));
		expect(responses.get(1)?.body).toBe("");
		expect(responses.get(2)?.headers["docker-content-digest"]).toBe(digest(2));
		expect(responses.get(2)?.body).toBe('{"manifests":[]}');
		expect(responses.get(3)?.status).toBe(0);
	});

	describe("output cut off by a dropped session", () => {
		const index = JSON.stringify({
			manifests: [img(7), img(8)],
		});
		// what curl prints for: GET kept-a, GET kept-b (an index), GET kept-c
		const full = [
			`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(1)}\r\nContent-Length: 2\r\n\r\n{}`,
			"@@DPL 0 200",
			`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(2)}\r\nContent-Length: ${index.length}\r\n\r\n${index}`,
			"@@DPL 1 200",
			`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(3)}\r\n\r\n{}`,
			"@@DPL 2 200",
			"",
		].join("\n");
		const second = full.indexOf("HTTP/1.1", 1);
		const cuts = {
			"inside the headers": full.indexOf("Docker-Content", second) + 9,
			"right after the headers": full.indexOf("\r\n\r\n", second) + 4,
			"inside the index body": full.indexOf(digest(8), second) + 30,
			"at the end of the body, before the marker": full.indexOf("\n@@DPL 1"),
			"inside the marker": full.indexOf("@@DPL 1") + 7,
			"before the marker's line end": full.indexOf("@@DPL 1 200") + 11,
		};
		for (const [where, cut] of Object.entries(cuts)) {
			it(`${where}: the cut response has no entry, the one before is intact`, () => {
				const responses = parseRegistryResponses(full.slice(0, cut), [0, 1, 2]);
				expect([...responses.keys()]).toEqual([0]);
				expect(responses.get(0)?.headers["docker-content-digest"]).toBe(digest(1));
				expect(responses.get(0)?.body).toBe("{}");
			});
		}

		it("reads everything once the marker is complete", () => {
			const responses = parseRegistryResponses(full, [0, 1, 2]);
			expect([...responses.keys()]).toEqual([0, 1, 2]);
			expect(getManifestChildDigests(responses.get(1)?.body as string)).toEqual([
				digest(7),
				digest(8),
			]);
			expect(isBodyTruncated(responses.get(1) as RegistryResponse)).toBe(false);
		});

		it("a body curl cut off itself (max-time: marker and status still written) is caught", () => {
			// curl stops the transfer mid-body and still writes `@@DPL 1 200`
			const cutBody = index.slice(0, 40);
			const out = full.replace(index, cutBody);
			const responses = parseRegistryResponses(out, [0, 1, 2]);
			const response = responses.get(1) as RegistryResponse;
			expect(response.status).toBe(200);
			expect(isBodyTruncated(response)).toBe(true);
			// and without a Content-Length, the cut index is unreadable, never "no children"
			expect(getManifestChildDigests(response.body)).toBeNull();
		});

		it("never attributes a response to another id", () => {
			// a marker-shaped line inside a body, out of order: parsing stops there
			const spoofed = [
				`HTTP/1.1 200 OK\r\n\r\n{"a":"`,
				"@@DPL 2 200",
				`"}`,
				"@@DPL 0 200",
				"",
			].join("\n");
			expect([...parseRegistryResponses(spoofed, [0, 1, 2]).keys()]).toEqual([]);
			// a marker for an id that was not asked for, or a repeated one, ends it too
			const repeated = ["{}", "@@DPL 0 200", "{}", "@@DPL 0 200", "{}", "@@DPL 1 200", ""].join(
				"\n",
			);
			expect([...parseRegistryResponses(repeated, [0, 1]).keys()]).toEqual([0]);
			expect([...parseRegistryResponses(repeated).keys()]).toEqual([0]);
			// a marker that does not start its own line is body text, not a marker
			// (checked below)
		});

		it("records a repeated header instead of letting the last one win", () => {
			const out = [
				'HTTP/1.1 200 OK\r\nLink: </v2/a/tags/list?last=x>; rel="next"\r\nlink: </v2/a/tags/list?last=y>; rel="next"\r\n\r\n{"tags":[]}',
				"@@DPL 0 200",
				`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(1)}\r\nDocker-Content-Digest: ${digest(2)}\r\nContent-Length: 2\r\nContent-Length: 3\r\nContent-Type: a\r\nContent-Type: b\r\n\r\n{}`,
				"@@DPL 1 200",
				`HTTP/1.1 200 OK\r\nDocker-Content-Digest: ${digest(3)}\r\nconstructor: x\r\n__proto__: y\r\n\r\n{}`,
				"@@DPL 2 200",
				"",
			].join("\n");
			const responses = parseRegistryResponses(out, [0, 1, 2]);
			const listing = responses.get(0) as RegistryResponse;
			const manifest = responses.get(1) as RegistryResponse;
			const plain = responses.get(2) as RegistryResponse;
			expect(listing.repeatedHeaders).toEqual(["link"]);
			expect(hasRepeatedHeader(listing, ["link"])).toBe(true);
			expect(hasRepeatedHeader(listing, RELIED_ON_HEADERS)).toBe(false);
			expect(manifest.repeatedHeaders.sort()).toEqual([
				"content-length",
				"content-type",
				"docker-content-digest",
			]);
			for (const name of RELIED_ON_HEADERS) {
				expect(hasRepeatedHeader(manifest, [name])).toBe(true);
			}
			// names that are object keys elsewhere are plain headers here
			expect(plain.repeatedHeaders).toEqual([]);
			expect(plain.headers.constructor).toBe("x");
			expect(plain.headers["docker-content-digest"]).toBe(digest(3));
		});

		it("does not read a marker inside a line as a marker", () => {
			const inline = ['{"x":"@@DPL 0 200', '"}', "@@DPL 0 200", ""].join("\n");
			expect(parseRegistryResponses(inline, [0]).get(0)?.body).toBe('{"x":"@@DPL 0 200\n"}');
		});
	});

	it("reads the override files back by marker", () => {
		const command = getReadFilesCommand([quote(["/a b/one"]), quote(["/two"])]);
		expect(command).toContain("'/a b/one'");
		expect(
			splitFileOutput("@@DPL-FILE /one\nservices: {}\n\n@@DPL-FILE /two\n\n"),
		).toEqual(["services: {}", ""]);
	});
});

// The same config and parser against real curl and a registry-shaped http
// server: proves the syntax curl is fed, the stdin config, basic auth and the
// write-out markers, none of which a hand-written fake can.
const hasCurl = spawnSync("curl", ["--version"]).status === 0;

describe.skipIf(!hasCurl)("against real curl", () => {
	it("round-trips auth, HEAD, GET with headers, and DELETE", async () => {
		const password = 'wi"ld\\pass';
		const seen: { method?: string; url?: string; authorization?: string }[] = [];
		const server = createServer((req, res) => {
			seen.push({
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization,
			});
			const expected = `Basic ${Buffer.from(`ci:${password}`).toString("base64")}`;
			if (req.headers.authorization !== expected) {
				res.writeHead(401).end();
				return;
			}
			if (req.url === "/v2/") {
				res.writeHead(200).end("{}");
			} else if (req.url?.startsWith("/v2/acme/app/tags/list")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ name: "acme/app", tags: ["latest", "dpl-a"] }));
			} else if (req.method === "DELETE") {
				res.writeHead(405).end();
			} else if (req.url?.startsWith("/v2/acme/app/manifests/")) {
				res.writeHead(200, {
					"Docker-Content-Digest": digest(5),
					"content-type": "application/vnd.docker.distribution.manifest.v2+json",
					...(req.headers.accept?.includes("manifest.v2+json")
						? {}
						: { "x-no-accept": "1" }),
				});
				res.end(req.method === "HEAD" ? undefined : '{"schemaVersion":2}');
			} else {
				res.writeHead(404).end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const config = buildRegistryCurlConfig({
				requests: [
					{ id: 0, method: "GET", url: `${base}/v2/` },
					{ id: 1, method: "GET", url: `${base}/v2/acme/app/tags/list?n=1000` },
					{
						id: 2,
						method: "HEAD",
						url: `${base}/v2/acme/app/manifests/dpl-a`,
						manifest: true,
					},
					{
						id: 3,
						method: "GET",
						url: `${base}/v2/acme/app/manifests/latest`,
						manifest: true,
						includeHeaders: true,
					},
					{ id: 4, method: "DELETE", url: `${base}/v2/acme/app/manifests/${digest(5)}` },
					{ id: 5, method: "GET", url: "http://127.0.0.1:1/v2/" },
				],
				username: "ci",
				password,
			});
			// async: the fake registry runs in this very process
			const result = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
				const child = spawn("curl", ["--config", "-"]);
				const chunks: Buffer[] = [];
				child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
				child.on("error", reject);
				child.on("close", () => resolve({ stdout: Buffer.concat(chunks) }));
				child.stdin.end(config);
			});
			// (exit status is non-zero because the last request cannot connect; the
			// build-server command ends in `exit 0` for exactly that reason)
			const responses = parseRegistryResponses(result.stdout.toString());
			expect(responses.get(0)?.status).toBe(200);
			expect(JSON.parse(responses.get(1)?.body ?? "{}").tags).toEqual([
				"latest",
				"dpl-a",
			]);
			expect(responses.get(2)?.headers["docker-content-digest"]).toBe(digest(5));
			expect(responses.get(2)?.headers["x-no-accept"]).toBeUndefined();
			expect(responses.get(3)?.headers["docker-content-digest"]).toBe(digest(5));
			expect(responses.get(3)?.body).toBe('{"schemaVersion":2}');
			expect(responses.get(4)?.status).toBe(405);
			expect(responses.get(5)?.status).toBe(0);
			// the password only ever travelled as an Authorization header
			expect(seen.every((entry) => entry.authorization)).toBe(true);
			expect(result.stdout.toString()).not.toContain(password);
		} finally {
			server.close();
		}
	});
});

describe("the detached delete job: config, commands and output", () => {
	const key = getRegistryJobKey("registry-1");
	const token = "0123456789abcdef";
	const dg = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
	const entries = [1, 2].map((n) => ({
		id: n - 1,
		digest: dg(n),
		deleteUrl: `http://localhost:5000/v2/a/manifests/${dg(n)}`,
		guards: [
			{ url: "http://localhost:5000/v2/a/manifests/latest", optional: true },
			{ url: "http://localhost:5000/v2/a/manifests/dpl-cur" },
		],
	}));

	it("config: per entry the guard GETs, then the DELETE with the long max-time, closed by the end marker", () => {
		const config = buildRegistryDeleteJobConfig({
			entries,
			username: "ci",
			password: "hunter2",
		});
		expect(config.match(/# @@DPL-ENTRY /g)).toHaveLength(2);
		expect(config).toContain(`# @@DPL-ENTRY 0 ${dg(1)} 2\n`);
		expect(config.match(/request = "DELETE"/g)).toHaveLength(2);
		expect(config.match(/max-time = 240/g)).toHaveLength(2);
		// one curl config per guard (the optional one is flagged), short limit,
		// headers and body asked for
		expect(config.match(/# @@DPL-GUARD 1\n/g)).toHaveLength(2);
		expect(config.match(/# @@DPL-GUARD 0\n/g)).toHaveLength(2);
		expect(config.match(/max-time = 20\n/g)).toHaveLength(4);
		expect(config.match(/^include$/gm)).toHaveLength(4);
		expect(config.trimEnd().endsWith("# @@DPL-END")).toBe(true);
		expect(config).toContain("hunter2");
		expect(() => buildRegistryDeleteJobConfig({ entries: [{ ...(entries[0] as object), guards: [] } as never] })).toThrow();
		expect(() => buildRegistryDeleteJobConfig({ entries: [{ ...(entries[0] as object), digest: "x" } as never] })).toThrow();
		// a read config keeps the short limit
		expect(
			buildRegistryCurlConfig({
				requests: [{ id: 0, method: "GET", url: "http://localhost:5000/v2/" }],
			}),
		).toContain("max-time = 20\n");
	});

	it("commands carry no secret and only accept a hashed key, a hex token and a plain directory", () => {
		const start = buildRegistryDeleteJobCommand({ key, token });
		const status = buildRegistryJobStatusCommand({ key });
		for (const command of [start, status]) {
			expect(command).not.toContain("hunter2");
			expect(command).toContain(`dokploy-registry-prune-${key}.lock`);
			expect(command).toContain(`dokploy-registry-prune-${key}.result`);
			expect(command).toContain("flock -n 9");
		}
		// no mkdir/pid/stale-lock takeover: the kernel owns the lock
		expect(start).not.toMatch(/rmdir|mkdir|kill -0|-mmin/);
		expect(start).toContain("@@DPL-NOFLOCK");
		// the registry id itself never reaches a path
		expect(key).toMatch(/^[a-f0-9]{16}$/);
		expect(key).not.toContain("registry-1");
		expect(getRegistryJobKey("registry-2")).not.toBe(key);
		// rows that name one endpoint share the files
		expect(getRegistryLockKey({ registryUrl: "https://localhost:5000" }, "a")).toBe(
			getRegistryLockKey({ registryUrl: "http://localhost:5000/" }, "b"),
		);
		expect(getRegistryLockKey({ registryUrl: "" }, "a")).toBe(getRegistryJobKey("a"));
		expect(() => buildRegistryDeleteJobCommand({ key: "../x", token })).toThrow();
		expect(() => buildRegistryDeleteJobCommand({ key, token: "a;b" })).toThrow();
		expect(() => buildRegistryDeleteJobCommand({ key, token, dir: "/tmp/$(x)" })).toThrow();
		expect(() => buildRegistryDeleteJobCommand({ key, token, maxSeconds: 0 })).toThrow();
		expect(() => buildRegistryJobStatusCommand({ key, dir: "relative" })).toThrow();
		// the job body sits in single quotes: nothing in it may close them
		const body = /JOB='([\s\S]*?)'\n/.exec(start)?.[1] ?? "";
		expect(body.length).toBeGreaterThan(50);
		expect(body).not.toContain("'");
		// a deploy's stop marker is a plain touch of the registry's own file
		expect(buildRegistryPruneStopCommand({ key })).toBe(
			`touch /tmp/dokploy-registry-prune-${key}.stop >/dev/null 2>&1 || true;`,
		);
	});

	it("parses what the commands print", () => {
		expect(parseRegistryJobOutput("@@DPL-NOCURL\n").kind).toBe("nocurl");
		expect(parseRegistryJobOutput("@@DPL-NOFLOCK\n").kind).toBe("noflock");
		expect(parseRegistryJobOutput("@@DPL-FAILED\n").kind).toBe("failed");
		expect(parseRegistryJobOutput("@@DPL-BUSY\n").kind).toBe("busy");
		expect(parseRegistryJobOutput("@@DPL-STARTED\n").kind).toBe("started");
		expect(parseRegistryJobOutput("@@DPL-LATE\n").kind).toBe("late");
		expect(parseRegistryJobOutput("").kind).toBe("unknown");
		expect(parseRegistryJobOutput("garbage").kind).toBe("unknown");
		expect(parseRegistryJobOutput("@@DPL-IDLE\n")).toEqual({
			kind: "idle",
			token: null,
			responses: new Map(),
		});
		// 000 is a DELETE the job skipped on purpose
		const idle = parseRegistryJobOutput(
			`@@DPL-IDLE\n@@DPL-JOB ${token}\n\n@@DPL 0 202\n\n@@DPL 1 000\n\n@@DPL 2 500\n`,
			[0, 1, 2],
		);
		if (idle.kind !== "idle") throw new Error("expected idle");
		expect(idle.token).toBe(token);
		expect([...idle.responses].map(([id, response]) => [id, response.status])).toEqual([
			[0, 202],
			[1, 0],
			[2, 500],
		]);
		const cut = parseRegistryJobOutput(
			`@@DPL-IDLE\n@@DPL-JOB ${token}\n\n@@DPL 0 202\n\n@@DPL 1 5`,
			[0, 1],
		);
		if (cut.kind !== "idle") throw new Error("expected idle");
		expect(cut.responses.size).toBe(1);
	});
});

// The job itself, run by a real sh against real curl and flock and a
// registry-shaped server: its lock, its detaching, its serial DELETEs, the
// re-check before each one, its stop conditions and its result file.
const hasSh = process.platform === "linux" && spawnSync("sh", ["-c", "true"]).status === 0;
const hasFlock = hasSh && spawnSync("sh", ["-c", "command -v flock"]).status === 0;

describe.skipIf(!hasCurl || !hasFlock)("the detached delete job against real sh, flock and curl", () => {
	const password = 'wi"ld\\pass';
	const dg = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	const runCommand = (command: string, input?: string, env?: NodeJS.ProcessEnv) =>
		new Promise<string>((resolve, reject) => {
			const child = spawn("/bin/sh", ["-c", command], { env: env ?? process.env });
			const chunks: Buffer[] = [];
			child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
			child.on("error", reject);
			// a starter that finds the lock held exits without reading its input
			child.stdin.on("error", () => {});
			child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
			child.stdin.end(input ?? "");
		});

	/** A registry stand-in: `latest` resolves to `state.latest`; every DELETE takes `delayMs`. */
	const startRegistry = async (delayMs: number, onDelete?: (digest: string) => void) => {
		const state = {
			latest: dg(9999),
			/** how `latest` answers: ok, 404, no digest header, a body cut off mid-transfer, or a repeated header */
			latestMode: "ok" as "ok" | "404" | "noheader" | "truncated" | "twoheaders" | "badheader",
			active: 0,
			maxActive: 0,
			deleted: [] as string[],
			gets: 0,
		};
		const server = createServer((req, res) => {
			const expected = `Basic ${Buffer.from(`ci:${password}`).toString("base64")}`;
			if (req.headers.authorization !== expected) {
				res.writeHead(401).end();
				return;
			}
			if (req.method === "GET" && req.url?.endsWith("/manifests/latest")) {
				state.gets += 1;
				if (state.latestMode === "404") {
					res.writeHead(404).end();
				} else if (state.latestMode === "noheader") {
					res.writeHead(200).end("{}");
				} else if (state.latestMode === "badheader") {
					res.writeHead(200, { "Docker-Content-Digest": "sha256:xyz" }).end("{}");
				} else if (state.latestMode === "twoheaders") {
					res.writeHead(200, [
						["Docker-Content-Digest", state.latest],
						["Docker-Content-Digest", state.latest],
					]);
					res.end("{}");
				} else if (state.latestMode === "truncated") {
					res.writeHead(200, {
						"Docker-Content-Digest": state.latest,
						"Content-Length": "100",
					});
					res.write("{}");
					setTimeout(() => res.destroy(), 20);
				} else {
					res.writeHead(200, { "Docker-Content-Digest": state.latest });
					res.end("{}");
				}
				return;
			}
			state.active += 1;
			state.maxActive = Math.max(state.maxActive, state.active);
			const digest = (req.url ?? "").split("/manifests/")[1] as string;
			setTimeout(() => {
				state.active -= 1;
				state.deleted.push(digest);
				onDelete?.(digest);
				res.writeHead(202).end();
			}, delayMs);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const entries = (count: number, optionalLatest = false) =>
			Array.from({ length: count }, (_, id) => ({
				id,
				digest: dg(id + 1),
				deleteUrl: `${base}/v2/a/manifests/${dg(id + 1)}`,
				guards: [{ url: `${base}/v2/a/manifests/latest`, optional: optionalLatest }],
			}));
		return { state, server, base, entries };
	};

	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), "dpl-job-"));
		const key = getRegistryJobKey(`registry-${dir}`);
		const files = (suffix: string) => join(dir, `dokploy-registry-prune-${key}.${suffix}`);
		const start = (token: string, extra: { maxSeconds?: number } = {}) =>
			buildRegistryDeleteJobCommand({ key, token, dir, ...extra });
		const status = buildRegistryJobStatusCommand({ key, dir });
		return { dir, key, files, start, status };
	};

	/** Waits for the job to let go of the lock and returns what it left. */
	const settle = async (status: string, ids: number[]) => {
		let result = parseRegistryJobOutput(await runCommand(status), ids);
		for (let tries = 0; tries < 100 && result.kind === "busy"; tries++) {
			await sleep(100);
			result = parseRegistryJobOutput(await runCommand(status), ids);
		}
		if (result.kind !== "idle") throw new Error(`job did not finish: ${result.kind}`);
		return result;
	};
	const statusesOf = (result: { responses: Map<number, RegistryResponse> }) =>
		[...result.responses.values()].map((response) => response.status);

	it("runs its DELETEs one at a time after the starting command has returned, under a lock", async () => {
		const { dir, start, status, files } = setup();
		const registry = await startRegistry(120);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(3),
				username: "ci",
				password,
			});
			const started = Date.now();
			const out = await runCommand(start("aaaaaaaaaaaaaaaa"), config);
			expect(parseRegistryJobOutput(out).kind).toBe("started");
			// the command is back while the job (3 x 120 ms) is still going
			expect(Date.now() - started).toBeLessThan(330);

			// a second start finds the lock held and sends nothing
			const second = await runCommand(start("bbbbbbbbbbbbbbbb"), config);
			expect(parseRegistryJobOutput(second).kind).toBe("busy");
			expect(parseRegistryJobOutput(await runCommand(status)).kind).toBe("busy");

			const result = await settle(status, [0, 1, 2]);
			expect(result.token).toBe("aaaaaaaaaaaaaaaa");
			expect(statusesOf(result)).toEqual([202, 202, 202]);
			expect(registry.state.maxActive).toBe(1);
			expect(registry.state.deleted).toEqual([1, 2, 3].map(dg));
			// private files; the lock file is never removed by anyone
			expect(statSync(files("lock")).mode & 0o777).toBe(0o600);
			expect(statSync(files("result")).mode & 0o777).toBe(0o600);

			// the lock is free again
			const third = await runCommand(start("cccccccccccccccc"), config);
			expect(parseRegistryJobOutput(third).kind).toBe("started");
			await settle(status, [0, 1, 2]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("200 simultaneous starts run at most one job", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(1500);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(2),
				username: "ci",
				password,
			});
			const outputs = await Promise.all(
				Array.from({ length: 200 }, (_, index) =>
					runCommand(start(`${index.toString(16).padStart(16, "0")}`), config),
				),
			);
			const kinds = outputs.map((output) => parseRegistryJobOutput(output).kind);
			expect(kinds.filter((kind) => kind === "started" || kind === "late")).toHaveLength(1);
			expect(kinds.filter((kind) => kind === "busy")).toHaveLength(199);
			const result = await settle(status, [0, 1]);
			expect(statusesOf(result)).toEqual([202, 202]);
			// two DELETEs reached the registry in all, never two at once
			expect(registry.state.deleted).toHaveLength(2);
			expect(registry.state.maxActive).toBe(1);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("skips a DELETE whose digest latest now points at (a revert re-pushed it before the job began)", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(20);
		registry.state.latest = dg(2);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(3),
				username: "ci",
				password,
			});
			await runCommand(start("aaaaaaaaaaaaaaaa"), config);
			const result = await settle(status, [0, 1, 2]);
			expect(statusesOf(result)).toEqual([202, 0, 202]);
			expect(registry.state.deleted).toEqual([dg(1), dg(3)]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("re-reads latest before every DELETE: a push in the middle of the job saves the rest", async () => {
		const { dir, start, status } = setup();
		// the first DELETE is still on the wire when a deploy re-pushes digest 3
		const registry = await startRegistry(100, (digest) => {
			if (digest === dg(1)) registry.state.latest = dg(3);
		});
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(4),
				username: "ci",
				password,
			});
			await runCommand(start("aaaaaaaaaaaaaaaa"), config);
			const result = await settle(status, [0, 1, 2, 3]);
			expect(registry.state.deleted).toEqual([dg(1), dg(2), dg(4)]);
			expect(statusesOf(result)).toEqual([202, 202, 0, 202]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("deletes nothing when the guard tags cannot be read", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(20);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(2).map((entry) => ({
					...entry,
					guards: [
						{ url: `${registry.base}/v2/a/manifests/latest` },
						{ url: "http://127.0.0.1:1/x" },
					],
				})),
				username: "ci",
				password,
			});
			await runCommand(start("aaaaaaaaaaaaaaaa"), config);
			const result = await settle(status, [0, 1]);
			expect(statusesOf(result)).toEqual([0, 0]);
			expect(registry.state.deleted).toEqual([]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	for (const [what, mode] of [
		["a 404", "404"],
		["a 200 without a Docker-Content-Digest header", "noheader"],
		["a 200 with a malformed digest", "badheader"],
		["a 200 with two digest headers", "twoheaders"],
		["a 200 whose body was cut off", "truncated"],
	] as const) {
		it(`fails closed: ${what} from a guard sends no DELETE`, async () => {
			const { dir, start, status } = setup();
			const registry = await startRegistry(20);
			registry.state.latestMode = mode;
			try {
				const config = buildRegistryDeleteJobConfig({
					entries: registry.entries(2),
					username: "ci",
					password,
				});
				await runCommand(start("aaaaaaaaaaaaaaaa"), config);
				const result = await settle(status, [0, 1]);
				expect(statusesOf(result)).toEqual([0, 0]);
				expect(registry.state.deleted).toEqual([]);
				expect(registry.state.gets).toBeGreaterThan(0);
			} finally {
				registry.server.close();
				rmSync(dir, { recursive: true, force: true });
			}
		}, 30_000);
	}

	it("sends the DELETE after a clean 200, and after a 404 only for a guard marked optional", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(20);
		try {
			await runCommand(
				start("aaaaaaaaaaaaaaaa"),
				buildRegistryDeleteJobConfig({ entries: registry.entries(2), username: "ci", password }),
			);
			expect(statusesOf(await settle(status, [0, 1]))).toEqual([202, 202]);

			registry.state.latestMode = "404";
			registry.state.deleted.length = 0;
			await runCommand(
				start("bbbbbbbbbbbbbbbb"),
				buildRegistryDeleteJobConfig({ entries: registry.entries(2), username: "ci", password }),
			);
			expect(statusesOf(await settle(status, [0, 1]))).toEqual([0, 0]);
			expect(registry.state.deleted).toEqual([]);

			await runCommand(
				start("cccccccccccccccc"),
				buildRegistryDeleteJobConfig({
					entries: registry.entries(2, true),
					username: "ci",
					password,
				}),
			);
			expect(statusesOf(await settle(status, [0, 1]))).toEqual([202, 202]);
			expect(registry.state.deleted).toEqual([dg(1), dg(2)]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("an optional guard still skips the DELETE on any other failure", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(20);
		registry.state.latestMode = "noheader";
		try {
			await runCommand(
				start("aaaaaaaaaaaaaaaa"),
				buildRegistryDeleteJobConfig({
					entries: registry.entries(1, true),
					username: "ci",
					password,
				}),
			);
			expect(statusesOf(await settle(status, [0]))).toEqual([0]);
			expect(registry.state.deleted).toEqual([]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("stops before its next DELETE when a deploy touches the stop marker", async () => {
		const { dir, start, status, files } = setup();
		const registry = await startRegistry(150, (digest) => {
			// the deploy's push begins while the first DELETE is on the wire
			if (digest === dg(1)) writeFileSync(files("stop"), "");
		});
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(4),
				username: "ci",
				password,
			});
			await runCommand(start("aaaaaaaaaaaaaaaa"), config);
			const result = await settle(status, [0, 1, 2, 3]);
			expect(statusesOf(result)).toEqual([202]);
			expect(registry.state.deleted).toEqual([dg(1)]);

			// a marker from before the job does not stop a new one
			await runCommand(start("bbbbbbbbbbbbbbbb"), config);
			const again = await settle(status, [0, 1, 2, 3]);
			expect(again.token).toBe("bbbbbbbbbbbbbbbb");
			expect(registry.state.deleted.length).toBeGreaterThan(1);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("stops sending at the wall-clock deadline", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(1300);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(5),
				username: "ci",
				password,
			});
			await runCommand(start("aaaaaaaaaaaaaaaa", { maxSeconds: 1 }), config);
			const result = await settle(status, [0, 1, 2, 3, 4]);
			expect(statusesOf(result)).toEqual([202]);
			expect(registry.state.deleted).toEqual([dg(1)]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("never runs a config that was cut off before the end marker", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(20);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(2),
				username: "ci",
				password,
			});
			const out = await runCommand(
				start("aaaaaaaaaaaaaaaa"),
				config.slice(0, config.indexOf("# @@DPL-END")),
			);
			expect(parseRegistryJobOutput(out).kind).toBe("late");
			await sleep(300);
			expect(registry.state.deleted).toEqual([]);
			expect(parseRegistryJobOutput(await runCommand(status)).kind).toBe("idle");
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps the password out of every argv and environment while the job runs", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(900);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(2),
				username: "ci",
				password,
			});
			await runCommand(start("aaaaaaaaaaaaaaaa"), config);
			const leaks: string[] = [];
			for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
				for (const file of ["cmdline", "environ"]) {
					try {
						if (readFileSync(`/proc/${pid}/${file}`, "utf8").includes(password)) {
							leaks.push(`${pid}/${file}`);
						}
					} catch {
						// gone, or not ours
					}
				}
			}
			expect(leaks).toEqual([]);
			await settle(status, [0, 1]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("lets go of the lock when the job is killed, with no stale-lock timer", async () => {
		const { dir, start, status } = setup();
		const registry = await startRegistry(800);
		try {
			const config = buildRegistryDeleteJobConfig({
				entries: registry.entries(3),
				username: "ci",
				password,
			});
			const token = "feedfeedfeedfeed";
			await runCommand(start(token), config);
			expect(parseRegistryJobOutput(await runCommand(status)).kind).toBe("busy");
			spawnSync("pkill", ["-9", "-f", token]);
			// whatever curl was in flight finishes, then the kernel has released it
			const result = await settle(status, [0, 1, 2]);
			expect(result.kind).toBe("idle");
			expect(parseRegistryJobOutput(await runCommand(start("abababababababab"), config)).kind).toBe(
				"started",
			);
			await settle(status, [0, 1, 2]);
		} finally {
			registry.server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("does nothing and says so when the build server has no flock", async () => {
		const { dir, start } = setup();
		const bin = mkdtempSync(join(tmpdir(), "dpl-bin-"));
		try {
			const curl = spawnSync("sh", ["-c", "command -v curl"]).stdout.toString().trim();
			symlinkSync(curl, join(bin, "curl"));
			const out = await runCommand(start("aaaaaaaaaaaaaaaa"), "", { ...process.env, PATH: bin });
			expect(parseRegistryJobOutput(out).kind).toBe("noflock");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(bin, { recursive: true, force: true });
		}
	});
});
