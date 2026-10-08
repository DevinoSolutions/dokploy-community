import { paths } from "@dokploy/server/constants";
import { quote } from "shell-quote";

/**
 * The docker config directory of one registry row on a host. Docker keeps a
 * single login per registry URL in a config, so giving each registry its own
 * directory lets two accounts on the same URL coexist on one host.
 */
export const getRegistryConfigDir = (registryId: string, isRemote: boolean) => {
	if (!/^[A-Za-z0-9_-]+$/.test(registryId)) {
		throw new Error("Invalid registry id");
	}
	return `${paths(isRemote).BASE_PATH}/docker-config/${registryId}`;
};

/** `docker`, or `docker --config <dir>` for a registry with its own config. */
export const dockerWithConfig = (configDir?: string | null) =>
	configDir ? `docker --config ${quote([configDir])}` : "docker";
