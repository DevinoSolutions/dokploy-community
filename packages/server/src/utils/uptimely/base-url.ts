import {
	integrationUrlChangeNeedsKeyMessage,
	isSameIntegrationBaseUrl,
} from "@dokploy/server/utils/integrations/base-url";

/**
 * The stored Uptimely API key is write-only and is sent as a Bearer token to
 * the configured base URL. Reusing it against a different URL would hand it to
 * whoever runs that URL, so a changed URL always needs the key typed again.
 */
export const UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE =
	integrationUrlChangeNeedsKeyMessage("Uptimely");

export const isSameUptimelyBaseUrl = isSameIntegrationBaseUrl;
