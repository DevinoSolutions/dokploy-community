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
import { getAccessibleGitProviderIds } from "./git-provider";

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

const findForeignReference = async (
	input: ServiceReferenceInput,
	organizationId: string,
	keys?: readonly (keyof ServiceReferenceInput)[],
) => {
	const present = REFERENCES.flatMap((reference) => {
		if (keys && !keys.includes(reference.key)) {
			return [];
		}
		const id = input[reference.key];
		return id === null || id === undefined ? [] : [{ reference, id }];
	});

	const owners = await Promise.all(
		present.map(({ reference, id }) => reference.organizationIdOf(id)),
	);

	return present.find((_, index) => owners[index] !== organizationId)
		?.reference;
};

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
	const refused = await findForeignReference(input, organizationId);
	if (refused) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `${refused.label} not found`,
		});
	}
};

export const foreignReferenceMessage = (label: string) =>
	`Deployment refused: the ${label} set on this service does not belong to its organization. ` +
	"Choose one of your own in the service settings and deploy again.";

const SOURCE_REFERENCE_KEYS: Record<string, keyof ServiceReferenceInput> = {
	github: "githubId",
	gitlab: "gitlabId",
	bitbucket: "bitbucketId",
	gitea: "giteaId",
	git: "customGitSSHKeyId",
};

const REGISTRY_REFERENCE_KEYS: (keyof ServiceReferenceInput)[] = [
	"registryId",
	"buildRegistryId",
	"rollbackRegistryId",
];

/**
 * Rows written before #461 can still hold a registry, git provider or SSH key
 * of another organization, and `project.duplicate` used to copy them. This is
 * the deploy-time half of the same rule: the deployment loads the credentials
 * of every id its source type and registries use, so each one is re-checked
 * against the organization of the service's project and the deployment fails
 * closed, with a message that lands in the deployment log. Nothing is rewritten:
 * the row keeps the stale id until somebody picks a provider of their own.
 *
 * Only the git id the source type clones with is checked (a stale `githubId` on
 * a custom-git service is never read); every registry id is, because the
 * build, pull, push and rollback paths pick among them.
 */
export const assertDeployReferencesInOrganization = async (
	entity: {
		sourceType?: string | null;
		environment: { project: { organizationId: string } };
	} & ServiceReferenceInput,
) => {
	const keys = [...REGISTRY_REFERENCE_KEYS];
	const sourceKey = entity.sourceType
		? SOURCE_REFERENCE_KEYS[entity.sourceType]
		: undefined;
	if (sourceKey) {
		keys.push(sourceKey);
	}

	const refused = await findForeignReference(
		entity,
		entity.environment.project.organizationId,
		keys,
	);
	if (refused) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: foreignReferenceMessage(refused.label),
		});
	}
};

/**
 * `project.duplicate` copies the registry, git provider and SSH key ids of a
 * service verbatim, so a row that already holds one of another organization
 * would carry it into a new service. Refused up front (before the new project
 * exists) rather than dropping the id, which would silently change what the
 * copy builds from.
 */
export const assertServiceCopyReferencesInOrganization = async (
	service: ServiceReferenceInput & { name: string },
	organizationId: string,
) => {
	const refused = await findForeignReference(service, organizationId);
	if (refused) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Cannot duplicate "${service.name}": its ${refused.label} does not belong to this organization. Choose one of your own in the service settings, then duplicate again.`,
		});
	}
};

type GitProviderReferences = Pick<
	ServiceReferenceInput,
	"githubId" | "gitlabId" | "bitbucketId" | "giteaId"
>;

const GIT_PROVIDER_REFERENCES: {
	key: keyof GitProviderReferences;
	label: string;
	gitProviderIdOf: Lookup;
}[] = [
	{
		key: "githubId",
		label: "GitHub provider",
		gitProviderIdOf: async (id) =>
			(
				await db.query.github.findFirst({
					where: eq(github.githubId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
	{
		key: "gitlabId",
		label: "GitLab provider",
		gitProviderIdOf: async (id) =>
			(
				await db.query.gitlab.findFirst({
					where: eq(gitlab.gitlabId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
	{
		key: "bitbucketId",
		label: "Bitbucket provider",
		gitProviderIdOf: async (id) =>
			(
				await db.query.bitbucket.findFirst({
					where: eq(bitbucket.bitbucketId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
	{
		key: "giteaId",
		label: "Gitea provider",
		gitProviderIdOf: async (id) =>
			(
				await db.query.gitea.findFirst({
					where: eq(gitea.giteaId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
];

/**
 * Being in the organization (assertServiceReferencesInOrganization) is not the
 * same as being allowed to use the git provider: members only see the
 * providers they connected, the ones shared with the organization and, with a
 * license, the ones assigned to them (`getAccessibleGitProviderIds`; owners and
 * admins see all). The provider pickers list exactly that set, so this refuses
 * the ids a picker could not have offered.
 *
 * An id equal to the one already stored on the row is left alone, so a member
 * editing other fields of a service whose provider somebody else connected is
 * not locked out; only setting or changing to an inaccessible id is refused.
 * `loadCurrent` is only called when the input sets one of the ids.
 */
export const assertCanUseServiceGitProviders = async (
	input: GitProviderReferences,
	loadCurrent: () => Promise<GitProviderReferences | null | undefined>,
	session: { userId: string; activeOrganizationId: string },
) => {
	const set = GIT_PROVIDER_REFERENCES.filter(
		({ key }) => input[key] !== null && input[key] !== undefined,
	);
	if (set.length === 0) {
		return;
	}

	const current = await loadCurrent();
	const changed = set.filter(({ key }) => input[key] !== current?.[key]);
	if (changed.length === 0) {
		return;
	}

	const [gitProviderIds, accessible] = await Promise.all([
		Promise.all(
			changed.map(({ key, gitProviderIdOf }) =>
				gitProviderIdOf(input[key] as string),
			),
		),
		getAccessibleGitProviderIds(session),
	]);

	const refused = changed.find((_, index) => {
		const gitProviderId = gitProviderIds[index];
		return !gitProviderId || !accessible.has(gitProviderId);
	});
	if (refused) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `You don't have access to this ${refused.label}`,
		});
	}
};
