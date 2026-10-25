import path from "node:path";
import { quote } from "shell-quote";
import {
	getBuildAppDirectory,
	getBuildDirectory,
	getCodeDirectory,
	getDockerContextPath,
	getPublishDirectoryPath,
} from "../filesystem/directory";
import type { ApplicationNested } from ".";

interface BuildPathCheck {
	/** The checkout the place has to be inside. */
	codeDirectory: string;
	place: string;
	label: string;
}

/**
 * The places a build reads from or writes to that the application's settings
 * name: the build directory, the Dockerfile and its directory, the Docker
 * context, the publish directory, and the files the build writes into the
 * build directory (`.env`, the static Dockerfile, Railpack's plan).
 */
const getBuildPathChecks = (application: ApplicationNested) => {
	const { buildType, createEnvFile, publishDirectory, isStaticSpa } =
		application;
	const codeDirectory = getCodeDirectory(application);
	const buildDirectory = getBuildDirectory(application);
	const checks: BuildPathCheck[] = [];
	const add = (place: string, label: string) =>
		checks.push({ codeDirectory, place, label });

	add(buildDirectory, "the build path");
	if (buildType === "dockerfile") {
		const dockerfilePath = getBuildAppDirectory(application);
		add(dockerfilePath, "the Dockerfile path");
		add(path.dirname(dockerfilePath), "the Dockerfile path");
		if (createEnvFile && !publishDirectory) {
			add(path.join(path.dirname(dockerfilePath), ".env"), "the .env file");
		}
	}
	const writesStaticFiles =
		buildType === "static" || (buildType === "nixpacks" && !!publishDirectory);
	if (writesStaticFiles) {
		for (const file of ["Dockerfile", ".dockerignore"]) {
			add(path.join(buildDirectory, file), "a file the build writes");
		}
		if (isStaticSpa) {
			add(path.join(buildDirectory, "nginx.conf"), "a file the build writes");
		}
		if (createEnvFile && !publishDirectory) {
			add(path.join(buildDirectory, ".env"), "the .env file");
		}
	}
	if (buildType === "railpack") {
		for (const file of ["railpack-plan.json", "railpack-info.json"]) {
			add(path.join(buildDirectory, file), "a file the build writes");
		}
	}
	if (buildType === "dockerfile" || writesStaticFiles) {
		const contextPath = getDockerContextPath(application);
		if (contextPath) {
			checks.push({
				// The same checkout `getDockerContextPath` joins it to.
				codeDirectory: getCodeDirectory(application, application.serverId),
				place: contextPath,
				label: "the Docker context path",
			});
		}
	}
	if (buildType === "nixpacks" || buildType === "static") {
		const publishPath = getPublishDirectoryPath(application);
		if (publishPath) {
			add(publishPath, "the publish directory");
		}
	}
	return checks;
};

/**
 * Shell lines for the build host, placed after the clone and before the
 * build (T-8282). The settings were checked as text when the script was
 * assembled (`joinInsideCodeDirectory`); these check what the checkout holds.
 * Each place is resolved with its links (`realpath -m`, or `readlink -f`
 * where that is all there is; a missing tail is fine, `mkdir -p` makes it
 * later) and has to be the resolved code directory or inside it. When
 * neither tool works, the build is refused. `cleanup` runs before a refusal
 * exits.
 */
export const getBuildPathGuardCommand = (
	application: ApplicationNested,
	cleanup = "",
) => {
	const refuse = (message: string) =>
		`{ ${cleanup ? `${cleanup} ` : ""}echo ${quote([`❌ Build refused: ${message}`])} >&2; exit 1; }`;
	const lines = [
		"if realpath -m -- / >/dev/null 2>&1; then",
		'\t__dokploy_resolve() { realpath -m -- "$1"; }',
		"elif readlink -f -- / >/dev/null 2>&1; then",
		// `readlink -f` (busybox) needs the path to exist but for its last part:
		// resolve the deepest part that exists and append the rest as it is.
		'\t__dokploy_resolve() { __dokploy_r=$1 __dokploy_t=; while [ ! -e "$__dokploy_r" ] && [ ! -L "$__dokploy_r" ] && [ "$__dokploy_r" != / ]; do __dokploy_t=/${__dokploy_r##*/}$__dokploy_t; __dokploy_r=${__dokploy_r%/*}; __dokploy_r=${__dokploy_r:-/}; done; case "$__dokploy_t" in */..|*/../*) return 1;; esac; __dokploy_r=$(readlink -f -- "$__dokploy_r") && printf "%s%s\\n" "$__dokploy_r" "$__dokploy_t"; }',
		"else",
		`\t${refuse("the build host has neither realpath -m nor readlink -f, so the build settings cannot be checked.")}`,
		"fi",
		'__dokploy_inside() { __dokploy_c=$(__dokploy_resolve "$1") && [ -d "$__dokploy_c" ] && __dokploy_p=$(__dokploy_resolve "$2") || return 1; case "$__dokploy_p" in "$__dokploy_c"|"$__dokploy_c"/*) return 0;; esac; return 1; }',
	];
	for (const { codeDirectory, place, label } of getBuildPathChecks(
		application,
	)) {
		lines.push(
			`__dokploy_inside ${quote([codeDirectory])} ${quote([place])} || ${refuse(`${label} is not inside the repository. Set it in the application's settings to a path inside the repository and deploy again.`)}`,
		);
	}
	return `\n${lines.join("\n")}\n`;
};
