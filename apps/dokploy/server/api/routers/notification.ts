import {
	buildSendlyTestEmail,
	createCustomNotification,
	createDiscordNotification,
	createEmailNotification,
	createGotifyNotification,
	createLarkNotification,
	createMattermostNotification,
	createNotiflyNotification,
	createNtfyNotification,
	createPushoverNotification,
	createResendNotification,
	createSendlyNotification,
	createSlackNotification,
	createTeamsNotification,
	createTelegramNotification,
	createUptimelyChannelNotification,
	EMAIL_SERVER_CHANGE_NEEDS_PASSWORD_MESSAGE,
	findNotificationById,
	GOTIFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
	getWebServerSettings,
	isSameIntegrationBaseUrl,
	isSameSmtpServer,
	maskApiKey,
	maskHeaderValues,
	maskWebhookUrl,
	mergeCustomHeaders,
	NOTIFLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
	NTFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
	NTFY_URL_CHANGE_NEEDS_TOPIC_MESSAGE,
	removeNotificationById,
	SENDLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
	sendCustomNotification,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendNotiflyNotification,
	sendNtfyNotification,
	sendPushoverNotification,
	sendResendNotification,
	sendSendlyNotification,
	sendServerThresholdNotifications,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
	testUptimelyConnection,
	UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE,
	updateCustomNotification,
	updateDiscordNotification,
	updateEmailNotification,
	updateGotifyNotification,
	updateLarkNotification,
	updateMattermostNotification,
	updateNotiflyNotification,
	updateNtfyNotification,
	updatePushoverNotification,
	updateResendNotification,
	updateSendlyNotification,
	updateSlackNotification,
	updateTeamsNotification,
	updateTelegramNotification,
	updateUptimelyChannelNotification,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	createTRPCRouter,
	publicProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateCustom,
	apiCreateDiscord,
	apiCreateEmail,
	apiCreateGotify,
	apiCreateLark,
	apiCreateMattermost,
	apiCreateNotifly,
	apiCreateNtfy,
	apiCreatePushover,
	apiCreateResend,
	apiCreateSendly,
	apiCreateSlack,
	apiCreateTeams,
	apiCreateTelegram,
	apiCreateUptimelyChannel,
	apiFindOneNotification,
	apiTestCustomConnection,
	apiTestDiscordConnection,
	apiTestEmailConnection,
	apiTestGotifyConnection,
	apiTestLarkConnection,
	apiTestMattermostConnection,
	apiTestNotiflyConnection,
	apiTestNtfyConnection,
	apiTestPushoverConnection,
	apiTestResendConnection,
	apiTestSendlyConnection,
	apiTestSlackConnection,
	apiTestTeamsConnection,
	apiTestTelegramConnection,
	apiTestUptimelyChannelConnection,
	apiUpdateCustom,
	apiUpdateDiscord,
	apiUpdateEmail,
	apiUpdateGotify,
	apiUpdateLark,
	apiUpdateMattermost,
	apiUpdateNotifly,
	apiUpdateNtfy,
	apiUpdatePushover,
	apiUpdateResend,
	apiUpdateSendly,
	apiUpdateSlack,
	apiUpdateTeams,
	apiUpdateTelegram,
	apiUpdateUptimelyChannel,
	notifications,
	server,
} from "@/server/db/schema";

/**
 * Client-safe view of a notification: every provider secret is write-only, so
 * it is replaced by its masked form (`<field>Masked`) and never returned. The
 * senders read the provider rows from the database, not this view.
 */
type NotificationWithProviders = Awaited<
	ReturnType<typeof findNotificationById>
>;

type Masked<C, K extends keyof C> = Omit<C, K> & {
	[P in K as `${P & string}Masked`]: string | null;
};

const maskSecrets = <C extends object, K extends keyof C & string>(
	row: C | null | undefined,
	keys: readonly K[],
	mask: (value: string) => string = maskApiKey,
) => {
	if (!row) return null;
	const visible: Record<string, unknown> = {
		...(row as Record<string, unknown>),
	};
	for (const key of keys) {
		const value = visible[key];
		delete visible[key];
		visible[`${key}Masked`] =
			typeof value === "string" && value ? mask(value) : null;
	}
	return visible as Masked<C, K>;
};

const maskCustomHeaders = (row: NotificationWithProviders["custom"]) => {
	if (!row) return null;
	const { headers, endpoint, ...visible } = row;
	return {
		...visible,
		// The endpoint often carries a token (in the path or the query).
		endpointMasked: endpoint ? maskWebhookUrl(endpoint) : null,
		headersMasked: maskHeaderValues(headers),
	};
};

/**
 * An error message from a failed test can echo the URL it called, and with it
 * the stored secret that was borrowed for the test. Hide those before the
 * message reaches the client.
 */
const redactSecrets = (message: string, secrets: Array<string | undefined>) =>
	secrets.reduce<string>(
		(text, secret) => (secret ? text.split(secret).join("••••") : text),
		message,
	);

const presentNotification = (notification: NotificationWithProviders) => {
	const {
		slack,
		telegram,
		discord,
		email,
		resend,
		sendly,
		notifly,
		uptimelyChannel,
		gotify,
		ntfy,
		mattermost,
		custom,
		lark,
		pushover,
		teams,
		...rest
	} = notification;
	return {
		...rest,
		slack: maskSecrets(slack, ["webhookUrl"], maskWebhookUrl),
		telegram: maskSecrets(telegram, ["botToken"]),
		discord: maskSecrets(discord, ["webhookUrl"], maskWebhookUrl),
		// A password is hidden entirely: no tail, unlike the keys and tokens.
		email: maskSecrets(email, ["password"], () => "••••••••"),
		resend: maskSecrets(resend, ["apiKey"]),
		sendly: maskSecrets(sendly, ["apiKey"]),
		notifly: maskSecrets(notifly, ["apiKey"]),
		uptimelyChannel: maskSecrets(uptimelyChannel, ["apiKey"]),
		gotify: maskSecrets(gotify, ["appToken"]),
		// On a public server (ntfy.sh) the topic is the secret.
		ntfy: maskSecrets(ntfy, ["accessToken", "topic"]),
		mattermost: maskSecrets(mattermost, ["webhookUrl"], maskWebhookUrl),
		custom: maskCustomHeaders(custom),
		lark: maskSecrets(lark, ["webhookUrl"], maskWebhookUrl),
		pushover: maskSecrets(pushover, ["userKey", "apiToken"]),
		teams: maskSecrets(teams, ["webhookUrl"], maskWebhookUrl),
	};
};

/**
 * The notification behind the "Test Notification" button of the edit form. It
 * must belong to the caller's organization: the stored secrets of another
 * organization's notification are never borrowed.
 */
const findOwnNotification = async (
	notificationId: string,
	organizationId: string,
) => {
	const notification = await findNotificationById(notificationId);
	if (notification.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this notification",
		});
	}
	return notification;
};

/**
 * Edit flow of the "Test Notification" button: the secret field is blank
 * (write-only), so the test uses the stored secret of the caller's own
 * notification, never one sent by the client. A typed secret is used as is.
 */
const resolveStoredSecret = async (params: {
	value?: string | null;
	notificationId?: string;
	organizationId: string;
	stored: (
		notification: NotificationWithProviders,
	) => string | null | undefined;
	missing: string;
}) => {
	if (params.value) return params.value;
	if (params.notificationId) {
		const notification = await findOwnNotification(
			params.notificationId,
			params.organizationId,
		);
		const stored = params.stored(notification);
		if (stored) return stored;
	}
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: `${params.missing} is required to test the connection`,
	});
};

/**
 * Same for a secret that is sent to a configurable server URL: the stored
 * secret is never replayed against a URL typed into the form. A provider
 * without a stored secret (an optional token) resolves to undefined.
 */
const resolveChannelTestKey = async (params: {
	apiKey?: string;
	notificationId?: string;
	baseUrl: string;
	organizationId: string;
	storedChannel: (
		notification: NotificationWithProviders,
	) => { apiKey: string; baseUrl: string } | null;
	urlChangeMessage: string;
}) => {
	if (params.apiKey || !params.notificationId) return params.apiKey;
	const notification = await findOwnNotification(
		params.notificationId,
		params.organizationId,
	);
	const channel = params.storedChannel(notification);
	if (!channel) return undefined;
	if (!isSameIntegrationBaseUrl(params.baseUrl, channel.baseUrl)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: params.urlChangeMessage,
		});
	}
	return channel.apiKey;
};

export const notificationRouter = createTRPCRouter({
	createSlack: withPermission("notification", "create")
		.input(apiCreateSlack)
		.mutation(async ({ input, ctx }) => {
			try {
				await createSlackNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				// Not the error itself: a database error carries the bound values,
				// which are the provider secrets.
				console.error(
					"Error creating the Slack notification:",
					error instanceof Error ? error.name : "unknown error",
				);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateSlack: withPermission("notification", "update")
		.input(apiUpdateSlack)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateSlackNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testSlackConnection: withPermission("notification", "create")
		.input(apiTestSlackConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const webhookUrl = await resolveStoredSecret({
					value: input.webhookUrl,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.slack?.webhookUrl,
					missing: "A webhook URL",
				});
				await sendSlackNotification(
					{ webhookUrl, channel: input.channel },
					{
						channel: input.channel,
						text: "Hi, From Dokploy 👋",
					},
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createTelegram: withPermission("notification", "create")
		.input(apiCreateTelegram)
		.mutation(async ({ input, ctx }) => {
			try {
				await createTelegramNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),

	updateTelegram: withPermission("notification", "update")
		.input(apiUpdateTelegram)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateTelegramNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the secret again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testTelegramConnection: withPermission("notification", "create")
		.input(apiTestTelegramConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const botToken = await resolveStoredSecret({
					value: input.botToken,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.telegram?.botToken,
					missing: "A bot token",
				});
				await sendTelegramNotification(
					{
						botToken,
						chatId: input.chatId,
						messageThreadId: input.messageThreadId,
					},
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createDiscord: withPermission("notification", "create")
		.input(apiCreateDiscord)
		.mutation(async ({ input, ctx }) => {
			try {
				await createDiscordNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),

	updateDiscord: withPermission("notification", "update")
		.input(apiUpdateDiscord)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateDiscordNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the secret again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),

	testDiscordConnection: withPermission("notification", "create")
		.input(apiTestDiscordConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const webhookUrl = await resolveStoredSecret({
					value: input.webhookUrl,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.discord?.webhookUrl,
					missing: "A webhook URL",
				});
				const decorate = (decoration: string, text: string) =>
					`${input.decoration ? decoration : ""} ${text}`.trim();

				await sendDiscordNotification(
					{ webhookUrl, decoration: input.decoration },
					{
						title: decorate(">", "`🤚` - Test Notification"),
						description: decorate(">", "Hi, From Dokploy 👋"),
						color: 0xf3f7f4,
					},
				);

				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createEmail: withPermission("notification", "create")
		.input(apiCreateEmail)
		.mutation(async ({ input, ctx }) => {
			try {
				await createEmailNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateEmail: withPermission("notification", "update")
		.input(apiUpdateEmail)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateEmailNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the secret again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testEmailConnection: withPermission("notification", "create")
		.input(apiTestEmailConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				let password = input.password;
				if (!password && input.notificationId && input.username) {
					const notification = await findOwnNotification(
						input.notificationId,
						ctx.session.activeOrganizationId,
					);
					const stored = notification.email;
					if (stored?.password) {
						// The stored password is never sent to a server typed into the form.
						if (!isSameSmtpServer(input, stored)) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message: EMAIL_SERVER_CHANGE_NEEDS_PASSWORD_MESSAGE,
							});
						}
						password = stored.password;
					}
				}
				await sendEmailNotification(
					{ ...input, password },
					"Test Email",
					"<p>Hi, From Dokploy 👋</p>",
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createResend: withPermission("notification", "create")
		.input(apiCreateResend)
		.mutation(async ({ input, ctx }) => {
			try {
				await createResendNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateResend: withPermission("notification", "update")
		.input(apiUpdateResend)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateResendNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the secret again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testResendConnection: withPermission("notification", "create")
		.input(apiTestResendConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const apiKey = await resolveStoredSecret({
					value: input.apiKey,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.resend?.apiKey,
					missing: "An API key",
				});
				await sendResendNotification(
					{ ...input, apiKey },
					"Test Email",
					"<p>Hi, From Dokploy 👋</p>",
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createSendly: withPermission("notification", "create")
		.input(apiCreateSendly)
		.mutation(async ({ input, ctx }) => {
			try {
				await createSendlyNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateSendly: withPermission("notification", "update")
		.input(apiUpdateSendly)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateSendlyNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the key again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testSendlyConnection: withPermission("notification", "create")
		.input(apiTestSendlyConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const apiKey = await resolveChannelTestKey({
					apiKey: input.apiKey,
					notificationId: input.notificationId,
					baseUrl: input.baseUrl,
					organizationId: ctx.session.activeOrganizationId,
					storedChannel: (notification) => notification.sendly,
					urlChangeMessage: SENDLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
				});
				if (!apiKey) {
					throw new Error("An API key is required to test the connection");
				}
				const { subject, html } = buildSendlyTestEmail();
				await sendSendlyNotification({ ...input, apiKey }, subject, html);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createNotifly: withPermission("notification", "create")
		.input(apiCreateNotifly)
		.mutation(async ({ input, ctx }) => {
			try {
				await createNotiflyNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateNotifly: withPermission("notification", "update")
		.input(apiUpdateNotifly)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateNotiflyNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the key again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testNotiflyConnection: withPermission("notification", "create")
		.input(apiTestNotiflyConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const apiKey = await resolveChannelTestKey({
					apiKey: input.apiKey,
					notificationId: input.notificationId,
					baseUrl: input.baseUrl,
					organizationId: ctx.session.activeOrganizationId,
					storedChannel: (notification) => notification.notifly,
					urlChangeMessage: NOTIFLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
				});
				if (!apiKey) {
					throw new Error("An API key is required to test the connection");
				}
				await sendNotiflyNotification(
					{ ...input, apiKey },
					{
						event: "test",
						message: "Hi, From Dokploy 👋",
						timestamp: new Date().toISOString(),
					},
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createUptimely: withPermission("notification", "create")
		.input(apiCreateUptimelyChannel)
		.mutation(async ({ input, ctx }) => {
			try {
				await createUptimelyChannelNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateUptimely: withPermission("notification", "update")
		.input(apiUpdateUptimelyChannel)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateUptimelyChannelNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				// Keep the specific refusals (not found, "enter the key again").
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	// Read-only on purpose: a test must not declare an incident in a real
	// Uptimely project. It proves the key, the base URL and the project id.
	testUptimelyConnection: withPermission("notification", "create")
		.input(apiTestUptimelyChannelConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const apiKey = await resolveChannelTestKey({
					apiKey: input.apiKey,
					notificationId: input.notificationId,
					baseUrl: input.baseUrl,
					organizationId: ctx.session.activeOrganizationId,
					storedChannel: (notification) => notification.uptimelyChannel,
					urlChangeMessage: UPTIMELY_URL_CHANGE_NEEDS_KEY_MESSAGE,
				});
				if (!apiKey) {
					throw new Error("An API key is required to test the connection");
				}
				const result = await testUptimelyConnection({
					apiKey,
					projectId: input.projectId,
					baseUrl: input.baseUrl,
				});
				if (!result.projectFound) {
					throw new Error(
						"The API key cannot access that project id. Check the project id.",
					);
				}
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	remove: withPermission("notification", "delete")
		.input(apiFindOneNotification)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to delete this notification",
					});
				}
				await audit(ctx, {
					action: "delete",
					resourceType: "notification",
					resourceName: notification.name,
				});
				return await removeNotificationById(input.notificationId);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Error deleting this notification";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	one: withPermission("notification", "read")
		.input(apiFindOneNotification)
		.query(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this notification",
				});
			}
			return presentNotification(notification);
		}),
	all: withPermission("notification", "read").query(async ({ ctx }) => {
		const list = await db.query.notifications.findMany({
			with: {
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
			},
			orderBy: desc(notifications.createdAt),
			where: eq(notifications.organizationId, ctx.session.activeOrganizationId),
		});
		return list.map(presentNotification);
	}),
	receiveNotification: publicProcedure
		.input(
			z.object({
				ServerType: z.enum(["Dokploy", "Remote"]).default("Dokploy"),
				Type: z.enum(["Memory", "CPU"]),
				Value: z.number(),
				Threshold: z.number(),
				Message: z.string(),
				Timestamp: z.string(),
				Token: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				let organizationId = "";
				let ServerName = "";
				if (input.ServerType === "Dokploy") {
					const settings = await getWebServerSettings();
					if (
						!settings?.metricsConfig?.server?.token ||
						settings.metricsConfig.server.token !== input.Token
					) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Token not found",
						});
					}

					organizationId = "";
					ServerName = "Dokploy";
				} else {
					const result = await db
						.select()
						.from(server)
						.where(
							sql`${server.metricsConfig}::jsonb -> 'server' ->> 'token' = ${input.Token}`,
						);

					if (!result?.[0]?.organizationId) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Token not found",
						});
					}

					organizationId = result?.[0]?.organizationId;
					ServerName = result?.[0]?.name ?? "Remote";
				}

				await sendServerThresholdNotifications(organizationId, {
					...input,
					ServerName,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error sending the notification",
					cause: error,
				});
			}
		}),
	createGotify: withPermission("notification", "create")
		.input(apiCreateGotify)
		.mutation(async ({ input, ctx }) => {
			try {
				await createGotifyNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateGotify: withPermission("notification", "update")
		.input(apiUpdateGotify)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateGotifyNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testGotifyConnection: withPermission("notification", "create")
		.input(apiTestGotifyConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const appToken = await resolveChannelTestKey({
					apiKey: input.appToken,
					notificationId: input.notificationId,
					baseUrl: input.serverUrl,
					organizationId: ctx.session.activeOrganizationId,
					storedChannel: (notification) =>
						notification.gotify
							? {
									apiKey: notification.gotify.appToken,
									baseUrl: notification.gotify.serverUrl,
								}
							: null,
					urlChangeMessage: GOTIFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
				});
				if (!appToken) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "An app token is required to test the connection",
					});
				}
				await sendGotifyNotification(
					{ ...input, appToken },
					"Test Notification",
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createNtfy: withPermission("notification", "create")
		.input(apiCreateNtfy)
		.mutation(async ({ input, ctx }) => {
			try {
				await createNtfyNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateNtfy: withPermission("notification", "update")
		.input(apiUpdateNtfy)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateNtfyNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testNtfyConnection: withPermission("notification", "create")
		.input(apiTestNtfyConnection)
		.mutation(async ({ input, ctx }) => {
			// Secrets in use (typed or borrowed), to keep out of an error message.
			const secrets: Array<string | undefined> = [
				input.topic,
				input.accessToken,
			];
			try {
				// The topic is write-only: a blank one is the stored topic, which is
				// never sent to a server typed into the form.
				const topic = await resolveChannelTestKey({
					apiKey: input.topic,
					notificationId: input.notificationId,
					baseUrl: input.serverUrl,
					organizationId: ctx.session.activeOrganizationId,
					storedChannel: (notification) =>
						notification.ntfy
							? {
									apiKey: notification.ntfy.topic,
									baseUrl: notification.ntfy.serverUrl,
								}
							: null,
					urlChangeMessage: NTFY_URL_CHANGE_NEEDS_TOPIC_MESSAGE,
				});
				if (!topic) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Topic is required to test the connection",
					});
				}
				secrets.push(topic);
				// The token is optional (public topics): without one, none is sent.
				const accessToken = await resolveChannelTestKey({
					apiKey: input.accessToken,
					notificationId: input.clearAccessToken
						? undefined
						: input.notificationId,
					baseUrl: input.serverUrl,
					organizationId: ctx.session.activeOrganizationId,
					storedChannel: (notification) =>
						notification.ntfy?.accessToken
							? {
									apiKey: notification.ntfy.accessToken,
									baseUrl: notification.ntfy.serverUrl,
								}
							: null,
					urlChangeMessage: NTFY_URL_CHANGE_NEEDS_TOKEN_MESSAGE,
				});
				secrets.push(accessToken);
				await sendNtfyNotification(
					{ ...input, topic, accessToken: accessToken || null },
					"Test Notification",
					"",
					"view, visit Dokploy on Github, https://github.com/dokploy/dokploy, clear=true;",
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? `Error testing the notification: ${redactSecrets(error.message, secrets)}`
							: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createMattermost: withPermission("notification", "create")
		.input(apiCreateMattermost)
		.mutation(async ({ input, ctx }) => {
			try {
				await createMattermostNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateMattermost: withPermission("notification", "update")
		.input(apiUpdateMattermost)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateMattermostNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testMattermostConnection: withPermission("notification", "create")
		.input(apiTestMattermostConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const webhookUrl = await resolveStoredSecret({
					value: input.webhookUrl,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.mattermost?.webhookUrl,
					missing: "A webhook URL",
				});
				await sendMattermostNotification(
					{ webhookUrl, channel: input.channel, username: input.username },
					{
						text: "Hi, From Dokploy 👋",
						channel: input.channel,
						username: input.username || "Dokploy Bot",
					},
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createCustom: withPermission("notification", "create")
		.input(apiCreateCustom)
		.mutation(async ({ input, ctx }) => {
			try {
				await createCustomNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateCustom: withPermission("notification", "update")
		.input(apiUpdateCustom)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateCustomNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testCustomConnection: withPermission("notification", "create")
		.input(apiTestCustomConnection)
		.mutation(async ({ input, ctx }) => {
			// Secrets in use (typed or borrowed), to keep out of an error message.
			const secrets: Array<string | undefined> = [input.endpoint];
			try {
				let endpoint = input.endpoint;
				let headers = input.headers;
				if (input.notificationId && (!endpoint || headers)) {
					const notification = await findOwnNotification(
						input.notificationId,
						ctx.session.activeOrganizationId,
					);
					const stored = notification.custom;
					// A blank endpoint is the stored one.
					endpoint = endpoint || stored?.endpoint;
					if (headers) {
						// Blank header values are the stored ones, which are never sent
						// to an endpoint typed into the form.
						headers = mergeCustomHeaders(
							headers,
							stored?.headers,
							!stored ||
								!endpoint ||
								!isSameIntegrationBaseUrl(endpoint, stored.endpoint),
						);
					}
					secrets.push(
						stored?.endpoint,
						...Object.values(stored?.headers ?? {}),
					);
				}
				if (!endpoint) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Endpoint is required to test the connection",
					});
				}
				await sendCustomNotification(
					{ endpoint, headers },
					{
						title: "Test Notification",
						message: "Hi, From Dokploy 👋",
						timestamp: new Date().toISOString(),
					},
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? redactSecrets(error.message, secrets)
							: "Unknown error",
					cause: error,
				});
			}
		}),
	createLark: withPermission("notification", "create")
		.input(apiCreateLark)
		.mutation(async ({ input, ctx }) => {
			try {
				await createLarkNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateLark: withPermission("notification", "update")
		.input(apiUpdateLark)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateLarkNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testLarkConnection: withPermission("notification", "create")
		.input(apiTestLarkConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const webhookUrl = await resolveStoredSecret({
					value: input.webhookUrl,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.lark?.webhookUrl,
					missing: "A webhook URL",
				});
				await sendLarkNotification(
					{ webhookUrl },
					{
						msg_type: "text",
						content: {
							text: "Hi, From Dokploy 👋",
						},
					},
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createTeams: withPermission("notification", "create")
		.input(apiCreateTeams)
		.mutation(async ({ input, ctx }) => {
			try {
				await createTeamsNotification(input, ctx.session.activeOrganizationId);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateTeams: withPermission("notification", "update")
		.input(apiUpdateTeams)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updateTeamsNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testTeamsConnection: withPermission("notification", "create")
		.input(apiTestTeamsConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const webhookUrl = await resolveStoredSecret({
					value: input.webhookUrl,
					notificationId: input.notificationId,
					organizationId: ctx.session.activeOrganizationId,
					stored: (notification) => notification.teams?.webhookUrl,
					missing: "A webhook URL",
				});
				await sendTeamsNotification(
					{ webhookUrl },
					{
						title: "🤚 Test Notification",
						facts: [{ name: "Message", value: "Hi, From Dokploy 👋" }],
					},
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createPushover: withPermission("notification", "create")
		.input(apiCreatePushover)
		.mutation(async ({ input, ctx }) => {
			try {
				await createPushoverNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updatePushover: withPermission("notification", "update")
		.input(apiUpdatePushover)
		.mutation(async ({ input, ctx }) => {
			try {
				const notification = await findNotificationById(input.notificationId);
				if (notification.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this notification",
					});
				}
				const result = await updatePushoverNotification({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
				await audit(ctx, {
					action: "update",
					resourceType: "notification",
					resourceId: input.notificationId,
					resourceName: notification.name,
				});
				return result;
			} catch (error) {
				throw error;
			}
		}),
	testPushoverConnection: withPermission("notification", "create")
		.input(apiTestPushoverConnection)
		.mutation(async ({ input, ctx }) => {
			try {
				const organizationId = ctx.session.activeOrganizationId;
				const userKey = await resolveStoredSecret({
					value: input.userKey,
					notificationId: input.notificationId,
					organizationId,
					stored: (notification) => notification.pushover?.userKey,
					missing: "A user key",
				});
				const apiToken = await resolveStoredSecret({
					value: input.apiToken,
					notificationId: input.notificationId,
					organizationId,
					stored: (notification) => notification.pushover?.apiToken,
					missing: "An API token",
				});
				await sendPushoverNotification(
					{ ...input, userKey, apiToken },
					"Test Notification",
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	getEmailProviders: withPermission("notification", "read").query(
		async ({ ctx }) => {
			// The invitation dialog only lists the providers by name, so the
			// provider rows (API keys, SMTP password) are never loaded.
			return await db.query.notifications.findMany({
				columns: { notificationId: true, name: true, notificationType: true },
				where: eq(
					notifications.organizationId,
					ctx.session.activeOrganizationId,
				),
			});
		},
	),
});
