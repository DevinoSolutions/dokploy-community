/**
 * The text a form shows under its generic error toast: the message of an error
 * the server raised on purpose (BAD_REQUEST, FORBIDDEN, ...), and nothing for
 * an internal error, whose message can carry a query, its parameters or other
 * server detail.
 */
export const refusalDescription = (error: unknown): string | undefined => {
	const { message, data } = (error ?? {}) as {
		message?: unknown;
		data?: { code?: unknown } | null;
	};
	const code = data?.code;
	if (typeof code !== "string" || code === "INTERNAL_SERVER_ERROR") {
		return undefined;
	}
	return typeof message === "string" && message !== "" ? message : undefined;
};
