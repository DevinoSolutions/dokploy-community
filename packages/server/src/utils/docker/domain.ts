import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { network, patch } from "@dokploy/server/db/schema";
import type { Compose } from "@dokploy/server/services/compose";
import type { Domain } from "@dokploy/server/services/domain";
import {
	assertDeployReferencesInOrganization,
	type DeployReferenceEntity,
} from "@dokploy/server/services/service-reference-scope";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import { applyRollingDrainHealthchecks } from "../builders/compose-rolling";
import {
	assertComposeFileInsideCodeDirectory,
	getComposeCodeDirectory,
	getComposeFileRefusal,
	getGuardedReadCommand,
	isComposeFileLinkMarker,
} from "../compose-file-guard";
import { assertSafeComposePath } from "../compose-path";
import { wildcardHostRegexp } from "../hostname-validation";
import { execAsyncRemote } from "../process/execAsync";
import { cloneBitbucketRepository } from "../providers/bitbucket";
import { cloneGitRepository } from "../providers/git";
import { cloneGiteaRepository } from "../providers/gitea";
import { cloneGithubRepository } from "../providers/github";
import { cloneGitlabRepository } from "../providers/gitlab";
import { getCreateComposeFileCommand } from "../providers/raw";
import { randomizeDeployableSpecificationFile } from "./collision";
import { randomizeSpecificationFile } from "./compose";
import { singleQuote } from "./env-file";
import {
	getInstallStagedFileCommand,
	STAGED_COMPOSE_PREFIX,
	STAGED_COMPOSE_SUFFIX,
	type StageOptions,
	sanitizeStageId,
	stageFiles,
} from "./staging";
import type {
	ComposeSpecification,
	DefinitionsService,
	PropertiesNetworks,
} from "./types";

/**
 * How long a clone outside a deploy may run: it is sent TERM after this many
 * seconds and KILL `FETCH_CLONE_KILL_AFTER_SECONDS` later. A Fetch holds the
 * compose's deploy lock while it clones (T-8239), and this keeps the clone well
 * inside the lock's 10-minute last-resort release, so the lock is given back
 * after the clone has exited, not while it still writes the code dir.
 */
export const FETCH_CLONE_TIMEOUT_SECONDS = 540;
export const FETCH_CLONE_KILL_AFTER_SECONDS = 15;

/**
 * Runs `command` in `sh` under `timeout`, on whichever host runs it (the
 * Dokploy host or a remote server). A host whose `timeout` is missing or does
 * not take `-k` (BusyBox before 1.30) runs it unbounded, as before. Exits with
 * the command's status; one stopped by a signal (124, or 137 once killed,
 * which a kill from elsewhere or the OOM killer also gives) says so on stderr.
 */
export const boundFetchCommand = (
	command: string,
	seconds = FETCH_CLONE_TIMEOUT_SECONDS,
	killAfter = FETCH_CLONE_KILL_AFTER_SECONDS,
) =>
	[
		`set -- sh -c ${singleQuote(command)}`,
		`if timeout -k 1 1 true >/dev/null 2>&1; then set -- timeout -k ${killAfter} ${seconds} "$@"; fi`,
		`"$@"`,
		"status=$?",
		`if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then echo ${singleQuote(`The clone was stopped (time limit of ${seconds} s reached, or the process was killed)`)} >&2; fi`,
		`exit "$status"`,
	].join("; ");

/**
 * Clones (or writes) the compose source for a read outside a deploy: the services
 * list, the source-type fetch, the rolling-replace preflight, the collision
 * rewrite. A stored registry, git provider or SSH key of another organization
 * is refused before anything is cloned, the same as at deploy (T-6902). The
 * command is bounded by `boundFetchCommand`.
 */
export const cloneCompose = async (
	compose: Compose & DeployReferenceEntity,
) => {
	await assertDeployReferencesInOrganization(compose, "source");
	let command = "set -e;";
	const entity = {
		...compose,
		type: "compose" as const,
	};
	if (compose.sourceType === "github") {
		command += await cloneGithubRepository(entity);
	} else if (compose.sourceType === "gitlab") {
		command += await cloneGitlabRepository(entity);
	} else if (compose.sourceType === "bitbucket") {
		command += await cloneBitbucketRepository(entity);
	} else if (compose.sourceType === "git") {
		command += await cloneGitRepository(entity);
	} else if (compose.sourceType === "gitea") {
		command += await cloneGiteaRepository(entity);
	} else if (compose.sourceType === "raw") {
		command += await getCreateComposeFileCommand(compose);
	}
	return boundFetchCommand(command);
};

export const getComposePath = (compose: Compose) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName, sourceType, composePath } = compose;
	let path = "";

	if (sourceType === "raw") {
		path = "docker-compose.yml";
	} else {
		assertSafeComposePath(composePath);
		path = composePath;
	}

	return join(COMPOSE_PATH, appName, "code", path);
};

export const loadDockerCompose = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	const path = getComposePath(compose);

	if (existsSync(path)) {
		assertComposeFileInsideCodeDirectory(
			getComposeCodeDirectory(compose),
			path,
		);
		const yamlStr = readFileSync(path, "utf8");
		const parsedConfig = parse(yamlStr, {
			maxAliasCount: 10000,
			merge: true,
		}) as ComposeSpecification;
		return parsedConfig;
	}
	return null;
};

export const loadDockerComposeRemote = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	const path = getComposePath(compose);
	let stdout: string;
	try {
		if (!compose.serverId) {
			return null;
		}
		const result = await execAsyncRemote(
			compose.serverId,
			getGuardedReadCommand({
				codeDirectory: getComposeCodeDirectory(compose),
				file: path,
				read: `cat ${quote([path])}`,
			}),
		);

		if (result.stderr) {
			return null;
		}
		stdout = result.stdout;
	} catch {
		return null;
	}
	// A link out of the checkout is a refusal, not a missing file (T-7857).
	if (isComposeFileLinkMarker(stdout)) {
		throw getComposeFileRefusal(stdout);
	}
	if (!stdout) return null;
	try {
		return parse(stdout, {
			maxAliasCount: 10000,
			merge: true,
		}) as ComposeSpecification;
	} catch {
		return null;
	}
};

export const readComposeFile = async (compose: Compose) => {
	const path = getComposePath(compose);
	if (existsSync(path)) {
		assertComposeFileInsideCodeDirectory(
			getComposeCodeDirectory(compose),
			path,
		);
		const yamlStr = readFileSync(path, "utf8");
		return yamlStr;
	}
	return null;
};

/**
 * Where the expanded compose waits before the deploy script copies it into
 * place. Next to `code/` (not inside it) so the clone, which wipes `code/`,
 * can never delete it, and unique per deployment so two runs never share it.
 */
export const getStagedComposePath = (
	compose: Pick<Compose, "appName" | "serverId">,
	deploymentId?: string,
) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	return join(
		COMPOSE_PATH,
		compose.appName,
		`${STAGED_COMPOSE_PREFIX}${sanitizeStageId(deploymentId)}${STAGED_COMPOSE_SUFFIX}`,
	);
};

/**
 * Writes the compose to a staging file on the host that will run the deploy
 * script (`compose.serverId`, or this machine when unset) and returns its path.
 * The content goes through SFTP or `fs`, never through a command line: a single
 * argument to `sh -c` is capped at 128 KB (MAX_ARG_STRLEN) on Linux, and an
 * expanded compose can be larger than that. The file is created 0600 before it
 * is filled.
 */
export const stageComposeFile = async ({
	compose,
	content,
	deploymentId,
	onStaged,
}: {
	compose: Pick<Compose, "appName" | "serverId">;
	content: string;
	deploymentId?: string;
	onStaged?: StageOptions["onStaged"];
}) => {
	const stagedPath = getStagedComposePath(compose, deploymentId);
	await stageFiles({
		serverId: compose.serverId,
		directory: dirname(stagedPath),
		files: [{ path: stagedPath, content }],
	});
	onStaged?.([stagedPath]);
	return stagedPath;
};

/**
 * Shell snippet that copies the staged compose over the compose file and
 * removes the staged file. It is removed on the failure path too, so a staged
 * compose is never left behind; a failed copy aborts the script.
 */
export const getInstallStagedComposeCommand = (
	stagedPath: string,
	composePath: string,
	alsoRemove: string[] = [],
	codeDirectory?: string,
) =>
	getInstallStagedFileCommand({
		staged: stagedPath,
		destination: composePath,
		failureMessage: "❌ Error: Could not write the compose file",
		alsoRemove,
		// Replaced by a renamed temporary file, never written in place, and only
		// when its directory is inside the checkout (T-7857).
		atomicIn: codeDirectory,
	});

/**
 * Builds the compose file the deploy runs (domain labels, randomize, isolated
 * deployment). `content` is the YAML; `errorCommand` is the shell snippet that
 * reports why there is none and stops the script.
 */
export const renderComposeWithDomains = async (
	compose: Compose,
	domains: Domain[],
	options: {
		/**
		 * Rolled services of this deploy: their shell-form healthcheck is made to
		 * fail while the drain marker exists, so the old container can be taken out
		 * of rotation before it is stopped (T-9197). Empty or unset: the compose is
		 * rendered exactly as before.
		 */
		rollingDrainServices?: string[];
	} = {},
): Promise<{ content: string } | { errorCommand: string }> => {
	try {
		const composeConverted = applyRollingDrainHealthchecks(
			await addDomainToCompose(compose, domains),
			options.rollingDrainServices ?? [],
		);

		if (!composeConverted) {
			return {
				errorCommand: `
echo "❌ Error: Compose file not found";
exit 1;
			`,
			};
		}

		return { content: stringify(composeConverted, { lineWidth: 1000 }) };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error ?? "");
		// The error message embeds user-controlled fields (e.g. serviceName) and is
		// executed as part of the compose build shell script, so it must be escaped.
		return {
			errorCommand: `echo ${quote([`❌ Has occurred an error: ${message}`])};
exit 1;
		`,
		};
	}
};

/**
 * Shell snippet for the deploy script that puts the rendered compose in place.
 * The compose itself is staged out of band (see `stageComposeFile`): embedding
 * it in the script used to fail with "Argument list too long" once the
 * expanded compose passed ~96 KB.
 */
export const writeDomainsToCompose = async (
	compose: Compose,
	domains: Domain[],
	options: StageOptions & {
		/** Other files staged for the same script, removed if it stops early. */
		alsoRemove?: string[];
		/** Services rolled by this deploy, see `renderComposeWithDomains`. */
		rollingDrainServices?: string[];
	} = {},
) => {
	const alsoRemove = options.alsoRemove ?? [];
	const rendered = await renderComposeWithDomains(compose, domains, {
		rollingDrainServices: options.rollingDrainServices,
	});
	if ("errorCommand" in rendered) {
		// The script stops here: files staged for it would never be consumed.
		return alsoRemove.length > 0
			? `rm -f ${quote(alsoRemove)};${rendered.errorCommand}`
			: rendered.errorCommand;
	}

	const stagedPath = await stageComposeFile({
		compose,
		content: rendered.content,
		deploymentId: options.deploymentId,
		onStaged: options.onStaged,
	});
	return getInstallStagedComposeCommand(
		stagedPath,
		getComposePath(compose),
		alsoRemove,
		getComposeCodeDirectory(compose),
	);
};
export const applyComposeFilePatch = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	if (compose.sourceType === "raw") {
		return null;
	}

	const composePatches = await db.query.patch.findMany({
		where: eq(patch.composeId, compose.composeId),
	});

	const composeFilePatch = composePatches.find(
		(p) =>
			p.enabled &&
			p.type !== "delete" &&
			join(p.filePath) === join(compose.composePath),
	);

	if (!composeFilePatch?.content) {
		return null;
	}

	try {
		const parsed = parse(composeFilePatch.content, {
			maxAliasCount: 10000,
			merge: true,
		}) as ComposeSpecification;
		return parsed ?? null;
	} catch {
		return null;
	}
};

const removeDomainLabels = (
	labels: DefinitionsService["labels"],
	appName: string,
	uniqueConfigKey: number,
) => {
	const prefixes = [
		`traefik.http.routers.${appName}-${uniqueConfigKey}-`,
		`traefik.http.services.${appName}-${uniqueConfigKey}-`,
		`traefik.http.middlewares.stripprefix-${appName}-${uniqueConfigKey}.`,
		`traefik.http.middlewares.addprefix-${appName}-${uniqueConfigKey}.`,
	];
	const belongsToDomain = (label: string) =>
		prefixes.some((prefix) => label.startsWith(prefix));

	if (Array.isArray(labels)) {
		return labels.filter((label) => !belongsToDomain(label));
	}
	if (labels) {
		return Object.fromEntries(
			Object.entries(labels).filter(([label]) => !belongsToDomain(label)),
		);
	}

	return labels;
};

export const addDomainToCompose = async (
	compose: Compose,
	domains: Domain[],
) => {
	const { appName } = compose;

	let result: ComposeSpecification | null;

	if (compose.sourceType === "raw") {
		result = parse(compose.composeFile, {
			maxAliasCount: 10000,
			merge: true,
		}) as ComposeSpecification;
	} else if (compose.serverId) {
		result = await loadDockerComposeRemote(compose);
	} else {
		result = await loadDockerCompose(compose);
	}

	if (!result) {
		return null;
	}

	result = (await applyComposeFilePatch(compose)) ?? result;

	if (compose.isolatedDeployment) {
		const randomized = randomizeDeployableSpecificationFile(
			result,
			compose.isolatedDeploymentsVolume,
			compose.suffix || compose.appName,
		);
		result = randomized;
	} else if (compose.randomize) {
		const randomized = randomizeSpecificationFile(result, compose.suffix);
		result = randomized;
	}

	for (const domain of domains) {
		for (const service of Object.values(result.services ?? {})) {
			if (compose.composeType === "docker-compose") {
				service.labels = removeDomainLabels(
					service.labels,
					appName,
					domain.uniqueConfigKey,
				);
			} else if (service.deploy) {
				service.deploy.labels = removeDomainLabels(
					service.deploy.labels,
					appName,
					domain.uniqueConfigKey,
				);
			}
		}
	}

	for (const domain of domains.filter((d) => d.enabled)) {
		const { serviceName, https } = domain;
		if (!serviceName) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Domain "${domain.host}" is missing a service name`,
			});
		}
		if (!result?.services?.[serviceName]) {
			// A domain pointing at a service the compose file no longer defines is
			// a configuration problem the user fixes, not a server failure.
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Domain "${domain.host}" is attached to service "${serviceName}" which does not exist in the compose`,
			});
		}

		const httpLabels = createDomainLabels(
			appName,
			domain,
			domain.customEntrypoint || "web",
		);
		if (!domain.customEntrypoint && https) {
			const httpsLabels = createDomainLabels(appName, domain, "websecure");
			httpLabels.push(...httpsLabels);
		}

		let labels: DefinitionsService["labels"] = [];
		if (compose.composeType === "docker-compose") {
			if (!result.services[serviceName].labels) {
				result.services[serviceName].labels = [];
			}

			labels = result.services[serviceName].labels;
		} else {
			// Stack Case
			if (!result.services[serviceName].deploy) {
				result.services[serviceName].deploy = {};
			}
			if (!result.services[serviceName].deploy.labels) {
				result.services[serviceName].deploy.labels = [];
			}

			labels = result.services[serviceName].deploy.labels;
		}

		const networkLabel =
			compose.composeType === "docker-compose"
				? "traefik.docker.network"
				: "traefik.swarm.network";
		const networkName = compose.isolatedDeployment
			? compose.suffix || compose.appName
			: "dokploy-network";

		if (Array.isArray(labels)) {
			if (!labels.includes("traefik.enable=true")) {
				labels.unshift("traefik.enable=true");
			}
			labels.unshift(...httpLabels);
			const networkLabelEntry = `${networkLabel}=${networkName}`;
			if (!labels.includes(networkLabelEntry)) {
				labels.unshift(networkLabelEntry);
			}
		} else if (labels) {
			labels["traefik.enable"] = "true";
			labels[networkLabel] = networkName;
			for (const label of httpLabels) {
				const separatorIndex = label.indexOf("=");
				labels[label.slice(0, separatorIndex)] = label.slice(
					separatorIndex + 1,
				);
			}
		}

		if (!compose.isolatedDeployment) {
			// Add the dokploy-network to the service
			result.services[serviceName].networks = addDokployNetworkToService(
				result.services[serviceName].networks,
			);
		}
	}

	const injectedNetworkNames = await applyServiceNetworks(result, compose);

	if (!compose.isolatedDeployment) {
		declareUsedNetworksInRoot(result, injectedNetworkNames);
	}

	return result;
};

export const applyServiceNetworks = async (
	result: ComposeSpecification,
	compose: Compose,
) => {
	const injectedNetworkNames = new Set<string>();
	const serviceNetworks = compose.serviceNetworks ?? [];
	if (serviceNetworks.length === 0) return injectedNetworkNames;

	const allNetworkIds = [
		...new Set(serviceNetworks.flatMap((s) => s.networkIds)),
	];
	const networks =
		allNetworkIds.length > 0
			? await db.query.network.findMany({
					where: inArray(network.networkId, allNetworkIds),
				})
			: [];

	for (const config of serviceNetworks) {
		const service = result.services?.[config.serviceName];
		if (!service) continue;

		for (const networkId of config.networkIds) {
			const match = networks.find((n) => n.networkId === networkId);
			if (!match) continue;
			service.networks = addDokployNetworkToService(
				service.networks,
				match.name,
			);
			injectedNetworkNames.add(match.name);
		}

		if (config.detachDokployNetwork) {
			removeNetworkFromService(service, "dokploy-network");
			removeNetworkFromService(service, "default");
			removeDokployNetworkLabel(service);
		}
	}

	return injectedNetworkNames;
};

export const declareUsedNetworksInRoot = (
	result: ComposeSpecification,
	injectedNetworkNames: Set<string>,
) => {
	const isUsed = (name: string) =>
		Object.values(result.services ?? {}).some((service) => {
			const nets = service?.networks;
			if (Array.isArray(nets)) return nets.includes(name);
			if (nets && typeof nets === "object") return name in nets;
			return false;
		});

	if (isUsed("dokploy-network")) {
		result.networks = addDokployNetworkToRoot(result.networks);
	}
	for (const name of injectedNetworkNames) {
		if (isUsed(name)) {
			result.networks = addDokployNetworkToRoot(result.networks, name);
		}
	}
};

export const createDomainLabels = (
	appName: string,
	domain: Domain,
	entrypoint: string,
) => {
	const {
		host,
		port,
		customEntrypoint,
		https,
		uniqueConfigKey,
		certificateType,
		path,
		customCertResolver,
		stripPath,
		internalPath,
	} = domain;
	const routerName = `${appName}-${uniqueConfigKey}-${entrypoint}`;
	// Generate the Host rule - support wildcards. Traefik v3 HostRegexp takes
	// a plain Go regexp (the v2 "{subdomain:...}" syntax is invalid in v3).
	const hostRule = host.startsWith("*.")
		? `HostRegexp(\`${wildcardHostRegexp(host)}\`)`
		: `Host(\`${host}\`)`;

	const labels = [
		`traefik.http.routers.${routerName}.rule=${hostRule}${path && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		`traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
		`traefik.http.services.${routerName}.loadbalancer.server.port=${port}`,
		`traefik.http.routers.${routerName}.service=${routerName}`,
	];

	// Collect middlewares for this router
	const middlewares: string[] = [];
	// Cloudflare-published domains terminate TLS at the edge and reach Traefik
	// over plain HTTP via cloudflared; skip the web->websecure redirect to avoid
	// redirect loops / 502s.
	const isRedirectRouter =
		entrypoint === "web" &&
		https &&
		!customEntrypoint &&
		!domain.publishToCloudflare;

	// Web router with HTTPS only needs redirect — all other middlewares
	// run on the websecure router where the request actually lands.
	if (isRedirectRouter) {
		middlewares.push("redirect-to-https@file");
	}

	// Add stripPath middleware if needed
	if (stripPath && path && path !== "/") {
		const middlewareName = `stripprefix-${appName}-${uniqueConfigKey}`;
		// Define middleware on web (or custom) entrypoint so Traefik registers it
		if (entrypoint === "web" || customEntrypoint) {
			labels.push(
				`traefik.http.middlewares.${middlewareName}.stripprefix.prefixes=${path}`,
			);
		}
		if (!isRedirectRouter) {
			middlewares.push(middlewareName);
		}
	}

	// Add internalPath middleware if needed
	if (internalPath && internalPath !== "/" && internalPath.startsWith("/")) {
		const middlewareName = `addprefix-${appName}-${uniqueConfigKey}`;
		// Define middleware on web (or custom) entrypoint so Traefik registers it
		if (entrypoint === "web" || customEntrypoint) {
			labels.push(
				`traefik.http.middlewares.${middlewareName}.addprefix.prefix=${internalPath}`,
			);
		}
		if (!isRedirectRouter) {
			middlewares.push(middlewareName);
		}
	}

	// Add custom middlewares (skip for redirect-only router)
	if (!isRedirectRouter && domain.middlewares?.length) {
		middlewares.push(...domain.middlewares);
	}

	// Apply middlewares to router if any exist
	if (middlewares.length > 0) {
		labels.push(
			`traefik.http.routers.${routerName}.middlewares=${middlewares.join(",")}`,
		);
	}

	// Add TLS configuration for websecure
	if (entrypoint === "websecure" || (customEntrypoint && https)) {
		if (certificateType === "letsencrypt") {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`,
			);
		} else if (certificateType === "custom" && customCertResolver) {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=${customCertResolver}`,
			);
		} else if (certificateType === "none" && https) {
			// No cert resolver, but HTTPS is enabled (default/custom certificate):
			// explicitly enable TLS so Traefik serves the router over HTTPS.
			labels.push(`traefik.http.routers.${routerName}.tls=true`);
		}
	}

	return labels;
};

export const addDokployNetworkToService = (
	networkService: DefinitionsService["networks"],
	networkName = "dokploy-network",
) => {
	let networks = networkService;
	const network = networkName;
	const defaultNetwork = "default";
	// If the service had no `networks` key it was relying on Compose's implicit
	// `default` network, so we preserve that by adding it back. If it declared
	// explicit networks (even an empty list/object), we must NOT force `default`
	// onto it, otherwise Compose creates a new per-project default network on
	// every deploy and eventually exhausts Docker's address pools.
	const hadExplicitNetworks = networkService !== undefined;
	if (!networks) {
		networks = [];
	} else if (Array.isArray(networks)) {
		networks = [...networks];
	} else if (typeof networks === "object") {
		networks = { ...networks };
	}

	if (Array.isArray(networks)) {
		if (!networks.includes(network)) {
			networks.push(network);
		}
		if (!hadExplicitNetworks && !networks.includes(defaultNetwork)) {
			networks.push(defaultNetwork);
		}
	} else if (networks && typeof networks === "object") {
		if (!(network in networks)) {
			networks[network] = {};
		}
		if (!hadExplicitNetworks && !(defaultNetwork in networks)) {
			networks[defaultNetwork] = {};
		}
	}

	return networks;
};

export const removeNetworkFromService = (
	service: DefinitionsService,
	networkName: string,
) => {
	const networks = service.networks;
	if (Array.isArray(networks)) {
		service.networks = networks.filter((n) => n !== networkName);
	} else if (networks && typeof networks === "object") {
		delete networks[networkName];
	}
};

const removeDokployNetworkLabel = (service: DefinitionsService) => {
	const stripped = (labels: DefinitionsService["labels"]) => {
		if (Array.isArray(labels)) {
			return labels.filter(
				(l) =>
					l !== "traefik.docker.network=dokploy-network" &&
					l !== "traefik.swarm.network=dokploy-network",
			);
		}
		return labels;
	};
	if (service.labels) service.labels = stripped(service.labels);
	if (service.deploy?.labels)
		service.deploy.labels = stripped(service.deploy.labels);
};

export const addDokployNetworkToRoot = (
	networkRoot: PropertiesNetworks | undefined,
	networkName = "dokploy-network",
) => {
	let networks = networkRoot;
	const network = networkName;

	if (!networks) {
		networks = {};
	}

	if (networks[network] || !networks[network]) {
		networks[network] = {
			external: true,
		};
	}

	return networks;
};
