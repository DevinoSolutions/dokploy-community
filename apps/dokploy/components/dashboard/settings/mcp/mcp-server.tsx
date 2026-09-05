import copy from "copy-to-clipboard";
import { formatDistanceToNow } from "date-fns";
import { Copy, Plug, Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

export const McpServer = () => {
	const { data: info } = api.mcp.connectionInfo.useQuery();
	const { data: authorizations, refetch } =
		api.mcp.listAuthorizations.useQuery();
	const { mutateAsync: revoke, isPending: isRevoking } =
		api.mcp.revokeAuthorization.useMutation();

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<Plug className="size-6 text-muted-foreground self-center" />
								MCP Server
							</CardTitle>
							<CardDescription>
								Connect Claude Code (or any MCP client) to this Dokploy over
								HTTPS with OAuth. No API key, no local process.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-6 py-6 border-t">
						{info && !info.enabled && (
							<AlertBlock type="warning">
								{info.reason === "disabled"
									? "The MCP server is disabled on this instance (DOKPLOY_MCP_DISABLED=true)."
									: "The MCP server needs a public origin. Set a domain under Settings → Server (Web Domain), or set BETTER_AUTH_URL."}
							</AlertBlock>
						)}
						{info?.enabled && info.endpoint && info.addCommand && (
							<div className="space-y-3">
								<div className="text-sm">
									<span className="text-muted-foreground">Endpoint: </span>
									<span className="font-mono">{info.endpoint}</span>
								</div>
								<div className="flex items-center gap-2">
									<code className="flex-1 rounded-md bg-muted px-3 py-2 text-xs overflow-x-auto">
										{info.addCommand}
									</code>
									<Button
										variant="outline"
										size="icon"
										type="button"
										onClick={() => {
											copy(info.addCommand ?? "");
											toast.success("Copied");
										}}
									>
										<Copy className="size-4" />
									</Button>
								</div>
								<p className="text-sm text-muted-foreground">
									Then run <code>/mcp</code> in Claude Code and choose
									Authenticate. The browser opens this Dokploy, you pick the
									scopes, and the token is shared by every session on that
									machine. Tokens refresh silently; you only sign in again if
									the client stays unused for {info.refreshTokenDays} days or
									you revoke it here.
								</p>
								<div className="text-sm">
									<span className="text-muted-foreground">
										MCP acts in organization:{" "}
									</span>
									<span className="font-medium">
										{info.organization?.name ?? "none"}
									</span>
									<span className="text-muted-foreground">
										{" "}
										(your default organization —{" "}
										<Link
											href="/dashboard/settings/organization"
											className="underline"
										>
											change it
										</Link>
										).
									</span>
								</div>
							</div>
						)}

						<div className="space-y-2">
							<h3 className="text-sm font-medium">Authorized clients</h3>
							{authorizations && authorizations.length > 0 ? (
								authorizations.map((auth) => (
									<div
										key={auth.clientId}
										className="flex flex-col gap-2 p-4 border rounded-lg"
									>
										<div className="flex justify-between items-start gap-4">
											<div className="flex flex-col gap-1">
												<span className="font-medium">{auth.clientName}</span>
												<div className="flex flex-wrap gap-1">
													{auth.scopes.map((scope) => (
														<Badge key={scope} variant="secondary">
															{scope}
														</Badge>
													))}
												</div>
												<div className="text-xs text-muted-foreground">
													Authorized{" "}
													{formatDistanceToNow(new Date(auth.authorizedAt))} ago
													· last refreshed{" "}
													{formatDistanceToNow(new Date(auth.lastRefreshedAt))}{" "}
													ago
													{auth.refreshExpiresAt &&
														` · expires ${formatDistanceToNow(new Date(auth.refreshExpiresAt), { addSuffix: true })} if unused`}
												</div>
											</div>
											<DialogAction
												title="Revoke MCP authorization"
												description="The client will lose access immediately and must authenticate again."
												type="destructive"
												onClick={async () => {
													try {
														await revoke({ clientId: auth.clientId });
														await refetch();
														toast.success("Authorization revoked");
													} catch (error) {
														toast.error(
															error instanceof Error
																? error.message
																: "Error revoking",
														);
													}
												}}
											>
												<Button
													variant="ghost"
													size="icon"
													isLoading={isRevoking}
												>
													<Trash2 className="size-4" />
												</Button>
											</DialogAction>
										</div>
									</div>
								))
							) : (
								<p className="text-sm text-muted-foreground">
									No MCP client has been authorized yet.
								</p>
							)}
						</div>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
