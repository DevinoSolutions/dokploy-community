import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	AlertTriangle,
	Mail,
	PenBoxIcon,
	PlusIcon,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	DiscordIcon,
	GotifyIcon,
	LarkIcon,
	MattermostIcon,
	NotiflyIcon,
	NtfyIcon,
	PushoverIcon,
	ResendIcon,
	SendlyIcon,
	SlackIcon,
	TeamsIcon,
	TelegramIcon,
	UptimelyIcon,
} from "@/components/icons/notification-icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";
import { DevinoProviderIntro } from "./devino-provider-intro";

const notificationBaseSchema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	appDeploy: z.boolean().default(false),
	appBuildError: z.boolean().default(false),
	databaseBackup: z.boolean().default(false),
	dokployBackup: z.boolean().default(false),
	volumeBackup: z.boolean().default(false),
	dokployRestart: z.boolean().default(false),
	dockerCleanup: z.boolean().default(false),
	serverThreshold: z.boolean().default(false),
	scheduleFailure: z.boolean().default(false),
});

export const notificationSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("slack"),
			// Required on create; blank keeps the stored webhook when editing.
			webhookUrl: z.string().optional(),
			channel: z.string(),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("telegram"),
			// Required on create; blank keeps the stored token when editing.
			botToken: z.string().optional(),
			chatId: z.string().min(1, { message: "Chat ID is required" }),
			messageThreadId: z.string().optional(),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("discord"),
			// Required on create; blank keeps the stored webhook when editing.
			webhookUrl: z.string().optional(),
			decoration: z.boolean().default(true),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("email"),
			smtpServer: z.string().min(1, { message: "SMTP Server is required" }),
			smtpPort: z.number().min(1, { message: "SMTP Port is required" }),
			username: z.string().optional(),
			password: z.string().optional(),
			fromAddress: z.string().min(1, { message: "From Address is required" }),
			toAddresses: z
				.array(
					z.string().min(1, { message: "Email is required" }).email({
						message: "Email is invalid",
					}),
				)
				.min(1, { message: "At least one email is required" }),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("resend"),
			// Required on create; blank keeps the stored key when editing.
			apiKey: z.string().optional(),
			fromAddress: z
				.string()
				.min(1, { message: "From Address is required" })
				.email({ message: "Email is invalid" }),
			toAddresses: z
				.array(
					z.string().min(1, { message: "Email is required" }).email({
						message: "Email is invalid",
					}),
				)
				.min(1, { message: "At least one email is required" }),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("sendly"),
			// Required on create; blank keeps the stored key when editing.
			apiKey: z.string().optional(),
			fromAddress: z
				.string()
				.min(1, { message: "From Address is required" })
				.email({ message: "Email is invalid" }),
			toAddresses: z
				.array(
					z.string().min(1, { message: "Email is required" }).email({
						message: "Email is invalid",
					}),
				)
				.min(1, { message: "At least one email is required" }),
			baseUrl: z.string().min(1, { message: "Base URL is required" }),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("notifly"),
			// Required on create; blank keeps the stored key when editing.
			apiKey: z.string().optional(),
			workflowKey: z.string().min(1, { message: "Workflow Key is required" }),
			subscriberId: z.string().optional(),
			baseUrl: z.string().min(1, { message: "Base URL is required" }),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("uptimely"),
			// Required on create; blank keeps the stored key when editing.
			apiKey: z.string().optional(),
			projectId: z
				.string()
				.trim()
				.uuid({ message: "The Uptimely project id is a UUID" }),
			baseUrl: z.string().min(1, { message: "Base URL is required" }),
			resolvedStateId: z
				.string()
				.trim()
				.uuid({ message: "The incident state id is a UUID" })
				.or(z.literal(""))
				.optional(),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("gotify"),
			serverUrl: z.string().min(1, { message: "Server URL is required" }),
			// Required on create; blank keeps the stored token when editing.
			appToken: z.string().optional(),
			priority: z.number().min(1).max(10).default(5),
			decoration: z.boolean().default(true),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("ntfy"),
			serverUrl: z.string().min(1, { message: "Server URL is required" }),
			topic: z.string().min(1, { message: "Topic is required" }),
			accessToken: z.string().optional(),
			clearAccessToken: z.boolean().optional(),
			priority: z.number().min(1).max(5).default(3),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("mattermost"),
			// Required on create; blank keeps the stored webhook when editing.
			webhookUrl: z.string().optional(),
			channel: z.string().optional(),
			username: z.string().optional(),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("pushover"),
			// Required on create; blank keeps the stored keys when editing.
			userKey: z.string().optional(),
			apiToken: z.string().optional(),
			priority: z.number().min(-2).max(2).default(0),
			retry: z.number().min(30).nullish(),
			expire: z.number().min(1).max(10800).nullish(),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("custom"),
			endpoint: z.string().min(1, { message: "Endpoint URL is required" }),
			headers: z
				.array(
					z.object({
						key: z.string(),
						value: z.string(),
					}),
				)
				.optional()
				.default([]),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("lark"),
			// Required on create; blank keeps the stored webhook when editing.
			webhookUrl: z.string().optional(),
		})
		.merge(notificationBaseSchema),
	z
		.object({
			type: z.literal("teams"),
			// Required on create; blank keeps the stored webhook when editing.
			webhookUrl: z.string().optional(),
		})
		.merge(notificationBaseSchema),
]);

export const notificationsMap = {
	slack: {
		icon: <SlackIcon />,
		label: "Slack",
	},
	telegram: {
		icon: <TelegramIcon />,
		label: "Telegram",
	},
	discord: {
		icon: <DiscordIcon />,
		label: "Discord",
	},
	lark: {
		icon: <LarkIcon className="text-muted-foreground" />,
		label: "Lark",
	},
	teams: {
		icon: <TeamsIcon className="text-muted-foreground" />,
		label: "Microsoft Teams",
	},
	email: {
		icon: <Mail size={29} className="text-muted-foreground" />,
		label: "Email",
	},
	resend: {
		icon: <ResendIcon className="text-muted-foreground" />,
		label: "Resend",
	},
	sendly: {
		icon: <SendlyIcon />,
		label: "Sendly",
	},
	notifly: {
		icon: <NotiflyIcon />,
		label: "Notifly",
	},
	uptimely: {
		icon: <UptimelyIcon />,
		label: "Uptimely",
	},
	gotify: {
		icon: <GotifyIcon />,
		label: "Gotify",
	},
	ntfy: {
		icon: <NtfyIcon />,
		label: "ntfy",
	},
	mattermost: {
		icon: <MattermostIcon />,
		label: "Mattermost",
	},
	pushover: {
		icon: <PushoverIcon />,
		label: "Pushover",
	},
	custom: {
		icon: <PenBoxIcon size={29} className="text-muted-foreground" />,
		label: "Custom",
	},
};

export type NotificationSchema = z.infer<typeof notificationSchema>;

/** Secrets are write-only: the field shows the masked stored value. */
const keepBlankPlaceholder = (
	masked: string | null | undefined,
	fallback: string,
) => (masked ? `${masked} (leave blank to keep)` : fallback);

const headerValuePlaceholder = (
	masked: Record<string, string> | undefined,
	name: unknown,
) =>
	keepBlankPlaceholder(
		typeof name === "string" && masked ? masked[name] : undefined,
		"Value",
	);

interface Props {
	notificationId?: string;
}

export const HandleNotifications = ({ notificationId }: Props) => {
	const utils = api.useUtils();
	const [visible, setVisible] = useState(false);
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const { data: notification } = api.notification.one.useQuery(
		{
			notificationId: notificationId || "",
		},
		{
			enabled: !!notificationId,
		},
	);
	const { mutateAsync: testSlackConnection, isPending: isLoadingSlack } =
		api.notification.testSlackConnection.useMutation();
	const { mutateAsync: testTelegramConnection, isPending: isLoadingTelegram } =
		api.notification.testTelegramConnection.useMutation();
	const { mutateAsync: testDiscordConnection, isPending: isLoadingDiscord } =
		api.notification.testDiscordConnection.useMutation();
	const { mutateAsync: testEmailConnection, isPending: isLoadingEmail } =
		api.notification.testEmailConnection.useMutation();
	const { mutateAsync: testResendConnection, isPending: isLoadingResend } =
		api.notification.testResendConnection.useMutation();
	const { mutateAsync: testSendlyConnection, isPending: isLoadingSendly } =
		api.notification.testSendlyConnection.useMutation();
	const { mutateAsync: testNotiflyConnection, isPending: isLoadingNotifly } =
		api.notification.testNotiflyConnection.useMutation();
	const { mutateAsync: testUptimelyConnection, isPending: isLoadingUptimely } =
		api.notification.testUptimelyConnection.useMutation();
	const { mutateAsync: testGotifyConnection, isPending: isLoadingGotify } =
		api.notification.testGotifyConnection.useMutation();
	const { mutateAsync: testNtfyConnection, isPending: isLoadingNtfy } =
		api.notification.testNtfyConnection.useMutation();
	const {
		mutateAsync: testMattermostConnection,
		isPending: isLoadingMattermost,
	} = api.notification.testMattermostConnection.useMutation();
	const { mutateAsync: testLarkConnection, isPending: isLoadingLark } =
		api.notification.testLarkConnection.useMutation();
	const { mutateAsync: testTeamsConnection, isPending: isLoadingTeams } =
		api.notification.testTeamsConnection.useMutation();
	const { mutateAsync: testCustomConnection, isPending: isLoadingCustom } =
		api.notification.testCustomConnection.useMutation();
	const { mutateAsync: testPushoverConnection, isPending: isLoadingPushover } =
		api.notification.testPushoverConnection.useMutation();

	const customMutation = notificationId
		? api.notification.updateCustom.useMutation()
		: api.notification.createCustom.useMutation();
	const slackMutation = notificationId
		? api.notification.updateSlack.useMutation()
		: api.notification.createSlack.useMutation();
	const telegramMutation = notificationId
		? api.notification.updateTelegram.useMutation()
		: api.notification.createTelegram.useMutation();
	const discordMutation = notificationId
		? api.notification.updateDiscord.useMutation()
		: api.notification.createDiscord.useMutation();
	const emailMutation = notificationId
		? api.notification.updateEmail.useMutation()
		: api.notification.createEmail.useMutation();
	const resendMutation = notificationId
		? api.notification.updateResend.useMutation()
		: api.notification.createResend.useMutation();
	const sendlyMutation = notificationId
		? api.notification.updateSendly.useMutation()
		: api.notification.createSendly.useMutation();
	const notiflyMutation = notificationId
		? api.notification.updateNotifly.useMutation()
		: api.notification.createNotifly.useMutation();
	const uptimelyMutation = notificationId
		? api.notification.updateUptimely.useMutation()
		: api.notification.createUptimely.useMutation();
	const gotifyMutation = notificationId
		? api.notification.updateGotify.useMutation()
		: api.notification.createGotify.useMutation();
	const ntfyMutation = notificationId
		? api.notification.updateNtfy.useMutation()
		: api.notification.createNtfy.useMutation();
	const mattermostMutation = notificationId
		? api.notification.updateMattermost.useMutation()
		: api.notification.createMattermost.useMutation();
	const larkMutation = notificationId
		? api.notification.updateLark.useMutation()
		: api.notification.createLark.useMutation();
	const teamsMutation = notificationId
		? api.notification.updateTeams.useMutation()
		: api.notification.createTeams.useMutation();
	const pushoverMutation = notificationId
		? api.notification.updatePushover.useMutation()
		: api.notification.createPushover.useMutation();

	const form = useForm({
		defaultValues: {
			type: "slack",
			webhookUrl: "",
			channel: "",
			name: "",
		},
		resolver: zodResolver(notificationSchema),
	});
	const type = form.watch("type");

	// Secrets are write-only: required to create, blank keeps the stored one
	// when editing.
	const requireOnCreate = (
		field: string,
		value: string | undefined,
		message: string,
	) => {
		if (notificationId || value?.trim()) return true;
		form.setError(field as never, { message });
		return false;
	};

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "toAddresses" as never,
	});

	const {
		fields: headerFields,
		append: appendHeader,
		remove: removeHeader,
	} = useFieldArray({
		control: form.control,
		name: "headers" as never,
	});

	useEffect(() => {
		if (
			(type === "email" || type === "resend" || type === "sendly") &&
			fields.length === 0
		) {
			append("");
		}
	}, [type, append, fields.length]);

	useEffect(() => {
		if (notification) {
			if (notification.notificationType === "slack") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					dockerCleanup: notification.dockerCleanup,
					webhookUrl: "",
					channel: notification.slack?.channel || "",
					name: notification.name,
					type: notification.notificationType,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "telegram") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					botToken: "",
					messageThreadId: notification.telegram?.messageThreadId || "",
					chatId: notification.telegram?.chatId,
					type: notification.notificationType,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "discord") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					webhookUrl: "",
					decoration: notification.discord?.decoration ?? undefined,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "email") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					smtpServer: notification.email?.smtpServer,
					smtpPort: notification.email?.smtpPort,
					username: notification.email?.username ?? undefined,
					password: "",
					toAddresses: notification.email?.toAddresses,
					fromAddress: notification.email?.fromAddress,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "resend") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					apiKey: "",
					toAddresses: notification.resend?.toAddresses,
					fromAddress: notification.resend?.fromAddress,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "sendly") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					apiKey: "",
					toAddresses: notification.sendly?.toAddresses,
					fromAddress: notification.sendly?.fromAddress,
					baseUrl: notification.sendly?.baseUrl,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "notifly") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					apiKey: "",
					workflowKey: notification.notifly?.workflowKey,
					subscriberId: notification.notifly?.subscriberId || "",
					baseUrl: notification.notifly?.baseUrl,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "uptimely") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					apiKey: "",
					projectId: notification.uptimelyChannel?.projectId,
					baseUrl: notification.uptimelyChannel?.baseUrl,
					resolvedStateId: notification.uptimelyChannel?.resolvedStateId || "",
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "gotify") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					appToken: "",
					decoration: notification.gotify?.decoration ?? undefined,
					priority: notification.gotify?.priority,
					serverUrl: notification.gotify?.serverUrl,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "ntfy") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					accessToken: "",
					clearAccessToken: false,
					topic: notification.ntfy?.topic,
					priority: notification.ntfy?.priority,
					serverUrl: notification.ntfy?.serverUrl,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "mattermost") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					webhookUrl: "",
					channel: notification.mattermost?.channel || "",
					username: notification.mattermost?.username || "",
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "lark") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					type: notification.notificationType,
					webhookUrl: "",
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					volumeBackup: notification.volumeBackup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "teams") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					webhookUrl: "",
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "custom") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					type: notification.notificationType,
					endpoint: notification.custom?.endpoint || "",
					// Header values are write-only: the names come back, the values stay blank.
					headers: Object.keys(notification.custom?.headersMasked ?? {}).map(
						(key) => ({ key, value: "" }),
					),
					name: notification.name,
					volumeBackup: notification.volumeBackup,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			} else if (notification.notificationType === "pushover") {
				form.reset({
					appBuildError: notification.appBuildError,
					appDeploy: notification.appDeploy,
					dokployRestart: notification.dokployRestart,
					databaseBackup: notification.databaseBackup,
					dokployBackup: notification.dokployBackup,
					volumeBackup: notification.volumeBackup,
					type: notification.notificationType,
					userKey: "",
					apiToken: "",
					priority: notification.pushover?.priority,
					retry: notification.pushover?.retry ?? undefined,
					expire: notification.pushover?.expire ?? undefined,
					name: notification.name,
					dockerCleanup: notification.dockerCleanup,
					serverThreshold: notification.serverThreshold,
					scheduleFailure: notification.scheduleFailure,
				});
			}
		} else {
			form.reset();
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, notification]);

	const activeMutation = {
		slack: slackMutation,
		telegram: telegramMutation,
		discord: discordMutation,
		email: emailMutation,
		resend: resendMutation,
		sendly: sendlyMutation,
		notifly: notiflyMutation,
		uptimely: uptimelyMutation,
		gotify: gotifyMutation,
		ntfy: ntfyMutation,
		mattermost: mattermostMutation,
		lark: larkMutation,
		teams: teamsMutation,
		custom: customMutation,
		pushover: pushoverMutation,
	};

	const onSubmit = async (data: NotificationSchema) => {
		const {
			appBuildError,
			appDeploy,
			dokployRestart,
			databaseBackup,
			dokployBackup,
			volumeBackup,
			dockerCleanup,
			serverThreshold,
			scheduleFailure,
		} = data;
		let promise: Promise<unknown> | null = null;
		if (data.type === "slack") {
			if (
				!requireOnCreate(
					"webhookUrl",
					data.webhookUrl,
					"Webhook URL is required",
				)
			)
				return;
			promise = slackMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				webhookUrl: data.webhookUrl ?? "",
				channel: data.channel,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "telegram") {
			if (!requireOnCreate("botToken", data.botToken, "Bot Token is required"))
				return;
			promise = telegramMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				botToken: data.botToken ?? "",
				messageThreadId: data.messageThreadId || "",
				chatId: data.chatId,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "discord") {
			if (
				!requireOnCreate(
					"webhookUrl",
					data.webhookUrl,
					"Webhook URL is required",
				)
			)
				return;
			promise = discordMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				webhookUrl: data.webhookUrl ?? "",
				decoration: data.decoration,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "email") {
			promise = emailMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				smtpServer: data.smtpServer,
				smtpPort: data.smtpPort,
				username: data.username || "",
				password: data.password || "",
				fromAddress: data.fromAddress,
				toAddresses: data.toAddresses,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "resend") {
			if (!requireOnCreate("apiKey", data.apiKey, "API Key is required"))
				return;
			promise = resendMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				apiKey: data.apiKey ?? "",
				fromAddress: data.fromAddress,
				toAddresses: data.toAddresses,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "sendly") {
			if (!notificationId && !data.apiKey?.trim()) {
				form.setError("apiKey", { message: "API Key is required" });
				return;
			}
			promise = sendlyMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				// Blank keeps the stored key when editing.
				apiKey: data.apiKey ?? "",
				fromAddress: data.fromAddress,
				toAddresses: data.toAddresses,
				baseUrl: data.baseUrl,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "notifly") {
			if (!notificationId && !data.apiKey?.trim()) {
				form.setError("apiKey", { message: "API Key is required" });
				return;
			}
			promise = notiflyMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				// Blank keeps the stored key when editing.
				apiKey: data.apiKey ?? "",
				workflowKey: data.workflowKey,
				subscriberId: data.subscriberId || "",
				baseUrl: data.baseUrl,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "uptimely") {
			if (!notificationId && !data.apiKey?.trim()) {
				form.setError("apiKey", { message: "API Key is required" });
				return;
			}
			// An Uptimely channel only reacts to deploys: "App Build Error"
			// declares the incident, the next success resolves it.
			promise = uptimelyMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: false,
				dokployRestart: false,
				databaseBackup: false,
				dokployBackup: false,
				volumeBackup: false,
				// Blank keeps the stored key when editing.
				apiKey: data.apiKey ?? "",
				projectId: data.projectId,
				baseUrl: data.baseUrl,
				resolvedStateId: data.resolvedStateId || "",
				name: data.name,
				dockerCleanup: false,
				notificationId: notificationId || "",
				serverThreshold: false,
				scheduleFailure: false,
			});
		} else if (data.type === "gotify") {
			if (!requireOnCreate("appToken", data.appToken, "App Token is required"))
				return;
			promise = gotifyMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				serverUrl: data.serverUrl,
				appToken: data.appToken ?? "",
				priority: data.priority,
				name: data.name,
				dockerCleanup: dockerCleanup,
				decoration: data.decoration,
				serverThreshold: serverThreshold,
				notificationId: notificationId || "",
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "ntfy") {
			promise = ntfyMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				serverUrl: data.serverUrl,
				accessToken: data.accessToken || "",
				clearAccessToken: data.clearAccessToken || undefined,
				topic: data.topic,
				priority: data.priority,
				name: data.name,
				dockerCleanup: dockerCleanup,
				serverThreshold: serverThreshold,
				notificationId: notificationId || "",
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "mattermost") {
			if (
				!requireOnCreate(
					"webhookUrl",
					data.webhookUrl,
					"Webhook URL is required",
				)
			)
				return;
			promise = mattermostMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				webhookUrl: data.webhookUrl ?? "",
				channel: data.channel || undefined,
				username: data.username || undefined,
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "lark") {
			if (
				!requireOnCreate(
					"webhookUrl",
					data.webhookUrl,
					"Webhook URL is required",
				)
			)
				return;
			promise = larkMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				webhookUrl: data.webhookUrl ?? "",
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "teams") {
			if (
				!requireOnCreate(
					"webhookUrl",
					data.webhookUrl,
					"Webhook URL is required",
				)
			)
				return;
			promise = teamsMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				webhookUrl: data.webhookUrl ?? "",
				name: data.name,
				dockerCleanup: dockerCleanup,
				notificationId: notificationId || "",
				serverThreshold: serverThreshold,
				scheduleFailure: scheduleFailure,
			});
		} else if (data.type === "custom") {
			// Convert headers array to object
			const headersRecord =
				data.headers && data.headers.length > 0
					? data.headers.reduce(
							(acc, { key, value }) => {
								if (key.trim()) acc[key] = value;
								return acc;
							},
							{} as Record<string, string>,
						)
					: undefined;

			promise = customMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				endpoint: data.endpoint,
				headers: headersRecord ?? (notificationId ? {} : undefined),
				name: data.name,
				dockerCleanup: dockerCleanup,
				serverThreshold: serverThreshold,
				notificationId: notificationId || "",
			});
		} else if (data.type === "pushover") {
			if (!requireOnCreate("userKey", data.userKey, "User Key is required"))
				return;
			if (!requireOnCreate("apiToken", data.apiToken, "API Token is required"))
				return;
			if (data.priority === 2 && (data.retry == null || data.expire == null)) {
				toast.error("Retry and expire are required for emergency priority (2)");
				return;
			}
			promise = pushoverMutation.mutateAsync({
				appBuildError: appBuildError,
				appDeploy: appDeploy,
				dokployRestart: dokployRestart,
				databaseBackup: databaseBackup,
				dokployBackup: dokployBackup,
				volumeBackup: volumeBackup,
				userKey: data.userKey ?? "",
				apiToken: data.apiToken ?? "",
				priority: data.priority,
				retry: data.priority === 2 ? data.retry : undefined,
				expire: data.priority === 2 ? data.expire : undefined,
				name: data.name,
				dockerCleanup: dockerCleanup,
				serverThreshold: serverThreshold,
				notificationId: notificationId || "",
			});
		}

		if (promise) {
			await promise
				.then(async () => {
					toast.success(
						notificationId ? "Notification Updated" : "Notification Created",
					);
					form.reset({
						type: "slack",
						webhookUrl: "",
					});
					setVisible(false);
					await utils.notification.all.invalidate();
					if (notificationId) {
						await utils.notification.one.invalidate({ notificationId });
					}
				})
				.catch((error) => {
					toast.error(
						notificationId
							? "Error updating a notification"
							: "Error creating a notification",
						{
							description: error instanceof Error ? error.message : undefined,
						},
					);
				});
		}
	};
	return (
		<Dialog open={visible} onOpenChange={setVisible}>
			<DialogTrigger className="" asChild>
				{notificationId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10 "
					>
						<PenBoxIcon className="size-3.5  text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Add Notification
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						{notificationId ? "Update" : "Add"} Notification
					</DialogTitle>
					<DialogDescription>
						{notificationId
							? "Update your notification providers for multiple channels."
							: "Create new notification providers for multiple channels."}
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						id="hook-form"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-8 "
					>
						<FormField
							control={form.control}
							defaultValue={form.control._defaultValues.type}
							name="type"
							render={({ field }) => (
								<FormItem className="space-y-3">
									<FormLabel className="text-muted-foreground">
										Select a provider
									</FormLabel>
									<FormControl>
										<RadioGroup
											onValueChange={field.onChange}
											defaultValue={field.value}
											className="grid w-full grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4"
										>
											{Object.entries(notificationsMap).map(([key, value]) => (
												<FormItem
													key={key}
													className="flex w-full items-center space-x-3 space-y-0"
												>
													<FormControl className="w-full">
														<div>
															<RadioGroupItem
																value={key}
																id={key}
																className="peer sr-only"
															/>
															<Label
																htmlFor={key}
																className="h-24 flex flex-col gap-2 items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary has-data-[state=checked]:border-primary cursor-pointer"
															>
																{value.icon}
																{value.label}
															</Label>
														</div>
													</FormControl>
												</FormItem>
											))}
										</RadioGroup>
									</FormControl>
									<FormMessage />
									{activeMutation[field.value].isError && (
										<div className="flex flex-row gap-4 rounded-lg bg-red-50 p-2 dark:bg-red-950">
											<AlertTriangle className="text-red-600 dark:text-red-400" />
											<span className="text-sm text-red-600 dark:text-red-400">
												{activeMutation[field.value].error?.message}
											</span>
										</div>
									)}
								</FormItem>
							)}
						/>

						<div className="flex flex-col gap-4">
							<FormLabel className="text-lg font-semibold leading-none tracking-tight">
								Fill the next fields.
							</FormLabel>
							<div className="flex flex-col gap-2">
								<FormField
									control={form.control}
									name="name"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Name</FormLabel>
											<FormControl>
												<Input placeholder="Name" {...field} />
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>

								{type === "slack" && (
									<>
										<FormField
											control={form.control}
											name="webhookUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Webhook URL</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.slack?.webhookUrlMasked,
																"https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
															)}
															{...field}
														/>
													</FormControl>

													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="channel"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Channel</FormLabel>
													<FormControl>
														<Input placeholder="Channel" {...field} />
													</FormControl>

													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "telegram" && (
									<>
										<FormField
											control={form.control}
											name="botToken"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Bot Token</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.telegram?.botTokenMasked,
																"6660491268:AAFMGmajZOVewpMNZCgJr5H7cpXpoZPgvXw",
															)}
															{...field}
														/>
													</FormControl>

													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="chatId"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Chat ID</FormLabel>
													<FormControl>
														<Input placeholder="431231869" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="messageThreadId"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Message Thread ID</FormLabel>
													<FormControl>
														<Input placeholder="11" {...field} />
													</FormControl>

													<FormMessage />
													<FormDescription>
														Optional. Use it when you want to send notifications
														to a specific topic in a group.
													</FormDescription>
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "discord" && (
									<>
										<FormField
											control={form.control}
											name="webhookUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Webhook URL</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.discord?.webhookUrlMasked,
																"https://discord.com/api/webhooks/123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ",
															)}
															{...field}
														/>
													</FormControl>

													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="decoration"
											defaultValue={true}
											render={({ field }) => (
												<FormItem className="flex items-center justify-between rounded-lg border p-3 shadow-xs">
													<div className="space-y-0.5">
														<FormLabel>Decoration</FormLabel>
														<FormDescription>
															Decorate the notification with emojis.
														</FormDescription>
													</div>
													<FormControl>
														<Switch
															checked={field.value}
															onCheckedChange={field.onChange}
														/>
													</FormControl>
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "email" && (
									<>
										<div className="flex md:flex-row flex-col gap-2 w-full">
											<FormField
												control={form.control}
												name="smtpServer"
												render={({ field }) => (
													<FormItem className="w-full">
														<FormLabel>SMTP Server</FormLabel>
														<FormControl>
															<Input placeholder="smtp.gmail.com" {...field} />
														</FormControl>

														<FormMessage />
													</FormItem>
												)}
											/>
											<FormField
												control={form.control}
												name="smtpPort"
												render={({ field }) => (
													<FormItem className="w-full">
														<FormLabel>SMTP Port</FormLabel>
														<FormControl>
															<Input
																placeholder="587"
																{...field}
																onChange={(e) => {
																	const value = e.target.value;
																	if (value === "") {
																		field.onChange(undefined);
																	} else {
																		const port = Number.parseInt(value);
																		if (port > 0 && port < 65536) {
																			field.onChange(port);
																		}
																	}
																}}
																value={field.value || ""}
																type="number"
															/>
														</FormControl>

														<FormMessage />
													</FormItem>
												)}
											/>
										</div>

										<div className="flex md:flex-row flex-col gap-2 w-full">
											<FormField
												control={form.control}
												name="username"
												render={({ field }) => (
													<FormItem className="w-full">
														<FormLabel>Username</FormLabel>
														<FormControl>
															<Input
																placeholder="username"
																{...field}
																value={field.value ?? ""}
															/>
														</FormControl>
														<FormDescription>
															Optional. Leave blank if your SMTP server does not
															require authentication.
														</FormDescription>
														<FormMessage />
													</FormItem>
												)}
											/>

											<FormField
												control={form.control}
												name="password"
												render={({ field }) => (
													<FormItem className="w-full">
														<FormLabel>Password</FormLabel>
														<FormControl>
															<Input
																type="password"
																autoComplete="off"
																placeholder={keepBlankPlaceholder(
																	notification?.email?.passwordMasked,
																	"******************",
																)}
																{...field}
																value={field.value ?? ""}
															/>
														</FormControl>
														<FormDescription>
															Optional. Leave blank if your SMTP server does not
															require authentication.
														</FormDescription>
														<FormMessage />
													</FormItem>
												)}
											/>
										</div>

										<FormField
											control={form.control}
											name="fromAddress"
											render={({ field }) => (
												<FormItem>
													<FormLabel>From Address</FormLabel>
													<FormControl>
														<Input placeholder="from@example.com" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<div className="flex flex-col gap-2 pt-2">
											<FormLabel>To Addresses</FormLabel>

											{fields.map((field, index) => (
												<div
													key={field.id}
													className="flex flex-row gap-2 w-full"
												>
													<FormField
														control={form.control}
														name={`toAddresses.${index}`}
														render={({ field }) => (
															<FormItem className="w-full">
																<FormControl>
																	<Input
																		placeholder="email@example.com"
																		className="w-full"
																		{...field}
																	/>
																</FormControl>

																<FormMessage />
															</FormItem>
														)}
													/>
													<Button
														variant="outline"
														type="button"
														onClick={() => {
															remove(index);
														}}
													>
														Remove
													</Button>
												</div>
											))}
											{type === "email" &&
												"toAddresses" in form.formState.errors && (
													<div className="text-sm font-medium text-destructive">
														{form.formState?.errors?.toAddresses?.root?.message}
													</div>
												)}
										</div>

										<Button
											variant="outline"
											type="button"
											onClick={() => {
												append("");
											}}
										>
											Add
										</Button>
									</>
								)}

								{type === "resend" && (
									<>
										<FormField
											control={form.control}
											name="apiKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>API Key</FormLabel>
													<FormControl>
														<Input
															type="password"
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.resend?.apiKeyMasked,
																"re_********",
															)}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="fromAddress"
											render={({ field }) => (
												<FormItem>
													<FormLabel>From Address</FormLabel>
													<FormControl>
														<Input placeholder="from@example.com" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<div className="flex flex-col gap-2 pt-2">
											<FormLabel>To Addresses</FormLabel>

											{fields.map((field, index) => (
												<div
													key={field.id}
													className="flex flex-row gap-2 w-full"
												>
													<FormField
														control={form.control}
														name={`toAddresses.${index}`}
														render={({ field }) => (
															<FormItem className="w-full">
																<FormControl>
																	<Input
																		placeholder="email@example.com"
																		className="w-full"
																		{...field}
																	/>
																</FormControl>

																<FormMessage />
															</FormItem>
														)}
													/>
													<Button
														variant="outline"
														type="button"
														onClick={() => {
															remove(index);
														}}
													>
														Remove
													</Button>
												</div>
											))}
											{type === "resend" &&
												"toAddresses" in form.formState.errors && (
													<div className="text-sm font-medium text-destructive">
														{form.formState?.errors?.toAddresses?.root?.message}
													</div>
												)}
										</div>

										<Button
											variant="outline"
											type="button"
											onClick={() => {
												append("");
											}}
										>
											Add
										</Button>
									</>
								)}

								{type === "sendly" && (
									<>
										<DevinoProviderIntro provider="sendly" />
										<FormField
											control={form.control}
											name="apiKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>API Key</FormLabel>
													<FormControl>
														<Input
															type="password"
															autoComplete="off"
															placeholder={
																notification?.sendly?.apiKeyMasked
																	? `${notification.sendly.apiKeyMasked} (leave blank to keep)`
																	: "sk_********"
															}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="baseUrl"
											defaultValue="https://app.sendly.now"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Base URL</FormLabel>
													<FormControl>
														<Input
															placeholder="https://app.sendly.now"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														The base URL of your Sendly instance.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="fromAddress"
											render={({ field }) => (
												<FormItem>
													<FormLabel>From Address</FormLabel>
													<FormControl>
														<Input placeholder="from@example.com" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<div className="flex flex-col gap-2 pt-2">
											<FormLabel>To Addresses</FormLabel>

											{fields.map((field, index) => (
												<div
													key={field.id}
													className="flex flex-row gap-2 w-full"
												>
													<FormField
														control={form.control}
														name={`toAddresses.${index}`}
														render={({ field }) => (
															<FormItem className="w-full">
																<FormControl>
																	<Input
																		placeholder="email@example.com"
																		className="w-full"
																		{...field}
																	/>
																</FormControl>

																<FormMessage />
															</FormItem>
														)}
													/>
													<Button
														variant="outline"
														type="button"
														onClick={() => {
															remove(index);
														}}
													>
														Remove
													</Button>
												</div>
											))}
											{type === "sendly" &&
												"toAddresses" in form.formState.errors && (
													<div className="text-sm font-medium text-destructive">
														{form.formState?.errors?.toAddresses?.root?.message}
													</div>
												)}
										</div>

										<Button
											variant="outline"
											type="button"
											onClick={() => {
												append("");
											}}
										>
											Add
										</Button>
									</>
								)}

								{type === "notifly" && (
									<>
										<DevinoProviderIntro provider="notifly" />
										<FormField
											control={form.control}
											name="apiKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>API Key</FormLabel>
													<FormControl>
														<Input
															type="password"
															autoComplete="off"
															placeholder={
																notification?.notifly?.apiKeyMasked
																	? `${notification.notifly.apiKeyMasked} (leave blank to keep)`
																	: "Notifly API key"
															}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="baseUrl"
											defaultValue="https://api.notifly.io"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Base URL</FormLabel>
													<FormControl>
														<Input
															placeholder="https://api.notifly.io"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														The base URL of your Notifly instance.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="workflowKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Workflow Key</FormLabel>
													<FormControl>
														<Input
															placeholder="dokploy-notifications"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														The identifier of the Notifly workflow to trigger.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="subscriberId"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Subscriber ID</FormLabel>
													<FormControl>
														<Input placeholder="dokploy" {...field} />
													</FormControl>
													<FormDescription>
														Optional. Defaults to "dokploy" when left empty.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "uptimely" && (
									<>
										<DevinoProviderIntro provider="uptimely" />
										<FormField
											control={form.control}
											name="apiKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>API Key</FormLabel>
													<FormControl>
														<Input
															type="password"
															autoComplete="off"
															placeholder={
																notification?.uptimelyChannel?.apiKeyMasked
																	? `${notification.uptimelyChannel.apiKeyMasked} (leave blank to keep)`
																	: "Uptimely project API key"
															}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="projectId"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Project ID</FormLabel>
													<FormControl>
														<Input
															placeholder="00000000-0000-0000-0000-000000000000"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														The Uptimely project that receives the incidents.
														The project needs AI write operations enabled, or
														Uptimely refuses to declare incidents.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="baseUrl"
											defaultValue="https://app.getuptimely.com"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Base URL</FormLabel>
													<FormControl>
														<Input
															placeholder="https://app.getuptimely.com"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="resolvedStateId"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Resolved state ID</FormLabel>
													<FormControl>
														<Input
															placeholder="Optional"
															{...field}
															value={field.value ?? ""}
														/>
													</FormControl>
													<FormDescription>
														Optional. Uptimely cannot list incident states, so
														Dokploy reads the Resolved state from the
														project&apos;s existing incidents. Set this if a
														resolve fails because none has been resolved yet.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "gotify" && (
									<>
										<FormField
											control={form.control}
											name="serverUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Server URL</FormLabel>
													<FormControl>
														<Input
															placeholder="https://gotify.example.com"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="appToken"
											render={({ field }) => (
												<FormItem>
													<FormLabel>App Token</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.gotify?.appTokenMasked,
																"AzxcvbnmKjhgfdsa...",
															)}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="priority"
											defaultValue={5}
											render={({ field }) => (
												<FormItem className="w-full">
													<FormLabel>Priority</FormLabel>
													<FormControl>
														<Input
															placeholder="5"
															{...field}
															onChange={(e) => {
																const value = e.target.value;
																if (value) {
																	const port = Number.parseInt(value);
																	if (port > 0 && port < 10) {
																		field.onChange(port);
																	}
																}
															}}
															type="number"
														/>
													</FormControl>
													<FormDescription>
														Message priority (1-10, default: 5)
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="decoration"
											defaultValue={true}
											render={({ field }) => (
												<FormItem className="flex items-center justify-between rounded-lg border p-3 shadow-xs">
													<div className="space-y-0.5">
														<FormLabel>Decoration</FormLabel>
														<FormDescription>
															Decorate the notification with emojis.
														</FormDescription>
													</div>
													<FormControl>
														<Switch
															checked={field.value}
															onCheckedChange={field.onChange}
														/>
													</FormControl>
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "ntfy" && (
									<>
										<FormField
											control={form.control}
											name="serverUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Server URL</FormLabel>
													<FormControl>
														<Input placeholder="https://ntfy.sh" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="topic"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Topic</FormLabel>
													<FormControl>
														<Input placeholder="deployments" {...field} />
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="accessToken"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Access Token</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.ntfy?.accessTokenMasked,
																"AzxcvbnmKjhgfdsa...",
															)}
															{...field}
															value={field.value ?? ""}
														/>
													</FormControl>
													<FormDescription>
														Optional. Leave blank for public topics.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
										{notification?.ntfy?.accessTokenMasked && (
											<FormField
												control={form.control}
												name="clearAccessToken"
												render={({ field }) => (
													<FormItem className="flex items-center justify-between rounded-lg border p-3 shadow-xs">
														<div className="space-y-0.5">
															<FormLabel>Remove the stored token</FormLabel>
															<FormDescription>
																Send to this topic without an access token. A
																stored token is otherwise kept, and needs to be
																typed again to change the server URL.
															</FormDescription>
														</div>
														<FormControl>
															<Switch
																checked={field.value ?? false}
																onCheckedChange={field.onChange}
															/>
														</FormControl>
													</FormItem>
												)}
											/>
										)}
										<FormField
											control={form.control}
											name="priority"
											defaultValue={3}
											render={({ field }) => (
												<FormItem className="w-full">
													<FormLabel>Priority</FormLabel>
													<FormControl>
														<Input
															placeholder="3"
															{...field}
															onChange={(e) => {
																const value = e.target.value;
																if (value) {
																	const port = Number.parseInt(value);
																	if (port > 0 && port <= 5) {
																		field.onChange(port);
																	}
																}
															}}
															type="number"
														/>
													</FormControl>
													<FormDescription>
														Message priority (1-5, default: 3)
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "mattermost" && (
									<>
										<FormField
											control={form.control}
											name="webhookUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Webhook URL</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.mattermost?.webhookUrlMasked,
																"https://your-mattermost.com/hooks/xxx-generatedkey-xxx",
															)}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="channel"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Channel</FormLabel>
													<FormControl>
														<Input placeholder="deployments" {...field} />
													</FormControl>
													<FormDescription>
														Optional. Channel to post to (without #).
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="username"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Username</FormLabel>
													<FormControl>
														<Input placeholder="Dokploy" {...field} />
													</FormControl>
													<FormDescription>
														Optional. Display name for the webhook.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "custom" && (
									<div className="space-y-4">
										<FormField
											control={form.control}
											name="endpoint"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Webhook URL</FormLabel>
													<FormControl>
														<Input
															placeholder="https://api.example.com/webhook"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														The URL where POST requests will be sent with
														notification data.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										<div className="space-y-3">
											<div>
												<FormLabel>Headers</FormLabel>
												<FormDescription>
													Optional. Custom headers for your POST request (e.g.,
													Authorization, Content-Type).
												</FormDescription>
											</div>

											<div className="space-y-2">
												{headerFields.map((field, index) => (
													<div
														key={field.id}
														className="flex items-center gap-2 p-2 border rounded-md bg-muted/50"
													>
														<FormField
															control={form.control}
															name={`headers.${index}.key` as never}
															render={({ field }) => (
																<FormItem className="flex-1">
																	<FormControl>
																		<Input placeholder="Key" {...field} />
																	</FormControl>
																</FormItem>
															)}
														/>
														<FormField
															control={form.control}
															name={`headers.${index}.value` as never}
															render={({ field }) => (
																<FormItem className="flex-2">
																	<FormControl>
																		<Input
																			autoComplete="off"
																			placeholder={headerValuePlaceholder(
																				notification?.custom?.headersMasked,
																				form.watch(
																					`headers.${index}.key` as never,
																				),
																			)}
																			{...field}
																		/>
																	</FormControl>
																</FormItem>
															)}
														/>
														<Button
															type="button"
															variant="ghost"
															size="sm"
															onClick={() => removeHeader(index)}
															className="text-red-500 hover:text-red-700 hover:bg-red-50"
														>
															<Trash2 className="h-4 w-4" />
														</Button>
													</div>
												))}
											</div>

											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => appendHeader({ key: "", value: "" })}
												className="w-full"
											>
												<PlusIcon className="h-4 w-4 mr-2" />
												Add header
											</Button>
										</div>
									</div>
								)}

								{type === "lark" && (
									<>
										<FormField
											control={form.control}
											name="webhookUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Webhook URL</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.lark?.webhookUrlMasked,
																"https://open.larksuite.com/open-apis/bot/v2/hook/xxxxxxxxxxxxxxxxxxxxxxxx",
															)}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}

								{type === "teams" && (
									<>
										<FormField
											control={form.control}
											name="webhookUrl"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Webhook URL</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.teams?.webhookUrlMasked,
																"https://xxx.webhook.office.com/webhookb2/...",
															)}
															{...field}
														/>
													</FormControl>
													<FormDescription>
														Incoming Webhook URL from a Teams channel. Add an
														Incoming Webhook in your channel settings to get the
														URL.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</>
								)}
								{type === "pushover" && (
									<>
										<FormField
											control={form.control}
											name="userKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>User Key</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.pushover?.userKeyMasked,
																"ub3de9kl2q...",
															)}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="apiToken"
											render={({ field }) => (
												<FormItem>
													<FormLabel>API Token</FormLabel>
													<FormControl>
														<Input
															autoComplete="off"
															placeholder={keepBlankPlaceholder(
																notification?.pushover?.apiTokenMasked,
																"a3d9k2q7m4...",
															)}
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="priority"
											defaultValue={0}
											render={({ field }) => (
												<FormItem className="w-full">
													<FormLabel>Priority</FormLabel>
													<FormControl>
														<Input
															placeholder="0"
															value={field.value ?? 0}
															onChange={(e) => {
																const value = e.target.value;
																if (value === "" || value === "-") {
																	field.onChange(0);
																} else {
																	const priority = Number.parseInt(value);
																	if (
																		!Number.isNaN(priority) &&
																		priority >= -2 &&
																		priority <= 2
																	) {
																		field.onChange(priority);
																	}
																}
															}}
															type="number"
															min={-2}
															max={2}
														/>
													</FormControl>
													<FormDescription>
														Message priority (-2 to 2, default: 0, emergency: 2)
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
										{form.watch("priority") === 2 && (
											<>
												<FormField
													control={form.control}
													name="retry"
													render={({ field }) => (
														<FormItem className="w-full">
															<FormLabel>Retry (seconds)</FormLabel>
															<FormControl>
																<Input
																	placeholder="30"
																	{...field}
																	value={field.value ?? ""}
																	onChange={(e) => {
																		const value = e.target.value;
																		if (value === "") {
																			field.onChange(undefined);
																		} else {
																			const retry = Number.parseInt(value);
																			if (!Number.isNaN(retry)) {
																				field.onChange(retry);
																			}
																		}
																	}}
																	type="number"
																	min={30}
																/>
															</FormControl>
															<FormDescription>
																How often (in seconds) to retry. Minimum 30
																seconds.
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>
												<FormField
													control={form.control}
													name="expire"
													render={({ field }) => (
														<FormItem className="w-full">
															<FormLabel>Expire (seconds)</FormLabel>
															<FormControl>
																<Input
																	placeholder="3600"
																	{...field}
																	value={field.value ?? ""}
																	onChange={(e) => {
																		const value = e.target.value;
																		if (value === "") {
																			field.onChange(undefined);
																		} else {
																			const expire = Number.parseInt(value);
																			if (!Number.isNaN(expire)) {
																				field.onChange(expire);
																			}
																		}
																	}}
																	type="number"
																	min={1}
																	max={10800}
																/>
															</FormControl>
															<FormDescription>
																How long to keep retrying (max 10800 seconds / 3
																hours).
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>
											</>
										)}
									</>
								)}
							</div>
						</div>
						<div className="flex flex-col gap-4">
							<FormLabel className="text-lg font-semibold leading-none tracking-tight">
								Select the actions.
							</FormLabel>

							{type === "uptimely" ? (
								<FormField
									control={form.control}
									name="appBuildError"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
											<div className="space-y-0.5">
												<FormLabel>App Build Error</FormLabel>
												<FormDescription>
													Declare an incident when a deploy fails. The next
													successful deploy of the same service resolves it.
													Uptimely only receives deploy events.
												</FormDescription>
											</div>
											<FormControl>
												<Switch
													checked={field.value}
													onCheckedChange={field.onChange}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							) : (
								<div className="grid md:grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="appDeploy"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
												<div className="">
													<FormLabel>App Deploy</FormLabel>
													<FormDescription>
														Trigger the action when an app is deployed.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="appBuildError"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
												<div className="space-y-0.5">
													<FormLabel>App Build Error</FormLabel>
													<FormDescription>
														Trigger the action when the build fails.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									<FormField
										control={form.control}
										name="databaseBackup"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
												<div className="space-y-0.5">
													<FormLabel>Database Backup</FormLabel>
													<FormDescription>
														Trigger the action when a database backup is
														created.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									<FormField
										control={form.control}
										name="dokployBackup"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
												<div className="space-y-0.5">
													<FormLabel>Dokploy Backup</FormLabel>
													<FormDescription>
														Trigger the action when a Dokploy backup is created.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									<FormField
										control={form.control}
										name="volumeBackup"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
												<div className="space-y-0.5">
													<FormLabel>Volume Backup</FormLabel>
													<FormDescription>
														Trigger the action when a volume backup is created.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									<FormField
										control={form.control}
										name="dockerCleanup"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
												<div className="space-y-0.5">
													<FormLabel>Docker Cleanup</FormLabel>
													<FormDescription>
														Trigger the action when Docker cleanup is performed.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									{!isCloud && (
										<FormField
											control={form.control}
											name="dokployRestart"
											render={({ field }) => (
												<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
													<div className="space-y-0.5">
														<FormLabel>Dokploy Restart</FormLabel>
														<FormDescription>
															Trigger the action when Dokploy is restarted.
														</FormDescription>
													</div>
													<FormControl>
														<Switch
															checked={field.value}
															onCheckedChange={field.onChange}
														/>
													</FormControl>
												</FormItem>
											)}
										/>
									)}

									<FormField
										control={form.control}
										name="scheduleFailure"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm gap-2">
												<div className="space-y-0.5">
													<FormLabel>Schedule Failure</FormLabel>
													<FormDescription>
														Trigger the action when a scheduled job fails.
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									{isCloud && (
										<FormField
											control={form.control}
											name="serverThreshold"
											render={({ field }) => (
												<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs gap-2">
													<div className="space-y-0.5">
														<FormLabel>Server Threshold</FormLabel>
														<FormDescription>
															Trigger the action when the server threshold is
															reached.
														</FormDescription>
													</div>
													<FormControl>
														<Switch
															checked={field.value}
															onCheckedChange={field.onChange}
														/>
													</FormControl>
												</FormItem>
											)}
										/>
									)}
								</div>
							)}
						</div>
					</form>

					<DialogFooter className="flex flex-row gap-2 justify-between! w-full">
						<Button
							isLoading={
								isLoadingSlack ||
								isLoadingTelegram ||
								isLoadingDiscord ||
								isLoadingEmail ||
								isLoadingResend ||
								isLoadingSendly ||
								isLoadingNotifly ||
								isLoadingUptimely ||
								isLoadingGotify ||
								isLoadingNtfy ||
								isLoadingMattermost ||
								isLoadingLark ||
								isLoadingTeams ||
								isLoadingCustom ||
								isLoadingPushover
							}
							variant="secondary"
							type="button"
							onClick={async () => {
								const isValid = await form.trigger();
								if (!isValid) return;

								const data = form.getValues();

								try {
									if (data.type === "slack") {
										await testSlackConnection({
											notificationId: notificationId || undefined,
											webhookUrl: data.webhookUrl ?? "",
											channel: data.channel,
										});
									} else if (data.type === "telegram") {
										await testTelegramConnection({
											notificationId: notificationId || undefined,
											botToken: data.botToken ?? "",
											chatId: data.chatId,
											messageThreadId: data.messageThreadId || "",
										});
									} else if (data.type === "discord") {
										await testDiscordConnection({
											notificationId: notificationId || undefined,
											webhookUrl: data.webhookUrl ?? "",
											decoration: data.decoration,
										});
									} else if (data.type === "email") {
										await testEmailConnection({
											notificationId: notificationId || undefined,
											smtpServer: data.smtpServer,
											smtpPort: data.smtpPort,
											username: data.username || "",
											password: data.password || "",
											fromAddress: data.fromAddress,
											toAddresses: data.toAddresses,
										});
									} else if (data.type === "resend") {
										await testResendConnection({
											notificationId: notificationId || undefined,
											apiKey: data.apiKey ?? "",
											fromAddress: data.fromAddress,
											toAddresses: data.toAddresses,
										});
									} else if (data.type === "sendly") {
										await testSendlyConnection({
											apiKey: data.apiKey ?? "",
											notificationId: notificationId || undefined,
											fromAddress: data.fromAddress,
											toAddresses: data.toAddresses,
											baseUrl: data.baseUrl,
										});
									} else if (data.type === "notifly") {
										await testNotiflyConnection({
											apiKey: data.apiKey ?? "",
											notificationId: notificationId || undefined,
											workflowKey: data.workflowKey,
											subscriberId: data.subscriberId || "",
											baseUrl: data.baseUrl,
										});
									} else if (data.type === "uptimely") {
										// Read-only: proves the key and project, declares nothing.
										await testUptimelyConnection({
											apiKey: data.apiKey ?? "",
											notificationId: notificationId || undefined,
											projectId: data.projectId,
											baseUrl: data.baseUrl,
										});
									} else if (data.type === "gotify") {
										await testGotifyConnection({
											notificationId: notificationId || undefined,
											serverUrl: data.serverUrl,
											appToken: data.appToken ?? "",
											priority: data.priority ?? 0,
											decoration: data.decoration,
										});
									} else if (data.type === "ntfy") {
										await testNtfyConnection({
											// Removing the token: nothing stored is borrowed.
											notificationId: data.clearAccessToken
												? undefined
												: notificationId || undefined,
											serverUrl: data.serverUrl,
											topic: data.topic,
											accessToken: data.accessToken || "",
											priority: data.priority ?? 0,
										});
									} else if (data.type === "mattermost") {
										await testMattermostConnection({
											notificationId: notificationId || undefined,
											webhookUrl: data.webhookUrl ?? "",
											channel: data.channel || undefined,
											username: data.username || undefined,
										});
									} else if (data.type === "lark") {
										await testLarkConnection({
											notificationId: notificationId || undefined,
											webhookUrl: data.webhookUrl ?? "",
										});
									} else if (data.type === "teams") {
										await testTeamsConnection({
											notificationId: notificationId || undefined,
											webhookUrl: data.webhookUrl ?? "",
										});
									} else if (data.type === "custom") {
										const headersRecord =
											data.headers && data.headers.length > 0
												? data.headers.reduce(
														(acc, { key, value }) => {
															if (key.trim()) acc[key] = value;
															return acc;
														},
														{} as Record<string, string>,
													)
												: undefined;
										await testCustomConnection({
											notificationId: notificationId || undefined,
											endpoint: data.endpoint,
											headers:
												headersRecord ?? (notificationId ? {} : undefined),
										});
									} else if (data.type === "pushover") {
										if (
											data.priority === 2 &&
											(data.retry == null || data.expire == null)
										) {
											throw new Error(
												"Retry and expire are required for emergency priority (2)",
											);
										}
										await testPushoverConnection({
											notificationId: notificationId || undefined,
											userKey: data.userKey ?? "",
											apiToken: data.apiToken ?? "",
											priority: data.priority ?? 0,
											retry: data.priority === 2 ? data.retry : undefined,
											expire: data.priority === 2 ? data.expire : undefined,
										});
									}
									toast.success("Connection Success");
								} catch (error) {
									toast.error(
										`Error testing the provider: ${error instanceof Error ? error.message : "Unknown error"}`,
									);
								}
							}}
						>
							Test Notification
						</Button>
						<Button
							isLoading={form.formState.isSubmitting}
							form="hook-form"
							type="submit"
						>
							{notificationId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
