import { validateRequestDetailed } from "@dokploy/server";
import { createNextApiHandler } from "@trpc/server/adapters/next";
import type { NextApiRequest, NextApiResponse } from "next";
import { respondApiKeyRateLimited } from "@/server/api/api-key-rate-limit";
import { appRouter } from "@/server/api/root";
import {
	createTRPCContext,
	createTRPCContextFromAuth,
} from "@/server/api/trpc";
import { captureError } from "@/server/sentry";

// Authenticate once per request (a single API key verification) and answer a
// throttled key with 429 + Retry-After; the tRPC context reuses the result.
// Unauthenticated callers still reach the router: public procedures and the
// per-procedure checks decide what they may do.
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	let validation: Awaited<ReturnType<typeof validateRequestDetailed>> | null =
		null;
	try {
		validation = await validateRequestDetailed(req);
	} catch {
		// Authentication threw (e.g. a database blip). Leave it to the tRPC
		// context, which authenticates inside tRPC, so the failure keeps its
		// JSON error reply and the onError -> captureError path.
	}
	if (validation && "rateLimited" in validation) {
		respondApiKeyRateLimited(req, res, validation);
		return;
	}
	const verified = validation;
	return createNextApiHandler({
		router: appRouter,
		createContext: (opts) =>
			verified
				? createTRPCContextFromAuth(opts, verified)
				: createTRPCContext(opts),
		onError: ({ path, error }) => {
			if (process.env.NODE_ENV === "development") {
				console.error(
					`❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
				);
				return;
			}
			// Only genuine backend failures — expected errors (bad input, auth,
			// not-found) are user-facing outcomes, not bugs.
			if (error.code === "INTERNAL_SERVER_ERROR") {
				captureError(error.cause ?? error, { trpcPath: path ?? "<no-path>" });
			}
		},
	})(req, res);
}

export const config = {
	api: {
		bodyParser: false,
		sizeLimit: "1gb",
	},
};
