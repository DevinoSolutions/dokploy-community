/**
 * GitHub Actions as a service provider (T-13879).
 *
 * A service that follows a repository's GitHub Actions releases has the source type `github-actions`, like another
 * service has `github` or `docker`. Pure: what that source type changes in a deploy, how Connect and Disconnect move
 * the service between source types, and which edits are refused while the service is connected.
 *
 * A github-actions application runs the image its release set (`dockerImage`, a digest reference), so its deploy path
 * is the Docker image one: it pulls and starts that image and never builds source. A github-actions compose stack
 * keeps its file stored in Dokploy (`raw`); a release moves the digest in that file.
 */

export const GHA_SOURCE_TYPE = "github-actions" as const;

export type ServiceKind = "application" | "compose";

export const isGhaSourceType = (
	sourceType: string | null | undefined,
): sourceType is typeof GHA_SOURCE_TYPE => sourceType === GHA_SOURCE_TYPE;

/** The source type the deploy code sees: the pull-an-image (application) or stored-file (compose) one. */
export const deploySourceTypeOf = (
	kind: ServiceKind,
	sourceType: string,
): string => {
	if (!isGhaSourceType(sourceType)) return sourceType;
	return kind === "application" ? "docker" : "raw";
};

/**
 * The service as the deploy code reads it. Shallow copy: only `sourceType` differs, and only for a github-actions
 * service, so every other deploy is untouched.
 */
export const asDeployable = <T extends { sourceType: string }>(
	kind: ServiceKind,
	service: T,
): T =>
	isGhaSourceType(service.sourceType)
		? ({
				...service,
				sourceType: deploySourceTypeOf(kind, service.sourceType),
			} as T)
		: service;

/**
 * The source type a copy of a service gets (a duplicated project, a copied service): a copy has no GitHub Actions
 * connection, so it keeps what the original runs, a Docker image or a stored compose file.
 */
export const copiedSourceType = <S extends string>(
	kind: ServiceKind,
	sourceType: S,
): Exclude<S, typeof GHA_SOURCE_TYPE> =>
	deploySourceTypeOf(kind, sourceType) as Exclude<S, typeof GHA_SOURCE_TYPE>;

export const REDEPLOY_LABEL = "Redeploy current image";

export const redeployHint = (branch: string | null | undefined): string =>
	branch
		? `To build a new version, push to ${branch}; GitHub Actions deploys it.`
		: "To build a new version, push to the tracked branch; GitHub Actions deploys it.";

export type RedeployCheck = { ok: true } | { ok: false; message: string };

/**
 * A github-actions application with no release yet has no image to run: refuse a manual deploy with a sentence that
 * says what to do instead of failing in the middle of a deploy. Any other service is not this function's business.
 */
export const checkRedeployable = (
	kind: ServiceKind,
	service: { sourceType: string; dockerImage?: string | null },
	trackedBranch?: string | null,
): RedeployCheck => {
	if (!isGhaSourceType(service.sourceType) || kind !== "application") {
		return { ok: true };
	}
	if (service.dockerImage && service.dockerImage.trim() !== "") {
		return { ok: true };
	}
	return {
		ok: false,
		message: `No GitHub Actions release has arrived yet, so there is no image to redeploy. ${redeployHint(trackedBranch)}`,
	};
};

export type ProviderRefusal = {
	code: "CONFLICT" | "BAD_REQUEST";
	message: string;
};

/**
 * A client that edits the compose file (the file editor) sends the stored-file source type back with it. For a stack
 * that follows GitHub Actions that is the same provider, not a change: the update goes through without the source type.
 */
export const keepsProvider = (
	kind: ServiceKind,
	currentSourceType: string,
	nextSourceType: string | undefined,
): boolean =>
	kind === "compose" &&
	isGhaSourceType(currentSourceType) &&
	nextSourceType !== undefined &&
	deploySourceTypeOf(kind, currentSourceType) === nextSourceType;

/**
 * Whether an edit that sets a source type may go through. A connected service is moved off GitHub Actions only by
 * Disconnect (which also removes the connection and restores the source it had), and a service is moved onto it only
 * by Connect (which checks the repository and the environment). Setting the type it already has is fine, because a
 * client that sends back the whole record must keep working.
 */
export const checkSourceTypeChange = (input: {
	currentSourceType: string;
	connected: boolean;
	nextSourceType: string | undefined;
}): ProviderRefusal | null => {
	const { currentSourceType, connected, nextSourceType } = input;
	if (nextSourceType === undefined || nextSourceType === currentSourceType) {
		return null;
	}
	if (isGhaSourceType(currentSourceType) && connected) {
		return {
			code: "CONFLICT",
			message:
				"This service follows GitHub Actions. Disconnect GitHub Actions first, then choose another source.",
		};
	}
	if (isGhaSourceType(nextSourceType)) {
		return {
			code: "BAD_REQUEST",
			message:
				"Connect GitHub Actions from the Provider tab: it checks the repository and the environment first.",
		};
	}
	return null;
};

/** Fields of the saved source that Disconnect leaves alone: what the service runs now is not part of the provider. */
const KEPT_ON_RESTORE = [
	"dockerImage",
	"registryId",
	"username",
	"password",
	"registryUrl",
] as const;

/** Fields of the saved source that point at another record; a record deleted since must not break Disconnect. */
export const RESTORE_REFERENCES = [
	"githubId",
	"gitlabId",
	"bitbucketId",
	"giteaId",
	"customGitSSHKeyId",
] as const;

export type SourceRestore = {
	values: Record<string, unknown>;
	/** True when the write is only the fallback and must touch a service still on github-actions, nothing else. */
	onlyWhenGha: boolean;
};

/**
 * What Disconnect writes back to the service. With a saved source and the caller's wish to restore it, the provider
 * fields of that source (the repository, branch, build path, trigger, git provider); the image the service runs now
 * stays (it is the digest the last release deployed, not the tag it had before). Otherwise (nothing saved, or the
 * caller asked to stay on what runs) the service goes to the image or stored file it runs now, so no service is left
 * on a source type that has no connection.
 */
export const planSourceRestore = (input: {
	kind: ServiceKind;
	previousSource: Record<string, unknown> | null | undefined;
	restoreSource: boolean;
}): SourceRestore => {
	const { kind, previousSource, restoreSource } = input;
	const previousType = previousSource?.sourceType;
	if (
		restoreSource &&
		previousSource &&
		typeof previousType === "string" &&
		!isGhaSourceType(previousType)
	) {
		// A compose keeps just its type; an application gets its provider settings back.
		const values: Record<string, unknown> = {};
		if (kind === "application") {
			for (const [field, value] of Object.entries(previousSource)) {
				if ((KEPT_ON_RESTORE as readonly string[]).includes(field)) continue;
				values[field] = value;
			}
		} else {
			values.sourceType = previousType;
		}
		return { values, onlyWhenGha: false };
	}
	return {
		values: { sourceType: deploySourceTypeOf(kind, GHA_SOURCE_TYPE) },
		onlyWhenGha: true,
	};
};

/**
 * The values with every reference to a record that no longer exists set to null, so the write cannot fail on a
 * foreign key (a Git provider, registry or SSH key deleted while the service was connected).
 */
export const withoutMissingReferences = async (
	values: Record<string, unknown>,
	exists: (
		field: (typeof RESTORE_REFERENCES)[number],
		id: string,
	) => Promise<boolean>,
): Promise<Record<string, unknown>> => {
	const out = { ...values };
	for (const field of RESTORE_REFERENCES) {
		const id = out[field];
		if (typeof id === "string" && id !== "" && !(await exists(field, id))) {
			out[field] = null;
		}
	}
	return out;
};
