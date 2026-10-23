import { beforeEach, describe, expect, it, vi } from "vitest";

// Rows written before T-6895 can still hold a registry, git provider or SSH key
// of another organization. The deploy re-checks every id its source type and
// registries use and fails closed, leaving the row as it is (T-6902). Only the
// database rows the real check reads are scripted: id -> owning organization.
const mocks = vi.hoisted(() => ({
	owners: new Map<string, string>(),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	eq: (_column: unknown, value: unknown) => ({ value }),
}));

const lookup = (kind: "plain" | "provider") =>
	vi.fn(async (args: { where: { value: string } }) => {
		const organizationId = mocks.owners.get(args.where.value);
		if (!organizationId) {
			return undefined;
		}
		return kind === "plain"
			? { organizationId }
			: { gitProvider: { organizationId } };
	});

vi.mock("@dokploy/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server/db")>()),
	db: {
		query: {
			registry: { findFirst: lookup("plain") },
			sshKeys: { findFirst: lookup("plain") },
			github: { findFirst: lookup("provider") },
			gitlab: { findFirst: lookup("provider") },
			gitea: { findFirst: lookup("provider") },
			bitbucket: { findFirst: lookup("provider") },
		},
	},
}));

// the shared test setup replaces the deploy check with a no-op; this file tests
// the real one
const {
	assertDeployReferencesInOrganization,
	assertServiceCopyReferencesInOrganization,
} = await vi.importActual<
	typeof import("@dokploy/server/services/service-reference-scope")
>("@dokploy/server/services/service-reference-scope");

const environment = { project: { organizationId: "org-b" } };

beforeEach(() => {
	mocks.owners.clear();
	mocks.owners.set("own", "org-b");
	mocks.owners.set("foreign", "org-a");
});

describe("assertDeployReferencesInOrganization", () => {
	it.each([
		["registryId", "Registry"],
		["buildRegistryId", "Build registry"],
		["rollbackRegistryId", "Rollback registry"],
	])("refuses a foreign %s whatever the source", async (field, label) => {
		const refusal = assertDeployReferencesInOrganization({
			sourceType: "docker",
			environment,
			[field]: "foreign",
		});

		await expect(refusal).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(refusal).rejects.toThrow(
			`Deployment refused: the ${label} set on this service does not belong to its organization.`,
		);
	});

	it.each([
		["github", "githubId", "GitHub provider"],
		["gitlab", "gitlabId", "GitLab provider"],
		["bitbucket", "bitbucketId", "Bitbucket provider"],
		["gitea", "giteaId", "Gitea provider"],
		["git", "customGitSSHKeyId", "SSH key"],
	])(
		"refuses a foreign %s source credential (%s)",
		async (sourceType, field, label) => {
			const refusal = assertDeployReferencesInOrganization({
				sourceType,
				environment,
				[field]: "foreign",
			});

			await expect(refusal).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(refusal).rejects.toThrow(`the ${label} set on this service`);
		},
	);

	it("refuses an id whose row is gone", async () => {
		await expect(
			assertDeployReferencesInOrganization({
				sourceType: "github",
				environment,
				githubId: "missing",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("does not read a stale id the source type never uses", async () => {
		await expect(
			assertDeployReferencesInOrganization({
				sourceType: "git",
				environment,
				githubId: "foreign",
				gitlabId: "foreign",
				customGitSSHKeyId: "own",
			}),
		).resolves.toBeUndefined();
		await expect(
			assertDeployReferencesInOrganization({
				sourceType: "docker",
				environment,
				githubId: "foreign",
				customGitSSHKeyId: "foreign",
			}),
		).resolves.toBeUndefined();
	});

	it("lets a service with its own credentials, or none, deploy", async () => {
		await expect(
			assertDeployReferencesInOrganization({
				sourceType: "github",
				environment,
				githubId: "own",
				registryId: "own",
				buildRegistryId: "own",
				rollbackRegistryId: "own",
			}),
		).resolves.toBeUndefined();
		await expect(
			assertDeployReferencesInOrganization({
				sourceType: "raw",
				environment,
				githubId: null,
				registryId: null,
			}),
		).resolves.toBeUndefined();
	});
});

describe("assertServiceCopyReferencesInOrganization", () => {
	it.each([
		"registryId",
		"buildRegistryId",
		"rollbackRegistryId",
		"githubId",
		"gitlabId",
		"bitbucketId",
		"giteaId",
		"customGitSSHKeyId",
	])("refuses to copy a service that holds a foreign %s", async (field) => {
		await expect(
			assertServiceCopyReferencesInOrganization(
				{ name: "web", [field]: "foreign" },
				"org-b",
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining('Cannot duplicate "web"'),
		});
	});

	it("copies a service whose ids are all the organization's", async () => {
		await expect(
			assertServiceCopyReferencesInOrganization(
				{
					name: "web",
					registryId: "own",
					githubId: "own",
					customGitSSHKeyId: null,
				},
				"org-b",
			),
		).resolves.toBeUndefined();
	});
});
