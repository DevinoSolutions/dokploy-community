// Browser Sentry for the opt-in session replay. Loaded only through a dynamic
// import from lib/session-replay.ts, so it (and @sentry/browser) never reach a
// bundle that is downloaded when replay is off.
import { redactSecrets } from "@dokploy/server/utils/process/redactSecrets";
import {
	type Breadcrumb,
	type ErrorEvent,
	type Event,
	getGlobalScope,
	init,
	replayIntegration,
} from "@sentry/browser";
import { stripUrl, stripUrlsInText } from "./telemetry-privacy";

export interface SentryReplayConfig {
	dsn: string;
	release: string;
	sessionSampleRate: number;
	onErrorSampleRate: number;
}

const scrubText = (text: string) => redactSecrets(stripUrlsInText(text));

const scrubData = (data: Record<string, unknown> | undefined) => {
	if (!data) return data;
	const next = { ...data };
	for (const key of ["url", "from", "to", "previous"]) {
		const value = next[key];
		if (typeof value === "string") next[key] = stripUrl(value);
	}
	return next;
};

// Console output can carry deployment logs, so it is dropped entirely. Other
// breadcrumbs lose their query strings (this also cleans the replay network and
// navigation spans, which are built from breadcrumbs).
export const scrubBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
	if (breadcrumb.category === "console") return null;
	return {
		...breadcrumb,
		...(breadcrumb.data ? { data: scrubData(breadcrumb.data) } : {}),
		...(typeof breadcrumb.message === "string"
			? { message: scrubText(breadcrumb.message) }
			: {}),
	};
};

// Runs for every event type, including replay_event (whose `urls` list the
// pages visited), so no URL leaves the browser with a query string or hash.
export const scrubEventUrls = <T extends Event>(event: T): T => {
	const request = event.request;
	if (request) {
		if (request.url) request.url = stripUrl(request.url);
		request.query_string = undefined;
		request.cookies = undefined;
		if (request.headers) {
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(request.headers)) {
				headers[name] =
					name.toLowerCase() === "referer" ? stripUrl(value) : value;
			}
			request.headers = headers;
		}
	}
	const withUrls = event as T & { urls?: string[] };
	if (Array.isArray(withUrls.urls)) withUrls.urls = withUrls.urls.map(stripUrl);
	for (const exception of event.exception?.values ?? []) {
		for (const frame of exception.stacktrace?.frames ?? []) {
			if (frame.filename) frame.filename = stripUrl(frame.filename);
			if (frame.abs_path) frame.abs_path = stripUrl(frame.abs_path);
		}
	}
	return event;
};

// Dokploy errors can embed shell commands and request URLs; redact them the
// same way the server SDK does before an event leaves the browser.
export const scrubErrorEvent = (event: ErrorEvent): ErrorEvent => {
	scrubEventUrls(event);
	if (typeof event.message === "string") {
		event.message = scrubText(event.message);
	}
	if (typeof event.logentry?.message === "string") {
		event.logentry.message = scrubText(event.logentry.message);
	}
	for (const exception of event.exception?.values ?? []) {
		if (typeof exception.value === "string") {
			exception.value = scrubText(exception.value);
		}
	}
	for (const breadcrumb of event.breadcrumbs ?? []) {
		if (typeof breadcrumb.message === "string") {
			breadcrumb.message = scrubText(breadcrumb.message);
		}
	}
	return event;
};

type RecordingEvent = { data?: { tag?: string; payload?: unknown } };

// Custom replay frames (navigation and resource spans, breadcrumbs) carry URLs.
export const scrubRecordingEvent = <T extends RecordingEvent>(event: T): T => {
	const payload = event.data?.payload as
		| { description?: unknown; data?: Record<string, unknown> }
		| undefined;
	if (!payload || typeof payload !== "object") return event;
	if (
		event.data?.tag === "performanceSpan" &&
		typeof payload.description === "string" &&
		/^(https?:)?\//.test(payload.description)
	) {
		payload.description = stripUrl(payload.description);
	}
	if (payload.data && typeof payload.data === "object") {
		payload.data = scrubData(payload.data);
	}
	return event;
};

export const startSentryReplay = (config: SentryReplayConfig) => {
	const replay = replayIntegration({
		// Dokploy renders secrets (env values, logs) as text, not only in inputs.
		maskAllText: true,
		maskAllInputs: true,
		blockAllMedia: true,
		mask: [".ph-sensitive"],
		block: [".ph-no-capture"],
		maskAttributes: [
			"title",
			"placeholder",
			"aria-label",
			"alt",
			"href",
			"value",
		],
		networkDetailAllowUrls: [],
		beforeAddRecordingEvent: scrubRecordingEvent,
	});
	init({
		dsn: config.dsn,
		release: config.release,
		environment: "production",
		sendDefaultPii: false,
		tracesSampleRate: 0,
		replaysSessionSampleRate: config.sessionSampleRate,
		replaysOnErrorSampleRate: config.onErrorSampleRate,
		beforeBreadcrumb: scrubBreadcrumb,
		beforeSend: scrubErrorEvent,
		ignoreErrors: [
			"ResizeObserver loop limit exceeded",
			"ResizeObserver loop completed with undelivered notifications.",
			/^Script error\.?$/,
		],
		denyUrls: [
			/^chrome-extension:\/\//i,
			/^moz-extension:\/\//i,
			/^safari-extension:\/\//i,
			/^safari-web-extension:\/\//i,
		],
		integrations: [replay],
	});
	getGlobalScope().addEventProcessor(scrubEventUrls);
	return { stop: () => replay.stop() };
};
