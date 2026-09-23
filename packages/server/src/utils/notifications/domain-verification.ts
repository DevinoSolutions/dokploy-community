import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import BuildFailedEmail from "@dokploy/server/emails/emails/build-failed";
import { render } from "@react-email/components";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import {
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
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "./utils";

interface Props {
	organizationId: string;
	projectName: string;
	serviceName: string;
	host: string;
	/** Human-readable reason (e.g. "DNS records drifted"). */
	reason: string;
	/** Link to the service's Domains tab. */
	domainLink: string;
}

const TITLE = "Domain DNS verification failed";

/**
 * Fans a DoDomain verification failure (`connection.failed` /
 * `connection.disconnected`) out to every notification provider of the
 * organization. Delivered to the channels subscribed to deploy failures
 * (`appBuildError`): a custom domain whose DNS broke takes the service offline
 * for its users the same way a failed deploy does, and a dedicated toggle
 * would need a column on the upstream-owned `notification` table.
 */
export const sendDomainVerificationFailedNotifications = async ({
	organizationId,
	projectName,
	serviceName,
	host,
	reason,
	domainLink,
}: Props) => {
	const date = new Date();
	const unixDate = ~~(Number(date) / 1000);
	const notificationList = await db.query.notifications.findMany({
		where: and(
			eq(notifications.appBuildError, true),
			eq(notifications.organizationId, organizationId),
		),
		with: {
			email: true,
			discord: true,
			telegram: true,
			slack: true,
			resend: true,
			sendly: true,
			notifly: true,
			gotify: true,
			ntfy: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});

	for (const notification of notificationList) {
		const {
			email,
			resend,
			sendly,
			notifly,
			discord,
			telegram,
			slack,
			gotify,
			ntfy,
			mattermost,
			custom,
			lark,
			pushover,
			teams,
		} = notification;
		try {
			if (email || resend || sendly) {
				const template = await render(
					BuildFailedEmail({
						projectName,
						applicationName: `${serviceName} (${host})`,
						applicationType: "Domain DNS verification",
						errorMessage: reason,
						buildLink: domainLink,
						date: date.toLocaleString(),
					}),
				).catch();

				if (email) {
					await sendEmailNotification(email, `${TITLE}: ${host}`, template);
				}
				if (resend) {
					await sendResendNotification(resend, `${TITLE}: ${host}`, template);
				}
				if (sendly) {
					await sendSendlyNotification(sendly, `${TITLE}: ${host}`, template);
				}
			}

			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();
				await sendDiscordNotification(discord, {
					title: decorate(">", "`🌐` Domain DNS Verification Failed"),
					color: 0xed4245,
					fields: [
						{
							name: decorate("`🛠️`", "Project"),
							value: projectName,
							inline: true,
						},
						{
							name: decorate("`⚙️`", "Service"),
							value: serviceName,
							inline: true,
						},
						{
							name: decorate("`🌐`", "Domain"),
							value: host,
							inline: true,
						},
						{
							name: decorate("`📅`", "Date"),
							value: `<t:${unixDate}:D>`,
							inline: true,
						},
						{
							name: decorate("`⌚`", "Time"),
							value: `<t:${unixDate}:t>`,
							inline: true,
						},
						{
							name: decorate("`⚠️`", "Reason"),
							value: `\`\`\`${reason.substring(0, 800)}\`\`\``,
						},
						{
							name: decorate("`🧷`", "Domains"),
							value: `[Open the domain settings](${domainLink})`,
						},
					],
					timestamp: date.toISOString(),
					footer: {
						text: "Dokploy Domain Notification",
					},
				});
			}

			if (gotify) {
				const decorate = (decoration: string, text: string) =>
					`${gotify.decoration ? decoration : ""} ${text}\n`;
				await sendGotifyNotification(
					gotify,
					decorate("🌐", "Domain DNS Verification Failed"),
					`${decorate("🛠️", `Project: ${projectName}`)}` +
						`${decorate("⚙️", `Service: ${serviceName}`)}` +
						`${decorate("🌐", `Domain: ${host}`)}` +
						`${decorate("🕒", `Date: ${date.toLocaleString()}`)}` +
						`${decorate("⚠️", `Reason:\n${reason}`)}` +
						`${decorate("🔗", `Domains:\n${domainLink}`)}`,
				);
			}

			if (ntfy) {
				await sendNtfyNotification(
					ntfy,
					"Domain DNS Verification Failed",
					"warning",
					`view, Domains, ${domainLink}, clear=true;`,
					`🛠️Project: ${projectName}\n` +
						`⚙️Service: ${serviceName}\n` +
						`🌐Domain: ${host}\n` +
						`🕒Date: ${date.toLocaleString()}\n` +
						`⚠️Reason:\n${reason}`,
				);
			}

			if (telegram) {
				await sendTelegramNotification(
					telegram,
					`<b>🌐 Domain DNS Verification Failed</b>\n\n<b>Project:</b> ${projectName}\n<b>Service:</b> ${serviceName}\n<b>Domain:</b> ${host}\n<b>Date:</b> ${format(date, "PP")}\n<b>Time:</b> ${format(date, "pp")}\n\n<b>Reason:</b>\n<pre>${reason}</pre>`,
					[[{ text: "Open domains", url: domainLink }]],
				);
			}

			if (slack) {
				await sendSlackNotification(slack, {
					channel: slack.channel,
					attachments: [
						{
							color: "#FF0000",
							pretext:
								":globe_with_meridians: *Domain DNS Verification Failed*",
							fields: [
								{ title: "Project", value: projectName, short: true },
								{ title: "Service", value: serviceName, short: true },
								{ title: "Domain", value: host, short: true },
								{ title: "Time", value: date.toLocaleString(), short: true },
								{
									title: "Reason",
									value: `\`\`\`${reason}\`\`\``,
									short: false,
								},
								{
									title: "Details",
									value: `<${domainLink}|Open the domain settings>`,
									short: false,
								},
							],
							mrkdwn_in: ["fields"],
						},
					],
				});
			}

			if (mattermost) {
				await sendMattermostNotification(mattermost, {
					text: `:globe_with_meridians: **Domain DNS Verification Failed**

**Project:** ${projectName}
**Service:** ${serviceName}
**Domain:** ${host}
**Time:** ${date.toLocaleString()}

**Reason:**
\`\`\`
${reason}
\`\`\`

[Open the domain settings](${domainLink})`,
					channel: mattermost.channel,
					username: mattermost.username || "Dokploy Bot",
				});
			}

			if (custom) {
				await sendCustomNotification(custom, {
					title: "Domain DNS Verification Failed",
					message: `DNS verification failed for ${host}`,
					projectName,
					serviceName,
					host,
					reason,
					domainLink,
					timestamp: date.toISOString(),
					date: date.toLocaleString(),
					status: "error",
					type: "domain-verification",
				});
			}

			if (notifly) {
				await sendNotiflyNotification(notifly, {
					event: "domain.verification_failed",
					projectName,
					applicationName: serviceName,
					host,
					status: "error",
					link: domainLink,
					timestamp: date.toISOString(),
					message: `DNS verification failed for ${host}: ${reason}`,
				});
			}

			if (lark) {
				await sendLarkNotification(lark, {
					msg_type: "interactive",
					card: {
						schema: "2.0",
						header: {
							title: {
								tag: "plain_text",
								content: "🌐 Domain DNS Verification Failed",
							},
							template: "red",
						},
						body: {
							direction: "vertical",
							elements: [
								{
									tag: "markdown",
									content: `**Project:** ${projectName}\n**Service:** ${serviceName}\n**Domain:** ${host}\n**Date:** ${format(date, "PP pp")}\n\n**Reason:**\n\`\`\`\n${reason.substring(0, 800)}\n\`\`\``,
								},
								{
									tag: "button",
									text: { tag: "plain_text", content: "Open domains" },
									type: "danger",
									behaviors: [{ type: "open_url", default_url: domainLink }],
								},
							],
						},
					},
				});
			}

			if (pushover) {
				await sendPushoverNotification(
					pushover,
					"Domain DNS Verification Failed",
					`Project: ${projectName}\nService: ${serviceName}\nDomain: ${host}\nDate: ${date.toLocaleString()}\nReason: ${reason}`,
				);
			}

			if (teams) {
				await sendTeamsNotification(teams, {
					title: "🌐 Domain DNS Verification Failed",
					facts: [
						{ name: "Project", value: projectName },
						{ name: "Service", value: serviceName },
						{ name: "Domain", value: host },
						{ name: "Date", value: format(date, "PP pp") },
						{ name: "Reason", value: reason.substring(0, 800) },
					],
					potentialAction: {
						type: "Action.OpenUrl",
						title: "Open domains",
						url: domainLink,
					},
				});
			}
		} catch (error) {
			console.log(error);
		}
	}
};
