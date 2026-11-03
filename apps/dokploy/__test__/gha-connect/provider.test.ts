import {
	asDeployable,
	checkRedeployable,
	checkSourceTypeChange,
	copiedSourceType,
	deploySourceTypeOf,
	isGhaSourceType,
	keepsProvider,
	planSourceRestore,
	REDEPLOY_LABEL,
	redeployHint,
	withoutMissingReferences,
} from "@dokploy/server/services/gha-connect/provider";
import { describe, expect, it } from "vitest";

describe("the github-actions source type in a deploy", () => {
	it("is a Docker image source for an application and a stored file for a compose stack", () => {
		expect(deploySourceTypeOf("application", "github-actions")).toBe("docker");
		expect(deploySourceTypeOf("compose", "github-actions")).toBe("raw");
	});

	it("leaves every other source type as it is", () => {
		for (const type of ["github", "gitlab", "git", "docker", "drop", "raw"]) {
			expect(deploySourceTypeOf("application", type)).toBe(type);
			expect(deploySourceTypeOf("compose", type)).toBe(type);
		}
	});

	it("changes only the source type of a github-actions service, on a copy", () => {
		const app = {
			sourceType: "github-actions",
			dockerImage: `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`,
			appName: "shop",
		};
		const deployable = asDeployable("application", app);
		expect(deployable).toEqual({ ...app, sourceType: "docker" });
		expect(app.sourceType).toBe("github-actions");
		const git = { sourceType: "github" };
		expect(asDeployable("application", git)).toBe(git);
		const stack = { sourceType: "github-actions", composeFile: "services: {}" };
		expect(asDeployable("compose", stack).sourceType).toBe("raw");
	});

	it("recognises the type", () => {
		expect(isGhaSourceType("github-actions")).toBe(true);
		expect(isGhaSourceType("github")).toBe(false);
		expect(isGhaSourceType(null)).toBe(false);
		expect(isGhaSourceType(undefined)).toBe(false);
	});
});

describe("a manual deploy of a github-actions service", () => {
	const image = `ghcr.io/acme/shop@sha256:${"b".repeat(64)}`;

	it("redeploys the current image", () => {
		expect(
			checkRedeployable("application", {
				sourceType: "github-actions",
				dockerImage: image,
			}),
		).toEqual({ ok: true });
	});

	it("is refused before the first release, with what to do instead", () => {
		for (const dockerImage of [null, undefined, "", "  "]) {
			const result = checkRedeployable(
				"application",
				{ sourceType: "github-actions", dockerImage },
				"main",
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.message).toContain("No GitHub Actions release");
			expect(result.message).toContain("push to main");
		}
	});

	it("never judges another source type, or a compose stack (its file is the image)", () => {
		expect(
			checkRedeployable("application", {
				sourceType: "github",
				dockerImage: null,
			}),
		).toEqual({ ok: true });
		expect(
			checkRedeployable("compose", { sourceType: "github-actions" }),
		).toEqual({ ok: true });
	});

	it("says it in the words of the product", () => {
		expect(REDEPLOY_LABEL).toBe("Redeploy current image");
		expect(redeployHint("dev")).toBe(
			"To build a new version, push to dev; GitHub Actions deploys it.",
		);
		expect(redeployHint(null)).toContain("push to the tracked branch");
	});
});

describe("changing the source type of a service", () => {
	it("refuses to move a connected service off GitHub Actions, naming the way out", () => {
		for (const next of ["docker", "github", "git", "gitlab", "raw", "drop"]) {
			const refusal = checkSourceTypeChange({
				currentSourceType: "github-actions",
				connected: true,
				nextSourceType: next,
			});
			expect(refusal).toEqual({
				code: "CONFLICT",
				message: expect.stringContaining("Disconnect GitHub Actions first"),
			});
		}
	});

	it("lets a client send back the type the service already has", () => {
		expect(
			checkSourceTypeChange({
				currentSourceType: "github-actions",
				connected: true,
				nextSourceType: "github-actions",
			}),
		).toBeNull();
		expect(
			checkSourceTypeChange({
				currentSourceType: "docker",
				connected: false,
				nextSourceType: undefined,
			}),
		).toBeNull();
	});

	it("does not trap a service marked github-actions that has no connection", () => {
		expect(
			checkSourceTypeChange({
				currentSourceType: "github-actions",
				connected: false,
				nextSourceType: "docker",
			}),
		).toBeNull();
	});

	it("moves a service onto GitHub Actions only through Connect", () => {
		const refusal = checkSourceTypeChange({
			currentSourceType: "docker",
			connected: false,
			nextSourceType: "github-actions",
		});
		expect(refusal?.code).toBe("BAD_REQUEST");
		expect(refusal?.message).toContain("Connect GitHub Actions");
	});

	it("leaves ordinary source changes alone", () => {
		expect(
			checkSourceTypeChange({
				currentSourceType: "github",
				connected: false,
				nextSourceType: "docker",
			}),
		).toBeNull();
	});
});

describe("Disconnect", () => {
	it("restores the provider settings of an application", () => {
		const previousSource = {
			sourceType: "github",
			autoDeploy: true,
			branch: "dev",
			githubId: "gh-1",
		};
		expect(
			planSourceRestore({
				kind: "application",
				previousSource,
				restoreSource: true,
			}),
		).toEqual({ values: previousSource, onlyWhenGha: false });
	});

	it("keeps the image the service runs now, and its registry login, instead of the tag it had before", () => {
		const restore = planSourceRestore({
			kind: "application",
			previousSource: {
				sourceType: "docker",
				dockerImage: "ghcr.io/acme/shop:latest",
				registryId: "reg-1",
				username: "u",
				registryUrl: "ghcr.io",
				autoDeploy: false,
			},
			restoreSource: true,
		});
		expect(restore.values).toEqual({ sourceType: "docker", autoDeploy: false });
	});

	it("restores only the type of a compose stack", () => {
		expect(
			planSourceRestore({
				kind: "compose",
				previousSource: { sourceType: "raw", composeFile: "ignored" },
				restoreSource: true,
			}),
		).toEqual({ values: { sourceType: "raw" }, onlyWhenGha: false });
	});

	it("keeps the image or stored file when asked not to restore, or when nothing was saved", () => {
		for (const input of [
			{ previousSource: { sourceType: "github" }, restoreSource: false },
			{ previousSource: null, restoreSource: true },
			{ previousSource: { sourceType: "github-actions" }, restoreSource: true },
			{ previousSource: {}, restoreSource: true },
		]) {
			expect(planSourceRestore({ kind: "application", ...input })).toEqual({
				values: { sourceType: "docker" },
				onlyWhenGha: true,
			});
			expect(planSourceRestore({ kind: "compose", ...input })).toEqual({
				values: { sourceType: "raw" },
				onlyWhenGha: true,
			});
		}
	});
});

describe("Disconnect and records deleted meanwhile", () => {
	it("nulls the references that no longer exist and keeps the others", async () => {
		const checked: string[] = [];
		const values = await withoutMissingReferences(
			{
				sourceType: "github",
				branch: "dev",
				githubId: "gh-gone",
				gitlabId: "gl-1",
				customGitSSHKeyId: "key-gone",
				bitbucketId: null,
			},
			async (field, id) => {
				checked.push(`${field}:${id}`);
				return id !== "gh-gone" && id !== "key-gone";
			},
		);
		expect(values).toEqual({
			sourceType: "github",
			branch: "dev",
			githubId: null,
			gitlabId: "gl-1",
			customGitSSHKeyId: null,
			bitbucketId: null,
		});
		expect(checked.sort()).toEqual([
			"customGitSSHKeyId:key-gone",
			"githubId:gh-gone",
			"gitlabId:gl-1",
		]);
	});

	it("does not look anything up when nothing is referenced", async () => {
		let calls = 0;
		const values = await withoutMissingReferences(
			{ sourceType: "docker" },
			async () => {
				calls += 1;
				return true;
			},
		);
		expect(values).toEqual({ sourceType: "docker" });
		expect(calls).toBe(0);
	});
});

describe("keepsProvider (the compose file editor sends raw back)", () => {
	it("is true only for a github-actions stack and its stored-file type", () => {
		expect(keepsProvider("compose", "github-actions", "raw")).toBe(true);
		expect(keepsProvider("compose", "github-actions", "git")).toBe(false);
		expect(keepsProvider("compose", "github-actions", undefined)).toBe(false);
		expect(keepsProvider("compose", "raw", "raw")).toBe(false);
		expect(keepsProvider("application", "github-actions", "docker")).toBe(
			false,
		);
	});
});

describe("copiedSourceType (a duplicated service has no connection)", () => {
	it("turns github-actions into the image or the stored file, and leaves every other type", () => {
		expect(copiedSourceType("application", "github-actions")).toBe("docker");
		expect(copiedSourceType("compose", "github-actions")).toBe("raw");
		expect(copiedSourceType("application", "github")).toBe("github");
		expect(copiedSourceType("compose", "raw")).toBe("raw");
	});
});
