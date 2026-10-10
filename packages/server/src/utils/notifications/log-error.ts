/**
 * What may be logged about a failed notification call. A transport error can
 * carry the request it failed on ("Failed to parse URL from <webhook>"), and
 * with it the webhook URL, token or topic, so the error itself is never logged:
 * only its name, a machine code (ENOTFOUND, ECONNRESET, ...) and the host of the
 * target, without scheme, userinfo, path, query, headers or body.
 */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

const codeOf = (value: unknown) => {
	const code = (value as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" && SAFE_CODE.test(code) ? code : undefined;
};

const hostOf = (target: string | undefined) => {
	if (!target) return undefined;
	try {
		return new URL(target).host || undefined;
	} catch {
		// Not a URL (e.g. no scheme): there is no host that can be told apart
		// from a secret, so none is logged.
		return undefined;
	}
};

export const describeSenderError = (error: unknown, target?: string) => {
	const name = error instanceof Error ? error.name : typeof error;
	const code =
		codeOf(error) ?? codeOf((error as { cause?: unknown } | null)?.cause);
	return [name, code, hostOf(target) && `to ${hostOf(target)}`]
		.filter(Boolean)
		.join(" ");
};

/** `target` is the URL the call was made to; only its host is logged. */
export const logSenderError = (
	label: string,
	error: unknown,
	target?: string,
) => {
	console.error(
		`[notifications] ${label} failed: ${describeSenderError(error, target)}`,
	);
};

/**
 * A response that was received but refused the message. `reason` is a status or
 * a code (`HTTP 400`, `code 19001`), never text taken from the response.
 */
export const logSenderRefusal = (
	label: string,
	reason: string,
	target?: string,
) => {
	const host = hostOf(target);
	console.error(
		`[notifications] ${label} failed: ${reason}${host ? ` from ${host}` : ""}`,
	);
};
