import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	APPLICATION_GIT_RESET,
	planApplicationFlip,
	snapshotPreviousSource,
} from "@dokploy/server/services/gha-connect/flip";
import { describe, expect, it } from "vitest";

const D = (c: string) => `sha256:${c.repeat(64)}`;

describe("planApplicationFlip", () => {
	const gitApp = {
		sourceType: "github",
		autoDeploy: true,
		repository: "voicelabs",
		owner: "DevinoSolutions",
		branch: "dev",
		githubId: "gh1",
		buildPath: "/",
		password: "secret",
		dockerImage: null,
	};

	it("does not flip an application that already deploys an image", () => {
		expect(planApplicationFlip({ sourceType: "docker" }, "x@sha256:1")).toEqual(
			{ flip: false },
		);
	});

	it("flips a git application to the image and keeps the old source whole", () => {
		const plan = planApplicationFlip(
			gitApp,
			`registry.devino.ca/voicelabs/web@${D("e")}`,
		);
		expect(plan.flip).toBe(true);
		if (!plan.flip) return;
		expect(plan.update).toMatchObject({
			...APPLICATION_GIT_RESET,
			sourceType: "docker",
			dockerImage: `registry.devino.ca/voicelabs/web@${D("e")}`,
			autoDeploy: false,
			isPreviewDeploymentsActive: false,
		});
		expect(plan.previousSource).toMatchObject({
			sourceType: "github",
			autoDeploy: true,
			repository: "voicelabs",
			owner: "DevinoSolutions",
			branch: "dev",
			githubId: "gh1",
		});
	});

	it("never keeps the registry password", () => {
		expect(snapshotPreviousSource(gitApp)).not.toHaveProperty("password");
	});
});

describe("APPLICATION_GIT_RESET", () => {
	it("matches what the application router's disconnectGitProvider writes, field for field", () => {
		const router = readFileSync(
			resolve(__dirname, "../../server/api/routers/application.ts"),
			"utf8",
		);
		const start = router.indexOf("disconnectGitProvider: protectedProcedure");
		expect(start).toBeGreaterThan(-1);
		const call = router.indexOf(
			"await updateApplication(input.applicationId, {",
			start,
		);
		expect(call).toBeGreaterThan(-1);
		const open = router.indexOf(
			"{",
			call + "await updateApplication(input.applicationId, ".length,
		);
		const close = router.indexOf("\n\t\t\t});", open);
		const body = router.slice(open + 1, close);

		const written: Record<string, unknown> = {};
		for (const line of body.split("\n")) {
			const match = line.match(/^\s*(\w+):\s*(null|false|true|"[^"]*")\s*,/);
			if (match) written[match[1] as string] = JSON.parse(match[2] as string);
		}

		const { sourceType, ...rest } = written;
		// The flip sets its own source type; everything else is the router's reset.
		expect(sourceType).toBe("github");
		expect(Object.keys(rest).length).toBeGreaterThan(25);
		expect(APPLICATION_GIT_RESET).toEqual(rest);
	});
});

import { deploySourceTypeOf } from "@dokploy/server/services/gha-connect/deploy-source";
import { planApplicationFlip as planFlip } from "@dokploy/server/services/gha-connect/flip";

describe("the github-actions provider source type", () => {
	it("deploys as an image for an application and as a stored file for compose", () => {
		expect(deploySourceTypeOf("application", "github-actions")).toBe("docker");
		expect(deploySourceTypeOf("compose", "github-actions")).toBe("raw");
		expect(deploySourceTypeOf("application", "github")).toBe("github");
		expect(deploySourceTypeOf("compose", null)).toBeNull();
	});

	it("is never flipped", () => {
		expect(planFlip({ sourceType: "github-actions" }, "x@sha256:1")).toEqual({
			flip: false,
		});
	});
});
