import {
	ExternalLink,
	Link2Off,
	Loader2,
	Play,
	PlugZap,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	PoweredByUptimely,
	UptimelyMark,
} from "@/components/dashboard/settings/integrations/uptimely/uptimely-logo";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, type RouterInputs, type RouterOutputs } from "@/utils/api";

type UptimelyServiceType =
	RouterInputs["uptimely"]["serviceStatus"]["serviceType"];
type ServiceStatus = Extract<
	RouterOutputs["uptimely"]["serviceStatus"],
	{ configured: true }
>;
type StatusRef = ServiceStatus["overall"];

interface Props {
	serviceType: UptimelyServiceType;
	serviceId: string;
}

const KIND_LABEL: Record<ServiceStatus["monitors"][number]["kind"], string> = {
	website: "Website",
	port: "Port",
	ssl: "SSL",
	domain: "Domain",
};

const Shell = ({ children }: { children: React.ReactNode }) => (
	<div className="flex flex-col gap-3 rounded-lg border p-4">{children}</div>
);

export const UptimelyStatusPill = ({
	status,
	className,
}: {
	status: StatusRef;
	className?: string;
}) => (
	<span
		className={cn(
			"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
			className,
		)}
	>
		<span
			className="size-2 rounded-full bg-muted-foreground/40"
			style={status?.color ? { backgroundColor: status.color } : undefined}
		/>
		{status?.name ?? "Unknown"}
	</span>
);

const DailyTimeline = ({
	days,
}: {
	days: ServiceStatus["monitors"][number]["timeline"];
}) => (
	<TooltipProvider delayDuration={0}>
		<div className="flex h-5 items-stretch gap-[2px]" aria-label="Last 30 days">
			{days.map((day) => (
				<Tooltip key={day.day}>
					<TooltipTrigger asChild>
						<span
							className="w-1.5 rounded-sm bg-muted"
							style={
								day.status?.color
									? { backgroundColor: day.status.color }
									: undefined
							}
						/>
					</TooltipTrigger>
					<TooltipContent>
						{day.day}: {day.status?.name ?? "No data"}
					</TooltipContent>
				</Tooltip>
			))}
		</div>
	</TooltipProvider>
);

/**
 * Uptimely panel shown above the built-in metrics in a service's Monitoring
 * tab (applications, compose and databases). Monitor creation is opt-in per
 * service; nothing is created until someone presses the button.
 */
export const UptimelyServicePanel = ({ serviceType, serviceId }: Props) => {
	const [includeSslAndDomain, setIncludeSslAndDomain] = useState(false);
	const utils = api.useUtils();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: auth } = api.user.get.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canManage = !!permissions?.service.create;
	const isAdmin = auth?.role === "owner" || auth?.role === "admin";

	const input = { serviceType, serviceId };
	const { data, isPending, error, refetch, isFetching } =
		api.uptimely.serviceStatus.useQuery(input, {
			enabled: isCloud === false && !!serviceId,
			refetchInterval: 60_000,
			refetchOnWindowFocus: false,
			retry: false,
		});

	const linkMutation = api.uptimely.linkService.useMutation();
	const unlinkMutation = api.uptimely.unlinkService.useMutation();
	const probeMutation = api.uptimely.runProbe.useMutation();

	if (isCloud !== false) return null;

	const supportsDomains =
		serviceType === "application" || serviceType === "compose";

	const link = async () => {
		await linkMutation
			.mutateAsync({ ...input, includeSslAndDomain })
			.then(async (result) => {
				toast.success(
					result.created > 0
						? `Created ${result.created} Uptimely monitor${result.created === 1 ? "" : "s"}`
						: "Every monitor already exists",
				);
				await utils.uptimely.serviceStatus.invalidate(input);
			})
			.catch((e) => {
				toast.error("Could not create Uptimely monitors", {
					description: e.message,
				});
				void utils.uptimely.serviceStatus.invalidate(input);
			});
	};

	const unlink = async () => {
		await unlinkMutation
			.mutateAsync(input)
			.then(async () => {
				toast.success("Service unlinked from Uptimely");
				await utils.uptimely.serviceStatus.invalidate(input);
			})
			.catch((e) => {
				toast.error("Could not unlink the service", {
					description: e.message,
				});
			});
	};

	const probe = async (linkId?: string) => {
		await probeMutation
			.mutateAsync({ ...input, ...(linkId ? { linkId } : {}) })
			.then(async (results) => {
				const failed = results.filter((r) => r.error).length;
				if (failed > 0) {
					toast.warning(
						`Probe ran on ${results.length - failed} of ${results.length} monitors`,
						{ description: results.find((r) => r.error)?.error ?? undefined },
					);
				} else {
					toast.success("Probe finished");
				}
				await utils.uptimely.serviceStatus.invalidate(input);
			})
			.catch((e) => {
				toast.error("Could not run the probe", { description: e.message });
			});
	};

	const header = (
		<div className="flex flex-row items-center gap-3">
			<UptimelyMark className="size-8 shrink-0" />
			<div className="flex flex-col">
				<span className="text-sm font-medium">Uptime by Uptimely</span>
				<span className="text-xs text-muted-foreground">
					External uptime, SSL and domain checks every 5 minutes.
				</span>
			</div>
		</div>
	);

	if (isPending) {
		return (
			<Shell>
				<div className="flex flex-row items-center justify-between gap-2">
					{header}
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				</div>
			</Shell>
		);
	}

	if (error) {
		return (
			<Shell>
				{header}
				<span className="text-sm text-red-500">{error.message}</span>
				<PoweredByUptimely />
			</Shell>
		);
	}

	if (!data.configured) {
		return (
			<div className="flex flex-row flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm">
				<span className="flex items-center gap-2 text-muted-foreground">
					<UptimelyMark className="size-5" />
					{isAdmin ? (
						<span>
							Monitor this service with Uptimely: connect it in{" "}
							<Link
								href="/dashboard/settings/integrations"
								className="text-foreground underline"
							>
								Settings → Integrations
							</Link>
							.
						</span>
					) : (
						<span>
							Uptimely monitoring is available once an admin connects it in
							Settings → Integrations.
						</span>
					)}
				</span>
				<PoweredByUptimely />
			</div>
		);
	}

	if (data.monitors.length === 0) {
		return (
			<Shell>
				{header}
				<div className="flex flex-col gap-3 rounded-lg bg-sidebar p-3">
					<span className="text-sm">Monitor this service with Uptimely</span>
					<span className="text-xs text-muted-foreground">
						{supportsDomains
							? "Creates one Website monitor per HTTPS domain of this service."
							: "Creates a Port monitor for the database's external port."}{" "}
						Requires AI write operations to be enabled for the Uptimely project.
					</span>
					{supportsDomains && (
						<div className="flex items-center gap-2">
							<Checkbox
								id={`uptimely-ssl-${serviceId}`}
								checked={includeSslAndDomain}
								onCheckedChange={(v) => setIncludeSslAndDomain(v === true)}
							/>
							<Label
								htmlFor={`uptimely-ssl-${serviceId}`}
								className="text-sm font-normal"
							>
								Also add SSL certificate and domain monitors
							</Label>
						</div>
					)}
					{canManage ? (
						<Button
							className="w-fit"
							onClick={link}
							isLoading={linkMutation.isPending}
						>
							<PlugZap className="size-4" />
							Monitor with Uptimely
						</Button>
					) : (
						<span className="text-xs text-muted-foreground">
							Ask someone who can manage this service to enable monitoring.
						</span>
					)}
				</div>
				<PoweredByUptimely />
			</Shell>
		);
	}

	return (
		<Shell>
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div className="flex flex-row items-center gap-3">
					{header}
					<UptimelyStatusPill status={data.overall} />
				</div>
				<div className="flex flex-row flex-wrap gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => probe()}
						isLoading={probeMutation.isPending}
					>
						<Play className="size-3.5" />
						Run probe now
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => refetch()}
						disabled={isFetching}
						aria-label="Refresh Uptimely status"
					>
						<RefreshCw
							className={cn("size-3.5", isFetching && "animate-spin")}
						/>
					</Button>
					{canManage && supportsDomains && (
						<Button
							variant="ghost"
							size="sm"
							onClick={link}
							isLoading={linkMutation.isPending}
						>
							Add monitors for new domains
						</Button>
					)}
					{canManage && (
						<DialogAction
							title="Unlink from Uptimely"
							description="Dokploy forgets the monitors linked to this service. Uptimely cannot delete monitors over its API, so they keep running there until you delete them in Uptimely."
							type="destructive"
							onClick={unlink}
						>
							<Button
								variant="ghost"
								size="sm"
								isLoading={unlinkMutation.isPending}
							>
								<Link2Off className="size-3.5" />
								Unlink
							</Button>
						</DialogAction>
					)}
				</div>
			</div>

			<div className="flex flex-col divide-y rounded-lg border">
				{data.monitors.map((monitor) => (
					<div
						key={monitor.linkId}
						className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between"
					>
						<div className="flex min-w-0 flex-row items-center gap-2">
							<Badge variant="secondary" className="shrink-0">
								{KIND_LABEL[monitor.kind]}
							</Badge>
							<span className="truncate text-sm" title={monitor.target}>
								{monitor.target}
							</span>
						</div>
						<div className="flex flex-row flex-wrap items-center gap-3">
							{monitor.error ? (
								<span className="text-xs text-red-500">{monitor.error}</span>
							) : (
								<DailyTimeline days={monitor.timeline} />
							)}
							<UptimelyStatusPill status={monitor.status} />
							<a
								href={monitor.url}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							>
								Open in Uptimely
								<ExternalLink className="size-3" />
							</a>
						</div>
					</div>
				))}
			</div>

			<div className="flex flex-row flex-wrap items-center justify-between gap-2">
				{data.badgeUrl ? (
					<a
						href={data.statusPageUrl ?? data.badgeUrl}
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open the Uptimely status page"
					>
						<img
							src={data.badgeUrl}
							alt="Uptimely status badge"
							className="h-5"
						/>
					</a>
				) : (
					<span />
				)}
				<PoweredByUptimely />
			</div>
		</Shell>
	);
};
