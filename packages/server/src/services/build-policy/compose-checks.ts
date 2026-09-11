import { getGitCommitInfo } from "@dokploy/server/utils/providers/git";
import { waitForUnitRequiredChecks } from "./github-checks";
import {
	findBuildPolicySettings,
	isBuildPolicyEnforcedAnywhere,
	requiredChecksTimeoutMs,
} from "./settings";

/**
 * `requiredChecks` for compose units.
 *
 * Round-2 review finding A. `compose.requiredChecks` was a real column and a
 * real writable API field, and nothing read it: a compose unit configured with
 * a required check deployed immediately, every time, while three documents said
 * otherwise. A claimed CI gate that is not wired is the dangerous kind of
 * documentation error, so it is wired here.
 *
 * **What compose gets and what it does not.** Coalescing, `[skip deploy]`,
 * derived `watchPaths` and now `requiredChecks` all apply. Exclusions and
 * break-glass do not, and are refused at the router rather than written as rows
 * nothing reads: both decide *where* a unit builds, and a compose build is
 * never relocated (`decideBuildPolicy` returns
 * `compose_build_not_relocatable`), so there is nothing to exclude it from.
 * That asymmetry is deliberate and the README states it.
 *
 * This deliberately does **not** consult exclusions or break-glass, for the
 * same reason: an exclusion must not silently disable a team's CI gate.
 *
 * **Two call sites, and both are needed.**
 *
 * - `runComposeBuild`, between the clone/patches steps and the build step,
 *   which is the compose equivalent of the application path's hook 2a/4. It
 *   runs on the commit the clone just fetched, so a check that fails or never
 *   arrives costs no build. `deployCompose` and both compose preview paths go
 *   through here.
 * - `rebuildCompose`, in the same position in its own inlined pipeline. This is
 *   the Redeploy button, and leaving it out was round-3 review finding H. A
 *   redeploy re-uses whatever is in the code directory, and `runComposeBuild`
 *   clones *before* it gates, so a refused deploy leaves the unchecked commit
 *   sitting on disk — Redeploy would then build precisely the commit the gate
 *   had just rejected, with no check and no audit row.
 *
 * If a new compose deploy path is ever added, it needs this call too. The
 * application side has the same rule for `runBuildPolicyPreBuildGate`.
 *
 * **Default-off**, in the same shape as every other touch point: an empty list
 * (every existing row, since the column is nullable with no default) reads
 * nothing at all, and a non-empty one costs the cached
 * `isBuildPolicyEnforcedAnywhere` boolean before anything else.
 *
 * The wait occupies the deployment slot it runs in; see finding E and the
 * README's required-checks section for what to raise before enabling it.
 */
export interface ComposeRequiredChecksUnit {
	composeId: string;
	appName: string;
	name: string;
	sourceType: string;
	requiredChecks?: string[] | null;
	githubId?: string | null;
	owner?: string | null;
	repository?: string | null;
	customGitUrl?: string | null;
	environment?: {
		project?: { organizationId?: string | null } | null;
	} | null;
}

export const waitForComposeRequiredChecks = async ({
	compose,
	serverId,
}: {
	compose: ComposeRequiredChecksUnit;
	serverId: string | null;
}): Promise<void> => {
	const requiredChecks = (compose.requiredChecks ?? []).filter(
		(name): name is string =>
			typeof name === "string" && name.trim().length > 0,
	);
	if (requiredChecks.length === 0) return;

	// Same cheap cached probe the enqueue gate opens with.
	if (!(await isBuildPolicyEnforcedAnywhere())) return;

	const organizationId = compose.environment?.project?.organizationId;
	if (!organizationId) {
		// The fork must not be the reason a deploy throws; a row loaded without
		// its nested environment deploys unchanged, with a warning.
		console.warn(
			`[build-policy] no organization on compose ${compose.composeId}; skipping the required-checks gate`,
		);
		return;
	}

	const settings = await findBuildPolicySettings(organizationId);
	if (!settings?.enforceRemoteBuilds) return;

	const sha =
		(
			await getGitCommitInfo({
				appName: compose.appName,
				type: "compose",
				serverId,
			})
		)?.hash || null;

	await waitForUnitRequiredChecks({
		unit: {
			unitType: "compose",
			unitId: compose.composeId,
			unitName: compose.name,
			organizationId,
			requiredChecks,
			sourceType: compose.sourceType,
			githubId: compose.githubId,
			owner: compose.owner,
			repository: compose.repository,
			customGitUrl: compose.customGitUrl,
		},
		sha,
		timeoutMs: requiredChecksTimeoutMs(settings),
	});
};
