import type { ComposeNested } from "@dokploy/server/utils/builders/compose";
import { withResolvedVaultRefs } from "@dokploy/server/utils/vault";
import {
	addDomainToCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@dokploy/server/utils/docker/domain";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import {
	type ComposeVariables,
	resolveComposeMountedVolumes,
} from "@dokploy/server/utils/volume-backups/compose-volumes";
import { parse as parseShell } from "shell-quote";
import { parse } from "yaml";
import { logger } from "../lib/logger";
import { findRefusedComposeVolumes } from "./volume-binding";

type ComposeForVolumeCheck = Pick<
	ComposeNested,
	| "composeId"
	| "appName"
	| "composeType"
	| "createEnvFile"
	| "env"
	| "randomize"
	| "suffix"
	| "environment"
>;

type Spec = Parameters<typeof resolveComposeMountedVolumes>[0];

// The variables `docker compose` / `docker stack deploy` interpolate the
// compose file with, as Dokploy writes them (see getCreateEnvFileCommand and
// stageStackEnvFile). A compose that does not get an env file from Dokploy
// reads whatever `.env` sits next to the file, which Dokploy cannot see, so no
// variable is trusted then (`strict`).
const getInterpolationVariables = (
	compose: ComposeForVolumeCheck,
): { env: ComposeVariables; strict: boolean } => {
	const isStack = compose.composeType === "stack";
	if (!isStack && !compose.createEnvFile) {
		return { env: {}, strict: true };
	}
	try {
		const content = isStack
			? (compose.env ?? "")
			: `APP_NAME=${compose.appName}\nCOMPOSE_PROJECT_NAME=${compose.appName}\n${compose.env ?? ""}${
					compose.randomize ? `\nCOMPOSE_PREFIX=${compose.suffix}` : ""
				}`;
		return {
			env: getEnvironmentVariablesObject(
				content,
				compose.environment.project.env,
				compose.environment.env,
			),
			strict: false,
		};
	} catch {
		// Unresolved references: the variables are not known.
		return { env: null, strict: true };
	}
};

// Refuses (throws) when the compose spec mounts a named volume that is not
// the compose's own (T-6822). `spec` is the YAML that is deployed: domains,
// randomize and isolatedDeployment already applied.
export const assertComposeSpecVolumesBound = async (
	compose: ComposeForVolumeCheck,
	spec: Spec,
) => {
	const { env, strict } = getInterpolationVariables(compose);
	const { uses, unresolved } = resolveComposeMountedVolumes(spec, {
		appName: compose.appName,
		env,
		strict,
	});
	if (unresolved.length > 0) {
		logger.warn(
			{ composeId: compose.composeId, unresolved },
			"[VolumeBinding] A compose file volume was refused: it could not be resolved",
		);
		throw new Error(
			`Compose volume check failed: ${unresolved[0]} cannot be resolved before the deploy, so the volumes it uses cannot be checked. Write the volume names out in the compose file, and keep volumes in the one compose file (no include, no extends from another file, no volumes_from a container).`,
		);
	}
	const [refused] = await findRefusedComposeVolumes(compose, uses);
	if (refused) {
		throw new Error(refused.message);
	}
};

// The compose file arguments of a custom command. A custom command replaces
// the generated one, so it could point docker at a file Dokploy did not
// check.
const getCommandFileArguments = (command: string) => {
	const files: string[] = [];
	const tokens = parseShell(command);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (typeof token !== "string") {
			continue;
		}
		const inline = /^(?:--file=|--compose-file=|-f|-c)(.+)$/.exec(token);
		if (inline?.[1]) {
			files.push(inline[1]);
		} else if (["-f", "--file", "-c", "--compose-file"].includes(token)) {
			const next = tokens[index + 1];
			if (typeof next === "string") {
				files.push(next);
			}
		}
	}
	return files;
};

const normalizeComposePath = (path: string) => path.replace(/^(\.\/)+/, "");

const assertCommandUsesCheckedFile = (
	compose: ComposeForVolumeCheck &
		Pick<ComposeNested, "command" | "sourceType" | "composePath">,
) => {
	if (!compose.command) {
		return;
	}
	const rendered = normalizeComposePath(
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath,
	);
	const other = getCommandFileArguments(compose.command).find(
		(file) => normalizeComposePath(file) !== rendered,
	);
	if (other !== undefined) {
		logger.warn(
			{ composeId: compose.composeId, file: other },
			"[VolumeBinding] A compose command was refused: it uses another compose file",
		);
		throw new Error(
			`Compose command refused: it uses the compose file "${other}", but only the compose file Dokploy deploys ("${rendered}") has its volumes checked. Use that file in the command.`,
		);
	}
};

// Deploy, redeploy and preview: checks the final compose file (the one
// `writeDomainsToCompose` stages) before anything is built, torn down or
// started. A file that cannot be rendered is left to the render step, which
// reports it and stops the script before any docker command.
export const assertComposeVolumesBound = async (
	rawCompose: ComposeNested,
) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	assertCommandUsesCheckedFile(compose);
	let spec: Awaited<ReturnType<typeof addDomainToCompose>>;
	try {
		spec = await addDomainToCompose(compose, compose.domains);
	} catch {
		return;
	}
	if (!spec) {
		return;
	}
	await assertComposeSpecVolumesBound(compose, spec as Spec);
};

// Start (`docker compose up -d` from the files on disk): checks the compose
// file that is there, which is already the final one of the last deploy.
export const assertComposeFileOnDiskVolumesBound = async (
	rawCompose: ComposeNested,
) => {
	const compose = await withResolvedVaultRefs(rawCompose);
	let spec: Awaited<ReturnType<typeof loadDockerCompose>>;
	try {
		spec = compose.serverId
			? await loadDockerComposeRemote(compose)
			: await loadDockerCompose(compose);
	} catch {
		// Nothing readable on disk: `up -d` has nothing to start either.
		return;
	}
	if (!spec) {
		return;
	}
	await assertComposeSpecVolumesBound(compose, spec as Spec);
};

// Save time, raw compose files only: the text the user typed, before the
// domain labels and the randomize suffixes. A deploy checks again.
export const assertComposeFileVolumesBound = async (
	compose: ComposeForVolumeCheck,
	composeFile: string,
) => {
	let spec: unknown;
	try {
		spec = parse(composeFile, { maxAliasCount: 10000, merge: true });
	} catch {
		// Not valid YAML: nothing deploys from it, and the editor reports it.
		return;
	}
	await assertComposeSpecVolumesBound(compose, spec as Spec);
};
