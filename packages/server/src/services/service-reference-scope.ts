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

export type DeployReferenceEntity = {
	sourceType?: string | null;
	environment: { project: { organizationId: string } };
} & ServiceReferenceInput;

/**
 * Rows written before #461 can still hold a registry, git provider or SSH key
 * of another organization, and `project.duplicate` used to copy them. This is
 * the use-time half of the same rule: whatever loads the credentials of the ids
 * a row points at re-checks them against the organization of the service's
 * project and fails closed (FORBIDDEN, with a message that lands in the
 * deployment log when it is a deploy). Nothing is rewritten: the row keeps the
 * stale id until somebody picks one of their own.
 *
 * Only the git id the source type clones with is checked (a stale `githubId` on
 * a custom-git service is never read). With the default `deploy` scope every
 * registry id is checked as well, because the build, pull, push and rollback
 * paths pick among them; the `source` scope is for the routes that only clone
 * or read the repository (services list, source fetch, template read, patch
 * repo) and checks the source credential alone.
 */
export const assertDeployReferencesInOrganization = async (
	entity: DeployReferenceEntity,
	scope: "deploy" | "source" = "deploy",
) => {
	const keys = scope === "deploy" ? [...REGISTRY_REFERENCE_KEYS] : [];
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

/**
 * The columns that say which repository a git-provider source points at, plus
 * the ids and the source type. Branch, build path, trigger type and the like
 * are not here: they stay free for anybody who may edit the service.
 */
export type GitSourceInput = GitProviderReferences & {
	sourceType?: string | null;
	repository?: string | null;
	owner?: string | null;
	gitlabRepository?: string | null;
	gitlabOwner?: string | null;
	gitlabProjectId?: number | null;
	gitlabPathNamespace?: string | null;
	bitbucketRepository?: string | null;
	bitbucketOwner?: string | null;
	bitbucketRepositorySlug?: string | null;
	giteaRepository?: string | null;
	giteaOwner?: string | null;
};

const GIT_SOURCES: {
	sourceType: string;
	key: keyof GitProviderReferences;
	label: string;
	repositoryKeys: (keyof GitSourceInput)[];
	gitProviderIdOf: Lookup;
}[] = [
	{
		sourceType: "github",
		key: "githubId",
		label: "GitHub provider",
		repositoryKeys: ["repository", "owner"],
		gitProviderIdOf: async (id) =>
			(
				await db.query.github.findFirst({
					where: eq(github.githubId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
	{
		sourceType: "gitlab",
		key: "gitlabId",
		label: "GitLab provider",
		repositoryKeys: [
			"gitlabRepository",
			"gitlabOwner",
			"gitlabProjectId",
			"gitlabPathNamespace",
		],
		gitProviderIdOf: async (id) =>
			(
				await db.query.gitlab.findFirst({
					where: eq(gitlab.gitlabId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
	{
		sourceType: "bitbucket",
		key: "bitbucketId",
		label: "Bitbucket provider",
		repositoryKeys: [
			"bitbucketRepository",
			"bitbucketOwner",
			"bitbucketRepositorySlug",
		],
		gitProviderIdOf: async (id) =>
			(
				await db.query.bitbucket.findFirst({
					where: eq(bitbucket.bitbucketId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
	{
		sourceType: "gitea",
		key: "giteaId",
		label: "Gitea provider",
		repositoryKeys: ["giteaRepository", "giteaOwner"],
		gitProviderIdOf: async (id) =>
			(
				await db.query.gitea.findFirst({
					where: eq(gitea.giteaId, id),
					columns: { gitProviderId: true },
				})
			)?.gitProviderId,
	},
];

// "", null and undefined all mean "no value" for a stored repository column
const normalized = (value: unknown) =>
	value === "" || value === undefined ? null : value;

/**
 * Being in the organization (assertServiceReferencesInOrganization) is not the
 * same as being allowed to use the git provider: members only see the
 * providers they connected, the ones shared with the organization and, with a
 * license, the ones assigned to them (`getAccessibleGitProviderIds`; owners and
 * admins see all). The provider pickers list exactly that set, so this refuses
 * the ids a picker could not have offered.
 *
 * Three things need access to the provider that ends up on the service (the id
 * in the input, or the one already stored when the input has none):
 * - setting or changing the id;
 * - changing a repository column of that source (repository, owner, project id
 *   and path namespace, slug), compared against the stored row, so the repo is
 *   not re-pointed through somebody else's token;
 * - switching the source type to that source, which makes the stored provider
 *   active.
 * Everything else is free, so a member editing the branch, build path, trigger
 * type or any other field of a service whose provider somebody else connected
 * is not locked out, and the unchanged values the save forms resend pass.
 *
 * `loadCurrent` is only called when the input touches one of those fields.
 */
const findInaccessibleGitProvider = async (
	input: GitSourceInput,
	loadCurrent: () => Promise<GitSourceInput | null | undefined>,
	session: { userId: string; activeOrganizationId: string },
) => {
	const touched = (key: keyof GitSourceInput) =>
		input[key] !== undefined && input[key] !== null;
	const touchesSource = (source: (typeof GIT_SOURCES)[number]) =>
		touched(source.key) ||
		source.repositoryKeys.some((key) => input[key] !== undefined) ||
		input.sourceType === source.sourceType;
	if (!GIT_SOURCES.some(touchesSource)) {
		return null;
	}

	const current = await loadCurrent();
	const needed = GIT_SOURCES.flatMap((source) => {
		if (!touchesSource(source)) {
			return [];
		}
		const id =
			input[source.key] !== undefined
				? input[source.key]
				: current?.[source.key];
		if (id === null || id === undefined) {
			return [];
		}
		const idChanged = touched(source.key) && id !== current?.[source.key];
		const repositoryChanged = source.repositoryKeys.some(
			(key) =>
				input[key] !== undefined &&
				normalized(input[key]) !== normalized(current?.[key]),
		);
		const activated =
			input.sourceType === source.sourceType &&
			current?.sourceType !== source.sourceType;
		return idChanged || repositoryChanged || activated ? [{ source, id }] : [];
	});
	if (needed.length === 0) {
		return null;
	}

	const [gitProviderIds, accessible] = await Promise.all([
		Promise.all(needed.map(({ source, id }) => source.gitProviderIdOf(id))),
		getAccessibleGitProviderIds(session),
	]);

	const refused = needed.find((_, index) => {
		const gitProviderId = gitProviderIds[index];
		return !gitProviderId || !accessible.has(gitProviderId);
	});
	return refused?.source.label ?? null;
};

export const assertCanUseServiceGitProviders = async (
	...args: Parameters<typeof findInaccessibleGitProvider>
) => {
	const label = await findInaccessibleGitProvider(...args);
	if (label) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `You don't have access to this ${label}`,
		});
	}
};

/**
 * `project.duplicate`, member side: the copy keeps the git provider ids of the
 * source row, so a caller who could not have picked that provider is refused
 * with the same kind of message as a foreign id. Owners and admins can use every
 * provider of the organization and pass.
 */
export const assertCanCopyServiceGitProviders = async (
	service: GitProviderReferences & { name: string },
	session: { userId: string; activeOrganizationId: string },
) => {
	const label = await findInaccessibleGitProvider(
		service,
		async () => null,
		session,
	);
	if (label) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Cannot duplicate "${service.name}": you don't have access to its ${label}. Ask its owner to share it, or choose one of your own in the service settings, then duplicate again.`,
		});
	}
};
