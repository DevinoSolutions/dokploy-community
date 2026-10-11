import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
	deploymentBuildRefetchInterval,
	deploymentCanHaveSnapvisorBuild,
	presentDeploymentBuild,
	type SnapvisorDeploymentBuildData,
} from "@/components/dashboard/settings/integrations/snapvisor/snapvisor-badge-state";
import { SnapvisorBuildBadge } from "@/components/dashboard/settings/integrations/snapvisor/snapvisor-build-badge";
import {
	SnapvisorProjectPickerView,
	type SnapvisorProjectPickerViewProps,
	snapvisorPickerCopy,
} from "@/components/dashboard/settings/integrations/snapvisor/snapvisor-project-picker-view";

/**
 * The deployments list shows a compact Snapvisor badge per finished
 * deployment of a linked service, and the project picker is reachable from the
 * Deployments tab, not only from the preview settings.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const APP_ROOT = path.resolve(__dirname, "../..");
const read = (file: string) =>
	fs.readFileSync(path.join(APP_ROOT, file), "utf8").replace(/\r\n/g, "\n");

describe("deploymentCanHaveSnapvisorBuild", () => {
	it("needs a finished deployment with a full commit sha", () => {
		expect(
			deploymentCanHaveSnapvisorBuild({
				status: "done",
				description: `Commit: ${SHA}`,
			}),
		).toBe(true);
		expect(
			deploymentCanHaveSnapvisorBuild({
				status: "done",
				description: `  Commit:  ${SHA}  `,
			}),
		).toBe(true);
	});

	it.each([
		["running", `Commit: ${SHA}`],
		["error", `Commit: ${SHA}`],
		["cancelled", `Commit: ${SHA}`],
		[null, `Commit: ${SHA}`],
		["done", null],
		["done", ""],
		["done", "Commit: abc1234"],
		["done", `Commit: ${SHA}extra`],
		["done", "Rollback to a previous version"],
		["done", SHA],
	])("%s / %s has no badge", (status, description) => {
		expect(deploymentCanHaveSnapvisorBuild({ status, description })).toBe(
			false,
		);
	});
});

describe("presentDeploymentBuild", () => {
	it.each(["off", "not-connected", "no-commit"] as const)(
		"shows nothing for %s",
		(state) => {
			expect(presentDeploymentBuild({ state })).toBeNull();
		},
	);

	it("shows nothing before the first answer", () => {
		expect(presentDeploymentBuild(undefined)).toBeNull();
		expect(presentDeploymentBuild(null)).toBeNull();
	});

	it("a missing build is a muted label, not an error", () => {
		expect(presentDeploymentBuild({ state: "no-build" })).toMatchObject({
			label: "No build yet",
			className: "text-muted-foreground",
			reviewUrl: null,
		});
	});

	it.each([
		["auth", "access token"],
		["rate-limited", "rate limiting"],
		["project", "not found"],
		["unreachable", "could not be reached"],
	] as const)(
		"unavailable (%s) explains itself in the tooltip",
		(reason, text) => {
			const view = presentDeploymentBuild({ state: "unavailable", reason });
			expect(view).toMatchObject({
				label: "Unavailable",
				className: "text-muted-foreground",
				reviewUrl: null,
			});
			expect(view?.title).toContain(text);
		},
	);

	it("shows the build status and the review link", () => {
		const ready = (
			buildStatus: string,
			changedSnapshots: number | null = null,
		): SnapvisorDeploymentBuildData => ({
			state: "ready",
			buildNumber: 12,
			buildStatus,
			changedSnapshots,
			reviewUrl: "https://app.snapvisor.io/t/p/builds/12",
		});

		expect(presentDeploymentBuild(ready("no-changes"))).toEqual({
			label: "No changes",
			className: "text-green-600",
			title: "Snapvisor build #12",
			reviewUrl: "https://app.snapvisor.io/t/p/builds/12",
		});
		expect(presentDeploymentBuild(ready("accepted"))?.label).toBe("Approved");
		expect(presentDeploymentBuild(ready("rejected"))?.label).toBe("Rejected");
		expect(presentDeploymentBuild(ready("progress"))?.label).toBe("Pending");
		expect(presentDeploymentBuild(ready("aborted"))?.label).toBe("Error");
		expect(presentDeploymentBuild(ready("something-new"))).toMatchObject({
			label: "Unknown",
			className: "text-muted-foreground",
		});
	});

	it("puts the number of changed snapshots on a build that needs review", () => {
		const view = presentDeploymentBuild({
			state: "ready",
			buildNumber: 3,
			buildStatus: "changes-detected",
			changedSnapshots: 5,
			reviewUrl: "https://app.snapvisor.io/t/p/builds/3",
		});
		expect(view).toMatchObject({
			label: "Changes detected (5)",
			className: "text-yellow-600",
		});
	});
});

describe("deploymentBuildRefetchInterval", () => {
	const ready = (buildStatus: string): SnapvisorDeploymentBuildData => ({
		state: "ready",
		buildNumber: 1,
		buildStatus,
		changedSnapshots: null,
		reviewUrl: "u",
	});

	it("keeps asking while a build can still change", () => {
		expect(deploymentBuildRefetchInterval({ state: "no-build" })).toBe(60_000);
		expect(deploymentBuildRefetchInterval(ready("progress"))).toBe(60_000);
		expect(deploymentBuildRefetchInterval(ready("changes-detected"))).toBe(
			60_000,
		);
	});

	it("stops once the build is final", () => {
		for (const status of [
			"accepted",
			"rejected",
			"no-changes",
			"error",
			"aborted",
			"expired",
		]) {
			expect(deploymentBuildRefetchInterval(ready(status))).toBe(false);
		}
	});

	it("does not poll nothing, a failure or an unlinked service", () => {
		expect(deploymentBuildRefetchInterval(undefined)).toBe(false);
		expect(deploymentBuildRefetchInterval({ state: "off" })).toBe(false);
		expect(
			deploymentBuildRefetchInterval({
				state: "unavailable",
				reason: "unreachable",
			}),
		).toBe(false);
	});
});

describe("SnapvisorBuildBadge", () => {
	const render = (props: Partial<Parameters<typeof SnapvisorBuildBadge>[0]>) =>
		renderToStaticMarkup(
			createElement(SnapvisorBuildBadge, {
				label: "No changes",
				className: "text-green-600",
				reviewUrl: "https://app.snapvisor.io/t/p/builds/1",
				isRefreshing: false,
				onRefresh: vi.fn(),
				...props,
			}),
		);

	it("has the status, a refresh action and a link to review in Snapvisor", () => {
		const html = render({});
		expect(html).toContain("No changes");
		expect(html).toContain("text-green-600");
		expect(html).toContain('aria-label="Refresh Snapvisor status"');
		expect(html).toContain('href="https://app.snapvisor.io/t/p/builds/1"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain("Review in Snapvisor");
	});

	it("has no link while there is nothing to review", () => {
		const html = render({ reviewUrl: null, label: "No build yet" });
		expect(html).toContain("No build yet");
		expect(html).toContain('aria-label="Refresh Snapvisor status"');
		expect(html).not.toContain("<a ");
	});
});

describe("the project picker outside previews", () => {
	const view = (props: Partial<SnapvisorProjectPickerViewProps> = {}) =>
		renderToStaticMarkup(
			createElement(SnapvisorProjectPickerView, {
				scope: "deployments",
				serviceNoun: "application",
				isLoadingIntegration: false,
				hasIntegration: true,
				currentProjectName: null,
				projects: [
					{ id: "1", name: "web-app" },
					{ id: "2", name: "marketing" },
				],
				isLoadingProjects: false,
				projectsError: null,
				isSaving: false,
				onChange: vi.fn(),
				...props,
			}),
		);

	it("talks about deployments, not previews", () => {
		const html = view();
		expect(html).toContain("Visual testing (Snapvisor)");
		expect(html).toContain("each deployment");
		expect(html).toContain("notified");
		const copy = snapvisorPickerCopy("deployments", "application");
		expect(copy.description).not.toMatch(/preview/i);
		expect(copy.notConnected).not.toMatch(/preview/i);
	});

	it("keeps the preview wording for the preview settings", () => {
		const html = view({ scope: "previews" });
		expect(html).toContain("Register each preview deployment");
		expect(
			snapvisorPickerCopy("previews", "compose service").notConnected,
		).toBe("to show visual-diff status on this compose service's previews.");
	});

	it("names the compose service in its copy", () => {
		expect(
			snapvisorPickerCopy("deployments", "compose service").description,
		).toContain("Link this compose service to a Snapvisor project");
	});

	it("is hidden on the Deployments tab until Snapvisor is connected", () => {
		expect(view({ hasIntegration: false, hideWhenNotConnected: true })).toBe(
			"",
		);
	});

	it("still hints at the Integrations page where connecting is the point", () => {
		const html = view({ hasIntegration: false, scope: "previews" });
		expect(html).toContain("/dashboard/settings/integrations");
		expect(html).toContain("previews");
	});

	it("shows nothing while it is not known whether Snapvisor is connected", () => {
		expect(view({ isLoadingIntegration: true })).toBe("");
	});

	it("reports a project list that failed to load", () => {
		expect(
			view({ projectsError: "Snapvisor responded with HTTP 500" }),
		).toContain("Could not load the Snapvisor projects");
	});
});

describe("where the badge and the picker are wired in", () => {
	const deployments = read(
		"components/dashboard/application/deployments/show-deployments.tsx",
	);

	it("the Deployments tab of applications and compose services offers the picker", () => {
		expect(deployments).toContain("<SnapvisorServiceLink");
		expect(deployments).toMatch(
			/\(type === "application" \|\| type === "compose"\) && \(\s*<SnapvisorServiceLink/,
		);
		const link = read(
			"components/dashboard/settings/integrations/snapvisor/snapvisor-service-link.tsx",
		);
		expect(link).toContain("api.snapvisor.setApplicationProject");
		expect(link).toContain("api.snapvisor.setComposeProject");
		expect(link).toContain('scope="deployments"');
		expect(link).toContain("hideWhenNotConnected");
	});

	it("each finished row of a linked service gets a badge", () => {
		expect(deployments).toMatch(
			/snapvisorProjectName &&\s*deploymentCanHaveSnapvisorBuild\(deployment\) && \(\s*<SnapvisorDeploymentBadge/,
		);
		const badge = read(
			"components/dashboard/settings/integrations/snapvisor/snapvisor-deployment-badge.tsx",
		);
		// Lazy per row: nothing is requested until the row has been on screen.
		expect(badge).toContain("useInView");
		expect(badge).toContain("enabled: seen");
		expect(badge).toContain("api.snapvisor.deploymentBuild");
		expect(badge).toContain("api.snapvisor.refreshDeploymentBuild");
	});

	it("the preview settings keep their picker", () => {
		for (const kind of ["application", "compose"]) {
			const settings = read(
				`components/dashboard/${kind}/preview-deployments/show-preview-settings.tsx`,
			);
			expect(settings).toContain("<SnapvisorProjectPicker");
		}
	});

	it("the preview cards keep their badge, now built on the shared one", () => {
		for (const kind of ["application", "compose"]) {
			const list = read(
				`components/dashboard/${kind}/preview-deployments/show-preview-deployments.tsx`,
			);
			expect(list).toContain("<SnapvisorPreviewBadge");
		}
		const preview = read(
			"components/dashboard/settings/integrations/snapvisor/snapvisor-preview-badge.tsx",
		);
		expect(preview).toContain("<SnapvisorBuildBadge");
	});
});
