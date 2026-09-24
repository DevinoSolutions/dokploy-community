import { appendFile } from "node:fs/promises";
import { ExecError } from "../process/ExecError";
import {
	execAsync,
	execAsyncRemote,
	execAsyncStream,
} from "../process/execAsync";
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
	// The server that holds `logPath`. The deployment log follows the build, so
	// when builds are relocated this differs from `serverId` and hook output
	// has to be relayed between hosts. Required on purpose: every caller must
	// say where the log lives. null, undefined and "" all mean the Dokploy host.
	logServerId: string | null | undefined;
	// If provided, skip the label-based container lookup and exec against this
	// container id directly. Post-deploy uses this to target the exact task the
	// swarm stability gate observed as running, avoiding the ambiguity of a
	// label lookup while the outgoing and incoming tasks briefly coexist.
	containerId?: string;
}

/**
 * Raw bytes of hook output appended to a remote log per command. The bytes are
 * base64-encoded into the command string (about 44 KiB here), which has to stay
 * well under the remote shell's single-argument limit (Linux MAX_ARG_STRLEN,
 * 128 KiB, since sshd runs `$SHELL -c <command>`) and the SSH request limits.
 */
export const HOOK_LOG_APPEND_CHUNK_BYTES = 32 * 1024;
/** How long relayed output may wait before it is flushed to the log host. */
export const HOOK_LOG_FLUSH_INTERVAL_MS = 2000;
/** Hook output relayed to a log on another host is capped at this size. */
export const HOOK_LOG_RELAY_MAX_BYTES = 8 * 1024 * 1024;
export const HOOK_LOG_TRUNCATION_MARKER = `\n===== Hook output truncated: only the first ${
	HOOK_LOG_RELAY_MAX_BYTES / (1024 * 1024)
} MiB were copied to this log =====\n`;
/** Local hook output buffered while relaying (exec's default is only 1 MiB). */
const LOCAL_HOOK_MAX_BUFFER = 64 * 1024 * 1024;

const normalizeHost = (id: string | null | undefined): string | null =>
	id || null;

export const runDeployHook = async ({
	kind,
	appName,
	serverId,
	command,
	logPath,
	logServerId,
	containerId,
}: RunDeployHookParams): Promise<void> => {
	const trimmed = command?.trim();
	if (!trimmed) return;

	const hookHost = normalizeHost(serverId);
	const logHost = normalizeHost(logServerId);

	let resolvedContainerId = containerId;
	if (!resolvedContainerId) {
		const container = await getServiceContainer(appName, serverId);
		if (!container) {
			if (kind === "pre") {
				// Fixed text, so appending it directly on the log host is safe.
				const skipLine = `echo "===== No previous container found; skipping pre-deploy hook =====" >> "${logPath}"`;
				if (logHost) {
					await execAsyncRemote(logHost, skipLine);
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
	const hookCommand = `(echo "===== Running ${label} hook (length=${trimmed.length} chars) =====" && ${scriptWrapper} && echo "===== ${label} hook finished =====")`;

	if (hookHost === logHost) {
		// The log is on the host the hook runs on: redirect straight into it so
		// the output streams into the deployment log while the hook runs.
		const wrappedCommand = `${hookCommand} >> "${logPath}" 2>&1`;
		if (hookHost) {
			await execAsyncRemote(hookHost, wrappedCommand);
		} else {
			await execAsync(wrappedCommand);
		}
		return;
	}

	// The log lives on another host (the build server). Capture the hook's
	// output here and relay it there in bounded chunks as it arrives. `2>&1`
	// keeps stdout and stderr interleaved in order on a single stream.
	const relay = new HookLogRelay(logPath, logHost);
	const relayedCommand = `${hookCommand} 2>&1`;
	try {
		if (hookHost) {
			await execAsyncRemote(hookHost, relayedCommand, (chunk) =>
				relay.push(chunk),
			);
		} else {
			await execAsyncStream(relayedCommand, (chunk) => relay.push(chunk), {
				maxBuffer: LOCAL_HOOK_MAX_BUFFER,
			});
		}
	} catch (error) {
		// The exec helpers stream everything through onData; only fall back to
		// the output captured on the error if nothing arrived that way.
		if (!relay.hasReceivedOutput() && error instanceof ExecError) {
			relay.push(`${error.stdout ?? ""}${error.stderr ?? ""}`);
		}
		// close() never throws, so the hook's own error is what propagates.
		await relay.close();
		throw error;
	}
	await relay.close();
};

/**
 * Appends a hook's output to a deployment log on another host. Output is
 * flushed whenever a chunk's worth has accumulated or after a short delay, so
 * the log keeps up with long hooks, and every write is bounded in size.
 *
 * Relaying is best effort: a failed append is reported and stops the relay,
 * but it never fails the deploy nor replaces the hook's own error.
 */
class HookLogRelay {
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private acceptedBytes = 0;
	private receivedOutput = false;
	private truncated = false;
	private failed = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly logPath: string,
		private readonly logHost: string | null,
	) {}

	hasReceivedOutput(): boolean {
		return this.receivedOutput;
	}

	push(data: string): void {
		if (!data) return;
		this.receivedOutput = true;
		if (this.truncated || this.failed) return;

		let bytes = Buffer.from(data, "utf8");
		const room = HOOK_LOG_RELAY_MAX_BYTES - this.acceptedBytes;
		if (bytes.length > room) {
			bytes = bytes.subarray(0, room);
			this.truncated = true;
		}
		if (bytes.length > 0) {
			this.pending.push(bytes);
			this.pendingBytes += bytes.length;
			this.acceptedBytes += bytes.length;
		}

		if (this.truncated) {
			const marker = Buffer.from(HOOK_LOG_TRUNCATION_MARKER, "utf8");
			this.pending.push(marker);
			this.pendingBytes += marker.length;
			this.flush();
		} else if (this.pendingBytes >= HOOK_LOG_APPEND_CHUNK_BYTES) {
			this.flush();
		} else if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this.flush();
			}, HOOK_LOG_FLUSH_INTERVAL_MS);
		}
	}

	/** Flushes what is left and waits for every append. Never throws. */
	async close(): Promise<void> {
		this.flush();
		await this.chain;
	}

	private flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pendingBytes === 0) return;
		const data = Buffer.concat(this.pending);
		this.pending = [];
		this.pendingBytes = 0;
		// Appends run one after another so the log keeps the output's order.
		this.chain = this.chain.then(() => this.write(data));
	}

	private async write(data: Buffer): Promise<void> {
		if (this.failed) return;
		try {
			await appendToLog(data, this.logPath, this.logHost);
		} catch (error) {
			this.failed = true;
			console.error(
				`Failed to relay deploy hook output to ${this.logPath} on ${
					this.logHost ?? "the Dokploy server"
				}:`,
				error,
			);
		}
	}
}

const appendToLog = async (
	data: Buffer,
	logPath: string,
	logHost: string | null,
): Promise<void> => {
	if (!logHost) {
		// Logs on the Dokploy host live on this process's own filesystem.
		await appendFile(logPath, data);
		return;
	}
	for (
		let offset = 0;
		offset < data.length;
		offset += HOOK_LOG_APPEND_CHUNK_BYTES
	) {
		// base64 is [A-Za-z0-9+/=] only, so it is safe inside the double quotes.
		const encoded = data
			.subarray(offset, offset + HOOK_LOG_APPEND_CHUNK_BYTES)
			.toString("base64");
		await execAsyncRemote(
			logHost,
			`echo "${encoded}" | base64 -d >> "${logPath}"`,
		);
	}
};
