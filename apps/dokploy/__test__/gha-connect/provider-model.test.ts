import { describe, expect, it } from "vitest";
import {
	type ConnectForm,
	COMPOSE_PIN_HINT,
	connectFormProblem,
	DEFAULT_WORKFLOW_PATH,
	defaultConnectForm,
	describeProviderStatus,
	effectiveMode,
	effectiveServiceKey,
	effectiveWorkflowPath,
	keyFromRepository,
	opensOnGithubActions,
	type ProviderConnection,
	panelImageOfConnection,
	providerDetailRows,
	redeployCopy,
	relativeTime,
	runningImageProblem,
	snippetProblem,
	toConnectInput,
	toSnippetInput,
	workflowImageOfForm,
} from "@/components/dashboard/shared/gha-provider-model";

const filled = (patch: Partial<ConnectForm> = {}): ConnectForm => ({
	...defaultConnectForm({ repository: "acme/Shop-Web", branch: "dev" }),
	githubConnectionId: "gh-1",
	...patch,
});

describe("the connect form", () => {
	it("starts from what the service already knows", () => {
		const form = defaultConnectForm({ repository: "acme/shop", branch: "dev" });
		expect(form.repository).toBe("acme/shop");
		expect(form.trackedBranch).toBe("dev");
		expect(form.mode).toBe("build");
		expect(form.gateMode).toBe("image");
		expect(defaultConnectForm().trackedBranch).toBe("main");
		expect(defaultConnectForm({ branch: "  " }).trackedBranch).toBe("main");
	});

	it("derives the service key from the repository name", () => {
		expect(keyFromRepository("acme/Shop Web")).toBe("");
		expect(keyFromRepository("acme/Shop-Web")).toBe("shop-web");
		expect(keyFromRepository("acme/_hidden")).toBe("hidden");
		expect(keyFromRepository("nonsense")).toBe("");
		expect(effectiveServiceKey(filled())).toBe("shop-web");
		expect(effectiveServiceKey(filled({ serviceKey: "web" }))).toBe("web");
	});

	it("is ready to connect with an account, a repository and the defaults", () => {
		expect(connectFormProblem(filled())).toBeNull();
	});

	it("holds Test connection and Connect until the account, the repository and the branch are chosen", () => {
		const blank = filled({
			githubConnectionId: "",
			repository: "",
			trackedBranch: "",
		});
		expect(connectFormProblem(blank)).not.toBeNull();
		expect(
			connectFormProblem({ ...blank, githubConnectionId: "gh-1" }),
		).not.toBeNull();
		expect(
			connectFormProblem({
				...blank,
				githubConnectionId: "gh-1",
				repository: "acme/shop",
			}),
		).toMatch(/branch/);
		expect(
			connectFormProblem(filled({ repository: "  ", trackedBranch: "  " })),
		).not.toBeNull();
		expect(
			connectFormProblem(
				filled({ repository: "acme/shop", trackedBranch: "main" }),
			),
		).toBeNull();
	});

	it("says the first thing that is missing, in the order the form is read", () => {
		expect(connectFormProblem(filled({ githubConnectionId: "" }))).toMatch(
			/GitHub account/,
		);
		expect(connectFormProblem(filled({ repository: "acme" }))).toMatch(
			/owner\/name/,
		);
		expect(connectFormProblem(filled({ trackedBranch: "a b" }))).toMatch(
			/branch/,
		);
		expect(connectFormProblem(filled({ environment: "" }))).toMatch(
			/environment/,
		);
		expect(connectFormProblem(filled({ serviceKey: "Bad Key" }))).toMatch(
			/service key/,
		);
		expect(connectFormProblem(filled({ dockerfile: "" }))).toMatch(
			/Dockerfile/,
		);
		expect(
			connectFormProblem(
				filled({ gateMode: "workflows", gateWorkflows: "  " }),
			),
		).toMatch(/workflow/);
		expect(
			connectFormProblem(
				filled({ gateMode: "checks", gateTimeoutMinutes: "1" }),
			),
		).toMatch(/minutes/);
	});

	it("builds the whole workflow with the Dokploy action, or adds a job to the user's own", () => {
		expect(effectiveMode(filled())).toBe("build");
		expect(effectiveWorkflowPath(filled())).toBe(DEFAULT_WORKFLOW_PATH);
		expect(toSnippetInput(filled())).toEqual({
			mode: "build",
			serviceKey: "shop-web",
			trackedBranch: "dev",
			environment: "production",
			repository: "acme/Shop-Web",
			dockerfile: "Dockerfile",
			context: ".",
			delivery: "pull",
		});
		const own = filled({
			mode: "existing",
			workflowPath: ".github/workflows/build.yml",
			buildJob: "compose",
		});
		expect(effectiveWorkflowPath(own)).toBe(".github/workflows/build.yml");
		expect(toSnippetInput(own)).toMatchObject({
			mode: "existing",
			buildJob: "compose",
			imageOutput: "image",
		});
		expect(
			snippetProblem(filled({ mode: "existing", buildJob: "1x" })),
		).toMatch(/build job/);
		expect(
			connectFormProblem(filled({ mode: "existing", workflowPath: "ci.yml" })),
		).toMatch(/\.github\/workflows/);
	});

	it("offers only the job when the images are mirrored, and needs how they are named", () => {
		const mirrored = filled({ registryId: "reg-1" });
		expect(effectiveMode(mirrored)).toBe("existing");
		expect(connectFormProblem(mirrored)).toMatch(/mirrored images are named/);
		const ready = filled({
			registryId: "reg-1",
			registryPrefix: " localhost:5000/registry.devino.ca ",
			workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
		});
		expect(connectFormProblem(ready)).toBeNull();
		expect(
			toConnectInput(ready, { serviceType: "compose", serviceId: "c1" }),
		).toMatchObject({
			registryId: "reg-1",
			registryPrefix: "localhost:5000/registry.devino.ca",
			workflowPath: ".github/workflows/dokploy-web-build-deploy.yml",
		});
	});

	it("sends what ghaConnection.connect takes", () => {
		expect(
			toConnectInput(
				filled({ gateMode: "workflows", gateWorkflows: "ci, lint.yml" }),
				{
					serviceType: "application",
					serviceId: "app-1",
				},
			),
		).toEqual({
			serviceType: "application",
			serviceId: "app-1",
			githubConnectionId: "gh-1",
			owner: "acme",
			repo: "Shop-Web",
			workflowPath: DEFAULT_WORKFLOW_PATH,
			trackedBranch: "dev",
			environment: "production",
			serviceKey: "shop-web",
			registryPrefix: null,
			registryId: null,
			protectionMode: "environment",
			gateMode: "workflows",
			gateWorkflows: ["ci", "lint.yml"],
			gateTimeoutMinutes: 60,
		});
		expect(
			toConnectInput(filled({ gateWorkflows: "ci" }), {
				serviceType: "compose",
				serviceId: "c1",
			}).gateWorkflows,
		).toEqual([]);
	});
});

const conn = (patch: Partial<ProviderConnection> = {}): ProviderConnection => ({
	state: "connected",
	statusText: "Deployed from GitHub Actions.",
	lastError: null,
	repository: "acme/shop",
	workflowPath: ".github/workflows/dokploy.yml",
	trackedBranch: "dev",
	environment: "production",
	serviceKey: "shop",
	deployedSha: "3f9c2a1b8d41b07aaaaaaaaaaaaaaaaaaaaaaaa",
	deployedRunId: 4242,
	deployedAt: new Date("2026-11-03T10:00:00Z"),
	lastActivityAt: new Date("2026-11-03T10:05:00Z"),
	...patch,
});

describe("the status panel", () => {
	it("names every state of the design and the way out of it", () => {
		const waiting = describeProviderStatus(
			conn({
				state: "waiting",
				statusText: "Waiting for GitHub Actions to publish 3f9c2a1.",
			}),
		);
		expect(waiting.pill).toEqual({
			label: "Waiting for first release",
			tone: "neutral",
		});
		expect(waiting.exit).toContain("Push a commit to dev");

		const connected = describeProviderStatus(conn());
		expect(connected.pill).toEqual({ label: "Connected", tone: "good" });
		expect(connected.sentence).toBe("Deployed from GitHub Actions.");
		expect(connected.exit).toBeNull();

		const stale = describeProviderStatus(
			conn({
				state: "stale",
				statusText: "GitHub Actions has not published commit 3f9c2a1.",
			}),
		);
		expect(stale.pill).toEqual({ label: "Stale", tone: "warn" });
		expect(stale.exit).toContain(".github/workflows/dokploy.yml");

		const blocked = describeProviderStatus(
			conn({ state: "blocked", statusText: "Checks failed on 3f9c2a1." }),
		);
		expect(blocked.pill).toEqual({ label: "Blocked", tone: "bad" });
		expect(blocked.sentence).toBe("Checks failed on 3f9c2a1.");
		expect(blocked.exit).toContain("deploy this release anyway");

		const lost = describeProviderStatus(
			conn({ state: "disconnected", statusText: null }),
		);
		expect(lost.pill.tone).toBe("bad");
		expect(lost.actions).toContain("reconnect");
		expect(lost.sentence).toBe("GitHub access was lost. Reconnect.");
	});

	it("always offers Check now, and never prints a digest or a command", () => {
		for (const state of [
			"waiting",
			"connected",
			"stale",
			"blocked",
			"disconnected",
		]) {
			const status = describeProviderStatus(conn({ state }));
			expect(status.actions).toContain("checkNow");
			expect(JSON.stringify(status)).not.toMatch(/sha256|docker |curl /);
		}
	});

	it("lists the facts with the commit and the run as links", () => {
		const rows = providerDetailRows(conn());
		expect(rows.map((row) => row.label)).toEqual([
			"Repository",
			"Workflow",
			"Branch",
			"Environment",
			"Deployed commit",
			"Run",
			"Last checked",
		]);
		const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
		expect(byLabel["Deployed commit"]).toMatchObject({
			value: "3f9c2a1",
			href: "https://github.com/acme/shop/commit/3f9c2a1b8d41b07aaaaaaaaaaaaaaaaaaaaaaaa",
		});
		expect(byLabel.Run).toMatchObject({
			value: "#4242",
			href: "https://github.com/acme/shop/actions/runs/4242",
		});
		expect(byLabel.Workflow?.href).toBe(
			"https://github.com/acme/shop/blob/dev/.github/workflows/dokploy.yml",
		);
		expect(byLabel.Repository?.href).toBe("https://github.com/acme/shop");
	});

	it("says when it last looked in words", () => {
		const now = new Date("2026-11-03T10:30:00Z");
		const rows = providerDetailRows(conn(), now);
		expect(rows.find((row) => row.label === "Last checked")?.value).toBe(
			"25 minutes ago",
		);
		expect(relativeTime(new Date("2026-11-03T10:29:50Z"), now)).toBe(
			"just now",
		);
		expect(relativeTime("2026-11-03T09:30:00Z", now)).toBe("1 hour ago");
		expect(relativeTime("2026-11-01T10:30:00Z", now)).toBe("2 days ago");
		expect(relativeTime("nonsense", now)).toBeNull();
		expect(relativeTime(null, now)).toBeNull();
	});

	it("shows what a release will pin as Image(s), and a guess as Expected image", () => {
		const one = providerDetailRows(conn(), new Date(), {
			repositories: ["ghcr.io/acme/shop/web"],
			source: "running",
		});
		expect(one.find((row) => row.label === "Image")).toMatchObject({
			value: "ghcr.io/acme/shop/web",
			mono: true,
			href: null,
		});
		const several = providerDetailRows(conn(), new Date(), {
			repositories: ["ghcr.io/acme/shop/web", "ghcr.io/acme/shop/worker"],
			source: "running",
		});
		expect(several.find((row) => row.label === "Images")?.value).toBe(
			"ghcr.io/acme/shop/web, ghcr.io/acme/shop/worker",
		);
		// The image row sits with the facts of the setup, before what was deployed.
		expect(several.map((row) => row.label).indexOf("Images")).toBe(4);
		const guess = providerDetailRows(conn(), new Date(), {
			repositories: ["ghcr.io/acme/shop/web"],
			source: "expected",
		});
		expect(guess.map((row) => row.label)).toContain("Expected image");
		expect(guess.map((row) => row.label)).not.toContain("Image");
		expect(providerDetailRows(conn()).map((row) => row.label)).not.toContain(
			"Image",
		);
	});

	it("names the image from what the service runs, else the expected one (mirrored or not)", () => {
		const D = `sha256:${"a".repeat(64)}`;
		// (a) running inside the namespace: that repository.
		expect(
			panelImageOfConnection(conn(), "application", {
				dockerImage: `ghcr.io/acme/shop/storefront@${D}`,
			}),
		).toEqual({
			repositories: ["ghcr.io/acme/shop/storefront"],
			source: "running",
		});
		// (c) nothing running yet: the expected name, labelled as a guess.
		expect(panelImageOfConnection(conn(), "application", {})).toEqual({
			repositories: ["ghcr.io/acme/shop/shop"],
			source: "expected",
		});
		expect(
			panelImageOfConnection(
				conn({ registryPrefix: "localhost:5000/registry.devino.ca/" }),
				"application",
				{},
			),
		).toEqual({
			repositories: ["localhost:5000/registry.devino.ca/shop/shop"],
			source: "expected",
		});
		// Outside the namespace (a release can never replace it): never named as the image.
		expect(
			panelImageOfConnection(conn(), "application", {
				dockerImage: `ghcr.io/org/app@${D}`,
			}),
		).toEqual({
			repositories: ["ghcr.io/acme/shop/shop"],
			source: "expected",
		});
		// A compose stack: the pinned images inside the namespace.
		expect(
			panelImageOfConnection(
				conn({ registryPrefix: "localhost:5000/registry.devino.ca" }),
				"compose",
				{
					composeFile: `services:\n  web:\n    image: localhost:5000/registry.devino.ca/shop/web@${D}\n  db:\n    image: postgres@${D}\n`,
				},
			),
		).toEqual({
			repositories: ["localhost:5000/registry.devino.ca/shop/web"],
			source: "running",
		});
		expect(
			panelImageOfConnection(
				conn({ repository: "nonsense" }),
				"application",
				{},
			),
		).toBeNull();
	});

	it("tells a compose stack with nothing pinned yet when a release will pin", () => {
		const D = `sha256:${"a".repeat(64)}`;
		const guess = panelImageOfConnection(conn(), "compose", {
			composeFile: "services:\n  db:\n    image: postgres:16\n",
		});
		expect(guess).toMatchObject({ source: "expected", hint: COMPOSE_PIN_HINT });
		const row = providerDetailRows(conn(), new Date(), guess).find(
			(r) => r.label === "Expected image",
		);
		expect(row?.note).toMatch(/pins only after the compose file carries/);
		// Pinned inside the namespace: it is what runs, no hint. An application never gets one.
		const pinned = panelImageOfConnection(conn(), "compose", {
			composeFile: `services:\n  web:\n    image: ghcr.io/acme/shop/web@${D}\n`,
		});
		expect(pinned?.hint).toBeUndefined();
		expect(panelImageOfConnection(conn(), "application", {})?.hint).toBeUndefined();
	});

	it("builds the workflow and refuses Connect from the same derivation", () => {
		const D = `sha256:${"a".repeat(64)}`;
		const form = filled({ repository: "acme/shop", serviceKey: "web" });
		// Running inside ghcr.io/acme/shop/: the workflow pushes that repository.
		const inside = { dockerImage: `ghcr.io/acme/shop/storefront@${D}` };
		expect(workflowImageOfForm(form, "application", inside)).toBe(
			"ghcr.io/acme/shop/storefront",
		);
		expect(toSnippetInput(form, "ghcr.io/acme/shop/storefront")).toMatchObject({
			mode: "build",
			image: "ghcr.io/acme/shop/storefront",
		});
		expect(runningImageProblem(form, "application", inside)).toBeNull();
		// Nothing running: the default name, no image sent.
		expect(workflowImageOfForm(form, "application", {})).toBeUndefined();
		expect(toSnippetInput(form)).not.toHaveProperty("image");
		// Outside it: no image to build, and a sentence that stops Connect.
		for (const dockerImage of [`ghcr.io/org/app@${D}`, "nginx:latest"]) {
			expect(
				workflowImageOfForm(form, "application", { dockerImage }),
			).toBeUndefined();
			expect(runningImageProblem(form, "application", { dockerImage })).toMatch(
				/outside ghcr\.io\/acme\/shop\//,
			);
		}
		// A compose stack in the mirror namespace connects without refusal.
		const mirrored = filled({
			repository: "acme/shop",
			registryId: "reg-1",
			registryPrefix: "localhost:5000/registry.devino.ca",
		});
		expect(
			runningImageProblem(mirrored, "compose", {
				composeFile: `services:\n  web:\n    image: localhost:5000/registry.devino.ca/shop/web@${D}\n`,
			}),
		).toBeNull();
	});

	it("leaves out what is not known yet", () => {
		const rows = providerDetailRows(
			conn({ deployedSha: null, deployedRunId: null, lastActivityAt: null }),
		);
		expect(rows.map((row) => row.label)).toEqual([
			"Repository",
			"Workflow",
			"Branch",
			"Environment",
		]);
	});
});

describe("the Provider tab", () => {
	it("opens on GitHub Actions for a service that follows it", () => {
		expect(opensOnGithubActions("github-actions")).toBe(true);
		expect(opensOnGithubActions("github")).toBe(false);
		expect(opensOnGithubActions(undefined)).toBe(false);
	});

	it("words the deploy button and the line under it", () => {
		const copy = redeployCopy("dev");
		expect(copy.label).toBe("Redeploy current image");
		expect(copy.hint).toBe(
			"To build a new version, push to dev; GitHub Actions deploys it.",
		);
		expect(copy.confirm).toContain("Nothing is built");
		expect(redeployCopy(undefined).hint).toContain("tracked branch");
	});
});
