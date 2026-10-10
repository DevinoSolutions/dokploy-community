import { db } from "@dokploy/server/db";
import {
	type apiCreateCustom,
	type apiCreateDiscord,
	type apiCreateEmail,
	type apiCreateGotify,
	type apiCreateLark,
	type apiCreateMattermost,
	type apiCreateNotifly,
	type apiCreateNtfy,
	type apiCreatePushover,
	type apiCreateResend,
	type apiCreateSendly,
	type apiCreateSlack,
	type apiCreateTeams,
	type apiCreateTelegram,
	type apiCreateUptimelyChannel,
	type apiUpdateCustom,
	type apiUpdateDiscord,
	type apiUpdateEmail,
	type apiUpdateGotify,
	type apiUpdateLark,
	type apiUpdateMattermost,
	type apiUpdateNotifly,
	type apiUpdateNtfy,
	type apiUpdatePushover,
	type apiUpdateResend,
	type apiUpdateSendly,
	type apiUpdateSlack,
	type apiUpdateTeams,
	type apiUpdateTelegram,
	type apiUpdateUptimelyChannel,
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
	uptimelyChannelIncident,
} from "@dokploy/server/db/schema";
import {
	integrationUrlChangeNeedsKeyMessage,
	isSameIntegrationBaseUrl,
} from "@dokploy/server/utils/integrations/base-url";
import {
	isSameUptimelyBaseUrl,
	UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE,
} from "@dokploy/server/utils/uptimely/base-url";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { deleteProviderRowsOf } from "./notification-channels";

export type Notification = typeof notifications.$inferSelect;

const withoutUndefined = <T extends Record<string, unknown>>(values: T) =>
	Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	) as Partial<T>;

export const SENDLY_URL_CHANGE_NEEDS_KEY_MESSAGE =
	integrationUrlChangeNeedsKeyMessage("Sendly");
export const NOTIFLY_URL_CHANGE_NEEDS_KEY_MESSAGE =
	integrationUrlChangeNeedsKeyMessage("Notifly");

export const GOTIFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE =
	integrationUrlChangeNeedsKeyMessage("Gotify", "app token");
export const NTFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE =
	integrationUrlChangeNeedsKeyMessage("ntfy", "access token");
export const EMAIL_SERVER_CHANGE_NEEDS_PASSWORD_MESSAGE =
	"Enter the SMTP password again to change the SMTP server or port.";
export const CUSTOM_URL_CHANGE_NEEDS_HEADERS_MESSAGE =
	"Enter the header values again to change the Custom webhook URL.";

/** Host (any case) and port: the SMTP password only goes to this server. */
export const isSameSmtpServer = (
	a: { smtpServer: string; smtpPort: number },
	b: { smtpServer: string; smtpPort: number },
) =>
	a.smtpServer.trim().toLowerCase() === b.smtpServer.trim().toLowerCase() &&
	a.smtpPort === b.smtpPort;

/**
 * The header values of a Custom notification are write-only. A blank value of
 * a header that is already stored keeps the stored value; a changed endpoint
 * would hand that value to another URL, so it needs the value typed again.
 */
export const mergeCustomHeaders = (
	headers: Record<string, string>,
	stored: Record<string, string> | null | undefined,
	endpointChanged: boolean,
) => {
	const known = stored ?? {};
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => {
			if (value !== "" || !Object.hasOwn(known, name)) {
				return [name, value];
			}
			if (endpointChanged) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: CUSTOM_URL_CHANGE_NEEDS_HEADERS_MESSAGE,
				});
			}
			return [name, known[name] as string];
		}),
	);
};

const PROVIDER_RELATIONS = {
	slack: true,
	telegram: true,
	discord: true,
	email: true,
	resend: true,
	sendly: true,
	notifly: true,
	uptimelyChannel: true,
	gotify: true,
	ntfy: true,
	mattermost: true,
	custom: true,
	lark: true,
	pushover: true,
	teams: true,
} as const;

type ProviderKey = keyof typeof PROVIDER_RELATIONS;

const findWithProviders = (
	executor: Pick<typeof db, "query">,
	notificationId: string,
) =>
	executor.query.notifications.findFirst({
		where: eq(notifications.notificationId, notificationId),
		with: PROVIDER_RELATIONS,
	});

type NotificationWithProviders = NonNullable<
	Awaited<ReturnType<typeof findWithProviders>>
>;

/**
 * The provider row of a notification, derived from the notification row and
 * never from a client-sent id: the notification must belong to the caller's
 * organization and be of the expected type.
 */
const findOwnedProvider = async <K extends ProviderKey>(
	tx: Pick<typeof db, "query">,
	input: { notificationId: string; organizationId?: string },
	type: Notification["notificationType"],
	key: K,
) => {
	const existing = await findWithProviders(tx, input.notificationId);
	const provider = existing?.[key];
	if (
		!existing ||
		!input.organizationId ||
		existing.organizationId !== input.organizationId ||
		existing.notificationType !== type ||
		!provider
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Notification not found",
		});
	}
	return provider as NonNullable<NotificationWithProviders[K]>;
};

type NotificationRowInput = Partial<
	Pick<
		Notification,
		| "name"
		| "appDeploy"
		| "appBuildError"
		| "databaseBackup"
		| "dokployBackup"
		| "volumeBackup"
		| "dokployRestart"
		| "dockerCleanup"
		| "serverThreshold"
		| "scheduleFailure"
	>
> & { notificationId: string };

const updateNotificationRow = async (
	tx: Pick<typeof db, "update">,
	input: NotificationRowInput,
) => {
	const values = withoutUndefined({
		name: input.name,
		appDeploy: input.appDeploy,
		appBuildError: input.appBuildError,
		databaseBackup: input.databaseBackup,
		dokployBackup: input.dokployBackup,
		volumeBackup: input.volumeBackup,
		dokployRestart: input.dokployRestart,
		dockerCleanup: input.dockerCleanup,
		serverThreshold: input.serverThreshold,
		scheduleFailure: input.scheduleFailure,
	});
	if (Object.keys(values).length === 0) return;
	await tx
		.update(notifications)
		.set(values)
		.where(eq(notifications.notificationId, input.notificationId));
};

export const createSlackNotification = async (
	input: z.infer<typeof apiCreateSlack>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newSlack = await tx
			.insert(slack)
			.values({
				channel: input.channel,
				webhookUrl: input.webhookUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newSlack) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting slack",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				slackId: newSlack.slackId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "slack",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateSlackNotification = async (
	input: z.infer<typeof apiUpdateSlack>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "slack", "slack");
		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			// The webhook URL is the credential: blank or omitted keeps it.
			webhookUrl: input.webhookUrl?.trim() || undefined,
			channel: input.channel,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(slack)
				.set(values)
				.where(eq(slack.slackId, stored.slackId));
		}
	});
};

export const createTelegramNotification = async (
	input: z.infer<typeof apiCreateTelegram>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newTelegram = await tx
			.insert(telegram)
			.values({
				botToken: input.botToken,
				chatId: input.chatId,
				messageThreadId: input.messageThreadId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newTelegram) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting telegram",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				telegramId: newTelegram.telegramId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "telegram",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateTelegramNotification = async (
	input: z.infer<typeof apiUpdateTelegram>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "telegram", "telegram");
		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			// Blank or omitted keeps the stored bot token (it is write-only).
			botToken: input.botToken?.trim() || undefined,
			chatId: input.chatId,
			messageThreadId: input.messageThreadId,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(telegram)
				.set(values)
				.where(eq(telegram.telegramId, stored.telegramId));
		}
	});
};

export const createDiscordNotification = async (
	input: z.infer<typeof apiCreateDiscord>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newDiscord = await tx
			.insert(discord)
			.values({
				webhookUrl: input.webhookUrl,
				decoration: input.decoration,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDiscord) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting discord",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				discordId: newDiscord.discordId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "discord",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateDiscordNotification = async (
	input: z.infer<typeof apiUpdateDiscord>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "discord", "discord");
		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			// The webhook URL is the credential: blank or omitted keeps it.
			webhookUrl: input.webhookUrl?.trim() || undefined,
			decoration: input.decoration,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(discord)
				.set(values)
				.where(eq(discord.discordId, stored.discordId));
		}
	});
};

export const createEmailNotification = async (
	input: z.infer<typeof apiCreateEmail>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newEmail = await tx
			.insert(email)
			.values({
				smtpServer: input.smtpServer,
				smtpPort: input.smtpPort,
				username: input.username,
				password: input.password,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
			})
			.returning()
			.then((value) => value[0]);

		if (!newEmail) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting email",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				emailId: newEmail.emailId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "email",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateEmailNotification = async (
	input: z.infer<typeof apiUpdateEmail>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "email", "email");

		// A blank username turns the authentication off, and the password with it.
		const clearsAuth = input.username !== undefined && !input.username.trim();
		const typedPassword = input.password || undefined;

		// The stored password must not be sent to a server the caller just chose.
		const username = input.username ?? stored.username ?? "";
		if (
			!typedPassword &&
			!clearsAuth &&
			stored.password &&
			username.trim() &&
			!isSameSmtpServer(
				{
					smtpServer: input.smtpServer ?? stored.smtpServer,
					smtpPort: input.smtpPort ?? stored.smtpPort,
				},
				stored,
			)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: EMAIL_SERVER_CHANGE_NEEDS_PASSWORD_MESSAGE,
			});
		}

		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			smtpServer: input.smtpServer,
			smtpPort: input.smtpPort,
			username: input.username,
			// Blank or omitted keeps the stored password (it is write-only).
			password: clearsAuth ? "" : typedPassword,
			fromAddress: input.fromAddress,
			toAddresses: input.toAddresses,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(email)
				.set(values)
				.where(eq(email.emailId, stored.emailId));
		}
	});
};

export const createResendNotification = async (
	input: z.infer<typeof apiCreateResend>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newResend = await tx
			.insert(resend)
			.values({
				apiKey: input.apiKey,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
			})
			.returning()
			.then((value) => value[0]);

		if (!newResend) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting resend",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				resendId: newResend.resendId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "resend",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateResendNotification = async (
	input: z.infer<typeof apiUpdateResend>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "resend", "resend");
		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			// Blank or omitted keeps the stored key (it is write-only).
			apiKey: input.apiKey?.trim() || undefined,
			fromAddress: input.fromAddress,
			toAddresses: input.toAddresses,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(resend)
				.set(values)
				.where(eq(resend.resendId, stored.resendId));
		}
	});
};

export const createSendlyNotification = async (
	input: z.infer<typeof apiCreateSendly>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newSendly = await tx
			.insert(sendly)
			.values({
				apiKey: input.apiKey,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
				baseUrl: input.baseUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newSendly) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting sendly",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				sendlyId: newSendly.sendlyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "sendly",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateSendlyNotification = async (
	input: z.infer<typeof apiUpdateSendly>,
) => {
	await db.transaction(async (tx) => {
		// The channel is derived from the notification row, never from the
		// client: the row must belong to the caller's organization and be a
		// Sendly one.
		const existing = await tx.query.notifications.findFirst({
			where: eq(notifications.notificationId, input.notificationId),
			with: { sendly: true },
		});
		if (
			!existing ||
			!input.organizationId ||
			existing.organizationId !== input.organizationId ||
			existing.notificationType !== "sendly" ||
			!existing.sendly
		) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Sendly notification not found",
			});
		}
		const stored = existing.sendly;

		// The stored key must not be sent to a URL the caller just chose.
		if (
			input.baseUrl !== undefined &&
			!input.apiKey?.trim() &&
			!isSameIntegrationBaseUrl(input.baseUrl, stored.baseUrl)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: SENDLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
			});
		}

		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const channelValues = withoutUndefined({
			// Blank or omitted keeps the stored key (it is write-only).
			apiKey: input.apiKey?.trim() || undefined,
			fromAddress: input.fromAddress,
			toAddresses: input.toAddresses,
			baseUrl: input.baseUrl,
		});
		if (Object.keys(channelValues).length > 0) {
			await tx
				.update(sendly)
				.set(channelValues)
				.where(eq(sendly.sendlyId, stored.sendlyId));
		}

		return newDestination;
	});
};

export const createNotiflyNotification = async (
	input: z.infer<typeof apiCreateNotifly>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newNotifly = await tx
			.insert(notifly)
			.values({
				apiKey: input.apiKey,
				workflowKey: input.workflowKey,
				subscriberId: input.subscriberId,
				baseUrl: input.baseUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newNotifly) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notifly",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				notiflyId: newNotifly.notiflyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "notifly",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateNotiflyNotification = async (
	input: z.infer<typeof apiUpdateNotifly>,
) => {
	await db.transaction(async (tx) => {
		// The channel is derived from the notification row, never from the
		// client: the row must belong to the caller's organization and be a
		// Notifly one.
		const existing = await tx.query.notifications.findFirst({
			where: eq(notifications.notificationId, input.notificationId),
			with: { notifly: true },
		});
		if (
			!existing ||
			!input.organizationId ||
			existing.organizationId !== input.organizationId ||
			existing.notificationType !== "notifly" ||
			!existing.notifly
		) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Notifly notification not found",
			});
		}
		const stored = existing.notifly;

		// The stored key must not be sent to a URL the caller just chose.
		if (
			input.baseUrl !== undefined &&
			!input.apiKey?.trim() &&
			!isSameIntegrationBaseUrl(input.baseUrl, stored.baseUrl)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: NOTIFLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
			});
		}

		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		const channelValues = withoutUndefined({
			// Blank or omitted keeps the stored key (it is write-only).
			apiKey: input.apiKey?.trim() || undefined,
			workflowKey: input.workflowKey,
			subscriberId: input.subscriberId,
			baseUrl: input.baseUrl,
		});
		if (Object.keys(channelValues).length > 0) {
			await tx
				.update(notifly)
				.set(channelValues)
				.where(eq(notifly.notiflyId, stored.notiflyId));
		}

		return newDestination;
	});
};

export const createUptimelyChannelNotification = async (
	input: z.infer<typeof apiCreateUptimelyChannel>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newChannel = await tx
			.insert(uptimelyChannel)
			.values({
				apiKey: input.apiKey,
				projectId: input.projectId,
				baseUrl: input.baseUrl,
				resolvedStateId: input.resolvedStateId || null,
			})
			.returning()
			.then((value) => value[0]);

		if (!newChannel) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting uptimely channel",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				uptimelyChannelId: newChannel.uptimelyChannelId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "uptimely",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateUptimelyChannelNotification = async (
	input: z.infer<typeof apiUpdateUptimelyChannel>,
) => {
	await db.transaction(async (tx) => {
		// The channel is derived from the notification row, never from the
		// client: the row must belong to the caller's organization and be an
		// Uptimely one.
		const existing = await tx.query.notifications.findFirst({
			where: eq(notifications.notificationId, input.notificationId),
			with: { uptimelyChannel: true },
		});
		if (
			!existing ||
			!input.organizationId ||
			existing.organizationId !== input.organizationId ||
			existing.notificationType !== "uptimely" ||
			!existing.uptimelyChannel
		) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Uptimely notification not found",
			});
		}
		const stored = existing.uptimelyChannel;

		// The stored key must not be sent to a URL the caller just chose.
		if (
			input.baseUrl !== undefined &&
			!input.apiKey?.trim() &&
			!isSameUptimelyBaseUrl(input.baseUrl, stored.baseUrl)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE,
			});
		}

		const notificationValues = Object.fromEntries(
			Object.entries({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			}).filter(([, value]) => value !== undefined),
		);
		if (Object.keys(notificationValues).length > 0) {
			await tx
				.update(notifications)
				.set(notificationValues)
				.where(eq(notifications.notificationId, input.notificationId));
		}

		// Blank or omitted keeps the stored key (it is write-only).
		const channelValues = Object.fromEntries(
			Object.entries({
				apiKey: input.apiKey?.trim() || undefined,
				projectId: input.projectId,
				baseUrl: input.baseUrl,
				// "" clears the override, undefined leaves it untouched.
				resolvedStateId:
					input.resolvedStateId === undefined
						? undefined
						: input.resolvedStateId || null,
			}).filter(([, value]) => value !== undefined),
		);
		if (Object.keys(channelValues).length > 0) {
			await tx
				.update(uptimelyChannel)
				.set(channelValues)
				.where(eq(uptimelyChannel.uptimelyChannelId, stored.uptimelyChannelId));
		}

		// The remembered incidents belong to the old project/key: pointing the
		// channel somewhere else would leave rows Uptimely can never resolve.
		const retargeted =
			(input.projectId !== undefined && input.projectId !== stored.projectId) ||
			(input.baseUrl !== undefined &&
				!isSameUptimelyBaseUrl(input.baseUrl, stored.baseUrl)) ||
			(!!input.apiKey && input.apiKey !== stored.apiKey);
		if (retargeted) {
			await tx
				.delete(uptimelyChannelIncident)
				.where(
					eq(
						uptimelyChannelIncident.uptimelyChannelId,
						stored.uptimelyChannelId,
					),
				);
		}
	});
};

export const createGotifyNotification = async (
	input: z.infer<typeof apiCreateGotify>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newGotify = await tx
			.insert(gotify)
			.values({
				serverUrl: input.serverUrl,
				appToken: input.appToken,
				priority: input.priority,
				decoration: input.decoration,
			})
			.returning()
			.then((value) => value[0]);

		if (!newGotify) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting gotify",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				gotifyId: newGotify.gotifyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "gotify",
				organizationId: organizationId,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateGotifyNotification = async (
	input: z.infer<typeof apiUpdateGotify>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "gotify", "gotify");

		// The stored token must not be sent to a server the caller just chose.
		if (
			input.serverUrl !== undefined &&
			!input.appToken?.trim() &&
			!isSameIntegrationBaseUrl(input.serverUrl, stored.serverUrl)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: GOTIFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
			});
		}

		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			serverUrl: input.serverUrl,
			// Blank or omitted keeps the stored token (it is write-only).
			appToken: input.appToken?.trim() || undefined,
			priority: input.priority,
			decoration: input.decoration,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(gotify)
				.set(values)
				.where(eq(gotify.gotifyId, stored.gotifyId));
		}
	});
};

export const createNtfyNotification = async (
	input: z.infer<typeof apiCreateNtfy>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newNtfy = await tx
			.insert(ntfy)
			.values({
				serverUrl: input.serverUrl,
				topic: input.topic,
				accessToken: input.accessToken ?? null,
				priority: input.priority,
			})
			.returning()
			.then((value) => value[0]);

		if (!newNtfy) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting ntfy",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				ntfyId: newNtfy.ntfyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "ntfy",
				organizationId: organizationId,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateNtfyNotification = async (
	input: z.infer<typeof apiUpdateNtfy>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "ntfy", "ntfy");

		const typedToken = input.accessToken?.trim() || undefined;
		const clearsToken = input.clearAccessToken === true && !typedToken;

		// The stored token must not be sent to a server the caller just chose.
		if (
			input.serverUrl !== undefined &&
			stored.accessToken &&
			!typedToken &&
			!clearsToken &&
			!isSameIntegrationBaseUrl(input.serverUrl, stored.serverUrl)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: NTFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
			});
		}

		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			serverUrl: input.serverUrl,
			topic: input.topic,
			// Blank or omitted keeps the stored token (it is write-only).
			accessToken: clearsToken ? null : typedToken,
			priority: input.priority,
		});
		if (Object.keys(values).length > 0) {
			await tx.update(ntfy).set(values).where(eq(ntfy.ntfyId, stored.ntfyId));
		}
	});
};

export const createCustomNotification = async (
	input: z.infer<typeof apiCreateCustom>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newCustom = await tx
			.insert(custom)
			.values({
				endpoint: input.endpoint,
				headers: input.headers,
			})
			.returning()
			.then((value) => value[0]);

		if (!newCustom) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting custom",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				customId: newCustom.customId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "custom",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateCustomNotification = async (
	input: z.infer<typeof apiUpdateCustom>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "custom", "custom");

		// The stored header values must not be sent to an endpoint the caller
		// just chose.
		const endpointChanged =
			input.endpoint !== undefined &&
			!isSameIntegrationBaseUrl(input.endpoint, stored.endpoint);
		let headers: Record<string, string> | undefined;
		if (input.headers === undefined) {
			if (endpointChanged && Object.keys(stored.headers ?? {}).length > 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: CUSTOM_URL_CHANGE_NEEDS_HEADERS_MESSAGE,
				});
			}
		} else {
			headers = mergeCustomHeaders(
				input.headers,
				stored.headers,
				endpointChanged,
			);
		}

		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			endpoint: input.endpoint,
			headers,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(custom)
				.set(values)
				.where(eq(custom.customId, stored.customId));
		}
	});
};

export const findNotificationById = async (notificationId: string) => {
	const notification = await findWithProviders(db, notificationId);
	if (!notification) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Notification not found",
		});
	}
	return notification;
};

export const removeNotificationById = async (notificationId: string) => {
	// One transaction: the provider row holds the API key or webhook and must
	// not outlive its notification (an Uptimely channel's open-incident rows
	// cascade).
	return db.transaction(async (tx) => {
		const result = await tx
			.delete(notifications)
			.where(eq(notifications.notificationId, notificationId))
			.returning();

		await deleteProviderRowsOf(tx, result);

		return result[0];
	});
};

export const createLarkNotification = async (
	input: z.infer<typeof apiCreateLark>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newLark = await tx
			.insert(lark)
			.values({
				webhookUrl: input.webhookUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newLark) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting lark",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				larkId: newLark.larkId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "lark",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateLarkNotification = async (
	input: z.infer<typeof apiUpdateLark>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "lark", "lark");
		await updateNotificationRow(tx, input);

		// The webhook URL is the credential: blank or omitted keeps it.
		const webhookUrl = input.webhookUrl?.trim();
		if (webhookUrl) {
			await tx
				.update(lark)
				.set({ webhookUrl })
				.where(eq(lark.larkId, stored.larkId));
		}
	});
};

export const createTeamsNotification = async (
	input: z.infer<typeof apiCreateTeams>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newTeams = await tx
			.insert(teams)
			.values({
				webhookUrl: input.webhookUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newTeams) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting teams",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				teamsId: newTeams.teamsId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "teams",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateTeamsNotification = async (
	input: z.infer<typeof apiUpdateTeams>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "teams", "teams");
		await updateNotificationRow(tx, input);

		// The webhook URL is the credential: blank or omitted keeps it.
		const webhookUrl = input.webhookUrl?.trim();
		if (webhookUrl) {
			await tx
				.update(teams)
				.set({ webhookUrl })
				.where(eq(teams.teamsId, stored.teamsId));
		}
	});
};

export const updateNotificationById = async (
	notificationId: string,
	notificationData: Partial<Notification>,
) => {
	const result = await db
		.update(notifications)
		.set({
			...notificationData,
		})
		.where(eq(notifications.notificationId, notificationId))
		.returning();

	return result[0];
};

export const createMattermostNotification = async (
	input: z.infer<typeof apiCreateMattermost>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newMattermost = await tx
			.insert(mattermost)
			.values({
				webhookUrl: input.webhookUrl,
				channel: input.channel,
				username: input.username,
			})
			.returning()
			.then((value) => value[0]);

		if (!newMattermost) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting mattermost",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				mattermostId: newMattermost.mattermostId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "mattermost",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateMattermostNotification = async (
	input: z.infer<typeof apiUpdateMattermost>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(
			tx,
			input,
			"mattermost",
			"mattermost",
		);
		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			// The webhook URL is the credential: blank or omitted keeps it.
			webhookUrl: input.webhookUrl?.trim() || undefined,
			channel: input.channel,
			username: input.username,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(mattermost)
				.set(values)
				.where(eq(mattermost.mattermostId, stored.mattermostId));
		}
	});
};

export const createPushoverNotification = async (
	input: z.infer<typeof apiCreatePushover>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newPushover = await tx
			.insert(pushover)
			.values({
				userKey: input.userKey,
				apiToken: input.apiToken,
				priority: input.priority,
				retry: input.retry,
				expire: input.expire,
			})
			.returning()
			.then((value) => value[0]);

		if (!newPushover) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting pushover",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				pushoverId: newPushover.pushoverId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				dokployBackup: input.dokployBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				scheduleFailure: input.scheduleFailure,
				notificationType: "pushover",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updatePushoverNotification = async (
	input: z.infer<typeof apiUpdatePushover>,
) => {
	await db.transaction(async (tx) => {
		const stored = await findOwnedProvider(tx, input, "pushover", "pushover");
		await updateNotificationRow(tx, input);

		const values = withoutUndefined({
			// Blank or omitted keeps the stored keys (they are write-only).
			userKey: input.userKey?.trim() || undefined,
			apiToken: input.apiToken?.trim() || undefined,
			priority: input.priority,
			retry: input.retry,
			expire: input.expire,
		});
		if (Object.keys(values).length > 0) {
			await tx
				.update(pushover)
				.set(values)
				.where(eq(pushover.pushoverId, stored.pushoverId));
		}
	});
};
