/**
 * A `${{vault.*}}` reference that could not be resolved: the provider is
 * missing or not assigned, or it could not return the secret. The message
 * names the provider and the reference; when the provider's own client failed,
 * it also carries that error's text. None of it is a secret value from the
 * vault, but that client text can echo a URL with credentials, so the copy on
 * the deployment is run through `redactSecrets` (see `recordVaultFailureReason`).
 */
export class VaultResolutionError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "VaultResolutionError";
	}
}

/**
 * The message of a vault resolution failure, or null for any other error.
 * Looks through `cause`, so a wrapper added on the way up does not hide it.
 */
export const getVaultResolutionMessage = (error: unknown): string | null => {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		if (current instanceof VaultResolutionError) {
			return current.message;
		}
		current = current.cause;
	}
	return null;
};
