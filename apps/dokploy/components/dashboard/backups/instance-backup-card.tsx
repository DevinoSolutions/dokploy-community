import { Server } from "lucide-react";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ShowBackups } from "../database/backups/show-backups";

// The Instance tab renders the exact Web Server Backups card used on
// Settings → Server (schedules, destination/database/prefix, run/edit/delete
// actions and Restore). Web-server backups are local-only and admin-managed, so
// this is hidden on cloud and for non-privileged members.
export const InstanceBackupCard = () => {
	const { data: user } = api.user.get.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();

	const isPrivileged = user?.role === "owner" || user?.role === "admin";

	if (isCloud || !isPrivileged) {
		return (
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="flex flex-row items-center gap-2 text-xl">
						<Server className="size-6 text-muted-foreground" />
						Instance backup
					</CardTitle>
					<CardDescription>
						The Dokploy web server backup is managed by an administrator on a
						self-hosted instance.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	return (
		<ShowBackups
			id={user?.userId ?? ""}
			databaseType="web-server"
			backupType="database"
		/>
	);
};
