import { useRouter } from "next/router";
import { useEffect } from "react";
import {
	startSessionReplay,
	suppressSessionReplay,
} from "@/lib/session-replay";
import { isSensitiveLocation } from "@/lib/telemetry-privacy";

/**
 * Renders nothing; starts opt-in browser session replay once the app is on a
 * page that is safe to record, and stops it if the user navigates to one that
 * carries credentials.
 */
export const SessionReplay = () => {
	const router = useRouter();

	useEffect(() => {
		void startSessionReplay();
		const onRouteChangeStart = (url: string) => {
			if (isSensitiveLocation(url)) suppressSessionReplay();
		};
		router.events.on("routeChangeStart", onRouteChangeStart);
		return () => router.events.off("routeChangeStart", onRouteChangeStart);
	}, [router.events]);

	return null;
};
