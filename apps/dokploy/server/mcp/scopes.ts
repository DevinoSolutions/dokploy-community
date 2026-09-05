import {
	DOKPLOY_MCP_SCOPE_IDS,
	type DokployMcpScope,
} from "@dokploy/server/services/mcp-oauth";

export type { DokployMcpScope };

export interface ScopeDefinition {
	id: DokployMcpScope;
	label: string;
	description: string;
	defaultOn: boolean;
}

/** Order here is the order the consent page and settings card display. */
export const DOKPLOY_SCOPES: ScopeDefinition[] = [
	{
		id: "dokploy:read",
		label: "Read",
		description:
			"List and inspect projects, services, deployments, logs and settings.",
		defaultOn: true,
	},
	{
		id: "dokploy:deploy",
		label: "Deploy & lifecycle",
		description:
			"Deploy, redeploy, start, stop, restart, rebuild, roll back, cancel builds and clean deployment history.",
		defaultOn: true,
	},
	{
		id: "dokploy:services:write",
		label: "Edit services",
		description:
			"Create and update applications, compose stacks, databases, domains, ports, mounts, schedules, patches and tags.",
		defaultOn: true,
	},
	{
		id: "dokploy:services:delete",
		label: "Delete services",
		description:
			"Delete applications, compose stacks, databases, domains and other service resources.",
		defaultOn: false,
	},
	{
		id: "dokploy:projects:write",
		label: "Edit projects",
		description: "Create, update and duplicate projects and environments.",
		defaultOn: true,
	},
	{
		id: "dokploy:projects:delete",
		label: "Delete projects",
		description:
			"Delete projects and environments (and everything inside them).",
		defaultOn: false,
	},
	{
		id: "dokploy:backups",
		label: "Backups",
		description:
			"Manage backups, backup policies, volume backups and destinations, including manual runs, restores and deletions.",
		defaultOn: true,
	},
	{
		id: "dokploy:admin",
		label: "Administration",
		description:
			"Servers, cluster, Docker cleanup, SSH keys, registries, git providers, notifications, certificates, users, organization, roles and every other setting.",
		defaultOn: false,
	},
];

export const ALL_DOKPLOY_SCOPES: DokployMcpScope[] = [...DOKPLOY_MCP_SCOPE_IDS];
export const DEFAULT_ON_SCOPES: DokployMcpScope[] = DOKPLOY_SCOPES.filter(
	(scope) => scope.defaultOn,
).map((scope) => scope.id);

export const isDokployScope = (value: string): value is DokployMcpScope =>
	(DOKPLOY_MCP_SCOPE_IDS as readonly string[]).includes(value);

const SERVICE_ROUTERS = new Set([
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
	"domain",
	"port",
	"redirects",
	"security",
	"mounts",
	"previewDeployment",
	"schedule",
	"patch",
	"tag",
	"deployment",
	"rollback",
	"docker",
]);

const PROJECT_ROUTERS = new Set(["project", "environment"]);

const BACKUP_ROUTERS = new Set([
	"backup",
	"backupPolicy",
	"volumeBackups",
	"destination",
]);

/** `router.procedure` → scope, checked before every pattern. Keep small. */
const OVERRIDES: Record<string, DokployMcpScope> = {
	"deployment.removeDeployment": "dokploy:deploy",
	"deployment.killProcess": "dokploy:deploy",
	"application.clearDeployments": "dokploy:deploy",
	"application.cleanQueues": "dokploy:deploy",
	"application.dropDeployment": "dokploy:deploy",
	"compose.clearDeployments": "dokploy:deploy",
	"compose.cleanQueues": "dokploy:deploy",
	"compose.deployTemplate": "dokploy:services:write",
	"schedule.runManually": "dokploy:deploy",
	"tag.removeFromProject": "dokploy:services:write",
	// Edits a file inside a container; its sibling writeContainerFile is write.
	"docker.deleteContainerFile": "dokploy:services:write",
	// Repo housekeeping, matched by the clean prefix rather than a real deletion.
	"patch.cleanPatchRepos": "dokploy:deploy",
	// Mutation that only inspects the source, so it reads rather than writes.
	"compose.fetchSourceType": "dokploy:read",
	// Update check: a mutation in shape, read-only in effect.
	"settings.getUpdateData": "dokploy:read",
	// Personal bookmark on a template; must not require administration.
	"user.toggleTemplateBookmark": "dokploy:services:write",
};

const DELETE_PATTERN = /^(delete|remove|drop|clear|clean)/i;
const DEPLOY_PATTERN =
	/^(deploy|redeploy|start|stop|restart|reload|rebuild|cancel|kill|rollback|changeStatus|markRunning)/i;

export interface ToolScopeInput {
	routerName: string;
	procedureName: string;
	type: "query" | "mutation";
}

/**
 * Rules, in order: override → query→read → router family (service/project/
 * backup) with delete/deploy patterns → everything else is admin (fail closed).
 */
export const resolveToolScope = ({
	routerName,
	procedureName,
	type,
}: ToolScopeInput): DokployMcpScope => {
	const override = OVERRIDES[`${routerName}.${procedureName}`];
	if (override) return override;
	if (type === "query") return "dokploy:read";
	if (SERVICE_ROUTERS.has(routerName)) {
		if (DELETE_PATTERN.test(procedureName)) return "dokploy:services:delete";
		if (DEPLOY_PATTERN.test(procedureName)) return "dokploy:deploy";
		return "dokploy:services:write";
	}
	if (PROJECT_ROUTERS.has(routerName)) {
		return DELETE_PATTERN.test(procedureName)
			? "dokploy:projects:delete"
			: "dokploy:projects:write";
	}
	if (BACKUP_ROUTERS.has(routerName)) return "dokploy:backups";
	return "dokploy:admin";
};

export const isDestructiveScope = (scope: DokployMcpScope) =>
	scope === "dokploy:services:delete" || scope === "dokploy:projects:delete";
