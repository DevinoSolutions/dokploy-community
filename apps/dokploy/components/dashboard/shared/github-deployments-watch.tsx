import { Github, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	id: string;
	type: "application" | "compose";
}

const REPO = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;

/**
 * "Deploy from GitHub Deployments": the service follows a repository's GitHub
 * Deployments instead of being called by GitHub Actions, so Dokploy can stay
 * behind Tailscale or a private network. Self-hosted only.
 */
export const GithubDeploymentsWatch = ({ id, type }: Props) => {
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const enabledQueries = isCloud === false && !!permissions?.gitProviders.read;
	const { data: connections } = api.githubDeployment.connections.useQuery(
		undefined,
		{ enabled: enabledQueries },
	);
	const { data: watch, isPending } = api.githubDeployment.watchOne.useQuery(
		{ serviceType: type, serviceId: id },
		{ enabled: enabledQueries && !!id },
	);
	const { mutateAsync: save, isPending: isSaving } =
		api.githubDeployment.watchSet.useMutation();
	const { mutateAsync: remove, isPending: isRemoving } =
		api.githubDeployment.watchRemove.useMutation();

	const [connectionId, setConnectionId] = useState("");
	const [repository, setRepository] = useState("");
	const [environment, setEnvironment] = useState("production");
	const [enabled, setEnabled] = useState(true);
	const [postLogUrl, setPostLogUrl] = useState(false);

	useEffect(() => {
		if (watch) {
			setConnectionId(watch.connectionId);
			setRepository(`${watch.owner}/${watch.repo}`);
			setEnvironment(watch.environment);
			setEnabled(watch.enabled);
			setPostLogUrl(watch.postLogUrl);
		}
	}, [watch]);

	if (!enabledQueries) return null;

	const parsed = REPO.exec(repository.trim());
	const canSave = !!parsed && !!connectionId && environment.trim().length > 0;

	const onSave = async () => {
		if (!parsed) return;
		try {
			await save({
				serviceType: type,
				serviceId: id,
				connectionId,
				owner: parsed[1] as string,
				repo: parsed[2] as string,
				environment: environment.trim(),
				enabled,
				postLogUrl,
			});
			await utils.githubDeployment.watchOne.invalidate();
			toast.success(
				"Saved. New GitHub deployments of this repository will deploy.",
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Error saving");
		}
	};

	const onRemove = async () => {
		try {
			await remove({ serviceType: type, serviceId: id });
			setRepository("");
			await utils.githubDeployment.watchOne.invalidate();
			toast.success("This service no longer follows GitHub Deployments");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Error removing");
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<div className="flex flex-row items-center gap-2">
					<Github className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">
							Deploy from GitHub Deployments
						</CardTitle>
						<CardDescription>
							Dokploy asks GitHub for new deployments of a repository and
							deploys the ones that name this service ({id}) and carry an image
							pinned by digest. Nothing connects inbound, so Dokploy can stay on
							a private network.
						</CardDescription>
					</div>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isPending ? (
					<Loader2 className="animate-spin size-4 text-muted-foreground" />
				) : !connections?.length ? (
					<span className="text-sm text-muted-foreground">
						Connect a GitHub account first, under{" "}
						<Link
							href="/dashboard/settings/git-providers"
							className="underline"
						>
							Settings &gt; Git Providers
						</Link>
						.
					</span>
				) : (
					<>
						<div className="grid gap-4 md:grid-cols-3">
							<div className="flex flex-col gap-2">
								<Label>GitHub account</Label>
								<Select value={connectionId} onValueChange={setConnectionId}>
									<SelectTrigger>
										<SelectValue placeholder="Select an account" />
									</SelectTrigger>
									<SelectContent>
										{connections.map((connection) => (
											<SelectItem
												key={connection.connectionId}
												value={connection.connectionId}
											>
												{connection.githubLogin}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Repository</Label>
								<Input
									placeholder="owner/name"
									value={repository}
									onChange={(event) => setRepository(event.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Environment</Label>
								<Input
									placeholder="production"
									value={environment}
									onChange={(event) => setEnvironment(event.target.value)}
								/>
							</div>
						</div>
						<div className="flex flex-row items-center gap-2">
							<Switch checked={enabled} onCheckedChange={setEnabled} />
							<Label>Enabled</Label>
						</div>
						<div className="flex flex-col gap-1">
							<div className="flex flex-row items-center gap-2">
								<Switch checked={postLogUrl} onCheckedChange={setPostLogUrl} />
								<Label>Send the Dokploy link to GitHub</Label>
							</div>
							<span className="text-xs text-muted-foreground">
								Off by default. GitHub shows the deployment statuses to everyone
								who can see the repository, so the link to this Dokploy is only
								sent when you turn this on. Statuses never carry error details.
							</span>
						</div>
						{watch && (
							<div className="text-xs text-muted-foreground flex flex-col gap-1">
								{watch.inflightDeploymentId !== null && (
									<span>
										Deploying GitHub deployment #{watch.inflightDeploymentId}
									</span>
								)}
								{watch.lastCheckedAt && (
									<span>
										Last checked{" "}
										{new Date(watch.lastCheckedAt).toLocaleString()}
									</span>
								)}
								{watch.lastError && (
									<span className="text-destructive">{watch.lastError}</span>
								)}
							</div>
						)}
						<div className="flex flex-row gap-2">
							<Button onClick={onSave} isLoading={isSaving} disabled={!canSave}>
								Save
							</Button>
							{watch && (
								<Button
									variant="outline"
									onClick={onRemove}
									isLoading={isRemoving}
								>
									Stop following
								</Button>
							)}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
};
