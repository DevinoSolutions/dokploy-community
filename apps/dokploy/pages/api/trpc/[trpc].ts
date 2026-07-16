import { createNextApiHandler } from "@trpc/server/adapters/next";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";
import { captureError } from "@/server/sentry";

// export API handler (v11: body parsed by Content-Type automatically, no experimental_contentTypeHandlers)
export default createNextApiHandler({
	router: appRouter,
	createContext: createTRPCContext,
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
});

export const config = {
	api: {
		bodyParser: false,
		sizeLimit: "1gb",
	},
};
