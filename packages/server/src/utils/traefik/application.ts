import fs from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import type { Domain } from "@dokploy/server/services/domain";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import {
	aggregateHourlyRequests,
	DATE_RANGE_ENTRY_LIMIT,
	DEFAULT_ENTRY_LIMIT,
	type HourlyRequestCount,
	readLastLogEntries,
} from "../access-log/reader";
import { processLogs } from "../access-log/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	asRemoteRefusal,
	dynamicTraefikFile,
	editorTraefikFile,
	isTraefikPathError,
	REMOTE_ABSENT,
	readConfinedFile,
	remoteConfinedReadCommand,
	remoteConfinedWriteCommand,
	type TraefikFile,
	writeConfinedFile,
} from "./confine";
import type { FileConfig, HttpLoadBalancerService } from "./file-types";

export const createTraefikConfig = (appName: string) => {
	const defaultPort = 3000;
	const serviceURLDefault = `http://${appName}:${defaultPort}`;
	const domainDefault = `Host(\`${appName}.docker.localhost\`)`;
	const config: FileConfig = {
		http: {
			routers: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${appName}-router-1`]: {
								rule: domainDefault,
								service: `${appName}-service-1`,
								entryPoints: ["web"],
							},
						}),
			},

			services: {
				...(process.env.NODE_ENV === "production"
					? {}
					: {
							[`${appName}-service-1`]: {
								loadBalancer: {
									servers: [{ url: serviceURLDefault }],
									passHostHeader: true,
								},
							},
						}),
			},
		},
	};
	const yamlStr = stringify(config);
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	fs.mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeConfinedFile(dynamicTraefikFile(`${appName}.yml`), yamlStr);
};

export const removeTraefikConfig = async (
	appName: string,
	serverId?: string | null,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		const command = `rm -f ${quote([configPath])}`;

		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing traefik config for ${appName}:`, error);
	}
};

export const removeTraefikConfigRemote = async (
	appName: string,
	serverId: string,
) => {
	try {
		const { DYNAMIC_TRAEFIK_PATH } = paths(true);
		const configPath = path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`);
		await execAsyncRemote(serverId, `rm -f ${quote([configPath])}`);
	} catch (error) {
		console.error(
			`Error removing remote traefik config for ${appName}:`,
			error,
		);
	}
};

/**
 * Reads a file on a remote server, confined to the Traefik directory
 * (symlinks resolved and refused, see `confine.ts`). Null when the file does
 * not exist; a refusal throws.
 */
export const readConfinedRemote = async (
	serverId: string,
	file: TraefikFile,
): Promise<string | null> => {
	try {
		const { stdout } = await execAsyncRemote(
			serverId,
			remoteConfinedReadCommand(file),
		);
		return stdout || null;
	} catch (error) {
		const refusal = asRemoteRefusal(error, file.target);
		if (refusal) throw refusal;
		if ((error as { exitCode?: unknown })?.exitCode === REMOTE_ABSENT) {
			return null;
		}
		throw error;
	}
};

/**
 * Writes a file on a remote server, confined to the Traefik directory; the
 * text goes over stdin. A refusal throws a TRPCError (BAD_REQUEST).
 */
export const writeConfinedRemote = async (
	serverId: string,
	file: TraefikFile,
	content: string,
): Promise<void> => {
	try {
		await execAsyncRemote(
			serverId,
			remoteConfinedWriteCommand(file),
			undefined,
			{ stdin: content },
		);
	} catch (error) {
		const refusal = asRemoteRefusal(error, file.target);
		if (refusal) throw refusal;
		throw error;
	}
};

const configLocks = new Map<string, Promise<unknown>>();

export const withTraefikConfigLock = async <T>(
	appName: string,
	serverId: string | null | undefined,
	fn: () => Promise<T>,
): Promise<T> => {
	const key = `${serverId ?? "local"}:${appName}`;
	const previous = configLocks.get(key) ?? Promise.resolve();
	const current = previous.catch(() => {}).then(fn);
	configLocks.set(key, current);
	try {
		return await current;
	} finally {
		if (configLocks.get(key) === current) {
			configLocks.delete(key);
		}
	}
};

export const loadOrCreateConfig = (appName: string): FileConfig => {
	const yamlStr = readConfinedFile(dynamicTraefikFile(`${appName}.yml`));
	if (yamlStr !== null) {
		const parsedConfig = (parse(yamlStr) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	}
	return { http: { routers: {}, services: {} } };
};

export const loadOrCreateConfigRemote = async (
	serverId: string,
	appName: string,
) => {
	const fileConfig: FileConfig = { http: { routers: {}, services: {} } };
	try {
		const stdout = await readConfinedRemote(
			serverId,
			dynamicTraefikFile(`${appName}.yml`, true),
		);

		if (!stdout) return fileConfig;

		const parsedConfig = (parse(stdout) as FileConfig) || {
			http: { routers: {}, services: {} },
		};
		return parsedConfig;
	} catch (error) {
		if (isTraefikPathError(error)) throw error;
		return fileConfig;
	}
};

export const readConfig = (appName: string) => {
	return readConfinedFile(dynamicTraefikFile(`${appName}.yml`));
};

export const readRemoteConfig = async (serverId: string, appName: string) => {
	try {
		return await readConfinedRemote(
			serverId,
			dynamicTraefikFile(`${appName}.yml`, true),
		);
	} catch (error) {
		if (isTraefikPathError(error)) throw error;
		return null;
	}
};

export const readMonitoringConfig = async (
	readAll = false,
	dateRange?: { start?: string; end?: string },
) => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, "access.log");
	if (!fs.existsSync(configPath)) {
		return null;
	}

	// access.log is append-only, so the entries the UI cares about are always at the
	// end of the file. Reading backwards keeps memory bounded by what is returned
	// instead of by the size of the log, and never blocks the event loop.
	//
	// When a start date is given the walk stops there; the limit is then only a safety
	// ceiling so that a very wide range still cannot pull an unbounded number of
	// entries into memory.
	return readLastLogEntries(configPath, {
		limit: readAll ? DATE_RANGE_ENTRY_LIMIT : DEFAULT_ENTRY_LIMIT,
		notBefore: dateRange?.start ? new Date(dateRange.start) : undefined,
	});
};

/**
 * Requests-per-hour series for the Requests page chart.
 *
 * With a date range the access log is streamed and aggregated without any entry cap,
 * so a wide range over a very large log is neither truncated nor loaded into memory.
 * Without a range it keeps the previous behaviour of summarising the default window
 * of entries.
 */
export const readMonitoringStats = async (dateRange?: {
	start?: string;
	end?: string;
}): Promise<HourlyRequestCount[]> => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configPath = path.join(DYNAMIC_TRAEFIK_PATH, "access.log");
	if (!fs.existsSync(configPath)) {
		return [];
	}
	if (dateRange?.start || dateRange?.end) {
		return aggregateHourlyRequests(configPath, dateRange);
	}
	return processLogs((await readMonitoringConfig(false)) as string);
};

/**
 * The Traefik files editor's read: `pathFile` is the path the router already
 * resolved. It is confined again here, in the same command (remote) or at the
 * open (local), so a link swapped in between is refused, not followed.
 */
export const readConfigInPath = async (pathFile: string, serverId?: string) => {
	const file = editorTraefikFile(pathFile, !!serverId);
	if (serverId) {
		return readConfinedRemote(serverId, file);
	}
	return readConfinedFile(file);
};

export const writeConfig = (appName: string, traefikConfig: string) => {
	try {
		writeConfinedFile(dynamicTraefikFile(`${appName}.yml`), traefikConfig);
	} catch (e) {
		if (isTraefikPathError(e)) throw e;
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeConfigRemote = async (
	serverId: string,
	appName: string,
	traefikConfig: string,
) => {
	try {
		await writeConfinedRemote(
			serverId,
			dynamicTraefikFile(`${appName}.yml`, true),
			traefikConfig,
		);
	} catch (e) {
		if (isTraefikPathError(e)) throw e;
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfigInPath = async (
	pathFile: string,
	traefikConfig: string,
	serverId?: string,
) => {
	try {
		const file = editorTraefikFile(pathFile, !!serverId);
		if (serverId) {
			await writeConfinedRemote(serverId, file, traefikConfig);
		} else {
			writeConfinedFile(file, traefikConfig);
		}
	} catch (e) {
		if (isTraefikPathError(e)) throw e;
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfig = (
	traefikConfig: FileConfig,
	appName: string,
) => {
	try {
		const yamlStr = stringify(traefikConfig);
		writeConfinedFile(dynamicTraefikFile(`${appName}.yml`), yamlStr);
	} catch (e) {
		if (isTraefikPathError(e)) throw e;
		console.error("Error saving the YAML config file:", e);
	}
};

export const writeTraefikConfigRemote = async (
	traefikConfig: FileConfig,
	appName: string,
	serverId: string,
) => {
	try {
		const yamlStr = stringify(traefikConfig);
		await writeConfinedRemote(
			serverId,
			dynamicTraefikFile(`${appName}.yml`, true),
			yamlStr,
		);
	} catch (e) {
		if (isTraefikPathError(e)) throw e;
		console.error("Error saving the YAML config file:", e);
	}
};

const isEmptyHttpRoutersAndServices = (traefikConfig: FileConfig) =>
	Object.keys(traefikConfig.http?.routers || {}).length === 0 &&
	Object.keys(traefikConfig.http?.services || {}).length === 0;

export const writeAppTraefikConfig = async (
	traefikConfig: FileConfig,
	appName: string,
	serverId?: string | null,
) => {
	if (isEmptyHttpRoutersAndServices(traefikConfig)) {
		await removeTraefikConfig(appName, serverId);
		return;
	}
	if (serverId) {
		await writeTraefikConfigRemote(traefikConfig, appName, serverId);
	} else {
		writeTraefikConfig(traefikConfig, appName);
	}
};

export const createServiceConfig = (
	appName: string,
	domain: Domain,
): {
	loadBalancer: HttpLoadBalancerService;
} => ({
	loadBalancer: {
		servers: [{ url: `http://${appName}:${domain.port || 80}` }],
		passHostHeader: true,
	},
});
