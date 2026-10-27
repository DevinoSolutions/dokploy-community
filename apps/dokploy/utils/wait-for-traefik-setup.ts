export type TraefikSetupStatus = {
	state: "pending" | "done" | "failed" | "unknown";
	error: string | null;
};

// error is null when the outcome could not be confirmed.
export type TraefikSetupResult =
	| { ok: true }
	| { ok: false; error: string | null };

export interface WaitForTraefikSetupOptions {
	getStatus: () => Promise<TraefikSetupStatus>;
	isHealthy: () => Promise<boolean>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	initialDelayMs?: number;
	statusIntervalMs?: number;
	healthIntervalMs?: number;
	// The server gives up on a hung recreate after 5 minutes.
	timeoutMs?: number;
}

// The server lost the run (restart) or never received it.
const MAX_UNKNOWN_POLLS = 5;

// The first line of a Docker or SSH failure is the reason; the rest is detail.
export const firstErrorLine = (message: string) => {
	const line = message
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find(Boolean);
	return line ? line.slice(0, 300) : null;
};

// Random enough to tell this run from an earlier one. crypto.randomUUID needs
// HTTPS, and Dokploy is often opened over plain HTTP.
export const newTraefikSetupJobId = () => {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

// Waits for the queued recreate of this run to end, then for the dashboard to
// answer again. The page is served through the Traefik being replaced, so a
// failed request is not an answer.
export const waitForTraefikSetup = async ({
	getStatus,
	isHealthy,
	sleep,
	now,
	initialDelayMs = 2000,
	statusIntervalMs = 3000,
	healthIntervalMs = 2000,
	timeoutMs = 5 * 60_000,
}: WaitForTraefikSetupOptions): Promise<TraefikSetupResult> => {
	const deadline = now() + timeoutMs;
	let unknownPolls = 0;
	let finished = false;

	await sleep(initialDelayMs);
	while (!finished && now() < deadline) {
		let status: TraefikSetupStatus | null = null;
		try {
			status = await getStatus();
		} catch {
			// Expected while Traefik is replaced.
		}
		if (status?.state === "failed") {
			return {
				ok: false,
				error: status.error ? firstErrorLine(status.error) : null,
			};
		}
		if (status?.state === "done") {
			finished = true;
			continue;
		}
		unknownPolls = status?.state === "unknown" ? unknownPolls + 1 : 0;
		if (unknownPolls >= MAX_UNKNOWN_POLLS) {
			return { ok: false, error: null };
		}
		await sleep(statusIntervalMs);
	}
	if (!finished) {
		return { ok: false, error: null };
	}

	while (now() < deadline) {
		if (await isHealthy()) {
			return { ok: true };
		}
		await sleep(healthIntervalMs);
	}
	return { ok: false, error: null };
};
