import { ArrowRight, Server } from "lucide-react";
import Link from "next/link";
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

// Read-only summary of the Dokploy instance (web-server) backup. It is not
// policy-managed — it keeps its own toggle under Web Server settings — so the
// Center only surfaces its state and links out.
export const InstanceBackupCard = () => {
	const { data: user } = api.user.get.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const isPrivileged = user?.role === "owner" || user?.role === "admin";
	const canView = isPrivileged && !isCloud;

	const { data: backupUser } = api.user.getBackups.useQuery(undefined, {
		enabled: canView,
	});

	if (!canView) {
		return null;
	}

	const backups = backupUser?.backups ?? [];
	const enabledCount = backups.filter((backup) => backup.enabled).length;

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<CardTitle className="flex flex-row items-center gap-2 text-xl">
						<Server className="size-6 text-muted-foreground" />
						Instance backup
					</CardTitle>
					<CardDescription>
						The Dokploy web server backup keeps its own schedule under Web
						Server settings.
					</CardDescription>
				</div>
				<Button variant="outline" size="sm" asChild>
					<Link href="/dashboard/settings/server">
						Manage
						<ArrowRight className="size-4" />
					</Link>
				</Button>
			</CardHeader>
			<CardContent>
				{backups.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No web server backup configured.
					</p>
				) : (
					<div className="flex items-center gap-2 text-sm">
						<Badge variant={enabledCount > 0 ? "green" : "blank"}>
							{enabledCount > 0 ? "Active" : "Inactive"}
						</Badge>
						<span className="text-muted-foreground">
							{backups.length} schedule{backups.length === 1 ? "" : "s"}
							{enabledCount !== backups.length && ` (${enabledCount} enabled)`}
						</span>
					</div>
				)}
			</CardContent>
		</Card>
	);
};
