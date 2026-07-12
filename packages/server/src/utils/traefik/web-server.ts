import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { webServerSettings } from "@dokploy/server/db/schema/web-server-settings";
import { parse, stringify } from "yaml";
import {
	loadOrCreateConfig,
	removeTraefikConfig,
	writeTraefikConfig,
} from "./application";
import type { FileConfig } from "./file-types";
import { loadMiddlewares, writeMiddleware } from "./middleware";
import type { MainTraefikConfig } from "./types";

export const RESPONSE_COMPRESSION_MIDDLEWARE = "compress";
const RESPONSE_COMPRESSION_MIDDLEWARE_REF = `${RESPONSE_COMPRESSION_MIDDLEWARE}@file`;
const RESPONSE_COMPRESSION_ENTRYPOINTS = ["web", "websecure"];

export const updateServerTraefik = (
	settings: typeof webServerSettings.$inferSelect | null,
	newHost: string | null,
) => {
	const { https, certificateType } = settings || {};
	const appName = "dokploy";
	const config: FileConfig = loadOrCreateConfig(appName);

	config.http = config.http || { routers: {}, services: {} };
	config.http.routers = config.http.routers || {};
	config.http.services = config.http.services || {};

	// Get or create router config, but always update the rule with newHost
	const currentRouterConfig = config.http.routers[`${appName}-router-app`] || {
		service: `${appName}-service-app`,
		entryPoints: ["web"],
		rule: `Host(\`${newHost}\`)`,
	};

	// Always update the rule with the new host
	if (newHost) {
		currentRouterConfig.rule = `Host(\`${newHost}\`)`;
	}

	config.http.routers[`${appName}-router-app`] = currentRouterConfig;

	config.http.services = {
		...config.http.services,
		[`${appName}-service-app`]: {
			loadBalancer: {
				servers: [
					{
						url: `http://dokploy:${process.env.PORT || 3000}`,
					},
				],
				passHostHeader: true,
			},
		},
	};

	if (https) {
		currentRouterConfig.middlewares = ["redirect-to-https"];

		if (certificateType === "letsencrypt") {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
				tls: { certResolver: "letsencrypt" },
			};
		} else {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
			};
		}
	} else {
		delete config.http.routers[`${appName}-router-app-secure`];
		currentRouterConfig.middlewares = [];
	}

	if (newHost) {
		writeTraefikConfig(config, appName);
	} else {
		removeTraefikConfig(appName);
	}
};

export const updateLetsEncryptEmail = (newEmail: string | null) => {
	try {
		if (!newEmail) return;
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		const configContent = readFileSync(configPath, "utf8");
		const config = parse(configContent) as MainTraefikConfig;
		if (config?.certificatesResolvers?.letsencrypt?.acme) {
			config.certificatesResolvers.letsencrypt.acme.email = newEmail;
		} else {
			throw new Error("Invalid Let's Encrypt configuration structure.");
		}
		const newYamlContent = stringify(config);
		writeFileSync(configPath, newYamlContent, "utf8");
	} catch (error) {
		throw error;
	}
};

export const readMainConfig = () => {
	const { MAIN_TRAEFIK_PATH } = paths();
	const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
	if (existsSync(configPath)) {
		const yamlStr = readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeMainConfig = (traefikConfig: string) => {
	try {
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		writeFileSync(configPath, traefikConfig, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

export const isResponseCompressionEnabledInConfig = (
	config: MainTraefikConfig | null,
) => {
	if (!config?.entryPoints) {
		return false;
	}
	return RESPONSE_COMPRESSION_ENTRYPOINTS.some((entryPointName) =>
		config.entryPoints?.[entryPointName]?.http?.middlewares?.includes(
			RESPONSE_COMPRESSION_MIDDLEWARE_REF,
		),
	);
};

export const applyResponseCompressionToMainConfig = (
	config: MainTraefikConfig,
	enabled: boolean,
) => {
	for (const entryPointName of RESPONSE_COMPRESSION_ENTRYPOINTS) {
		const entryPoint = config?.entryPoints?.[entryPointName];
		if (!entryPoint) {
			continue;
		}
		const middlewares = (entryPoint.http?.middlewares || []).filter(
			(middleware) => middleware !== RESPONSE_COMPRESSION_MIDDLEWARE_REF,
		);

		if (enabled) {
			middlewares.push(RESPONSE_COMPRESSION_MIDDLEWARE_REF);
		}

		if (middlewares.length > 0) {
			entryPoint.http = {
				...entryPoint.http,
				middlewares,
			};
		} else if (entryPoint.http?.middlewares) {
			delete entryPoint.http.middlewares;
			if (Object.keys(entryPoint.http).length === 0) {
				delete entryPoint.http;
			}
		}
	}
	return config;
};

export const applyResponseCompressionToMiddlewaresConfig = (
	config: FileConfig,
	enabled: boolean,
) => {
	config.http = config.http || {};
	config.http.middlewares = config.http.middlewares || {};

	if (enabled) {
		config.http.middlewares[RESPONSE_COMPRESSION_MIDDLEWARE] = {
			compress: {},
		};
	} else {
		delete config.http.middlewares[RESPONSE_COMPRESSION_MIDDLEWARE];
	}
	return config;
};

export const isResponseCompressionEnabled = () => {
	const yamlStr = readMainConfig();
	if (!yamlStr) {
		return false;
	}
	const config = parse(yamlStr) as MainTraefikConfig;
	return isResponseCompressionEnabledInConfig(config);
};

export const updateResponseCompression = (enabled: boolean) => {
	// 1. Define (or remove) the compress middleware in the shared dynamic
	// middlewares file, the same file used by redirect-to-https.
	let middlewaresConfig: FileConfig;
	try {
		middlewaresConfig = loadMiddlewares<FileConfig>();
	} catch {
		middlewaresConfig = { http: { middlewares: {} } };
	}
	writeMiddleware(
		applyResponseCompressionToMiddlewaresConfig(middlewaresConfig, enabled),
	);

	// 2. Attach (or detach) the middleware globally on the web/websecure
	// entry points of the main Traefik config. Requires a Traefik reload.
	const yamlStr = readMainConfig();
	if (!yamlStr) {
		throw new Error("Main Traefik config (traefik.yml) not found");
	}
	const config = parse(yamlStr) as MainTraefikConfig;
	writeMainConfig(
		stringify(applyResponseCompressionToMainConfig(config, enabled)),
	);
};
