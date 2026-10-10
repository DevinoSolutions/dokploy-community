import { TRPCError } from "@trpc/server";

/** Shorter values are not hidden: "1" would wipe that character from a message. */
export const MIN_REDACTED_SECRET_LENGTH = 4;

/**
 * An error message from a failed test can echo the URL it called, and with it
 * the stored secret that was borrowed for the test. Hide those before the
 * message reaches the client.
 */
export const redactSecrets = (
	message: string,
	secrets: ReadonlyArray<unknown>,
) =>
	secrets.reduce<string>(
		(text, secret) =>
			typeof secret === "string" && secret.length >= MIN_REDACTED_SECRET_LENGTH
				? text.split(secret).join("••••")
				: text,
		message,
	);

/**
 * The failure of a "Test Notification" call. A test borrows a stored secret, and
 * a sender's error (e.g. "Failed to parse URL from <webhook>") can echo it, so
 * every secret in play (typed or borrowed) is hidden from the message.
 */
export const testFailure = (error: unknown, secrets: ReadonlyArray<unknown>) =>
	error instanceof TRPCError
		? error
		: new TRPCError({
				code: "BAD_REQUEST",
				message:
					error instanceof Error
						? redactSecrets(error.message, secrets)
						: "Unknown error",
				cause: error,
			});
