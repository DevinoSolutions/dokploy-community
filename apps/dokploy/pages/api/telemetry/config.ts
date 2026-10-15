import type { NextApiRequest, NextApiResponse } from "next";
import { buildTelemetryConfig } from "@/server/utils/telemetry-config";
import packageInfo from "../../../package.json";

/**
 * Unauthenticated on purpose: the login page loads before a session exists.
 * It exposes only the opt-in browser telemetry switch plus public ingest-only
 * values (a Sentry DSN and a PostHog project key), and nothing when disabled.
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
	res.setHeader("Cache-Control", "no-store");
	return res
		.status(200)
		.json(buildTelemetryConfig(process.env, packageInfo.version));
}
