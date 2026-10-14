import { TRPCError } from "@trpc/server";

/**
 * A remote server with no SSH key attached cannot be reached. That is a setup
 * precondition the user fixes in the server settings, not a backend failure, so
 * it is a PRECONDITION_FAILED tRPC error (the API handler only reports
 * INTERNAL_SERVER_ERROR to Sentry).
 */
export class MissingSshKeyError extends TRPCError {
	constructor() {
		super({
			code: "PRECONDITION_FAILED",
			message:
				"No SSH key available for this server. Add one in the server settings.",
		});
		this.name = "MissingSshKeyError";
	}
}

export const assertServerHasSshKey = (server: {
	sshKeyId?: string | null;
}): void => {
	if (!server.sshKeyId) throw new MissingSshKeyError();
};
