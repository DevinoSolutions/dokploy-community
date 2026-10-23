import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const table = () => ({ findFirst: vi.fn(), findMany: vi.fn() });
	return {
		applications: table(),
		compose: table(),
		libsql: table(),
		mariadb: table(),
		mongo: table(),
		mysql: table(),
		postgres: table(),
		redis: table(),
		mounts: table(),
		volumeBackups: table(),
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: { query: mocks },
}));

const {
	assertVolumeBindingAllowed,
	evaluateVolumeBinding,
	isDokployReservedVolumeName,
	isInServiceVolumeNamespace,
	resolveVolumeBackupHost,
} = await import("@dokploy/server/utils/volume-backups/binding");
const { collectComposeDeclaredVolumeNames, loadVolumeBindingFacts } =
	await import("@dokploy/server/services/volume-binding");

type Facts = Parameters<typeof evaluateVolumeBinding>[0];

const facts = (overrides: Partial<Facts> = {}): Facts => ({
	volumeName: "app-one-x_data",
	serviceType: "application",
	serviceId: "app-1",
	appName: "app-one-x",
	serverId: null,
	recordedOnOwnMount: false,
	recordedOnOtherSameOrgMount: false,
	declaredByComposeFile: false,
	claimedByOtherOrganization: false,
	...overrides,
});

describe("the service volume namespace", () => {
	it("matches the app name and the names Dokploy builds from it", () => {
		// database data volume, compose project volume, isolated compose volume
		for (const [name, appName] of [
			["app-one-x", "app-one-x"],
			["postgres-db-AbC123-data", "postgres-db-AbC123"],
			["stack-x_pgdata", "stack-x"],
			["stack-x_pgdata-9f8e7d6c", "stack-x"],
		] as const) {
			expect(isInServiceVolumeNamespace(name, appName)).toBe(true);
		}
	});

	it("does not match another service's name that merely starts the same way", () => {
		expect(isInServiceVolumeNamespace("app-one-xyz_data", "app-one-x")).toBe(
			false,
		);
		expect(isInServiceVolumeNamespace("app-one", "app-one-x")).toBe(false);
		expect(isInServiceVolumeNamespace("other_data", "")).toBe(false);
	});

	it("reserves Dokploy's own volumes", () => {
		for (const name of ["dokploy", "dokploy-postgres", "dokploy_redis"]) {
			expect(isDokployReservedVolumeName(name)).toBe(true);
		}
		expect(isDokployReservedVolumeName("dokployment")).toBe(false);
	});
});

describe("resolveVolumeBackupHost", () => {
	it("is the server of whichever service owns the row, null for the local host", () => {
		expect(resolveVolumeBackupHost({ application: { serverId: "s1" } })).toBe(
			"s1",
		);
		expect(resolveVolumeBackupHost({ compose: { serverId: "s2" } })).toBe("s2");
		for (const key of [
			"postgres",
			"mysql",
			"mariadb",
			"mongo",
			"redis",
			"libsql",
		] as const) {
			expect(resolveVolumeBackupHost({ [key]: { serverId: "s3" } })).toBe("s3");
			expect(resolveVolumeBackupHost({ [key]: { serverId: null } })).toBeNull();
		}
		expect(resolveVolumeBackupHost({ application: { serverId: null } })).toBe(
			null,
		);
		expect(resolveVolumeBackupHost({})).toBeNull();
	});
});

describe("evaluateVolumeBinding", () => {
	it("accepts the service's own volumes for a member", () => {
		expect(evaluateVolumeBinding(facts(), { privileged: false })).toEqual({
			ok: true,
		});
	});

	it("rejects a volume outside the namespace for a member", () => {
		const verdict = evaluateVolumeBinding(
			facts({ volumeName: "another_org_pgdata" }),
			{ privileged: false },
		);
		expect(verdict).toMatchObject({ ok: false });
		expect(JSON.stringify(verdict)).toContain("app-one-x-<name>");
	});

	it("rejects a volume another organization claims, for everyone", () => {
		const claimed = facts({
			volumeName: "orgb-app_data",
			claimedByOtherOrganization: true,
			recordedOnOwnMount: true,
			recordedOnOtherSameOrgMount: true,
		});
		expect(evaluateVolumeBinding(claimed, { privileged: false }).ok).toBe(
			false,
		);
		expect(evaluateVolumeBinding(claimed, { privileged: true }).ok).toBe(false);
	});

	it("lets another organization's claim beat a short legacy appName prefix", () => {
		const verdict = evaluateVolumeBinding(
			facts({
				appName: "app",
				volumeName: "app-xyz-data",
				claimedByOtherOrganization: true,
			}),
			{ privileged: true },
		);
		expect(verdict.ok).toBe(false);
	});

	it("fails closed on a name that is not a volume name, even if it is a recorded mount", () => {
		for (const volumeName of ["/etc", "../x", "a b", "-x", "", "a:b"]) {
			for (const privileged of [true, false]) {
				expect(
					evaluateVolumeBinding(
						facts({
							appName: "",
							volumeName,
							recordedOnOwnMount: true,
							recordedOnOtherSameOrgMount: true,
						}),
						{ privileged },
					).ok,
				).toBe(false);
			}
		}
	});

	it("answers every refusal with the same text, so names of other organizations cannot be probed", () => {
		const message = (overrides: Partial<Facts>, privileged = false) => {
			const verdict = evaluateVolumeBinding(facts(overrides), { privileged });
			return verdict.ok ? null : verdict.message.replace(/"[^"]*"/, "");
		};
		const unclaimed = message({ volumeName: "nobody-uses-this" });
		const claimed = message({
			volumeName: "nobody-uses-this",
			claimedByOtherOrganization: true,
		});
		const reserved = message({ volumeName: "dokploy-postgres" });
		expect(unclaimed).toBeTruthy();
		expect(claimed).toBe(unclaimed);
		expect(reserved).toBe(unclaimed);
		expect(message({ volumeName: "nobody-uses-this" }, true)).toBe(unclaimed);
	});

	it("rejects Dokploy's own volumes, for everyone", () => {
		const reserved = facts({
			volumeName: "dokploy-postgres",
			recordedOnOwnMount: true,
		});
		expect(evaluateVolumeBinding(reserved, { privileged: true }).ok).toBe(
			false,
		);
		expect(evaluateVolumeBinding(reserved, { privileged: false }).ok).toBe(
			false,
		);
	});

	it("accepts an outside volume that is already a mount of the same service", () => {
		expect(
			evaluateVolumeBinding(
				facts({ volumeName: "legacy-data", recordedOnOwnMount: true }),
				{ privileged: false },
			).ok,
		).toBe(true);
	});

	it("lets an owner or admin use an outside volume only when the organization already knows it", () => {
		const outside = facts({ volumeName: "shared-data" });
		expect(evaluateVolumeBinding(outside, { privileged: true }).ok).toBe(false);
		expect(
			evaluateVolumeBinding(
				{ ...outside, recordedOnOtherSameOrgMount: true },
				{ privileged: true },
			).ok,
		).toBe(true);
		expect(
			evaluateVolumeBinding(
				{ ...outside, serviceType: "compose", declaredByComposeFile: true },
				{ privileged: true },
			).ok,
		).toBe(true);
	});

	it("does not give a member the owner/admin reach", () => {
		expect(
			evaluateVolumeBinding(
				facts({
					volumeName: "shared-data",
					recordedOnOtherSameOrgMount: true,
					declaredByComposeFile: true,
				}),
				{ privileged: false },
			).ok,
		).toBe(false);
	});

	it("throws BAD_REQUEST when asserted", () => {
		expect(() =>
			assertVolumeBindingAllowed(facts({ volumeName: "nope" }), {
				privileged: false,
			}),
		).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
	});
});

describe("collectComposeDeclaredVolumeNames", () => {
	it("returns the volumes the file takes out of the default namespace", () => {
		const declared = collectComposeDeclaredVolumeNames(`
services:
  db:
    image: postgres
volumes:
  plain:
  named:
    name: custom-name
  ext:
    external: true
  ext-named:
    external:
      name: other-volume
`);
		expect([...declared].sort()).toEqual(
			["custom-name", "ext", "other-volume"].sort(),
		);
	});

	it("declares nothing for an empty or unreadable file", () => {
		expect(collectComposeDeclaredVolumeNames("").size).toBe(0);
		expect(collectComposeDeclaredVolumeNames("a: [unclosed").size).toBe(0);
	});
});

describe("loadVolumeBindingFacts", () => {
	const orgOf = (organizationId: string) => ({
		environment: { project: { organizationId } },
	});

	beforeEach(() => {
		vi.resetAllMocks();
		for (const key of [
			"applications",
			"compose",
			"libsql",
			"mariadb",
			"mongo",
			"mysql",
			"postgres",
			"redis",
			"mounts",
			"volumeBackups",
		] as const) {
			mocks[key].findMany.mockResolvedValue([]);
		}
		mocks.applications.findFirst.mockResolvedValue({
			appName: "app-one-x",
			serverId: null,
			...orgOf("org-a"),
		});
	});

	it("reports no claim for a volume nobody else records", async () => {
		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "app-1",
				volumeName: "app-one-x-data",
			}),
		).resolves.toMatchObject({
			appName: "app-one-x",
			recordedOnOwnMount: false,
			recordedOnOtherSameOrgMount: false,
			claimedByOtherOrganization: false,
		});
	});

	it("flags a volume that sits in another organization's service namespace", async () => {
		mocks.postgres.findMany.mockResolvedValue([
			{ appName: "postgres-b-AbC123", ...orgOf("org-b") },
		]);

		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "app-1",
				volumeName: "postgres-b-AbC123-data",
			}),
		).resolves.toMatchObject({ claimedByOtherOrganization: true });
	});

	it("only counts claims of services on the same server", async () => {
		const input = {
			serviceType: "application" as const,
			serviceId: "app-1",
			volumeName: "pgdata",
		};
		const foreignMount = (serverId: string | null) => [
			{
				postgresId: "pg-b",
				postgres: { appName: "x", serverId, ...orgOf("org-b") },
			},
		];

		// org A on the local host, org B on its own remote server: no collision
		mocks.mounts.findMany.mockResolvedValue(foreignMount("server-b"));
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			claimedByOtherOrganization: false,
		});

		// same local host: collision
		mocks.mounts.findMany.mockResolvedValue(foreignMount(null));
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			serverId: null,
			claimedByOtherOrganization: true,
		});

		// both on the same remote server: collision
		mocks.applications.findFirst.mockResolvedValue({
			appName: "app-one-x",
			serverId: "server-b",
			...orgOf("org-a"),
		});
		mocks.mounts.findMany.mockResolvedValue(foreignMount("server-b"));
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			serverId: "server-b",
			claimedByOtherOrganization: true,
		});

		// namespace claims and volume backups follow the same rule
		mocks.mounts.findMany.mockResolvedValue([]);
		mocks.postgres.findMany.mockResolvedValue([
			{ appName: "pgdata", serverId: "server-c", ...orgOf("org-b") },
		]);
		mocks.volumeBackups.findMany.mockResolvedValue([
			{ mysql: { appName: "y", serverId: "server-c", ...orgOf("org-b") } },
		]);
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			claimedByOtherOrganization: false,
		});
	});

	it("counts a claim whose service or organization cannot be resolved on every server", async () => {
		const input = {
			serviceType: "application" as const,
			serviceId: "app-1",
			volumeName: "pgdata",
		};
		mocks.applications.findFirst.mockResolvedValue({
			appName: "app-one-x",
			serverId: "server-b",
			...orgOf("org-a"),
		});

		// a mount whose service no longer resolves
		mocks.mounts.findMany.mockResolvedValue([{ mountId: "orphan" }]);
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			serverId: "server-b",
			claimedByOtherOrganization: true,
		});

		// a volume backup whose service has no organization
		mocks.mounts.findMany.mockResolvedValue([]);
		mocks.volumeBackups.findMany.mockResolvedValue([
			{ redis: { appName: "z", serverId: "server-x", environment: null } },
		]);
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			claimedByOtherOrganization: true,
		});

		// a namespace claim without organization
		mocks.volumeBackups.findMany.mockResolvedValue([]);
		mocks.postgres.findMany.mockResolvedValue([
			{ appName: "pgdata", serverId: "server-x", environment: null },
		]);
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			claimedByOtherOrganization: true,
		});
	});

	it("only offers a same-organization mount on the same server to owners and admins", async () => {
		const sameOrgOn = (serverId: string | null) => [
			{
				applicationId: "app-2",
				application: { appName: "app-two", serverId, ...orgOf("org-a") },
			},
		];
		const input = {
			serviceType: "application" as const,
			serviceId: "app-1",
			volumeName: "shared-data",
		};

		mocks.mounts.findMany.mockResolvedValue(sameOrgOn("server-z"));
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			recordedOnOtherSameOrgMount: false,
		});
		mocks.mounts.findMany.mockResolvedValue(sameOrgOn(null));
		await expect(loadVolumeBindingFacts(input)).resolves.toMatchObject({
			recordedOnOtherSameOrgMount: true,
		});
	});

	it("flags a volume another organization records as a mount or a volume backup", async () => {
		mocks.mounts.findMany.mockResolvedValue([
			{ postgresId: "pg-b", postgres: { appName: "x", ...orgOf("org-b") } },
		]);
		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "app-1",
				volumeName: "orgb-data",
			}),
		).resolves.toMatchObject({ claimedByOtherOrganization: true });

		mocks.mounts.findMany.mockResolvedValue([]);
		mocks.volumeBackups.findMany.mockResolvedValue([
			{ mysql: { appName: "y", ...orgOf("org-b") } },
		]);
		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "app-1",
				volumeName: "orgb-data",
			}),
		).resolves.toMatchObject({ claimedByOtherOrganization: true });
	});

	it("treats a row whose organization cannot be resolved as another organization", async () => {
		mocks.mounts.findMany.mockResolvedValue([
			{ redisId: "redis-x", redis: { appName: "z", environment: null } },
		]);

		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "app-1",
				volumeName: "mystery",
			}),
		).resolves.toMatchObject({ claimedByOtherOrganization: true });
	});

	it("tells the service's own mount from another service's in the same organization", async () => {
		mocks.mounts.findMany.mockResolvedValue([
			{
				applicationId: "app-1",
				application: { appName: "app-one-x", ...orgOf("org-a") },
			},
			{
				applicationId: "app-2",
				application: { appName: "app-two", ...orgOf("org-a") },
			},
		]);

		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "app-1",
				volumeName: "shared-data",
			}),
		).resolves.toMatchObject({
			recordedOnOwnMount: true,
			recordedOnOtherSameOrgMount: true,
			claimedByOtherOrganization: false,
		});
	});

	it("reads the compose file's declared volumes", async () => {
		mocks.compose.findFirst.mockResolvedValue({
			appName: "stack-x",
			composeFile: "volumes:\n  ext:\n    external: true\n",
			...orgOf("org-a"),
		});

		await expect(
			loadVolumeBindingFacts({
				serviceType: "compose",
				serviceId: "compose-1",
				volumeName: "ext",
			}),
		).resolves.toMatchObject({ declaredByComposeFile: true });
	});

	it("fails closed for a service that does not exist", async () => {
		mocks.applications.findFirst.mockResolvedValue(undefined);

		await expect(
			loadVolumeBindingFacts({
				serviceType: "application",
				serviceId: "missing",
				volumeName: "x",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
