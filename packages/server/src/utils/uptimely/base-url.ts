import { isSameBaseUrl } from "../base-url";

/**
 * The stored Uptimely API key is write-only and is sent as a Bearer token to
 * the configured base URL. Reusing it against a different URL would hand it to
 * whoever runs that URL, so a changed URL always needs the key typed again.
 */
export const UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE =
	"Enter the API key again to change the Uptimely URL.";

export const isSameUptimelyBaseUrl = isSameBaseUrl;
