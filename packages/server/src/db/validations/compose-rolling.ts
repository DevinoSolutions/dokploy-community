import { z } from "zod";

/**
 * Validation for the opt-in Compose rolling replace. Dependency free on
 * purpose: the dashboard form imports it as well as the server.
 */

export const ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS = 120;
export const ROLLING_HEALTH_TIMEOUT_MIN_SECONDS = 10;
export const ROLLING_HEALTH_TIMEOUT_MAX_SECONDS = 900;
export const ROLLING_DRAIN_DEFAULT_SECONDS = 5;
export const ROLLING_DRAIN_MIN_SECONDS = 0;
export const ROLLING_DRAIN_MAX_SECONDS = 120;
export const ROLLING_MAX_SERVICES = 50;

/**
 * A compose service name: the characters the Compose spec allows. Anything
 * else never reaches the deploy script (it is also quoted there).
 */
export const ROLLING_SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const rollingServiceNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(
		ROLLING_SERVICE_NAME_PATTERN,
		"A service name can only contain letters, digits, '.', '_' and '-'",
	);

export const composeRollingReplaceSchema = z
	.object({
		enabled: z.boolean().default(false),
		/** Services to replace one at a time. Never "all": the user opts in per service. */
		services: z
			.array(rollingServiceNameSchema)
			.max(ROLLING_MAX_SERVICES)
			.refine((names) => new Set(names).size === names.length, {
				message: "A service can only be listed once",
			})
			.default([]),
		/** How long the new replica gets to report healthy before it is removed. */
		healthTimeoutSeconds: z
			.number()
			.int()
			.min(ROLLING_HEALTH_TIMEOUT_MIN_SECONDS)
			.max(ROLLING_HEALTH_TIMEOUT_MAX_SECONDS)
			.default(ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS),
		/** Wait between "new replica healthy" and "stop the old one". */
		drainSeconds: z
			.number()
			.int()
			.min(ROLLING_DRAIN_MIN_SECONDS)
			.max(ROLLING_DRAIN_MAX_SECONDS)
			.default(ROLLING_DRAIN_DEFAULT_SECONDS),
	})
	.refine((value) => !value.enabled || value.services.length > 0, {
		message: "Select at least one service to roll",
		path: ["services"],
	});

export type ComposeRollingReplace = z.infer<typeof composeRollingReplaceSchema>;
