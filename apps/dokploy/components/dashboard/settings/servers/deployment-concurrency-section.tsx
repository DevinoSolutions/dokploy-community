import { Info, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { api } from "@/utils/api";

const MIN = 1;
const MAX = 10;

interface Props {
	serverId: string;
}

/**
 * Inline editor for a remote server's deployment concurrency. Rendered inside
 * the "Deployments" tab of the Setup Server dialog — groups with other
 * deployment-related server configuration.
 */
export const DeploymentConcurrencySection = ({ serverId }: Props) => {
	const serverQuery = api.server.one.useQuery(
		{ serverId },
		{ enabled: !!serverId },
	);
	const update = api.server.updateDeploymentConcurrency.useMutation();

	const currentConcurrency = serverQuery.data?.deploymentConcurrency;
	const [value, setValue] = useState<number>(currentConcurrency ?? 1);

	useEffect(() => {
		if (typeof currentConcurrency === "number") {
			setValue(currentConcurrency);
		}
	}, [currentConcurrency]);

	const isDirty =
		typeof currentConcurrency === "number" && value !== currentConcurrency;
	const isValid = Number.isInteger(value) && value >= MIN && value <= MAX;

	const save = async () => {
		if (!isValid) {
			toast.error(`Concurrency must be an integer between ${MIN} and ${MAX}`);
			return;
		}
		try {
			await update.mutateAsync({
				serverId,
				deploymentConcurrency: value,
			});
			await serverQuery.refetch();
			toast.success("Deployment concurrency updated");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update concurrency",
			);
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Deployment Concurrency</CardTitle>
				<CardDescription>
					Number of deployments this server may run in parallel. Other servers
					are unaffected.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<Label htmlFor="deployment-concurrency">Concurrent deployments</Label>
				<Input
					id="deployment-concurrency"
					type="number"
					min={MIN}
					max={MAX}
					step={1}
					value={value}
					onChange={(event) => setValue(Number(event.target.value))}
					className="max-w-xs"
				/>
				<Alert>
					<Info className="h-4 w-4" />
					<AlertDescription>
						Each concurrent build uses roughly one CPU core and 2&nbsp;GB of RAM
						while active. The value is applied immediately; in-flight
						deployments are not interrupted.
					</AlertDescription>
				</Alert>
				<div>
					<Button
						onClick={save}
						disabled={update.isPending || !isDirty || !isValid}
					>
						{update.isPending ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Saving…
							</>
						) : (
							"Save"
						)}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
};
