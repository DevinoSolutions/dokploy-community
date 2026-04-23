import { ServerIcon } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { ChangeConcurrencyModal } from "./servers/actions/change-concurrency-modal";
import { ShowDokployActions } from "./servers/actions/show-dokploy-actions";
import { ShowStorageActions } from "./servers/actions/show-storage-actions";
import { ShowTraefikActions } from "./servers/actions/show-traefik-actions";
import { ToggleDockerCleanup } from "./servers/actions/toggle-docker-cleanup";
import { UpdateServer } from "./web-server/update-server";

export const WebServer = () => {
	const { data: webServerSettings } =
		api.settings.getWebServerSettings.useQuery();

	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();

	return (
		<div className="w-full">
			{/* <Card className={cn("rounded-lg w-full bg-transparent p-0", className)}></Card> */}
			<Card className="h-full bg-sidebar  p-2.5 rounded-xl  max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md ">
					<CardHeader className="">
						<CardTitle className="text-xl flex flex-row gap-2">
							<ServerIcon className="size-6 text-muted-foreground self-center" />
							Web Server
						</CardTitle>
						<CardDescription>Reload or clean the web server.</CardDescription>
					</CardHeader>
					{/* <CardHeader>
						<CardTitle className="text-xl">
							Web Server
						</CardTitle>
						<CardDescription>
							Reload or clean the web server.
						</CardDescription>
					</CardHeader> */}
					<CardContent className="space-y-6 py-6 border-t">
						<div className="grid md:grid-cols-2 gap-4">
							<ShowDokployActions />
							<ShowTraefikActions />
							<ShowStorageActions />

							<UpdateServer />
						</div>

						<div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pt-4 border-t">
							<div className="min-w-0">
								<div className="text-sm font-medium">
									Deployment concurrency
								</div>
								<div className="text-xs text-muted-foreground">
									Number of deployments the Dokploy host can run in parallel.
								</div>
							</div>
							<div className="self-end md:self-auto shrink-0">
								<ChangeConcurrencyModal serverId={null} asButton />
							</div>
						</div>

						<div className="flex items-center flex-wrap justify-between gap-4">
							<span className="text-sm text-muted-foreground">
								Server IP: {webServerSettings?.serverIp}
							</span>
							<span className="text-sm text-muted-foreground">
								Version: {dokployVersion}
							</span>

							<ToggleDockerCleanup />
						</div>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
