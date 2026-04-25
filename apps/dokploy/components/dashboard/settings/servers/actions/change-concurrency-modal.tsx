import { Info, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

const MIN = 1;
const MAX = 10;

interface Props {
	// `null` targets the local Dokploy host (persisted on webServerSettings).
	serverId: string | null;
}

export const ChangeConcurrencyModal = ({ serverId }: Props) => {
	const isLocal = serverId === null;
	const [open, setOpen] = useState(false);

	const serverQuery = api.server.one.useQuery(
		{ serverId: serverId ?? "" },
		{ enabled: !isLocal },
	);
	const webServerQuery = api.settings.getWebServerSettings.useQuery(undefined, {
		enabled: isLocal,
	});

	const updateRemote = api.server.updateDeploymentConcurrency.useMutation();
	const updateLocal = api.settings.updateDeploymentConcurrency.useMutation();
	const update = isLocal ? updateLocal : updateRemote;

	const currentConcurrency = isLocal
		? webServerQuery.data?.deploymentConcurrency
		: serverQuery.data?.deploymentConcurrency;

	const [value, setValue] = useState<number>(currentConcurrency ?? 1);

	useEffect(() => {
		if (open && typeof currentConcurrency === "number") {
			setValue(currentConcurrency);
		}
	}, [open, currentConcurrency]);

	const save = async () => {
		if (!Number.isInteger(value) || value < MIN || value > MAX) {
			toast.error(`Concurrency must be an integer between ${MIN} and ${MAX}`);
			return;
		}
		try {
			if (isLocal) {
				await updateLocal.mutateAsync({ deploymentConcurrency: value });
				await webServerQuery.refetch();
			} else {
				await updateRemote.mutateAsync({
					serverId: serverId as string,
					deploymentConcurrency: value,
				});
				await serverQuery.refetch();
			}
			toast.success("Deployment concurrency updated");
			setOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update concurrency",
			);
		}
	};

	const description = isLocal
		? "Number of deployments the Dokploy host can run in parallel. Remote servers are unaffected."
		: "Number of deployments this server may run in parallel. Other servers are unaffected.";

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<DropdownMenuItem
					className="w-full cursor-pointer"
					onSelect={(e) => e.preventDefault()}
				>
					<span>Deployment Concurrency</span>
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Deployment concurrency</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3 py-2">
					<Label htmlFor="deployment-concurrency">Concurrent deployments</Label>
					<Input
						id="deployment-concurrency"
						type="number"
						min={MIN}
						max={MAX}
						step={1}
						value={value}
						onChange={(event) => setValue(Number(event.target.value))}
					/>
					<Alert>
						<Info className="h-4 w-4" />
						<AlertDescription>
							Each concurrent build uses roughly one CPU core and 2&nbsp;GB of
							RAM while active. The value is applied immediately; in-flight
							deployments are not interrupted.
						</AlertDescription>
					</Alert>
				</div>

				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => setOpen(false)}
						disabled={update.isPending}
					>
						Cancel
					</Button>
					<Button onClick={save} disabled={update.isPending}>
						{update.isPending ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Saving…
							</>
						) : (
							"Save"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
