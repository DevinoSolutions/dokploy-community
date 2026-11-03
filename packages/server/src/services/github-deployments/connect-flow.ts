import { randomBytes } from "node:crypto";
import {
	type DeviceFlowState,
	type FetchLike,
	startDeviceFlow,
	stepDeviceFlow,
} from "./device-flow";
import { fetchTokenOwner } from "./github-api";

/**
 * Server-side half of "Connect GitHub". The device code stays in this
 * process; the browser only holds a `flowId` and polls `completeConnect`.
 * A restart drops pending flows, which just means "start again".
 */

const MAX_FLOWS = 50;

interface Flow {
	organizationId: string;
	userId: string;
	state: DeviceFlowState;
}

const flows = new Map<string, Flow>();

const prune = (now: number) => {
	for (const [id, flow] of flows) {
		if (now >= flow.state.expiresAt) flows.delete(id);
	}
	while (flows.size >= MAX_FLOWS) {
		const oldest = flows.keys().next().value;
		if (oldest === undefined) break;
		flows.delete(oldest);
	}
};

export interface ConnectDeps {
	fetch: FetchLike;
	now: () => number;
	clientId?: string;
}

export const beginGithubConnect = async (
	deps: ConnectDeps,
	owner: { organizationId: string; userId: string },
	options: { scope?: string } = {},
) => {
	prune(deps.now());
	const started = await startDeviceFlow({
		...deps,
		...(options.scope ? { scope: options.scope } : {}),
	});
	if (!started.ok) return started;
	const flowId = randomBytes(18).toString("base64url");
	flows.set(flowId, { ...owner, state: started.state });
	return {
		ok: true as const,
		flowId,
		userCode: started.state.userCode,
		verificationUri: started.state.verificationUri,
		intervalSeconds: started.state.intervalSeconds,
		expiresInSeconds: Math.max(
			0,
			Math.floor((started.state.expiresAt - deps.now()) / 1000),
		),
	};
};

export type ConnectProgress =
	| { status: "pending"; retryAfterSeconds: number }
	| { status: "expired" }
	| { status: "denied" }
	| { status: "failed"; message: string }
	| {
			status: "connected";
			login: string;
			userId: string;
			scopes: string;
			accessToken: string;
	  };

/** One poll. On success the caller saves the connection; the flow is then closed. */
export const progressGithubConnect = async (
	deps: ConnectDeps,
	flowId: string,
	owner: { organizationId: string; userId: string },
): Promise<ConnectProgress> => {
	const flow = flows.get(flowId);
	if (
		!flow ||
		flow.organizationId !== owner.organizationId ||
		flow.userId !== owner.userId
	) {
		return { status: "expired" };
	}
	const step = await stepDeviceFlow(flow.state, deps);
	switch (step.status) {
		case "pending":
			flow.state = step.state;
			return { status: "pending", retryAfterSeconds: step.retryAfterSeconds };
		case "expired":
		case "denied":
			flows.delete(flowId);
			return { status: step.status };
		case "failed":
			flows.delete(flowId);
			return { status: "failed", message: step.message };
		case "authorized": {
			flows.delete(flowId);
			const who = await fetchTokenOwner(deps, step.accessToken);
			if (!who.ok) {
				return {
					status: "failed",
					message: "GitHub gave a token but would not say whose it is",
				};
			}
			const scopes =
				who.scopes ||
				step.scope
					.split(/[,\s]+/)
					.filter(Boolean)
					.join(",");
			return {
				status: "connected",
				login: who.login,
				userId: who.userId,
				scopes,
				accessToken: step.accessToken,
			};
		}
	}
};

/** Test hook. */
export const resetConnectFlows = () => flows.clear();
