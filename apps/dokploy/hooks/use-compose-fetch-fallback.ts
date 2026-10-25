import { useEffect } from "react";
import { toast } from "sonner";

type LoadServicesError = {
	message: string;
	data?: { code?: string } | null;
};

/**
 * What a refused Fetch answers with: the caller may not deploy the compose
 * (UNAUTHORIZED, FORBIDDEN) or a deployment of it is queued or running
 * (CONFLICT). A clone that failed is not a refusal and keeps its error.
 */
const REFUSED = new Set(["UNAUTHORIZED", "FORBIDDEN", "CONFLICT"]);

/** The reason a Fetch was refused, to show as is; null for any other error. */
export const fetchRefusalMessage = (error: unknown): string | null => {
	const refusal = error as LoadServicesError | null | undefined;
	return refusal?.message && REFUSED.has(refusal.data?.code ?? "")
		? refusal.message
		: null;
};

/**
 * A compose services selector that switched to Fetch goes back to the cached
 * services when the Fetch is refused, with the reason in a toast, so the list
 * keeps the services it had. Nothing is done while the query fetches: going
 * back to Fetch after a refusal shows the old error until the new answer.
 */
export const useComposeFetchFallback = (
	cacheType: "fetch" | "cache",
	setCacheType: (type: "cache") => void,
	error: LoadServicesError | null | undefined,
	isFetching: boolean,
) => {
	useEffect(() => {
		if (cacheType !== "fetch" || !error || isFetching) return;
		const refusal = fetchRefusalMessage(error);
		if (!refusal) return;
		toast.error(refusal);
		setCacheType("cache");
	}, [cacheType, error, isFetching, setCacheType]);
};
