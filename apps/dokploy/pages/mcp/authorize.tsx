import {
	findOAuthApplicationByClientId,
	findOrganizationName,
	isMcpDisabled,
	resolveDefaultOrganizationId,
	validateRequest,
} from "@dokploy/server";
import { ShieldCheck } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { type ReactElement, useState } from "react";
import { toast } from "sonner";
import { OnboardingLayout } from "@/components/layouts/onboarding-layout";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { countToolsByScope, getMcpToolRegistry } from "@/server/mcp/registry";
import {
	DEFAULT_ON_SCOPES,
	DOKPLOY_SCOPES,
	type DokployMcpScope,
	isDokployScope,
} from "@/server/mcp/scopes";
import { api } from "@/utils/api";

interface ScopeRow {
	id: DokployMcpScope;
	label: string;
	description: string;
	toolCount: number;
	checked: boolean;
}

interface OAuthParams {
	clientId: string;
	redirectUri: string;
	responseType: string;
	state: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	resource: string;
}

interface Props {
	error: string | null;
	clientName: string;
	redirectHost: string;
	organizationName: string | null;
	scopes: ScopeRow[];
	params: OAuthParams | null;
	cancelUrl: string | null;
}

const one = (value: string | string[] | undefined) =>
	(Array.isArray(value) ? value[0] : value) ?? "";

export default function McpAuthorizePage({
	error,
	clientName,
	redirectHost,
	organizationName,
	scopes,
	params,
	cancelUrl,
}: Props) {
	const [selected, setSelected] = useState<Set<DokployMcpScope>>(
		new Set(scopes.filter((s) => s.checked).map((s) => s.id)),
	);
	const approve = api.mcp.approveAuthorization.useMutation();

	const onAuthorize = async () => {
		if (!params) return;
		try {
			const { url } = await approve.mutateAsync({
				clientId: params.clientId,
				redirectUri: params.redirectUri,
				responseType: params.responseType,
				state: params.state || undefined,
				codeChallenge: params.codeChallenge,
				codeChallengeMethod: params.codeChallengeMethod,
				resource: params.resource || undefined,
				scopes: [...selected],
			});
			window.location.assign(url);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Authorization failed");
		}
	};

	return (
		<>
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight flex items-center justify-center gap-2">
					<ShieldCheck className="size-8" />
					Authorize {clientName}
				</h1>
				<p className="text-sm text-muted-foreground">
					{clientName} wants to use the Dokploy MCP server on your behalf.
				</p>
			</div>
			<CardContent className="p-0 space-y-4">
				{error ? (
					<AlertBlock type="error">{error}</AlertBlock>
				) : (
					<>
						<div className="rounded-lg border p-3 text-sm space-y-1">
							<div>
								<span className="text-muted-foreground">
									Acting in organization:{" "}
								</span>
								<span className="font-medium">
									{organizationName ?? "none"}
								</span>
							</div>
							<div>
								<span className="text-muted-foreground">
									Code will be sent to:{" "}
								</span>
								<span className="font-mono">{redirectHost}</span>
							</div>
						</div>
						{!organizationName && (
							<AlertBlock type="error">
								You are not a member of any organization, so nothing can be
								authorized.
							</AlertBlock>
						)}
						<div className="flex flex-col gap-3">
							{scopes.map((scope) => (
								<div
									key={scope.id}
									className="flex items-start justify-between gap-4 rounded-lg border p-3"
								>
									<div className="space-y-1">
										<Label htmlFor={scope.id} className="font-medium">
											{scope.label}{" "}
											<span className="text-xs text-muted-foreground font-mono">
												{scope.id} · {scope.toolCount} tools
											</span>
										</Label>
										<p className="text-sm text-muted-foreground">
											{scope.description}
										</p>
									</div>
									<Switch
										id={scope.id}
										checked={selected.has(scope.id)}
										onCheckedChange={(checked) => {
											setSelected((prev) => {
												const next = new Set(prev);
												if (checked) next.add(scope.id);
												else next.delete(scope.id);
												return next;
											});
										}}
									/>
								</div>
							))}
						</div>
						<p className="text-xs text-muted-foreground">
							Scopes only restrict what this client may do. Your role
							permissions still apply. You can revoke this authorization any
							time under Settings → Profile → MCP Server.
						</p>
						<div className="grid grid-cols-2 gap-4">
							<Button
								variant="outline"
								type="button"
								onClick={() => cancelUrl && window.location.assign(cancelUrl)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								onClick={onAuthorize}
								isLoading={approve.isPending}
								disabled={!organizationName || selected.size === 0}
							>
								Authorize
							</Button>
						</div>
					</>
				)}
			</CardContent>
		</>
	);
}

McpAuthorizePage.getLayout = (page: ReactElement) => (
	<OnboardingLayout>{page}</OnboardingLayout>
);

export async function getServerSideProps(context: GetServerSidePropsContext) {
	const { user } = await validateRequest(context.req);
	if (!user) {
		return {
			redirect: {
				permanent: false,
				destination: `/?redirect=${encodeURIComponent(context.resolvedUrl)}`,
			},
		};
	}

	const empty: Props = {
		error: null,
		clientName: "Unknown client",
		redirectHost: "",
		organizationName: null,
		scopes: [],
		params: null,
		cancelUrl: null,
	};

	if (isMcpDisabled()) {
		return {
			props: {
				...empty,
				error: "The MCP server is disabled on this instance.",
			},
		};
	}

	const q = context.query;
	const params: OAuthParams = {
		clientId: one(q.client_id),
		redirectUri: one(q.redirect_uri),
		responseType: one(q.response_type),
		state: one(q.state),
		codeChallenge: one(q.code_challenge),
		codeChallengeMethod: one(q.code_challenge_method),
		resource: one(q.resource),
	};

	const client = await findOAuthApplicationByClientId(params.clientId);
	if (!client || client.disabled) {
		return { props: { ...empty, error: "Unknown or disabled OAuth client." } };
	}
	if (!client.redirectUrls.includes(params.redirectUri)) {
		return {
			props: {
				...empty,
				clientName: client.name,
				error: "The redirect URI is not registered for this client.",
			},
		};
	}
	if (
		params.responseType !== "code" ||
		!params.codeChallenge ||
		params.codeChallengeMethod !== "S256"
	) {
		return {
			props: {
				...empty,
				clientName: client.name,
				error:
					"This authorization request is missing PKCE (S256) or uses an unsupported response type.",
			},
		};
	}

	const organizationId = await resolveDefaultOrganizationId(user.id);
	const organization = organizationId
		? await findOrganizationName(organizationId)
		: null;

	const requested = one(q.scope).split(" ").filter(isDokployScope);
	const shown =
		requested.length > 0 ? requested : DOKPLOY_SCOPES.map((s) => s.id);
	const counts = countToolsByScope(await getMcpToolRegistry());
	const scopes: ScopeRow[] = DOKPLOY_SCOPES.filter((s) =>
		shown.includes(s.id),
	).map((s) => ({
		id: s.id,
		label: s.label,
		description: s.description,
		toolCount: counts[s.id] ?? 0,
		checked: DEFAULT_ON_SCOPES.includes(s.id),
	}));

	const cancel = new URL(params.redirectUri);
	cancel.searchParams.set("error", "access_denied");
	if (params.state) cancel.searchParams.set("state", params.state);

	return {
		props: {
			error: null,
			clientName: client.name,
			redirectHost: new URL(params.redirectUri).host,
			organizationName: organization?.name ?? null,
			scopes,
			params,
			cancelUrl: cancel.toString(),
		} satisfies Props,
	};
}
