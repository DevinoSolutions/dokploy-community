import { execAsync, execAsyncRemote } from "../process/execAsync";
import { encodeBase64, getServiceContainer } from "./utils";

export type DeployHookKind = "pre" | "post";

export interface DeployHooks {
	pre?: string | null;
	post?: string | null;
}

export const parseDeployHooks = (
	raw: string | null | undefined,
): DeployHooks => {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return {
				pre: typeof parsed.pre === "string" ? parsed.pre : null,
				post: typeof parsed.post === "string" ? parsed.post : null,
			};
		}
	} catch {
		/* ignore malformed payload — treat as no hooks */
	}
	return {};
};

interface RunDeployHookParams {
	kind: DeployHookKind;
	appName: string;
	// The server the application's containers run on — `application.serverId`,
	// NOT `buildServerId || serverId`. Hooks exec against the deployed
	// container, which only exists on the deploy host; a build server never
	// has it.
	serverId: string | null | undefined;
	command: string | null | undefined;
	logPath: string;
	// If provided, skip the label-based container lookup and exec against this
	// container id directly. Post-deploy uses this to target the exact task the
	// swarm stability gate observed as running, avoiding the ambiguity of a
	// label lookup while the outgoing and incoming tasks briefly coexist.
	containerId?: string;
}

export const runDeployHook = async ({
	kind,
	appName,
	serverId,
	command,
	logPath,
	containerId,
}: RunDeployHookParams): Promise<void> => {
	const trimmed = command?.trim();
	if (!trimmed) return;

	let resolvedContainerId = containerId;
	if (!resolvedContainerId) {
		const container = await getServiceContainer(appName, serverId);
		if (!container) {
			if (kind === "pre") {
				const skipLine = `echo "===== No previous container found; skipping pre-deploy hook =====" >> "${logPath}"`;
				if (serverId) {
					await execAsyncRemote(serverId, skipLine);
				} else {
					await execAsync(skipLine);
				}
				return;
			}
			throw new Error(
				`post-deploy hook: no running container found for "${appName}"`,
			);
		}
		resolvedContainerId = container.Id;
	}

	const label = kind === "pre" ? "pre-deploy" : "post-deploy";
	const encoded = encodeBase64(trimmed);
	const scriptWrapper = `hook_cmd=$(echo "${encoded}" | base64 -d) && docker exec "${resolvedContainerId}" sh -c "$hook_cmd"`;
	const wrappedCommand = `(echo "===== Running ${label} hook (length=${trimmed.length} chars) =====" && ${scriptWrapper} && echo "===== ${label} hook finished =====") >> "${logPath}" 2>&1`;

	if (serverId) {
		await execAsyncRemote(serverId, wrappedCommand);
	} else {
		await execAsync(wrappedCommand);
	}
};
