import {
	ExecError,
	truncateOutputTail,
} from "@dokploy/server/utils/process/ExecError";
import { redactSecrets } from "@dokploy/server/utils/process/redactSecrets";
import * as Sentry from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import packageInfo from "../package.json";

// Defense in depth: even though ExecError scrubs its own fields, strip
// credentials from every event field an embedded command could reach (exception
// values, the top-level message, and breadcrumb messages) before it leaves the
// process. This catches any future code path that puts a raw command in an error.
const scrubEvent = (event: ErrorEvent): ErrorEvent => {
	if (typeof event.message === "string") {
		event.message = redactSecrets(event.message);
	}
	for (const exception of event.exception?.values ?? []) {
		if (typeof exception.value === "string") {
			exception.value = redactSecrets(exception.value);
		}
	}
	for (const breadcrumb of event.breadcrumbs ?? []) {
		if (typeof breadcrumb.message === "string") {
			breadcrumb.message = redactSecrets(breadcrumb.message);
		}
	}
	return event;
};

// Public ingest-only DSN for the fork's error tracker. A DSN can only submit
// events — it grants no read access to the project — so it is safe in source.
const SENTRY_DSN =
	"https://d98cecf413db8997128f3519f26e3620@sentry.devino.ca/59";

const optedOut =
	process.env.DOKPLOY_DISABLE_SENTRY === "true" ||
	process.env.DO_NOT_TRACK === "1" ||
	process.env.DO_NOT_TRACK === "true";

export const isSentryEnabled =
	process.env.NODE_ENV === "production" &&
	!optedOut &&
	SENTRY_DSN.startsWith("https://");

if (isSentryEnabled) {
	Sentry.init({
		dsn: SENTRY_DSN,
		release: packageInfo.version,
		environment: "production",
		sendDefaultPii: false,
		tracesSampleRate: 0,
		// Console breadcrumbs can carry deployment output, and the process-level
		// handlers are managed explicitly in server.ts so its exit semantics
		// (see issue #4253) stay intact.
		integrations: (defaults) =>
			defaults.filter(
				(integration) =>
					!["Console", "OnUncaughtException", "OnUnhandledRejection"].includes(
						integration.name,
					),
			),
		beforeSend(event) {
			// The reporting instance's hostname identifies a user's server — drop it.
			event.server_name = undefined;
			return scrubEvent(event);
		},
	});
}

type ExecErrorLike = Pick<
	ExecError,
	"command" | "stdout" | "stderr" | "exitCode" | "serverId"
>;

const isExecError = (error: unknown): error is ExecErrorLike =>
	error instanceof ExecError ||
	(error instanceof Error &&
		error.name === "ExecError" &&
		typeof (error as Partial<ExecErrorLike>).command === "string");

/**
 * Identifying fields for an ExecError. Node's exception context carries only
 * the message, so a remote "exit code 1" used to reach Sentry with no command,
 * server or output attached. ExecError scrubs its own fields; they are scrubbed
 * once more here as defense in depth.
 */
export const execErrorContext = (error: unknown) => {
	if (!isExecError(error)) return undefined;
	const tail = (output?: string) =>
		output ? redactSecrets(truncateOutputTail(output, 500)) : "";
	return {
		command: redactSecrets(error.command),
		exitCode: error.exitCode ?? null,
		serverId: error.serverId ?? null,
		stderrTail: tail(error.stderr),
		stdoutTail: tail(error.stdout),
	};
};

export const captureError = (error: unknown, tags?: Record<string, string>) => {
	if (!isSentryEnabled) return;
	const extra = execErrorContext(error);
	Sentry.captureException(error, {
		...(tags ? { tags } : {}),
		...(extra ? { extra } : {}),
	});
};

/** Best-effort flush with a hard cap so crash paths still exit promptly. */
export const flushSentry = async (timeoutMs = 2000) => {
	if (!isSentryEnabled) return;
	try {
		await Sentry.flush(timeoutMs);
	} catch {}
};
