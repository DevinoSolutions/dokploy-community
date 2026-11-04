import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	ghaConnection,
} from "@dokploy/server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { GHA_SOURCE_TYPE } from "./provider";

/**
 * Connections made before GitHub Actions became a provider (T-13879) left their service on its old source type (the
 * git source of a waiting application, the image of a deployed one, the stored file of a stack). This gives each of
 * them the github-actions source type, once, at start: every service with a connection row and one of those types.
 * It cannot live in migration 0232, which adds the enum value and so must not use it. Idempotent: a service that
 * already has the type is not matched, and a service without a connection row is never touched.
 */
export const adoptConnectedServices = async (): Promise<{
	applications: number;
	composes: number;
}> => {
	const connectedApplications = db
		.select({ id: ghaConnection.serviceId })
		.from(ghaConnection)
		.where(eq(ghaConnection.serviceType, "application"));
	const connectedComposes = db
		.select({ id: ghaConnection.serviceId })
		.from(ghaConnection)
		.where(eq(ghaConnection.serviceType, "compose"));

	const apps = await db
		.update(applications)
		.set({ sourceType: GHA_SOURCE_TYPE })
		.where(
			and(
				inArray(applications.sourceType, ["docker", "github"]),
				inArray(applications.applicationId, connectedApplications),
			),
		)
		.returning({ id: applications.applicationId });
	const stacks = await db
		.update(compose)
		.set({ sourceType: GHA_SOURCE_TYPE })
		.where(
			and(
				eq(compose.sourceType, "raw"),
				inArray(compose.composeId, connectedComposes),
			),
		)
		.returning({ id: compose.composeId });
	return { applications: apps.length, composes: stacks.length };
};

/** Never throws: a failure here must not stop the server from starting. */
export const adoptConnectedServicesAtStart = async () => {
	try {
		const adopted = await adoptConnectedServices();
		if (adopted.applications + adopted.composes > 0) {
			console.log(
				`GitHub Actions: ${adopted.applications} application(s) and ${adopted.composes} compose stack(s) moved to the GitHub Actions provider`,
			);
		}
	} catch (error) {
		console.error("GitHub Actions: could not adopt connected services", error);
	}
};
