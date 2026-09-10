/**
 * Every failure this module raises is a `BuildPolicyError` with a stable code,
 * so the deploy path can log a named reason instead of a stack trace and the
 * integration test can assert on the code rather than on prose.
 */
export type BuildPolicyErrorCode =
	| "NO_BUILD_SERVER"
	| "NO_REGISTRY"
	| "REGISTRY_NOT_ALLOWED"
	| "INVALID_IMAGE"
	| "INVALID_DIGEST"
	| "DIGEST_NOT_PUBLISHED"
	| "REQUIRED_CHECKS_FAILED"
	| "REQUIRED_CHECKS_TIMEOUT"
	| "REQUIRED_CHECKS_UNAVAILABLE";

export class BuildPolicyError extends Error {
	public readonly code: BuildPolicyErrorCode;
	public readonly details?: Record<string, unknown>;

	constructor(
		code: BuildPolicyErrorCode,
		message: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "BuildPolicyError";
		this.code = code;
		this.details = details;
	}
}

export const isBuildPolicyError = (error: unknown): error is BuildPolicyError =>
	error instanceof BuildPolicyError;
