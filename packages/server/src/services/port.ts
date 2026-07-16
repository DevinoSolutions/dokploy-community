import { db } from "@dokploy/server/db";
import { type apiCreatePort, ports } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";

export type Port = typeof ports.$inferSelect;

export const createPort = async (input: z.infer<typeof apiCreatePort>) => {
	const newPort = await db
		.insert(ports)
		.values({
			...input,
		})
		.returning()
		.then((value) => value[0]);

	if (!newPort) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting port",
		});
	}

	return newPort;
};

export const finPortById = async (portId: string) => {
	const result = await db.query.ports.findFirst({
		where: eq(ports.portId, portId),
		with: {
			// `application` has 100 columns (incl. the fork's `networkIds`). Drizzle
			// packs every selected column of a joined resource plus one entry per
			// nested relation into a single json_build_array(...), which Postgres
			// caps at 100 arguments (error 54023). Selecting all of `application`
			// emits json_build_array(100 columns + environment) = 101 args and
			// throws, so we project it down. The port router only reads
			// `application.applicationId` (permission checks); the other identifying
			// columns are kept for API-shape stability. See services/schedule.ts and
			// services/volume-backups.ts for the same fix.
			application: {
				columns: {
					applicationId: true,
					appName: true,
					name: true,
					serverId: true,
				},
				with: {
					environment: {
						columns: { environmentId: true, name: true },
						with: {
							project: {
								columns: { projectId: true, name: true, organizationId: true },
							},
						},
					},
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Port not found",
		});
	}
	return result;
};

export const removePortById = async (portId: string) => {
	const result = await db
		.delete(ports)
		.where(eq(ports.portId, portId))
		.returning();

	return result[0];
};

export const updatePortById = async (
	portId: string,
	portData: Partial<Port>,
) => {
	const result = await db
		.update(ports)
		.set({
			...portData,
		})
		.where(eq(ports.portId, portId))
		.returning();

	return result[0];
};
