import { describe, expect, it } from "vitest";

/**
 * Wave 5 regression guard for the `@dokploy/server` barrel.
 *
 * `packages/server/src/index.ts` re-exported `./services/user`, which shipped
 * legacy `(userId, ..., organizationId)` duplicates of the access helpers that
 * never received the wave 3/4 organization scoping. `./services/permission` was
 * not barrel-exported at all, so `import { checkServiceAccess } from
 * "@dokploy/server"` resolved to the *unhardened* implementation. The
 * duplicates are deleted and `./services/permission` is exported, so the barrel
 * can only hand out the hardened implementations.
 */
const barrel = await import("@dokploy/server");
const permission = await import("@dokploy/server/services/permission");
const userService = await import("@dokploy/server/services/user");

const hardenedNames = [
	"checkServiceAccess",
	"checkProjectAccess",
	"checkEnvironmentAccess",
	"checkEnvironmentCreationPermission",
	"checkEnvironmentDeletionPermission",
	"checkServicePermissionAndAccess",
	"addNewProject",
	"addNewEnvironment",
	"addNewService",
] as const;

describe("@dokploy/server barrel exposes the hardened permission helpers", () => {
	it.each(hardenedNames)("%s comes from services/permission", (name) => {
		expect(barrel[name]).toBeTypeOf("function");
		expect(barrel[name]).toBe(permission[name]);
	});

	it("keeps the ctx-shaped signature of checkServiceAccess", () => {
		// A compile-level assertion: the barrel export has to be assignable to
		// the `services/permission` implementation, which the legacy
		// `(userId, serviceId, organizationId, action)` duplicate was not.
		const hardenedCheckServiceAccess: typeof permission.checkServiceAccess =
			barrel.checkServiceAccess;
		expect(hardenedCheckServiceAccess).toBe(permission.checkServiceAccess);
	});

	it("no longer ships duplicates of the helpers in services/user", () => {
		const userExports = Object.keys(userService);
		for (const name of hardenedNames) {
			expect(userExports).not.toContain(name);
		}
	});
});
