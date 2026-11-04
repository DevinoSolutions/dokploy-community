import {
	decideApplicationImage,
	isStoredComposeSource,
	pinComposeImage,
	repositoryOfReference,
	runningImageRepository,
} from "@dokploy/server/services/github-deployments/service-image";
import { describe, expect, it } from "vitest";

const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;
const REPO = "ghcr.io/devinosolutions/sendly-web";
const payload = (repository = REPO) => ({
	kind: "deploy" as const,
	image: `${repository}@${NEW}`,
	repository,
	digest: NEW,
});

describe("repositoryOfReference", () => {
	it("strips a tag and a digest but keeps a registry port", () => {
		expect(repositoryOfReference(`${REPO}:1.2@${OLD}`)).toBe(REPO);
		expect(repositoryOfReference(`${REPO}:latest`)).toBe(REPO);
		expect(repositoryOfReference("host:5000/a/b")).toBe("host:5000/a/b");
	});
});

describe("decideApplicationImage", () => {
	it("moves a docker application to a new digest of the image it already runs", () => {
		expect(
			decideApplicationImage(
				{ sourceType: "docker", dockerImage: `${REPO}@${OLD}` },
				payload(),
				"DevinoSolutions",
			),
		).toEqual({ ok: true, dockerImage: `${REPO}@${NEW}` });
		expect(
			decideApplicationImage(
				{ sourceType: "docker", dockerImage: `${REPO}:prod` },
				payload(),
				"DevinoSolutions",
			).ok,
		).toBe(true);
	});

	it("refuses an image from another repository than the one the application runs", () => {
		const result = decideApplicationImage(
			{ sourceType: "docker", dockerImage: `${REPO}@${OLD}` },
			payload("ghcr.io/attacker/miner"),
			"DevinoSolutions",
		);
		expect(result.ok).toBe(false);
	});

	it("refuses an application that does not deploy an image", () => {
		expect(
			decideApplicationImage(
				{ sourceType: "github", dockerImage: null },
				payload(),
				"DevinoSolutions",
			).ok,
		).toBe(false);
	});

	it("an application with no image yet accepts only ghcr.io/<owner>/", () => {
		const empty = { sourceType: "docker", dockerImage: null };
		expect(decideApplicationImage(empty, payload(), "DevinoSolutions").ok).toBe(
			true,
		);
		expect(
			decideApplicationImage(
				empty,
				payload("ghcr.io/other/app"),
				"DevinoSolutions",
			).ok,
		).toBe(false);
		expect(
			decideApplicationImage(
				empty,
				payload("docker.io/library/nginx"),
				"DevinoSolutions",
			).ok,
		).toBe(false);
	});
});

describe("pinComposeImage", () => {
	const compose = [
		"services:",
		"  web:",
		`    image: ${REPO}@${OLD} # pinned`,
		"    ports: ['3000:3000']",
		"  db:",
		"    image: postgres:16",
		"",
	].join("\n");

	it("replaces only the digest on the single pinned line", () => {
		const result = pinComposeImage(compose, REPO, NEW);
		expect(result).toMatchObject({
			ok: true,
			changed: true,
			previousDigest: OLD,
		});
		if (result.ok) {
			expect(result.composeFile).toBe(compose.replace(OLD, NEW));
			expect(result.composeFile).toContain("image: postgres:16");
		}
	});

	it("is a no-op when the digest is already the one asked for", () => {
		const result = pinComposeImage(compose.replace(OLD, NEW), REPO, NEW);
		expect(result).toMatchObject({ ok: true, changed: false });
	});

	it("understands list-style and quoted image lines", () => {
		const text = `x:\n  - image: "${REPO}@${OLD}"\n`;
		const result = pinComposeImage(text, REPO, NEW);
		expect(result.ok && result.composeFile).toBe(
			`x:\n  - image: "${REPO}@${NEW}"\n`,
		);
	});

	it("refuses a compose with no pinned line for that repository", () => {
		expect(pinComposeImage(compose, "ghcr.io/other/app", NEW).ok).toBe(false);
		expect(pinComposeImage(`image: ${REPO}:latest\n`, REPO, NEW).ok).toBe(
			false,
		);
	});

	it("refuses when the repository is pinned on more than one line", () => {
		const twice = `${compose}  worker:\n    image: ${REPO}@${OLD}\n`;
		expect(pinComposeImage(twice, REPO, NEW).ok).toBe(false);
	});

	it("does not treat a longer repository name as a match", () => {
		const text = `image: ${REPO}-admin@${OLD}\n`;
		expect(pinComposeImage(text, REPO, NEW).ok).toBe(false);
	});
});

describe("a service whose provider is GitHub Actions (T-13879)", () => {
	it("takes a new digest of the image it runs, like a Docker image application", () => {
		expect(
			decideApplicationImage(
				{ sourceType: "github-actions", dockerImage: `${REPO}@${OLD}` },
				payload(),
				"DevinoSolutions",
			),
		).toEqual({ ok: true, dockerImage: `${REPO}@${NEW}` });
		expect(
			decideApplicationImage(
				{ sourceType: "github-actions", dockerImage: `${REPO}@${OLD}` },
				payload("ghcr.io/other/app"),
				"DevinoSolutions",
			).ok,
		).toBe(false);
	});

	it("keeps refusing an application built from git", () => {
		expect(
			decideApplicationImage(
				{ sourceType: "github", dockerImage: null },
				payload(),
				"DevinoSolutions",
			).ok,
		).toBe(false);
	});

	it("treats a stack of that type as a stored compose file", () => {
		expect(isStoredComposeSource("raw")).toBe(true);
		expect(isStoredComposeSource("github-actions")).toBe(true);
		expect(isStoredComposeSource("github")).toBe(false);
		expect(isStoredComposeSource("git")).toBe(false);
	});
});

describe("the repository of a running image", () => {
	const DIGEST = `sha256:${"a".repeat(64)}`;

	it("is the repository of the current image, without tag or digest", () => {
		expect(runningImageRepository(`ghcr.io/org/app@${DIGEST}`)).toBe(
			"ghcr.io/org/app",
		);
		expect(
			runningImageRepository("localhost:5000/registry.devino.ca/org/app:tag"),
		).toBe("localhost:5000/registry.devino.ca/org/app");
		expect(runningImageRepository(`  ghcr.io/org/app:v1@${DIGEST} `)).toBe(
			"ghcr.io/org/app",
		);
	});

	it("is nothing for what is not an image name", () => {
		for (const value of [null, undefined, "", "   ", "${IMAGE}", "a b"]) {
			expect(runningImageRepository(value)).toBeNull();
		}
	});
});
