import { appendFile } from "node:fs/promises";
import { ExecError } from "../process/ExecError";
import {
	execAsync,
	execAsyncRemote,
	execAsyncStream,
	openRemoteInputSession,
	type RemoteInputSession,
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

/** Hook output relayed to a log on another host is capped at this size. */
export const HOOK_LOG_RELAY_MAX_BYTES = 8 * 1024 * 1024;
export const HOOK_LOG_TRUNCATION_MARKER = `\n===== Hook output truncated: only the first ${
	HOOK_LOG_RELAY_MAX_BYTES / (1024 * 1024)
} MiB were copied to this log =====\n`;
/** Written where the relay to the log host failed and was restarted. */
export const HOOK_LOG_RETRY_MARKER =
	"\n===== Relaying hook output to this log failed and was restarted; output around here may be missing or repeated =====\n";
/** How long the relay waits before restarting a failed session. */
export const HOOK_LOG_RETRY_DELAY_MS = 1500;
/** How long a finished hook waits for its relayed output to reach the log. */
export const HOOK_LOG_CLOSE_TIMEOUT_MS = 60_000;

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
	// output here and relay it there as it arrives. `2>&1` keeps stdout and
	// stderr interleaved in order on a single stream.
	const relay = new HookLogRelay(logPath, logHost);
	const relayedCommand = `${hookCommand} 2>&1`;
	try {
		// The relay has the output; the exec helpers keep only its tail.
		if (hookHost) {
			await execAsyncRemote(
				hookHost,
				relayedCommand,
				(chunk) => relay.push(chunk),
				{ streamOnly: true },
			);
		} else {
			await execAsyncStream(relayedCommand, (chunk) => relay.push(chunk), {
				streamOnly: true,
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
 * written as it arrives over a single SSH session that runs `cat` into the
 * log, so a long or chatty hook still costs one connection to the log host.
 *
 * Relaying is best effort: a failed session is restarted once, and a failure
 * after that is reported and stops the relay. It never fails the deploy nor
 * replaces the hook's own error.
 */
class HookLogRelay {
	private pending: Buffer[] = [];
	private acceptedBytes = 0;
	private receivedOutput = false;
	private truncated = false;
	private stopped = false;
	private retried = false;
	private session: RemoteInputSession | null = null;
	private draining: Promise<void> | null = null;

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
		if (this.truncated || this.stopped) return;

		let bytes = Buffer.from(data, "utf8");
		const room = HOOK_LOG_RELAY_MAX_BYTES - this.acceptedBytes;
		if (bytes.length > room) {
			bytes = bytes.subarray(0, room);
			this.truncated = true;
		}
		this.acceptedBytes += bytes.length;
		if (bytes.length > 0) this.pending.push(bytes);
		if (this.truncated) {
			this.pending.push(Buffer.from(HOOK_LOG_TRUNCATION_MARKER, "utf8"));
		}
		this.drain();
	}

	/**
	 * Writes what is left and waits for `cat` on the log host to exit, which is
	 * the only confirmation that the output reached the log. Gives up after
	 * HOOK_LOG_CLOSE_TIMEOUT_MS so a stuck log host cannot hold the deploy.
	 * Never throws.
	 */
	async close(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<true>((resolve) => {
			timer = setTimeout(() => resolve(true), HOOK_LOG_CLOSE_TIMEOUT_MS);
		});
		const result = await Promise.race([this.finish(), timedOut]);
		clearTimeout(timer);
		if (result === true) {
			this.fail(
				new Error(
					`Timed out after ${HOOK_LOG_CLOSE_TIMEOUT_MS / 1000}s waiting for the log host`,
				),
			);
		}
	}

	private async finish(): Promise<void> {
		await this.draining;
		const session = this.session;
		if (!session) return;
		try {
			await session.end();
		} catch (error) {
			this.fail(error);
		}
		// Kept until now so that a timeout can still abort it.
		if (this.session === session) this.session = null;
	}

	/** Writes pending output one write at a time, so the log keeps its order. */
	private drain(): void {
		if (this.draining || this.pending.length === 0) return;
		this.draining = (async () => {
			while (this.pending.length > 0) {
				const data = Buffer.concat(this.pending);
				this.pending = [];
				await this.write(data);
			}
			this.draining = null;
		})();
	}

	private async write(data: Buffer): Promise<void> {
		if (this.stopped) return;
		if (!this.logHost) {
			// Logs on the Dokploy host live on this process's own filesystem.
			try {
				await appendFile(this.logPath, data);
			} catch (error) {
				this.fail(error);
			}
			return;
		}
		try {
			if (!this.session) {
				const session = await openRemoteInputSession(
					this.logHost,
					`cat >> "${this.logPath}"`,
				);
				// The relay may have given up while the session was opening.
				if (this.stopped) {
					session.abort();
					return;
				}
				this.session = session;
			}
			await this.session.write(data);
		} catch (error) {
			// A write only means ssh2 took the data; a session that dies can take
			// some of what it already took with it.
			const lost = this.session !== null;
			this.session = null;
			if (this.stopped) return;
			if (this.retried) {
				this.fail(error);
				return;
			}
			this.retried = true;
			await new Promise((resolve) =>
				setTimeout(resolve, HOOK_LOG_RETRY_DELAY_MS),
			);
			await this.write(
				lost
					? Buffer.concat([Buffer.from(HOOK_LOG_RETRY_MARKER, "utf8"), data])
					: data,
			);
		}
	}

	private fail(error: unknown): void {
		if (this.stopped) return;
		this.stopped = true;
		this.pending = [];
		this.session?.abort();
		this.session = null;
		console.error(
			`Failed to relay deploy hook output to ${this.logPath} on ${
				this.logHost ?? "the Dokploy server"
			}:`,
			error,
		);
	}
}
