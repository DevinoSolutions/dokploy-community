import { useEffect } from "react";
import { startSessionReplay } from "@/lib/session-replay";

/** Renders nothing; starts opt-in browser session replay once on mount. */
export const SessionReplay = () => {
	useEffect(() => {
		void startSessionReplay();
	}, []);
	return null;
};
