import { describe, expect, it } from "vitest";
import {
	DEFAULT_ON_SCOPES,
	DOKPLOY_SCOPES,
	isDokployScope,
	resolveToolScope,
} from "@/server/mcp/scopes";

const q = (routerName: string, procedureName: string) =>
	resolveToolScope({ routerName, procedureName, type: "query" });
const m = (routerName: string, procedureName: string) =>
	resolveToolScope({ routerName, procedureName, type: "mutation" });

describe("scope catalogue", () => {
	it("has 8 scopes with delete/admin off by default", () => {
		expect(DOKPLOY_SCOPES.map((s) => s.id)).toEqual([
			"dokploy:read",
			"dokploy:deploy",
			"dokploy:services:write",
			"dokploy:services:delete",
			"dokploy:projects:write",
			"dokploy:projects:delete",
			"dokploy:backups",
			"dokploy:admin",
		]);
		expect(DEFAULT_ON_SCOPES).not.toContain("dokploy:services:delete");
		expect(DEFAULT_ON_SCOPES).not.toContain("dokploy:projects:delete");
		expect(DEFAULT_ON_SCOPES).not.toContain("dokploy:admin");
		expect(isDokployScope("dokploy:read")).toBe(true);
		expect(isDokployScope("openid")).toBe(false);
	});
});

describe("resolveToolScope", () => {
	it("queries are always read, whatever the router", () => {
		expect(q("settings", "getDokployVersion")).toBe("dokploy:read");
		expect(q("application", "one")).toBe("dokploy:read");
		expect(q("user", "get")).toBe("dokploy:read");
	});

	it("service routers: deploy pattern, delete pattern, else write", () => {
		expect(m("application", "deploy")).toBe("dokploy:deploy");
		expect(m("compose", "redeploy")).toBe("dokploy:deploy");
		expect(m("postgres", "stop")).toBe("dokploy:deploy");
		expect(m("application", "killBuild")).toBe("dokploy:deploy");
		expect(m("rollback", "rollback")).toBe("dokploy:deploy");
		expect(m("previewDeployment", "redeploy")).toBe("dokploy:deploy");
		expect(m("docker", "restartContainer")).toBe("dokploy:deploy");
		expect(m("application", "delete")).toBe("dokploy:services:delete");
		expect(m("postgres", "remove")).toBe("dokploy:services:delete");
		expect(m("docker", "removeContainer")).toBe("dokploy:services:delete");
		expect(m("application", "update")).toBe("dokploy:services:write");
		expect(m("domain", "create")).toBe("dokploy:services:write");
		expect(m("application", "move")).toBe("dokploy:services:write");
	});

	it("explicit overrides beat the patterns", () => {
		expect(m("deployment", "removeDeployment")).toBe("dokploy:deploy");
		expect(m("deployment", "killProcess")).toBe("dokploy:deploy");
		expect(m("application", "clearDeployments")).toBe("dokploy:deploy");
		expect(m("application", "cleanQueues")).toBe("dokploy:deploy");
		expect(m("compose", "deployTemplate")).toBe("dokploy:services:write");
		expect(m("schedule", "runManually")).toBe("dokploy:deploy");
		expect(m("tag", "removeFromProject")).toBe("dokploy:services:write");
		expect(m("docker", "deleteContainerFile")).toBe("dokploy:services:write");
		expect(m("patch", "cleanPatchRepos")).toBe("dokploy:deploy");
		expect(m("compose", "fetchSourceType")).toBe("dokploy:deploy");
		expect(m("settings", "getUpdateData")).toBe("dokploy:read");
		expect(m("user", "toggleTemplateBookmark")).toBe("dokploy:services:write");
	});

	it("queries that return credentials need admin, ordinary queries stay read", () => {
		expect(q("sshKey", "one")).toBe("dokploy:admin");
		expect(q("sshKey", "all")).toBe("dokploy:admin");
		expect(q("destination", "all")).toBe("dokploy:admin");
		expect(q("github", "one")).toBe("dokploy:admin");
		expect(q("settings", "readTraefikEnv")).toBe("dokploy:admin");
		expect(q("settings", "getWebServerSettings")).toBe("dokploy:admin");
		expect(q("notification", "all")).toBe("dokploy:admin");
		expect(q("ai", "getAll")).toBe("dokploy:admin");
		expect(q("sso", "listProviders")).toBe("dokploy:admin");
		expect(q("server", "withSSHKey")).toBe("dokploy:admin");
		expect(q("certificates", "one")).toBe("dokploy:admin");
		expect(q("user", "all")).toBe("dokploy:admin");
		// Safe projections and ordinary reads keep the default-on read scope.
		expect(q("application", "one")).toBe("dokploy:read");
		expect(q("registry", "one")).toBe("dokploy:read");
		expect(q("sshKey", "allForApps")).toBe("dokploy:read");
		expect(q("gitProvider", "getAll")).toBe("dokploy:read");
		expect(q("user", "get")).toBe("dokploy:read");
	});

	it("project routers split write/delete", () => {
		expect(m("project", "create")).toBe("dokploy:projects:write");
		expect(m("environment", "duplicate")).toBe("dokploy:projects:write");
		expect(m("project", "remove")).toBe("dokploy:projects:delete");
		expect(m("environment", "remove")).toBe("dokploy:projects:delete");
	});

	it("backup routers are one scope, admin routers and unknowns are admin", () => {
		expect(m("backup", "create")).toBe("dokploy:backups");
		expect(m("backup", "remove")).toBe("dokploy:backups");
		expect(m("volumeBackups", "runManually")).toBe("dokploy:backups");
		expect(m("destination", "update")).toBe("dokploy:backups");
		expect(m("settings", "cleanAll")).toBe("dokploy:admin");
		expect(m("server", "remove")).toBe("dokploy:admin");
		expect(m("user", "createApiKey")).toBe("dokploy:admin");
		expect(m("someFutureRouter", "doThing")).toBe("dokploy:admin");
	});
});
