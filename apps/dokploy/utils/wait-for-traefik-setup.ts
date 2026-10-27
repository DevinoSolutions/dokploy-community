export type TraefikSetupStatus = {
	state: "pending" | "done" | "failed" | "unknown";
	error: string | null;
};

// "unconfirmed" is a timeout, a run the server doesn't know, or a dashboard
// that never answered: the save is not known to have failed.
export type TraefikSetupResult =
	| { status: "applied" }
	| { status: "failed"; error: string | null }
	| { status: "unconfirmed" };

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
	// A request that hangs must not outlive the deadline.
	requestTimeoutMs?: number;
}

// About 30 seconds with the default interval. The server records a run only
// after its pre-checks (port check, SSH to a remote server), so a run it does
// not know yet is not a lost one. Past that it lost the run (restart) or never
// received it.
const MAX_UNKNOWN_POLLS = 10;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Request timed out")), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};

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
	requestTimeoutMs = 10_000,
}: WaitForTraefikSetupOptions): Promise<TraefikSetupResult> => {
	const deadline = now() + timeoutMs;
	let unknownPolls = 0;
	let finished = false;

	await sleep(initialDelayMs);
	while (!finished && now() < deadline) {
		let status: TraefikSetupStatus | null = null;
		try {
			status = await withTimeout(getStatus(), requestTimeoutMs);
		} catch {
			// Expected while Traefik is replaced.
		}
		if (status?.state === "failed") {
			return {
				status: "failed",
				error: status.error ? firstErrorLine(status.error) : null,
			};
		}
		if (status?.state === "done") {
			finished = true;
			continue;
		}
		unknownPolls = status?.state === "unknown" ? unknownPolls + 1 : 0;
		if (unknownPolls >= MAX_UNKNOWN_POLLS) {
			return { status: "unconfirmed" };
		}
		await sleep(statusIntervalMs);
	}
	if (!finished) {
		return { status: "unconfirmed" };
	}

	while (now() < deadline) {
		const healthy = await withTimeout(isHealthy(), requestTimeoutMs).catch(
			() => false,
		);
		if (healthy) {
			return { status: "applied" };
		}
		await sleep(healthIntervalMs);
	}
	return { status: "unconfirmed" };
};
