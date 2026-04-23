import { Info, Loader2, Workflow } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

const MIN = 1;
const MAX = 10;

interface Props {
	/**
	 * Target of the concurrency change.
	 * - A `serverId` string: configures a remote server.
	 * - `null`: configures the local Dokploy host (persisted on `webServerSettings`).
	 */
	serverId: string | null;
	/** When true, render as a small icon button matching the other card actions. */
	asButton?: boolean;
}

/**
 * Lets operators raise or lower the number of deployments that can run in
 * parallel on a given deployment target. The change lands in the DB and is
 * pushed into the live in-memory queue the same tick — no restart needed.
 *
 * In-flight jobs keep running; pending jobs stay queued. Lowering the value
 * does NOT kill anything currently executing.
 */
export const ChangeConcurrencyModal = ({
	serverId,
	asButton = false,
}: Props) => {
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

	// Keep the input in sync when the query resolves / dialog opens.
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
				{asButton ? (
					<Button variant="outline" size="icon" className="h-9 w-9">
						<Workflow className="h-4 w-4" />
					</Button>
				) : (
					<Button variant="outline" className="w-full justify-start gap-2">
						<Workflow className="h-4 w-4" />
						Deployment concurrency
					</Button>
				)}
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
