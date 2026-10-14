import { z } from "zod";

/**
 * Validation for the opt-in Compose deploy guardrails. Dependency free on
 * purpose: the dashboard form imports it as well as the server.
 */

export const HEALTH_CHECK_TIMEOUT_DEFAULT_SECONDS = 60;
export const HEALTH_CHECK_TIMEOUT_MIN_SECONDS = 5;
export const HEALTH_CHECK_TIMEOUT_MAX_SECONDS = 600;

const isHttpUrl = (value: string) => {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			// Credentials would end up in the deploy log and in process arguments.
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
};

export const deployHealthCheckSchema = z.object({
	url: z
		.string()
		.trim()
		.min(1)
		.max(2048)
		// No whitespace or control characters: a URL never needs them and they
		// are the usual way to smuggle a second argument or line.
		.refine((value) => !/[\s\p{Cc}]/u.test(value), {
			message: "The URL cannot contain whitespace or control characters",
		})
		.refine(isHttpUrl, {
			message: "Enter an http:// or https:// URL without credentials",
		}),
	timeoutSeconds: z
		.number()
		.int()
		.min(HEALTH_CHECK_TIMEOUT_MIN_SECONDS)
		.max(HEALTH_CHECK_TIMEOUT_MAX_SECONDS)
		.default(HEALTH_CHECK_TIMEOUT_DEFAULT_SECONDS),
	/** Exact status to wait for. Omitted: any 2xx counts as healthy. */
	expectedStatus: z.number().int().min(100).max(599).optional(),
});

export const STALL_SNAPSHOT_AFTER_DEFAULT_SECONDS = 60;
export const STALL_SNAPSHOT_AFTER_MIN_SECONDS = 15;
export const STALL_SNAPSHOT_AFTER_MAX_SECONDS = 1800;
export const STALL_SNAPSHOT_EVERY_DEFAULT_SECONDS = 30;
export const STALL_SNAPSHOT_EVERY_MIN_SECONDS = 10;
export const STALL_SNAPSHOT_EVERY_MAX_SECONDS = 600;
export const STALL_SNAPSHOT_MAX_DEFAULT = 5;
export const STALL_SNAPSHOT_MAX_MIN = 1;
export const STALL_SNAPSHOT_MAX_MAX = 20;

/** Observe-only: logs the container states while `compose up` is slow. */
export const deployStallSnapshotSchema = z.object({
	afterSeconds: z
		.number()
		.int()
		.min(STALL_SNAPSHOT_AFTER_MIN_SECONDS)
		.max(STALL_SNAPSHOT_AFTER_MAX_SECONDS)
		.default(STALL_SNAPSHOT_AFTER_DEFAULT_SECONDS),
	everySeconds: z
		.number()
		.int()
		.min(STALL_SNAPSHOT_EVERY_MIN_SECONDS)
		.max(STALL_SNAPSHOT_EVERY_MAX_SECONDS)
		.default(STALL_SNAPSHOT_EVERY_DEFAULT_SECONDS),
	maxSnapshots: z
		.number()
		.int()
		.min(STALL_SNAPSHOT_MAX_MIN)
		.max(STALL_SNAPSHOT_MAX_MAX)
		.default(STALL_SNAPSHOT_MAX_DEFAULT),
});

export const deployGuardrailsSchema = z.object({
	phaseTimestamps: z.boolean().optional(),
	dockerEvents: z.boolean().optional(),
	healthCheck: deployHealthCheckSchema.nullable().optional(),
	stallSnapshot: deployStallSnapshotSchema.nullable().optional(),
});

export type DeployGuardrails = z.infer<typeof deployGuardrailsSchema>;
export type DeployHealthCheck = z.infer<typeof deployHealthCheckSchema>;
export type DeployStallSnapshot = z.infer<typeof deployStallSnapshotSchema>;
