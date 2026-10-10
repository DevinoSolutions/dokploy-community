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
	findNotificationById,
	getWebServerSettings,
	IS_CLOUD,
	isSameIntegrationBaseUrl,
	maskApiKey,
	removeNotificationById,
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
	NOTIFLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
	SENDLY_URL_CHANGE_NEEDS_KEY_MESSAGE,
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
	type notifly,
	type sendly,
	type uptimelyChannel,
} from "@/server/db/schema";

/**
 * Client-safe view of a notification: the Sendly, Notifly and Uptimely channel
 * API keys are write-only, so each is replaced by its masked form (like the
 * Uptimely integration key).
 */
type ChannelWithKey = { apiKey: string };

const maskChannelKey = <C extends ChannelWithKey>(channel: C | null) => {
	if (!channel) return null;
	const { apiKey, ...visible } = channel;
	return { ...visible, apiKeyMasked: maskApiKey(apiKey) };
};

const presentNotification = <
	T extends {
		sendly: typeof sendly.$inferSelect | null;
		notifly: typeof notifly.$inferSelect | null;
		uptimelyChannel: typeof uptimelyChannel.$inferSelect | null;
	},
>(
	notification: T,
) => {
	const {
		sendly: sendlyChannel,
		notifly: notiflyChannel,
		uptimelyChannel: channel,
		...rest
	} = notification;
	return {
		...rest,
		sendly: maskChannelKey(sendlyChannel),
		notifly: maskChannelKey(notiflyChannel),
		uptimelyChannel: maskChannelKey(channel),
	};
};

/**
 * Edit flow of the "Test Notification" button: the key field is blank
 * (write-only), so the test uses the stored key of the caller's own
 * notification, never a key sent by the client. The stored key is never
 * replayed against a URL typed into the form.
 */
const resolveChannelTestKey = async (params: {
	apiKey?: string;
	notificationId?: string;
	baseUrl: string;
	organizationId: string;
	storedChannel: (
		notification: Awaited<ReturnType<typeof findNotificationById>>,
	) => { apiKey: string; baseUrl: string } | null;
	urlChangeMessage: string;
}) => {
	if (params.apiKey || !params.notificationId) return params.apiKey;
	const notification = await findNotificationById(params.notificationId);
	if (notification.organizationId !== params.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this notification",
		});
	}
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
				console.log(error);
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
		.mutation(async ({ input }) => {
			try {
				await sendSlackNotification(input, {
					channel: input.channel,
					text: "Hi, From Dokploy 👋",
				});
				return true;
			} catch (error) {
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
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testTelegramConnection: withPermission("notification", "create")
		.input(apiTestTelegramConnection)
		.mutation(async ({ input }) => {
			try {
				await sendTelegramNotification(input, "Hi, From Dokploy 👋");
				return true;
			} catch (error) {
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
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),

	testDiscordConnection: withPermission("notification", "create")
		.input(apiTestDiscordConnection)
		.mutation(async ({ input }) => {
			try {
				const decorate = (decoration: string, text: string) =>
					`${input.decoration ? decoration : ""} ${text}`.trim();

				await sendDiscordNotification(input, {
					title: decorate(">", "`🤚` - Test Notification"),
					description: decorate(">", "Hi, From Dokploy 👋"),
					color: 0xf3f7f4,
				});

				return true;
			} catch (error) {
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
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testEmailConnection: withPermission("notification", "create")
		.input(apiTestEmailConnection)
		.mutation(async ({ input }) => {
			try {
				await sendEmailNotification(
					input,
					"Test Email",
					"<p>Hi, From Dokploy 👋</p>",
				);
				return true;
			} catch (error) {
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
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating the notification",
					cause: error,
				});
			}
		}),
	testResendConnection: withPermission("notification", "create")
		.input(apiTestResendConnection)
		.mutation(async ({ input }) => {
			try {
				await sendResendNotification(
					input,
					"Test Email",
					"<p>Hi, From Dokploy 👋</p>",
				);
				return true;
			} catch (error) {
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
				if (
					IS_CLOUD &&
					notification.organizationId !== ctx.session.activeOrganizationId
				) {
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
		.mutation(async ({ input }) => {
			try {
				await sendGotifyNotification(
					input,
					"Test Notification",
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
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
				if (
					IS_CLOUD &&
					notification.organizationId !== ctx.session.activeOrganizationId
				) {
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
		.mutation(async ({ input }) => {
			try {
				await sendNtfyNotification(
					input,
					"Test Notification",
					"",
					"view, visit Dokploy on Github, https://github.com/dokploy/dokploy, clear=true;",
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? `Error testing the notification: ${error.message}`
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
				if (
					IS_CLOUD &&
					notification.organizationId !== ctx.session.activeOrganizationId
				) {
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
		.mutation(async ({ input }) => {
			try {
				await sendMattermostNotification(input, {
					text: "Hi, From Dokploy 👋",
					channel: input.channel,
					username: input.username || "Dokploy Bot",
				});
				return true;
			} catch (error) {
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
		.mutation(async ({ input }) => {
			try {
				await sendCustomNotification(input, {
					title: "Test Notification",
					message: "Hi, From Dokploy 👋",
					timestamp: new Date().toISOString(),
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
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
				if (
					IS_CLOUD &&
					notification.organizationId !== ctx.session.activeOrganizationId
				) {
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
		.mutation(async ({ input }) => {
			try {
				await sendLarkNotification(input, {
					msg_type: "text",
					content: {
						text: "Hi, From Dokploy 👋",
					},
				});
				return true;
			} catch (error) {
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
				if (
					IS_CLOUD &&
					notification.organizationId !== ctx.session.activeOrganizationId
				) {
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
		.mutation(async ({ input }) => {
			try {
				await sendTeamsNotification(input, {
					title: "🤚 Test Notification",
					facts: [{ name: "Message", value: "Hi, From Dokploy 👋" }],
				});
				return true;
			} catch (error) {
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
				if (
					IS_CLOUD &&
					notification.organizationId !== ctx.session.activeOrganizationId
				) {
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
		.mutation(async ({ input }) => {
			try {
				await sendPushoverNotification(
					input,
					"Test Notification",
					"Hi, From Dokploy 👋",
				);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	getEmailProviders: withPermission("notification", "read").query(
		async ({ ctx }) => {
			return await db.query.notifications.findMany({
				where: eq(
					notifications.organizationId,
					ctx.session.activeOrganizationId,
				),
				with: {
					email: true,
					resend: true,
					sendly: true,
				},
			});
		},
	),
});
