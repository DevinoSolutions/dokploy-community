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

/**
 * A compose services selector that switched to Fetch goes back to the cached
 * services when the Fetch is refused, with the reason in a toast, so the list
 * keeps the services it had.
 */
export const useComposeFetchFallback = (
	cacheType: "fetch" | "cache",
	setCacheType: (type: "cache") => void,
	error: LoadServicesError | null | undefined,
) => {
	useEffect(() => {
		if (cacheType !== "fetch" || !error) return;
		if (!REFUSED.has(error.data?.code ?? "")) return;
		toast.error(error.message);
		setCacheType("cache");
	}, [cacheType, error, setCacheType]);
};
