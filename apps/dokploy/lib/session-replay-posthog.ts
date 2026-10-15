// PostHog for the opt-in session replay. Loaded only through a dynamic import
// from lib/session-replay.ts, so posthog-js never reaches a bundle that is
// downloaded when replay is off.
import posthog from "posthog-js";
import { scrubUrlProperties, stripUrl } from "./telemetry-privacy";

export interface PostHogReplayConfig {
	key: string;
	host: string;
	sampleRate: number;
}

// Elements whose content must never be recorded (QR codes, images, embeds).
const BLOCK_SELECTOR = "img,svg,video,canvas,picture,object,embed,audio,iframe";

const MASKED_ATTRIBUTES = new Set([
	"title",
	"aria-label",
	"placeholder",
	"alt",
	"href",
	"value",
]);

export const maskAttribute = (name: string, value: string) => {
	const lower = name.toLowerCase();
	return MASKED_ATTRIBUTES.has(lower) || lower.startsWith("data-")
		? "*".repeat(Math.min(value.length, 32))
		: value;
};

// Network capture is pinned off, but if a remote setting ever turned it on this
// keeps only the method, status and the URL without query or hash.
export const maskNetworkRequest = <T extends { name?: string }>(
	request: T,
): T => ({
	...request,
	...(typeof request.name === "string" ? { name: stripUrl(request.name) } : {}),
	requestHeaders: undefined,
	requestBody: undefined,
	responseHeaders: undefined,
	responseBody: undefined,
});

export const startPostHogReplay = (config: PostHogReplayConfig) => {
	posthog.init(config.key, {
		api_host: config.host,
		autocapture: false,
		// Pages router navigations are history changes, not page loads.
		capture_pageview: "history_change",
		person_profiles: "identified_only",
		respect_dnt: true,
		// The rrweb Meta event records the page href; this strips these query params.
		mask_personal_data_properties: true,
		custom_personal_data_properties: [
			"q",
			"search",
			"serverId",
			"projectId",
			"environmentId",
			"applicationId",
			"composeId",
		],
		disable_session_recording: false,
		enable_recording_console_log: false,
		// Pinned off locally so a remote project setting cannot switch them on.
		capture_performance: false,
		capture_dead_clicks: false,
		capture_exceptions: false,
		capture_heatmaps: false,
		disable_surveys: true,
		disable_product_tours: true,
		disable_conversations: true,
		before_send: (event) => {
			if (!event) return event;
			scrubUrlProperties(event.properties);
			if (event.$set) scrubUrlProperties(event.$set);
			if (event.$set_once) scrubUrlProperties(event.$set_once);
			return event;
		},
		session_recording: {
			maskAllInputs: true,
			maskTextSelector: "*",
			blockSelector: BLOCK_SELECTOR,
			maskAttributeFn: maskAttribute,
			maskCapturedNetworkRequestFn: maskNetworkRequest,
			// A client-side rate takes precedence over the project setting.
			sampleRate: config.sampleRate,
		},
	});
	return { stop: () => posthog.opt_out_capturing() };
};
