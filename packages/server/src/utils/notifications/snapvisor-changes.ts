import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import SnapvisorChangesEmail from "@dokploy/server/emails/emails/snapvisor-changes";
import { render } from "@react-email/components";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { logSenderError } from "./log-error";
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
	escapeHtml,
	sendTelegramNotification,
} from "./utils";

interface Props {
	organizationId: string;
	/** The Dokploy project. */
	projectName: string;
	serviceName: string;
	serviceType: string;
	environmentName: string;
	branch: string;
	commitSha: string;
	/** The linked Snapvisor project. */
	snapvisorProjectName: string;
	changedSnapshots: number | null;
	addedSnapshots: number | null;
	removedSnapshots: number | null;
	reviewUrl: string;
}

/**
 * "12 changed, 2 added, 1 removed": the snapshot counts Snapvisor reported,
 * leaving out the ones that are zero or unknown. `null` when it reported
 * nothing to count.
 */
export const describeSnapvisorSnapshots = ({
	changed,
	added,
	removed,
}: {
	changed: number | null;
	added: number | null;
	removed: number | null;
}) => {
	const parts = [
		changed ? `${changed} changed` : null,
		added ? `${added} added` : null,
		removed ? `${removed} removed` : null,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : null;
};

export const sendSnapvisorChangesNotifications = async ({
	organizationId,
	projectName,
	serviceName,
	serviceType,
	environmentName,
	branch,
	commitSha,
	snapvisorProjectName,
	changedSnapshots,
	addedSnapshots,
	removedSnapshots,
	reviewUrl,
}: Props) => {
	const date = new Date();
	const unixDate = ~~(Number(date) / 1000);
	const commit = commitSha.slice(0, 7);
	const snapshotSummary = describeSnapvisorSnapshots({
		changed: changedSnapshots,
		added: addedSnapshots,
		removed: removedSnapshots,
	});
	const notificationList = await db.query.notifications.findMany({
		where: and(
			eq(notifications.snapvisorChanges, true),
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
					SnapvisorChangesEmail({
						projectName,
						serviceName,
						environmentName,
						branch,
						commit,
						snapshotSummary,
						reviewUrl,
						date: date.toLocaleString(),
					}),
				).catch();

				if (email) {
					await sendEmailNotification(
						email,
						"Snapvisor visual changes to review",
						template,
					);
				}

				if (resend) {
					await sendResendNotification(
						resend,
						"Snapvisor visual changes to review",
						template,
					);
				}

				if (sendly) {
					await sendSendlyNotification(
						sendly,
						"Snapvisor visual changes to review",
						template,
					);
				}
			}

			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();

				await sendDiscordNotification(discord, {
					title: decorate(">", "`🖼️` Visual Changes Detected"),
					color: 0xfee75c,
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
							name: decorate("`🌍`", "Environment"),
							value: environmentName,
							inline: true,
						},
						{
							name: decorate("`🌿`", "Branch"),
							value: branch,
							inline: true,
						},
						{
							name: decorate("`🔖`", "Commit"),
							value: commit,
							inline: true,
						},
						...(snapshotSummary
							? [
									{
										name: decorate("`🖼️`", "Snapshots"),
										value: snapshotSummary,
										inline: true,
									},
								]
							: []),
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
							name: decorate("`🧷`", "Review Link"),
							value: `[Review in Snapvisor](${reviewUrl})`,
						},
					],
					timestamp: date.toISOString(),
					footer: {
						text: "Dokploy Snapvisor Notification",
					},
				});
			}

			if (gotify) {
				const decorate = (decoration: string, text: string) =>
					`${gotify.decoration ? decoration : ""} ${text}\n`;
				await sendGotifyNotification(
					gotify,
					decorate("🖼️", "Visual Changes Detected"),
					`${decorate("🛠️", `Project: ${projectName}`)}` +
						`${decorate("⚙️", `Service: ${serviceName}`)}` +
						`${decorate("🌍", `Environment: ${environmentName}`)}` +
						`${decorate("🌿", `Branch: ${branch}`)}` +
						`${decorate("🔖", `Commit: ${commit}`)}` +
						(snapshotSummary
							? `${decorate("🖼️", `Snapshots: ${snapshotSummary}`)}`
							: "") +
						`${decorate("🕒", `Date: ${date.toLocaleString()}`)}` +
						`${decorate("🔗", `Review in Snapvisor:\n${reviewUrl}`)}`,
				);
			}

			if (ntfy) {
				await sendNtfyNotification(
					ntfy,
					"Visual Changes Detected",
					"framed_picture",
					`view, Review in Snapvisor, ${reviewUrl}, clear=true;`,
					`🛠Project: ${projectName}\n` +
						`⚙️Service: ${serviceName}\n` +
						`🌍Environment: ${environmentName}\n` +
						`🌿Branch: ${branch}\n` +
						`🔖Commit: ${commit}\n` +
						(snapshotSummary ? `🖼Snapshots: ${snapshotSummary}\n` : "") +
						`🕒Date: ${date.toLocaleString()}`,
				);
			}

			if (telegram) {
				await sendTelegramNotification(
					telegram,
					`<b>🖼️ Visual Changes Detected</b>\n\n<b>Project:</b> ${escapeHtml(projectName)}\n<b>Service:</b> ${escapeHtml(serviceName)}\n<b>Environment:</b> ${escapeHtml(environmentName)}\n<b>Branch:</b> ${escapeHtml(branch)}\n<b>Commit:</b> ${escapeHtml(commit)}\n${
						snapshotSummary
							? `<b>Snapshots:</b> ${escapeHtml(snapshotSummary)}\n`
							: ""
					}<b>Date:</b> ${format(date, "PP")}\n<b>Time:</b> ${format(date, "pp")}`,
					[[{ text: "Review in Snapvisor", url: reviewUrl }]],
				);
			}

			if (slack) {
				const { channel } = slack;
				await sendSlackNotification(slack, {
					channel: channel,
					attachments: [
						{
							color: "#FEE75C",
							pretext: ":frame_with_picture: *Visual Changes Detected*",
							fields: [
								{
									title: "Project",
									value: projectName,
									short: true,
								},
								{
									title: "Service",
									value: serviceName,
									short: true,
								},
								{
									title: "Environment",
									value: environmentName,
									short: true,
								},
								{
									title: "Branch",
									value: branch,
									short: true,
								},
								{
									title: "Commit",
									value: commit,
									short: true,
								},
								...(snapshotSummary
									? [
											{
												title: "Snapshots",
												value: snapshotSummary,
												short: true,
											},
										]
									: []),
								{
									title: "Time",
									value: date.toLocaleString(),
									short: true,
								},
								{
									title: "Details",
									value: `<${reviewUrl}|Review in Snapvisor>`,
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
					text: `**🖼️ Visual Changes Detected**\n\n**Project:** ${projectName}\n**Service:** ${serviceName}\n**Environment:** ${environmentName}\n**Branch:** ${branch}\n**Commit:** ${commit}\n${
						snapshotSummary ? `**Snapshots:** ${snapshotSummary}\n` : ""
					}**Date:** ${format(date, "PP")}\n**Time:** ${format(date, "pp")}\n\n[Review in Snapvisor](${reviewUrl})`,
					channel: mattermost.channel,
					username: mattermost.username || "Dokploy",
				});
			}

			if (custom) {
				await sendCustomNotification(custom, {
					title: "Snapvisor Visual Changes",
					message: "Snapvisor found visual changes to review",
					projectName,
					applicationName: serviceName,
					applicationType: serviceType,
					environmentName,
					branch,
					commit: commitSha,
					snapvisorProject: snapvisorProjectName,
					changedSnapshots,
					addedSnapshots,
					removedSnapshots,
					reviewUrl,
					timestamp: date.toISOString(),
					date: date.toLocaleString(),
					status: "changes-detected",
					type: "snapvisor",
				});
			}

			if (notifly) {
				await sendNotiflyNotification(notifly, {
					event: "snapvisor.changes",
					projectName,
					applicationName: serviceName,
					environmentName,
					branch,
					commit: commitSha,
					changedSnapshots,
					status: "changes-detected",
					link: reviewUrl,
					timestamp: date.toISOString(),
					message: `Snapvisor found visual changes for ${serviceName}`,
				});
			}

			if (lark) {
				await sendLarkNotification(lark, {
					msg_type: "interactive",
					card: {
						schema: "2.0",
						config: {
							update_multi: true,
							style: {
								text_size: {
									normal_v2: {
										default: "normal",
										pc: "normal",
										mobile: "heading",
									},
								},
							},
						},
						header: {
							title: {
								tag: "plain_text",
								content: "🖼️ Visual Changes Detected",
							},
							subtitle: {
								tag: "plain_text",
								content: "",
							},
							template: "yellow",
							padding: "12px 12px 12px 12px",
						},
						body: {
							direction: "vertical",
							padding: "12px 12px 12px 12px",
							elements: [
								{
									tag: "column_set",
									columns: [
										{
											tag: "column",
											width: "weighted",
											elements: [
												{
													tag: "markdown",
													content: `**Project:**\n${projectName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Environment:**\n${environmentName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Commit:**\n${commit}`,
													text_align: "left",
													text_size: "normal_v2",
												},
											],
											vertical_align: "top",
											weight: 1,
										},
										{
											tag: "column",
											width: "weighted",
											elements: [
												{
													tag: "markdown",
													content: `**Service:**\n${serviceName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Branch:**\n${branch}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												...(snapshotSummary
													? [
															{
																tag: "markdown",
																content: `**Snapshots:**\n${snapshotSummary}`,
																text_align: "left",
																text_size: "normal_v2",
															},
														]
													: []),
											],
											vertical_align: "top",
											weight: 1,
										},
									],
								},
								{
									tag: "button",
									text: {
										tag: "plain_text",
										content: "Review in Snapvisor",
									},
									type: "primary",
									width: "default",
									size: "medium",
									behaviors: [
										{
											type: "open_url",
											default_url: reviewUrl,
											pc_url: "",
											ios_url: "",
											android_url: "",
										},
									],
									margin: "0px 0px 0px 0px",
								},
							],
						},
					},
				});
			}

			if (pushover) {
				await sendPushoverNotification(
					pushover,
					"Visual Changes Detected",
					`Project: ${projectName}\nService: ${serviceName}\nEnvironment: ${environmentName}\nBranch: ${branch}\nCommit: ${commit}\n${
						snapshotSummary ? `Snapshots: ${snapshotSummary}\n` : ""
					}Review: ${reviewUrl}`,
				);
			}

			if (teams) {
				await sendTeamsNotification(teams, {
					title: "🖼️ Visual Changes Detected",
					facts: [
						{ name: "Project", value: projectName },
						{ name: "Service", value: serviceName },
						{ name: "Environment", value: environmentName },
						{ name: "Branch", value: branch },
						{ name: "Commit", value: commit },
						...(snapshotSummary
							? [{ name: "Snapshots", value: snapshotSummary }]
							: []),
						{ name: "Date", value: format(date, "PP pp") },
					],
					potentialAction: {
						type: "Action.OpenUrl",
						title: "Review in Snapvisor",
						url: reviewUrl,
					},
				});
			}
		} catch (error) {
			logSenderError("snapvisor changes", error);
		}
	}
};
