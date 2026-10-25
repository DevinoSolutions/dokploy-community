import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Application } from "@dokploy/server/services/application";
import { TRPCError } from "@trpc/server";
import { getCheckoutPathError } from "../compose-path";
import { execAsync, execAsyncRemote } from "../process/execAsync";

export const recreateDirectory = async (pathFolder: string): Promise<void> => {
	try {
		await removeDirectoryIfExistsContent(pathFolder);
		await fsPromises.mkdir(pathFolder, { recursive: true });
	} catch (error) {
		console.error(`Error recreating directory '${pathFolder}':`, error);
	}
};

export const recreateDirectoryRemote = async (
	pathFolder: string,
	serverId: string | null,
): Promise<void> => {
	try {
		await execAsyncRemote(
			serverId,
			`rm -rf ${pathFolder}; mkdir -p ${pathFolder}`,
		);
	} catch (error) {
		console.error(`Error recreating directory '${pathFolder}':`, error);
	}
};

export const removeDirectoryIfExistsContent = async (
	path: string,
): Promise<void> => {
	if (fs.existsSync(path) && fs.readdirSync(path).length !== 0) {
		await execAsync(`rm -rf ${path}`);
	}
};

export const removeFileOrDirectory = async (path: string) => {
	try {
		await execAsync(`rm -rf ${path}`);
	} catch (error) {
		console.error(`Error removing ${path}: ${error}`);
		throw error;
	}
};

export const removeDirectoryCode = async (
	appName: string,
	serverId?: string | null,
) => {
	const { APPLICATIONS_PATH } = paths(!!serverId);
	const directoryPath = path.join(APPLICATIONS_PATH, appName);
	const command = `rm -rf ${directoryPath}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing ${directoryPath}: ${error}`);
		throw error;
	}
};

export const removeComposeDirectory = async (
	appName: string,
	serverId?: string | null,
) => {
	const { COMPOSE_PATH } = paths(!!serverId);
	const directoryPath = path.join(COMPOSE_PATH, appName);
	const command = `rm -rf ${directoryPath}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing ${directoryPath}: ${error}`);
		throw error;
	}
};

export const removeMonitoringDirectory = async (
	appName: string,
	serverId?: string | null,
) => {
	const { MONITORING_PATH } = paths(!!serverId);
	const directoryPath = path.join(MONITORING_PATH, appName);
	const command = `rm -rf ${directoryPath}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing ${directoryPath}: ${error}`);
		throw error;
	}
};

/**
 * `value`, a build setting of the application, joined to `directory`. The
 * deploy is refused when the setting holds a control character or a
 * backslash, or when the joined path is not inside `codeDirectory`, the
 * application's checkout (T-8282). Rows saved before the API checked these
 * settings go through here as well.
 */
export const joinInsideCodeDirectory = (
	codeDirectory: string,
	directory: string,
	value: string,
	label: string,
) => {
	const fullPath = path.join(directory, value);
	const relative = path.relative(codeDirectory, fullPath);
	const reason =
		getCheckoutPathError(value, label, { parentSegments: true }) ??
		(relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
			? `${label} leaves the repository`
			: null);
	if (reason) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Build refused: ${reason}. Set it in the application's settings to a path inside the repository and deploy again.`,
		});
	}
	return fullPath;
};

/** The application's checkout on the host that runs its build. */
export const getCodeDirectory = (
	application: Application,
	serverId = application.buildServerId || application.serverId,
) => {
	const { APPLICATIONS_PATH } = paths(!!serverId);
	return path.join(APPLICATIONS_PATH, application.appName, "code");
};

/** The directory the build path of the application's provider names. */
export const getBuildDirectory = (application: Application) => {
	const { sourceType, customGitBuildPath } = application;
	const codeDirectory = getCodeDirectory(application);
	let buildPath = "";

	if (sourceType === "github") {
		buildPath = application?.buildPath || "";
	} else if (sourceType === "gitlab") {
		buildPath = application?.gitlabBuildPath || "";
	} else if (sourceType === "bitbucket") {
		buildPath = application?.bitbucketBuildPath || "";
	} else if (sourceType === "gitea") {
		buildPath = application?.giteaBuildPath || "";
	} else if (sourceType === "drop") {
		buildPath = application?.dropBuildPath || "";
	} else if (sourceType === "git") {
		buildPath = customGitBuildPath || "";
	}
	return joinInsideCodeDirectory(
		codeDirectory,
		codeDirectory,
		buildPath ?? "",
		"the build path",
	);
};

export const getBuildAppDirectory = (application: Application) => {
	const { buildType, dockerfile } = application;
	const buildDirectory = getBuildDirectory(application);
	if (buildType === "dockerfile") {
		return joinInsideCodeDirectory(
			getCodeDirectory(application),
			buildDirectory,
			dockerfile || "Dockerfile",
			"the Dockerfile path",
		);
	}

	return buildDirectory;
};

/**
 * Where the publish directory (`publishDirectory`) of a nixpacks or static
 * build lands on the host: inside the build directory, and refused like the
 * other build settings when it is not inside the checkout. `null` when it is
 * not set.
 */
export const getPublishDirectoryPath = (application: Application) => {
	const { publishDirectory } = application;
	if (!publishDirectory) {
		return null;
	}
	return joinInsideCodeDirectory(
		getCodeDirectory(application),
		getBuildAppDirectory(application),
		publishDirectory,
		"the publish directory",
	);
};

export const getDockerContextPath = (application: Application) => {
	const { dockerContextPath } = application;

	if (!dockerContextPath) {
		return null;
	}

	const codeDirectory = getCodeDirectory(application, application.serverId);
	return joinInsideCodeDirectory(
		codeDirectory,
		codeDirectory,
		dockerContextPath,
		"the Docker context path",
	);
};
