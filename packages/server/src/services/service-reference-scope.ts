import { db } from "@dokploy/server/db";
import {
	bitbucket,
	gitea,
	github,
	gitlab,
	registry,
	sshKeys,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

/**
 * The columns of an application or compose row that point at a row owned by an
 * organization: the registries a build pushes to, pulls from and rolls back
 * with, the git providers a source is cloned through and the SSH key a custom
 * git source clones with. Each id selects credentials that the deployment then
 * uses, so each one has to belong to the organization of the service.
 */
export type ServiceReferenceInput = {
	registryId?: string | null;
	buildRegistryId?: string | null;
	rollbackRegistryId?: string | null;
	githubId?: string | null;
	gitlabId?: string | null;
	bitbucketId?: string | null;
	giteaId?: string | null;
	customGitSSHKeyId?: string | null;
};

type Lookup = (id: string) => Promise<string | null | undefined>;

const REFERENCES: {
	key: keyof ServiceReferenceInput;
	label: string;
	organizationIdOf: Lookup;
}[] = [
	{
		key: "registryId",
		label: "Registry",
		organizationIdOf: async (id) =>
			(
				await db.query.registry.findFirst({
					where: eq(registry.registryId, id),
					columns: { organizationId: true },
				})
			)?.organizationId,
	},
	{
		key: "buildRegistryId",
		label: "Build registry",
		organizationIdOf: async (id) =>
			(
				await db.query.registry.findFirst({
					where: eq(registry.registryId, id),
					columns: { organizationId: true },
				})
			)?.organizationId,
	},
	{
		key: "rollbackRegistryId",
		label: "Rollback registry",
		organizationIdOf: async (id) =>
			(
				await db.query.registry.findFirst({
					where: eq(registry.registryId, id),
					columns: { organizationId: true },
				})
			)?.organizationId,
	},
	{
		key: "githubId",
		label: "GitHub provider",
		organizationIdOf: async (id) =>
			(
				await db.query.github.findFirst({
					where: eq(github.githubId, id),
					columns: {},
					with: { gitProvider: { columns: { organizationId: true } } },
				})
			)?.gitProvider?.organizationId,
	},
	{
		key: "gitlabId",
		label: "GitLab provider",
		organizationIdOf: async (id) =>
			(
				await db.query.gitlab.findFirst({
					where: eq(gitlab.gitlabId, id),
					columns: {},
					with: { gitProvider: { columns: { organizationId: true } } },
				})
			)?.gitProvider?.organizationId,
	},
	{
		key: "bitbucketId",
		label: "Bitbucket provider",
		organizationIdOf: async (id) =>
			(
				await db.query.bitbucket.findFirst({
					where: eq(bitbucket.bitbucketId, id),
					columns: {},
					with: { gitProvider: { columns: { organizationId: true } } },
				})
			)?.gitProvider?.organizationId,
	},
	{
		key: "giteaId",
		label: "Gitea provider",
		organizationIdOf: async (id) =>
			(
				await db.query.gitea.findFirst({
					where: eq(gitea.giteaId, id),
					columns: {},
					with: { gitProvider: { columns: { organizationId: true } } },
				})
			)?.gitProvider?.organizationId,
	},
	{
		key: "customGitSSHKeyId",
		label: "SSH key",
		organizationIdOf: async (id) =>
			(
				await db.query.sshKeys.findFirst({
					where: eq(sshKeys.sshKeyId, id),
					columns: { organizationId: true },
				})
			)?.organizationId,
	},
];

/**
 * Fail-closed organization scope for the registry, git provider and SSH key
 * ids a service update or a `save*Provider` call is about to write.
 *
 * `checkServicePermissionAndAccess` proves the caller may edit the *service*;
 * it says nothing about the ids they put on it. Without this check an
 * owner/admin/member of organization A could point their service at
 * organization B's registry or git token and have the build run with B's
 * credentials.
 *
 * `null` and `undefined` mean "unset" and are allowed. A missing row and a row of
 * another organization produce the identical NOT_FOUND error, so the check is
 * not an existence oracle. Must be called BEFORE the write.
 */
export const assertServiceReferencesInOrganization = async (
	input: ServiceReferenceInput,
	organizationId: string,
) => {
	const present = REFERENCES.flatMap((reference) => {
		const id = input[reference.key];
		return id === null || id === undefined ? [] : [{ reference, id }];
	});

	const owners = await Promise.all(
		present.map(({ reference, id }) => reference.organizationIdOf(id)),
	);

	const refused = present.find((_, index) => owners[index] !== organizationId);
	if (refused) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `${refused.reference.label} not found`,
		});
	}
};
