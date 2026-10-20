import { randomUUID } from "node:crypto";
import { chmod, rename } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import { IS_CLOUD, paths } from "../constants";
import { db } from "../db";
import type {
	createScheduleSchema,
	updateScheduleSchema,
} from "../db/schema/schedule";
import { type Schedule, schedules } from "../db/schema/schedule";
import { isPlainAppName } from "../db/schema/utils";
import {
	getStagedFilePath,
	removeStagedFiles,
	stageFiles,
} from "../utils/docker/staging";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { findMemberByUserId } from "./permission";
import { findServerById } from "./server";

export type ScheduleExtended = Awaited<ReturnType<typeof findScheduleById>>;

// Host-level schedules (server / dokploy-server) run their script as root on the
// host and must stay restricted to owners/admins, regardless of whether the
// request is also tied to a service. Attaching an accessible applicationId must
// not downgrade this to a service-access check.
export const assertHostScheduleAccess = async (
	ctx: { user: { id: string }; session: { activeOrganizationId: string } },
	scheduleType: Schedule["scheduleType"] | null | undefined,
	serverId: string | null | undefined,
) => {
	if (scheduleType !== "server" && scheduleType !== "dokploy-server") return;

	if (scheduleType === "dokploy-server" && IS_CLOUD) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Host-level schedules are not available in the cloud version.",
		});
	}

	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (member.role !== "owner" && member.role !== "admin") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only owners and admins can manage server-level schedules.",
		});
	}

	if (scheduleType === "server" && serverId) {
		const targetServer = await findServerById(serverId);
		if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this server.",
			});
		}
	}
};

// A dokploy-server schedule has no service or server to scope it by; its
// organizationId is the only thing tying it to a caller.
export const assertScheduleOrganization = (
	ctx: { session: { activeOrganizationId: string } },
	schedule: {
		scheduleType: Schedule["scheduleType"];
		organizationId: string | null;
	},
) => {
	if (
		schedule.scheduleType === "dokploy-server" &&
		schedule.organizationId !== ctx.session.activeOrganizationId
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this schedule.",
		});
	}
};

export const createSchedule = async (
	input: z.infer<typeof createScheduleSchema> & { organizationId?: string },
) => {
	const { scheduleId, ...rest } = input;
	const [newSchedule] = await db
		.insert(schedules)
		.values(rest as typeof schedules.$inferInsert)
		.returning();

	if (
		newSchedule &&
		(newSchedule.scheduleType === "dokploy-server" ||
			newSchedule.scheduleType === "server")
	) {
		await handleScript(newSchedule);
	}

	return newSchedule;
};

export const findScheduleById = async (scheduleId: string) => {
	const schedule = await db.query.schedules.findFirst({
		where: eq(schedules.scheduleId, scheduleId),
		with: {
			// `application` has 100 columns (incl. the fork's `networkIds`). Drizzle
			// packs every selected column of a joined resource plus one entry per
			// nested relation into a single json_build_array(...), which Postgres caps
			// at 100 arguments (error 54023). Selecting all of `application` emits
			// json_build_array(100 columns + environment) = 101 args and throws, so we
			// project it down to only the fields consumers read. `compose`/`server`
			// are far narrower and left intact. See services/mount.ts for the same fix.
			application: {
				columns: {
					applicationId: true,
					appName: true,
					serverId: true,
				},
				with: {
					environment: {
						columns: {},
						with: {
							project: {
								columns: { name: true, organizationId: true },
							},
						},
					},
				},
			},
			compose: {
				with: {
					environment: {
						with: {
							project: true,
						},
					},
				},
			},
			server: {
				with: {
					organization: true,
				},
			},
		},
	});

	if (!schedule) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Schedule not found",
		});
	}
	return schedule;
};

export const findScheduleOrganizationId = async (scheduleId: string) => {
	const schedule = await findScheduleById(scheduleId);

	if (schedule?.application) {
		return schedule?.application?.environment?.project?.organizationId;
	}
	if (schedule?.compose) {
		return schedule?.compose?.environment?.project?.organizationId;
	}
	if (schedule?.server) {
		return schedule?.server?.organization?.id;
	}
	if (schedule?.organizationId) {
		return schedule.organizationId;
	}
	return null;
};

export const deleteSchedule = async (scheduleId: string) => {
	const schedule = await findScheduleById(scheduleId);
	const serverId =
		schedule?.serverId ||
		schedule?.application?.serverId ||
		schedule?.compose?.serverId;
	const { SCHEDULES_PATH } = paths(!!serverId);

	// A row written before appName stopped being client input can hold anything;
	// never turn it into a path to delete. The row itself is still removed.
	if (isPlainAppName(schedule?.appName || "")) {
		const fullPath = path.join(SCHEDULES_PATH, schedule.appName);
		const command = `rm -rf ${quote([fullPath])}`;
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	}

	const scheduleResult = await db
		.delete(schedules)
		.where(eq(schedules.scheduleId, scheduleId));
	if (!scheduleResult) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Schedule not found",
		});
	}

	return true;
};

export const updateSchedule = async (
	input: z.infer<typeof updateScheduleSchema> & {
		organizationId?: string | null;
	},
) => {
	const { scheduleId, ...rest } = input;
	const [updatedSchedule] = await db
		.update(schedules)
		.set(rest as Partial<typeof schedules.$inferInsert>)
		.where(eq(schedules.scheduleId, scheduleId))
		.returning();

	if (!updatedSchedule) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Schedule not found",
		});
	}

	if (
		updatedSchedule?.scheduleType === "dokploy-server" ||
		updatedSchedule?.scheduleType === "server"
	) {
		await handleScript(updatedSchedule);
	}

	return updatedSchedule;
};

const handleScript = async (schedule: Schedule) => {
	if (!isPlainAppName(schedule?.appName || "")) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid schedule app name",
		});
	}
	// A server schedule without a server has nowhere to write its script.
	const serverId =
		schedule.scheduleType === "server" ? schedule.serverId : null;
	if (schedule.scheduleType === "server" && !serverId) return;

	const { SCHEDULES_PATH } = paths(!!schedule?.serverId);
	const fullPath = path.join(SCHEDULES_PATH, schedule.appName);
	const scriptPath = path.join(fullPath, "script.sh");

	// Add PID and Schedule ID echo by default to all scripts
	const scriptWithPid = `echo "PID: $$ | Schedule ID: ${schedule.scheduleId}"
${schedule?.script || ""}`;

	// The script can hold secrets and be large, so it never goes through a
	// command line (it would show in the host's process list, and one shell
	// argument is capped at 128 KB). It is staged as a 0600 file through SFTP /
	// fs, then moved over the script in one step, so a run never sees half of it.
	const staged = getStagedFilePath({
		directory: fullPath,
		kind: "schedule-script",
		// Per call: two saves of one schedule at once must not share a file.
		deploymentId: `${schedule.scheduleId}-${randomUUID()}`,
	});
	try {
		await stageFiles({
			serverId,
			directory: fullPath,
			files: [{ path: staged, content: scriptWithPid }],
		});
		if (serverId) {
			const qStaged = quote([staged]);
			await execAsyncRemote(
				serverId,
				`chmod 700 ${qStaged} && mv -f ${qStaged} ${quote([scriptPath])}`,
			);
		} else {
			await chmod(staged, 0o700);
			await rename(staged, scriptPath);
		}
	} catch (error) {
		await removeStagedFiles(serverId, [staged]);
		throw error;
	}
};
