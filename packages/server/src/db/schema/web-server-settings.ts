import { relations } from "drizzle-orm";
import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	DEFAULT_WATCHDOG_ENABLED,
	DEFAULT_WATCHDOG_IDLE_MINUTES,
	DEFAULT_WATCHDOG_MAX_MINUTES,
	type WatchdogExclusion,
	watchdogExclusionSchema,
	watchdogIdleMinutesSchema,
	watchdogMaxMinutesSchema,
} from "../../utils/deployments/watchdog-config";
import {
	DEFAULT_DOCKER_CLEANUP_CRON,
	dockerCleanupCronSchema,
} from "../../utils/docker/cleanup-schedule";
import { certificateType } from "./shared";

export const webServerSettings = pgTable("webServerSettings", {
	id: text("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	// Web Server Configuration
	serverIp: text("serverIp"),
	certificateType: certificateType("certificateType").notNull().default("none"),
	https: boolean("https").notNull().default(false),
	host: text("host"),
	letsEncryptEmail: text("letsEncryptEmail"),
	sshPrivateKey: text("sshPrivateKey"),
	enableDockerCleanup: boolean("enableDockerCleanup").notNull().default(true),
	// 5-field cron, read in UTC. See utils/docker/cleanup-schedule.ts.
	dockerCleanupCron: text("dockerCleanupCron")
		.notNull()
		.default(DEFAULT_DOCKER_CLEANUP_CRON),
	logCleanupCron: text("logCleanupCron").default("0 0 * * *"),
	// Metrics Configuration
	metricsConfig: jsonb("metricsConfig")
		.$type<{
			server: {
				type: "Dokploy" | "Remote";
				refreshRate: number;
				port: number;
				token: string;
				urlCallback: string;
				retentionDays: number;
				cronJob: string;
				thresholds: {
					cpu: number;
					memory: number;
				};
			};
			containers: {
				refreshRate: number;
				services: {
					include: string[];
					exclude: string[];
				};
			};
		}>()
		.notNull()
		.default({
			server: {
				type: "Dokploy",
				refreshRate: 60,
				port: 4500,
				token: "",
				retentionDays: 2,
				cronJob: "",
				urlCallback: "",
				thresholds: {
					cpu: 0,
					memory: 0,
				},
			},
			containers: {
				refreshRate: 60,
				services: {
					include: [],
					exclude: [],
				},
			},
		}),
	// Whitelabeling Configuration (Enterprise / Proprietary)
	whitelabelingConfig: jsonb("whitelabelingConfig")
		.$type<{
			appName: string | null;
			appDescription: string | null;
			logoUrl: string | null;
			faviconUrl: string | null;
			customCss: string | null;
			loginLogoUrl: string | null;
			supportUrl: string | null;
			docsUrl: string | null;
			errorPageTitle: string | null;
			errorPageDescription: string | null;
			footerText: string | null;
			ogImageUrl: string | null;
		}>()
		.default({
			appName: null,
			appDescription: null,
			logoUrl: null,
			faviconUrl: null,
			customCss: null,
			loginLogoUrl: null,
			supportUrl: null,
			docsUrl: null,
			errorPageTitle: null,
			errorPageDescription: null,
			footerText: null,
			ogImageUrl: null,
		}),
	// Deployment Configuration (self-hosted only)
	remoteServersOnly: boolean("remoteServersOnly").notNull().default(false),
	// Concurrent builds on the local web server
	buildsConcurrency: integer("buildsConcurrency").notNull().default(1),
	// Stuck-deployment watchdog (see utils/deployments/watchdog-config.ts):
	// fails a deployment whose log has been silent for `idleMinutes`, or that has
	// run for more than `maxMinutes`, and frees its queue slot.
	deploymentWatchdogEnabled: boolean("deploymentWatchdogEnabled")
		.notNull()
		.default(DEFAULT_WATCHDOG_ENABLED),
	deploymentWatchdogIdleMinutes: integer("deploymentWatchdogIdleMinutes")
		.notNull()
		.default(DEFAULT_WATCHDOG_IDLE_MINUTES),
	deploymentWatchdogMaxMinutes: integer("deploymentWatchdogMaxMinutes")
		.notNull()
		.default(DEFAULT_WATCHDOG_MAX_MINUTES),
	// Services whose deployments the watchdog never fails. Nothing by default.
	deploymentWatchdogExclusions: jsonb("deploymentWatchdogExclusions")
		.$type<WatchdogExclusion[]>()
		.notNull()
		.default([]),
	// Auth Configuration (self-hosted only)
	enforceSSO: boolean("enforceSSO").notNull().default(false),
	// Domain Restriction Configuration
	domainRestrictionConfig: jsonb("domainRestrictionConfig")
		.$type<{
			enabled: boolean;
			allowedWildcards: string[];
		}>()
		.default({
			enabled: false,
			allowedWildcards: [],
		}),
	// Cache Cleanup Configuration
	cleanupCacheApplications: boolean("cleanupCacheApplications")
		.notNull()
		.default(false),
	cleanupCacheOnPreviews: boolean("cleanupCacheOnPreviews")
		.notNull()
		.default(false),
	cleanupCacheOnCompose: boolean("cleanupCacheOnCompose")
		.notNull()
		.default(false),
	createdAt: timestamp("created_at").defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const webServerSettingsRelations = relations(
	webServerSettings,
	() => ({}),
);

const createSchema = createInsertSchema(webServerSettings, {
	id: z.string().min(1),
});

export const apiUpdateWebServerSettings = createSchema.partial().extend({
	serverIp: z.string().optional(),
	certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
	https: z.boolean().optional(),
	host: z.string().optional(),
	letsEncryptEmail: z.string().email().optional().nullable(),
	sshPrivateKey: z.string().optional(),
	enableDockerCleanup: z.boolean().optional(),
	dockerCleanupCron: dockerCleanupCronSchema.optional(),
	logCleanupCron: z.string().optional().nullable(),
	metricsConfig: z
		.object({
			server: z.object({
				type: z.enum(["Dokploy", "Remote"]),
				refreshRate: z.number(),
				port: z.number(),
				token: z.string(),
				urlCallback: z.string(),
				retentionDays: z.number(),
				cronJob: z.string(),
				thresholds: z.object({
					cpu: z.number(),
					memory: z.number(),
				}),
			}),
			containers: z.object({
				refreshRate: z.number(),
				services: z.object({
					include: z.array(z.string()),
					exclude: z.array(z.string()),
				}),
			}),
		})
		.optional(),
	cleanupCacheApplications: z.boolean().optional(),
	cleanupCacheOnPreviews: z.boolean().optional(),
	cleanupCacheOnCompose: z.boolean().optional(),
	remoteServersOnly: z.boolean().optional(),
	enforceSSO: z.boolean().optional(),
	buildsConcurrency: z.number().int().min(1).max(100).optional(),
	deploymentWatchdogEnabled: z.boolean().optional(),
	deploymentWatchdogIdleMinutes: watchdogIdleMinutesSchema.optional(),
	deploymentWatchdogMaxMinutes: watchdogMaxMinutesSchema.optional(),
	deploymentWatchdogExclusions: z.array(watchdogExclusionSchema).optional(),
});

export const apiUpdateWebServerBuildsConcurrency = z.object({
	buildsConcurrency: z.number().int().min(1).max(100),
});

export const apiAssignDomain = z
	.object({
		host: z.string(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]),
		letsEncryptEmail: z
			.union([z.string().email(), z.literal("")])
			.optional()
			.nullable(),
		https: z.boolean().optional(),
	})
	.required()
	.partial({
		letsEncryptEmail: true,
		https: true,
	});

export const apiSaveSSHKey = z
	.object({
		sshPrivateKey: z.string(),
	})
	.required();

export const apiUpdateDockerCleanup = z.object({
	enableDockerCleanup: z.boolean(),
	// Omitted = keep the stored schedule.
	dockerCleanupCron: dockerCleanupCronSchema.optional(),
	serverId: z.string().optional(),
});

// Whitelabeling validation schemas
const safeUrl = z
	.string()
	.refine((url) => /^https?:\/\//i.test(url), {
		message: "Only http:// and https:// URLs are allowed",
	})
	.nullable();

export const whitelabelingConfigSchema = z.object({
	appName: z.string().nullable(),
	appDescription: z.string().nullable(),
	logoUrl: safeUrl,
	faviconUrl: safeUrl,
	customCss: z.string().nullable(),
	loginLogoUrl: safeUrl,
	supportUrl: safeUrl,
	docsUrl: safeUrl,
	errorPageTitle: z.string().nullable(),
	errorPageDescription: z.string().nullable(),
	footerText: z.string().nullable(),
	ogImageUrl: safeUrl,
});

export const apiUpdateWhitelabeling = z.object({
	whitelabelingConfig: whitelabelingConfigSchema,
});

export const apiUpdateWebServerMonitoring = z.object({
	metricsConfig: z
		.object({
			server: z.object({
				refreshRate: z.number().min(2),
				port: z.number().min(1),
				token: z.string(),
				urlCallback: z.string().url(),
				retentionDays: z.number().min(1),
				cronJob: z.string().min(1),
				thresholds: z.object({
					cpu: z.number().min(0),
					memory: z.number().min(0),
				}),
			}),
			containers: z.object({
				refreshRate: z.number().min(2),
				services: z.object({
					include: z.array(z.string()).optional(),
					exclude: z.array(z.string()).optional(),
				}),
			}),
		})
		.required(),
});

// Domain Restriction validation schemas
export const domainRestrictionConfigSchema = z.object({
	enabled: z.boolean(),
	allowedWildcards: z.array(
		z
			.string()
			.min(1)
			.refine((s) => s.startsWith("*.") || s.startsWith("**."), {
				message: "Pattern must start with '*.' or '**.' (e.g. *.example.com)",
			}),
	),
});

export const apiUpdateDomainRestriction = z.object({
	domainRestrictionConfig: domainRestrictionConfigSchema,
});
