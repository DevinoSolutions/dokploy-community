import {
	type ConnectCode,
	type ConnectPlan,
	type ConnectReads,
	type ConnectRequest,
	planConnect,
	type ServiceFacts,
} from "./connect";

/**
 * The Connect action as a sequence: who may be connected to what, in the
 * order the user would hit the problems. Everything it touches is injected,
 * so the order and the messages are tested without a database or GitHub.
 */

export interface ConnectServiceInput extends ConnectRequest {
	serviceType: "application" | "compose";
	serviceId: string;
	githubConnectionId: string;
	workflowPath: string;
	serviceKey: string;
	registryId: string | null;
	gateMode: "image" | "checks" | "workflows";
}

export type ConnectServiceError = {
	ok: false;
	code: ConnectCode | "not-found" | "conflict" | "connection";
	message: string;
};

export interface ConnectServiceDeps<Saved> {
	/** The organization's GitHub account: its scopes and whether the token still works. */
	githubConnection(
		id: string,
	): Promise<{ scopes: string[]; status: string } | null>;
	token(githubConnectionId: string): Promise<string | null>;
	/** The service of this organization, or null. */
	service(
		type: "application" | "compose",
		id: string,
	): Promise<ServiceFacts | null>;
	/** What already follows this service. */
	existing(
		type: "application" | "compose",
		id: string,
	): Promise<{ connection: boolean; plainWatch: boolean }>;
	/** The organization's Dokploy registry record (Settings, Registry), or null. */
	registry(id: string): Promise<{ registryUrl: string } | null>;
	reads(token: string, owner: string, repo: string): ConnectReads;
	/** Writes the watch, the connection row and the service change; throws on a unique violation. */
	persist(
		plan: ConnectPlan,
		input: ConnectServiceInput,
		registry: { registryProbeHost: string | null },
	): Promise<Saved>;
	isUniqueViolation(error: unknown): boolean;
}

const refuse = (
	code: ConnectServiceError["code"],
	message: string,
): ConnectServiceError => ({ ok: false, code, message });

export const connectGhaService = async <Saved>(
	input: ConnectServiceInput,
	deps: ConnectServiceDeps<Saved>,
): Promise<
	{ ok: true; saved: Saved; plan: ConnectPlan } | ConnectServiceError
> => {
	const service = await deps.service(input.serviceType, input.serviceId);
	if (!service) return refuse("not-found", "Service not found");

	const account = await deps.githubConnection(input.githubConnectionId);
	if (!account) return refuse("connection", "GitHub connection not found");
	if (account.status !== "active") {
		return refuse(
			"connection",
			"The GitHub connection was revoked. Connect GitHub again, then retry.",
		);
	}

	const existing = await deps.existing(input.serviceType, input.serviceId);
	if (existing.connection) {
		return refuse(
			"conflict",
			"This service already follows GitHub Actions. Disconnect it first to change the settings.",
		);
	}
	if (existing.plainWatch) {
		return refuse(
			"conflict",
			"This service already follows GitHub Deployments (Deploy from GitHub Deployments). Remove that setting first, so only one thing deploys it.",
		);
	}

	const token = await deps.token(input.githubConnectionId);
	if (!token) {
		return refuse(
			"connection",
			"The GitHub connection has no usable token. Connect GitHub again, then retry.",
		);
	}

	// The mirror's digests are checked at a Dokploy registry record, with its login.
	let registryProbeHost: string | null = null;
	if (input.registryPrefix === null && input.registryId !== null) {
		return refuse(
			"registry",
			"A registry was chosen but no image prefix. Give both, or neither.",
		);
	}
	if (input.registryPrefix !== null) {
		const record = input.registryId
			? await deps.registry(input.registryId)
			: null;
		if (!record) {
			return refuse(
				"registry",
				"Choose the Dokploy registry (Settings, Registry) that serves the mirror. Its login is used to check the image digests.",
			);
		}
		registryProbeHost = record.registryUrl
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.replace(/\/+$/, "");
		if (registryProbeHost === "") {
			return refuse("registry", "That registry has no URL set.");
		}
	}

	const plan = await planConnect(
		{ scopes: account.scopes, service, request: input },
		deps.reads(token, input.owner, input.repo),
	);
	if (!plan.ok) return plan;

	try {
		return {
			ok: true,
			saved: await deps.persist(plan, input, { registryProbeHost }),
			plan,
		};
	} catch (error) {
		if (deps.isUniqueViolation(error)) {
			return refuse(
				"conflict",
				`Another service already follows ${plan.repoFullName} for environment ${input.environment} with the key ${input.serviceKey}. Pick another key.`,
			);
		}
		throw error;
	}
};
