import { TimerOff } from "lucide-react";
import { toast } from "sonner";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	id: string;
	type: "application" | "compose";
}

/**
 * "Exclude from the stuck-deployment watchdog": a service owner opts this
 * service out of the automatic failing of stuck deployments. Off by default.
 * Self-hosted only (the watchdog works on the self-hosted queue).
 */
export const WatchdogExclusion = ({ id, type }: Props) => {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const applicationQuery = api.application.watchdogExclusion.useQuery(
		{ applicationId: id },
		{ enabled: type === "application" && !!id && !isCloud },
	);
	const composeQuery = api.compose.watchdogExclusion.useQuery(
		{ composeId: id },
		{ enabled: type === "compose" && !!id && !isCloud },
	);
	const { mutateAsync: setApplication, isPending: isSavingApplication } =
		api.application.setWatchdogExclusion.useMutation();
	const { mutateAsync: setCompose, isPending: isSavingCompose } =
		api.compose.setWatchdogExclusion.useMutation();

	if (isCloud) return null;

	const query = type === "application" ? applicationQuery : composeQuery;
	const isSaving = isSavingApplication || isSavingCompose;
	const excluded = query.data?.excluded ?? false;

	const onChange = async (value: boolean) => {
		try {
			if (type === "application") {
				await setApplication({ applicationId: id, excluded: value });
			} else {
				await setCompose({ composeId: id, excluded: value });
			}
			await query.refetch();
			toast.success(
				value
					? "Excluded from the stuck-deployment watchdog"
					: "The stuck-deployment watchdog applies again",
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Error saving the setting",
			);
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div className="flex flex-row items-center gap-2">
					<TimerOff className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">
							Exclude from the stuck-deployment watchdog
						</CardTitle>
						<CardDescription>
							When on, a deployment of this service is never failed
							automatically for a silent log or for running too long, and its
							queue slot is never released by force. Off by default.
							{query.data && !query.data.watchdogEnabled
								? " The watchdog is currently turned off for the whole instance."
								: ""}
						</CardDescription>
					</div>
				</div>
				<Switch
					checked={excluded}
					disabled={isSaving || query.isLoading}
					onCheckedChange={onChange}
				/>
			</CardHeader>
		</Card>
	);
};
