import { db } from "@dokploy/server/db";
import {
	custom,
	discord,
	email,
	gotify,
	lark,
	mattermost,
	notifications,
	notifly,
	ntfy,
	pushover,
	resend,
	sendly,
	slack,
	teams,
	telegram,
	uptimelyChannel,
} from "@dokploy/server/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

type NotificationRow = typeof notifications.$inferSelect;

/** Either the pool or a transaction handle. */
type Executor = Pick<typeof db, "delete" | "select">;

/**
 * A notification points at its provider row (the foreign key cascades from the
 * provider to the notification, not the other way round), so deleting the
 * notification alone leaves the provider row - and the API key or webhook in
 * it - behind.
 */
export const deleteProviderRowsOf = async (
	tx: Pick<typeof db, "delete">,
	rows: Pick<
		NotificationRow,
		| "slackId"
		| "telegramId"
		| "discordId"
		| "emailId"
		| "resendId"
		| "gotifyId"
		| "ntfyId"
		| "mattermostId"
		| "customId"
		| "larkId"
		| "pushoverId"
		| "teamsId"
		| "sendlyId"
		| "notiflyId"
		| "uptimelyChannelId"
	>[],
) => {
	const ids = <K extends keyof (typeof rows)[number]>(key: K) =>
		rows.map((row) => row[key]).filter((id): id is string => !!id);

	// Deleting an Uptimely channel also cascades to its open-incident rows.
	const targets: [PgTable, PgColumn, string[]][] = [
		[slack, slack.slackId, ids("slackId")],
		[telegram, telegram.telegramId, ids("telegramId")],
		[discord, discord.discordId, ids("discordId")],
		[email, email.emailId, ids("emailId")],
		[resend, resend.resendId, ids("resendId")],
		[gotify, gotify.gotifyId, ids("gotifyId")],
		[ntfy, ntfy.ntfyId, ids("ntfyId")],
		[mattermost, mattermost.mattermostId, ids("mattermostId")],
		[custom, custom.customId, ids("customId")],
		[lark, lark.larkId, ids("larkId")],
		[pushover, pushover.pushoverId, ids("pushoverId")],
		[teams, teams.teamsId, ids("teamsId")],
		[sendly, sendly.sendlyId, ids("sendlyId")],
		[notifly, notifly.notiflyId, ids("notiflyId")],
		[
			uptimelyChannel,
			uptimelyChannel.uptimelyChannelId,
			ids("uptimelyChannelId"),
		],
	];

	for (const [table, column, channelIds] of targets) {
		if (channelIds.length > 0) {
			await tx.delete(table).where(inArray(column, channelIds));
		}
	}
};

/**
 * Deletes every notification of an organization together with its provider
 * rows. Run it BEFORE the organization (or its owner) is deleted: once the
 * notification rows have cascaded away nothing points at the provider rows
 * any more. Pass the transaction that deletes the organization so both
 * succeed or fail together.
 */
export const removeOrganizationNotifications = async (
	organizationId: string,
	executor: Executor = db,
) => {
	const rows = await executor
		.select()
		.from(notifications)
		.where(eq(notifications.organizationId, organizationId));
	if (rows.length === 0) return 0;
	await executor
		.delete(notifications)
		.where(eq(notifications.organizationId, organizationId));
	await deleteProviderRowsOf(executor, rows);
	return rows.length;
};
