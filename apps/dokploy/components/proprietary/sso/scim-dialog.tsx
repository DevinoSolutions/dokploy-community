"use client";

import copy from "copy-to-clipboard";
import { Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";
import { useUrl } from "@/utils/hooks/use-url";

interface Props {
	children: ReactNode;
}

interface IssuedToken {
	connectionId: string;
	token: string;
	expiresAt: Date;
}

const shortId = (connectionId: string) =>
	connectionId.replace(/^ba_scim_connection_/, "").slice(0, 12);

export const ScimDialog = ({ children }: Props) => {
	const utils = api.useUtils();
	const baseURL = useUrl();
	const [open, setOpen] = useState(false);
	const [issuedToken, setIssuedToken] = useState<IssuedToken | null>(null);

	const { data: connections = [], isPending } =
		api.scim.listProviders.useQuery(undefined, { enabled: open });
	const { mutateAsync: generateToken, isPending: isGenerating } =
		api.scim.generateToken.useMutation();
	const { mutateAsync: rotateToken, isPending: isRotating } =
		api.scim.rotateToken.useMutation();
	const { mutateAsync: deleteProvider, isPending: isDeleting } =
		api.scim.deleteProvider.useMutation();

	const scimUrl = `${baseURL || "{baseURL}"}/api/auth/scim/v2`;

	const showIssued = (result: {
		connectionId: string;
		scimToken: string;
		expiresAt: Date | string;
	}) =>
		setIssuedToken({
			connectionId: result.connectionId,
			token: result.scimToken,
			expiresAt: new Date(result.expiresAt),
		});

	const handleGenerate = async () => {
		try {
			showIssued(await generateToken({}));
			await utils.scim.listProviders.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to create SCIM connection",
			);
		}
	};

	const handleRotate = async (connectionId: string) => {
		try {
			showIssued(await rotateToken({ connectionId }));
			toast.success(
				"New token issued. The previous token keeps working until it expires.",
			);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to rotate SCIM token",
			);
		}
	};

	const handleDelete = async (connectionId: string) => {
		try {
			await deleteProvider({ connectionId });
			toast.success("SCIM connection removed");
			if (issuedToken?.connectionId === connectionId) setIssuedToken(null);
			await utils.scim.listProviders.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to remove SCIM connection",
			);
		}
	};

	const handleCopy = (value: string, label: string) => {
		copy(value);
		toast.success(`${label} copied`);
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) setIssuedToken(null);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<KeyRound className="size-5" />
						SCIM provisioning
					</DialogTitle>
					<DialogDescription>
						Automatically provision, update, and deactivate users from your
						identity provider (Okta, Entra ID, etc.). Provisioned users join
						this organization with its default role. They still sign in with
						SSO or another login method.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4 py-2">
					<div className="grid gap-1">
						<Label className="text-xs font-medium text-muted-foreground">
							SCIM 2.0 endpoint URL
						</Label>
						<div className="flex items-center gap-2">
							<p className="flex-1 break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
								{scimUrl}
							</p>
							<Button
								variant="outline"
								size="icon"
								className="size-8 shrink-0"
								onClick={() => handleCopy(scimUrl, "Endpoint URL")}
								disabled={!baseURL}
							>
								<Copy className="size-3.5" />
							</Button>
						</div>
					</div>

					{issuedToken && (
						<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
							<p className="text-sm font-medium">
								Bearer token for connection {shortId(issuedToken.connectionId)}
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Copy this token now, it will not be shown again. Paste it into
								your IdP's SCIM configuration. It expires on{" "}
								{issuedToken.expiresAt.toLocaleDateString()}.
							</p>
							<div className="mt-2 flex items-center gap-2">
								<p className="flex-1 break-all rounded-md bg-background px-2 py-1.5 font-mono text-xs">
									{issuedToken.token}
								</p>
								<Button
									variant="outline"
									size="icon"
									className="size-8 shrink-0"
									onClick={() => handleCopy(issuedToken.token, "Bearer token")}
								>
									<Copy className="size-3.5" />
								</Button>
							</div>
						</div>
					)}

					<div className="flex items-center justify-between gap-2">
						<Label className="text-sm font-medium">Connections</Label>
						<Button size="sm" onClick={handleGenerate} disabled={isGenerating}>
							<Plus className="mr-1 size-4" />
							New connection
						</Button>
					</div>
					{isPending ? (
						<div className="flex items-center gap-2 justify-center py-4">
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
							<span className="text-sm text-muted-foreground">Loading...</span>
						</div>
					) : connections.length === 0 ? (
						<p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
							No SCIM connections configured yet.
						</p>
					) : (
						<ul className="flex flex-col gap-2">
							{connections.map((connection) => (
								<li
									key={connection.connectionId}
									className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2"
								>
									<div className="flex-1">
										<p className="font-mono text-sm">
											{shortId(connection.connectionId)}
										</p>
										<p className="text-xs text-muted-foreground">
											{connection.status} · created{" "}
											{new Date(connection.createdAt).toLocaleDateString()}
										</p>
									</div>
									<Button
										variant="ghost"
										size="icon"
										className="size-8 shrink-0"
										title="Issue a new token"
										disabled={isRotating || connection.status !== "active"}
										onClick={() => handleRotate(connection.connectionId)}
									>
										<RefreshCw className="size-3.5" />
									</Button>
									<DialogAction
										title="Remove SCIM connection"
										description="Remove this connection? Its tokens stop working immediately and this cannot be undone. Provisioned users stay, but the IdP can no longer sync them."
										type="destructive"
										onClick={() => handleDelete(connection.connectionId)}
									>
										<Button
											variant="ghost"
											size="icon"
											className="size-8 shrink-0 text-destructive hover:text-destructive"
											disabled={isDeleting}
										>
											<Trash2 className="size-3.5" />
										</Button>
									</DialogAction>
								</li>
							))}
						</ul>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => handleOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
