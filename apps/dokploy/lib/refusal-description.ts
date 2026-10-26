/**
 * The text a form shows under its generic error toast: the message of an error
 * the server raised on purpose (BAD_REQUEST, FORBIDDEN, ...), and nothing for
 * an internal error, whose message can carry a query, its parameters or other
 * server detail.
 */
export const refusalDescription = (error: unknown): string | undefined => {
	const { message, data } = (error ?? {}) as {
		message?: unknown;
		data?: { code?: unknown; zodError?: unknown } | null;
	};
	const code = data?.code;
	if (typeof code !== "string" || code === "INTERNAL_SERVER_ERROR") {
		return undefined;
	}
	// An input the schema refused carries its issues as a JSON list in the
	// message; show the issues' own messages instead.
	if (data?.zodError) {
		return zodIssueText(data.zodError);
	}
	return typeof message === "string" && message !== "" ? message : undefined;
};

const zodIssueText = (zodError: unknown): string | undefined => {
	const { formErrors, fieldErrors } = zodError as {
		formErrors?: unknown;
		fieldErrors?: unknown;
	};
	const messages = [
		...(Array.isArray(formErrors) ? formErrors : []),
		...Object.values(
			fieldErrors && typeof fieldErrors === "object" ? fieldErrors : {},
		).flatMap((value) => (Array.isArray(value) ? value : [])),
	].filter((text): text is string => typeof text === "string" && text !== "");
	return messages.length > 0 ? [...new Set(messages)].join(" ") : undefined;
};
