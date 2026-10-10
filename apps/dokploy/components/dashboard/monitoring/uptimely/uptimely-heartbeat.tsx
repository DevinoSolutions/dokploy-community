import { ExternalLink, HeartPulse, Link2Off } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type RouterOutputs } from "@/utils/api";
import { formatRelativeTime } from "./uptimely-panel-helpers";

type ServiceStatus = Extract<
	RouterOutputs["uptimely"]["serviceStatus"],
	{ configured: true }
>;

interface Props {
	serviceType: "application" | "compose";
	serviceId: string;
	heartbeat: ServiceStatus["heartbeat"];
	canManage: boolean;
	/** Renders the Uptimely status pill (owned by the panel). */
	renderStatus: (
		status: NonNullable<ServiceStatus["heartbeat"]>["status"],
	) => React.ReactNode;
}

/**
 * Optional "Deploy heartbeat" of the Uptimely panel: an `Incoming Request`
 * monitor that Dokploy pings after every successful deploy, so Uptimely
 * alerts when a service stops deploying.
 */
export const UptimelyHeartbeat = ({
	serviceType,
	serviceId,
	heartbeat,
	canManage,
	renderStatus,
}: Props) => {
	const [pasted, setPasted] = useState("");
	const [error, setError] = useState<string | null>(null);
	const utils = api.useUtils();
	const input = { serviceType, serviceId };
	const refresh = () => utils.uptimely.serviceStatus.invalidate(input);

	const linkMutation = api.uptimely.linkHeartbeat.useMutation();
	const keyMutation = api.uptimely.setHeartbeatKey.useMutation();
	const unlinkMutation = api.uptimely.unlinkHeartbeat.useMutation();

	const link = async () => {
		setError(null);
		await linkMutation
			.mutateAsync(input)
			.then(async (result) => {
				toast.success(
					result.hasKey
						? "Deploy heartbeat created"
						: "Heartbeat monitor created in Uptimely",
				);
				await refresh();
			})
			.catch((e) => {
				setError(e.message);
				toast.error("Could not create the deploy heartbeat", {
					description: e.message,
				});
				void refresh();
			});
	};

	const saveKey = async () => {
		setError(null);
		await keyMutation
			.mutateAsync({ ...input, key: pasted })
			.then(async () => {
				setPasted("");
				toast.success("Heartbeat key saved");
				await refresh();
			})
			.catch((e) => setError(e.message));
	};

	const unlink = async () => {
		await unlinkMutation
			.mutateAsync(input)
			.then(async () => {
				toast.success("Deploy heartbeat removed");
				await refresh();
			})
			.catch((e) => {
				toast.error("Could not remove the deploy heartbeat", {
					description: e.message,
				});
			});
	};

	const lastPing = formatRelativeTime(heartbeat?.lastPingAt);

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<div className="flex flex-row flex-wrap items-center justify-between gap-2">
				<div className="flex flex-col">
					<span className="flex items-center gap-2 text-sm font-medium">
						<HeartPulse className="size-4" />
						Deploy heartbeat
					</span>
					<span className="text-xs text-muted-foreground">
						Pings Uptimely after every successful deploy, so Uptimely alerts you
						when this service stops deploying.
					</span>
				</div>
				{heartbeat && (
					<div className="flex flex-row flex-wrap items-center gap-3">
						{heartbeat.error ? (
							<span className="text-xs text-red-500">{heartbeat.error}</span>
						) : (
							renderStatus(heartbeat.status)
						)}
						<a
							href={heartbeat.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						>
							Open in Uptimely
							<ExternalLink className="size-3" />
						</a>
						{canManage && (
							<DialogAction
								title="Remove the deploy heartbeat"
								description="Dokploy stops pinging and forgets the monitor. Uptimely cannot delete monitors over its API, so the monitor stays there, and reports Offline once it stops receiving pings, until you delete it in Uptimely."
								type="destructive"
								onClick={unlink}
							>
								<Button
									variant="ghost"
									size="sm"
									isLoading={unlinkMutation.isPending}
								>
									<Link2Off className="size-3.5" />
									Remove
								</Button>
							</DialogAction>
						)}
					</div>
				)}
			</div>

			{!heartbeat && (
				<>
					<span className="text-xs text-muted-foreground">
						Creates an Incoming Request monitor in Uptimely. A new heartbeat
						monitor expects a ping every 5 minutes and reports Offline until you
						set the interval that suits this service in the monitor&apos;s
						Settings in Uptimely. Requires AI write operations to be enabled for
						the Uptimely project.
					</span>
					{error && (
						<AlertBlock type="error" className="w-full">
							{error}
						</AlertBlock>
					)}
					{canManage ? (
						<Button
							className="w-fit"
							variant="secondary"
							size="sm"
							onClick={link}
							isLoading={linkMutation.isPending}
						>
							<HeartPulse className="size-3.5" />
							Add deploy heartbeat
						</Button>
					) : (
						<span className="text-xs text-muted-foreground">
							Ask someone who can manage this service to enable it.
						</span>
					)}
				</>
			)}

			{heartbeat && !heartbeat.hasKey && (
				<div className="flex flex-col gap-2">
					<span className="text-xs text-muted-foreground">
						The heartbeat key comes from the monitor&apos;s Settings page in
						Uptimely (Uptimely does not share it over its API). Copy the
						heartbeat URL or the key from there and paste it here. No ping is
						sent until it is saved.
					</span>
					{canManage && (
						<div className="flex flex-row flex-wrap items-center gap-2">
							<Input
								type="password"
								autoComplete="off"
								className="max-w-md"
								placeholder="https://app.getuptimely.com/heartbeat/..."
								value={pasted}
								onChange={(e) => setPasted(e.target.value)}
								aria-label="Heartbeat URL or secret key"
							/>
							<Button
								size="sm"
								onClick={saveKey}
								isLoading={keyMutation.isPending}
								disabled={!pasted.trim()}
							>
								Save key
							</Button>
							<a
								href={heartbeat.settingsUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							>
								Open monitor settings
								<ExternalLink className="size-3" />
							</a>
						</div>
					)}
					{error && (
						<AlertBlock type="error" className="w-full">
							{error}
						</AlertBlock>
					)}
				</div>
			)}

			{heartbeat?.hasKey && (
				<span className="text-xs text-muted-foreground">
					Pinged after every successful deploy
					{lastPing ? ` · Last ping received ${lastPing}` : ""}. Set the
					expected interval in the monitor&apos;s Settings in Uptimely.
				</span>
			)}
		</div>
	);
};
