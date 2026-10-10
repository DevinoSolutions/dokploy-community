/**
 * Deploy heartbeat ping for an Uptimely `Incoming Request` monitor.
 *
 * The ping is a GET on `<baseUrl>/heartbeat/<secretKey>`. It runs after a
 * deploy has already succeeded, so it must never fail or slow the deploy: the
 * request has a short timeout, every failure is swallowed, and the secret key
 * is never logged (only the service and the failure class are).
 */

export const UPTIMELY_HEARTBEAT_TIMEOUT_MS = 5_000;

export const uptimelyHeartbeatUrl = (baseUrl: string, secretKey: string) =>
	`${baseUrl.replace(/\/+$/, "")}/heartbeat/${encodeURIComponent(secretKey)}`;

export interface PingUptimelyHeartbeatOptions {
	baseUrl: string;
	secretKey: string;
	/** Only used to say which service failed in the log line. */
	label: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

/**
 * Pings the heartbeat. Resolves to whether Uptimely accepted it; never
 * rejects.
 */
export const pingUptimelyHeartbeat = async (
	options: PingUptimelyHeartbeatOptions,
): Promise<boolean> => {
	const timeoutMs = options.timeoutMs ?? UPTIMELY_HEARTBEAT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(
			uptimelyHeartbeatUrl(options.baseUrl, options.secretKey),
			{
				method: "GET",
				signal: AbortSignal.timeout(timeoutMs),
				// A redirect would leak the key to wherever it points.
				redirect: "error",
			},
		);
		if (!response.ok) {
			console.error(
				`Uptimely deploy heartbeat for ${options.label} was refused (HTTP ${response.status})`,
			);
			return false;
		}
		return true;
	} catch (error) {
		// `error.message` can carry the request URL, which holds the key.
		const reason = error instanceof Error ? error.name : "unknown error";
		console.error(
			`Uptimely deploy heartbeat for ${options.label} failed (${reason})`,
		);
		return false;
	}
};
