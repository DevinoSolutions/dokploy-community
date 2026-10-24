import {
	apiUpdateDeploymentWatchdog,
	DEFAULT_WATCHDOG_IDLE_MINUTES,
	DEFAULT_WATCHDOG_MAX_MINUTES,
	MIN_WATCHDOG_IDLE_MINUTES,
	MIN_WATCHDOG_MAX_MINUTES,
	resolveWatchdogConfig,
} from "@dokploy/server/utils/deployments/watchdog-config";
import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

/**
 * Settings of the stuck-deployment watchdog: the on/off switch, the two limits,
 * and the services it never touches. Shown on the Deployments settings page,
 * under Concurrent Builds, and not in cloud (it works on the self-hosted queue).
 */
export const DeploymentWatchdog = () => {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: settings, refetch } =
		api.settings.getWebServerSettings.useQuery();
	const { data: projects } = api.project.all.useQuery();
	const { mutateAsync: updateWatchdog, isPending: isSaving } =
		api.settings.updateDeploymentWatchdog.useMutation();
	const { mutateAsync: addExclusion, isPending: isAdding } =
		api.settings.addDeploymentWatchdogExclusion.useMutation();
	const { mutateAsync: removeExclusion, isPending: isRemoving } =
		api.settings.removeDeploymentWatchdogExclusion.useMutation();

	const config = useMemo(() => resolveWatchdogConfig(settings), [settings]);
	const [enabled, setEnabled] = useState(true);
	const [idle, setIdle] = useState(String(DEFAULT_WATCHDOG_IDLE_MINUTES));
	const [wall, setWall] = useState(String(DEFAULT_WATCHDOG_MAX_MINUTES));
	const [service, setService] = useState("");
	const [reason, setReason] = useState("");

	useEffect(() => {
		if (!settings) return;
		setEnabled(config.enabled);
		setIdle(String(config.idleMinutes));
		setWall(String(config.maxMinutes));
	}, [settings, config]);

	// `application:<id>` or `compose:<id>`, so one Select carries both.
	const serviceOptions = useMemo(() => {
		const options: Array<{ value: string; label: string }> = [];
		for (const project of projects ?? []) {
			for (const environment of project.environments ?? []) {
				for (const application of environment.applications ?? []) {
					options.push({
						value: `application:${application.applicationId}`,
						label: `${project.name} / ${environment.name} / ${application.name}`,
					});
				}
				for (const composeService of environment.compose ?? []) {
					options.push({
						value: `compose:${composeService.composeId}`,
						label: `${project.name} / ${environment.name} / ${composeService.name}`,
					});
				}
			}
		}
		return options;
	}, [projects]);

	if (isCloud) return null;

	const parsed = apiUpdateDeploymentWatchdog.safeParse({
		enabled,
		idleMinutes: Number(idle),
		maxMinutes: Number(wall),
	});
	const problem = parsed.success ? null : parsed.error.issues[0]?.message;
	const hasChanges =
		enabled !== config.enabled ||
		Number(idle) !== config.idleMinutes ||
		Number(wall) !== config.maxMinutes;

	const onSave = async () => {
		if (!parsed.success) {
			toast.error(problem ?? "Invalid settings");
			return;
		}
		await updateWatchdog(parsed.data)
			.then(async () => {
				await refetch();
				toast.success("Deployment watchdog updated");
			})
			.catch((error) => {
				toast.error(error.message || "Error updating the deployment watchdog");
			});
	};

	const onAdd = async () => {
		if (!service) {
			toast.error("Select a service to exclude");
			return;
		}
		const [type, id] = service.split(":");
		if ((type !== "application" && type !== "compose") || !id) return;
		await addExclusion({ type, id, reason: reason.trim() || undefined })
			.then(async () => {
				await refetch();
				setService("");
				setReason("");
				toast.success("Service excluded from the watchdog");
			})
			.catch((error) => {
				toast.error(error.message || "Error adding the exclusion");
			});
	};

	const onRemove = async (type: "application" | "compose", id: string) => {
		await removeExclusion({ type, id })
			.then(async () => {
				await refetch();
				toast.success("Exclusion removed");
			})
			.catch((error) => {
				toast.error(error.message || "Error removing the exclusion");
			});
	};

	const labelOf = (type: string, id: string) =>
		serviceOptions.find((option) => option.value === `${type}:${id}`)?.label ??
		`${type} ${id}`;

	return (
		<>
			<CardHeader>
				<CardTitle className="text-xl">Stuck Deployment Watchdog</CardTitle>
				<CardDescription>
					Fails a deployment that has stopped making progress and frees its
					queue slot, so a few hung builds cannot block every deploy. A
					deployment is stopped when its log has had no new output for the idle
					limit, or when it has run for longer than the wall time limit. It is
					marked failed, the deployment-failed notification is sent, and the
					stop is recorded in the cancel trail as the system.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				<div className="flex flex-col gap-3 rounded-lg border p-3">
					<div className="flex flex-row items-center justify-between gap-4">
						<div className="space-y-0.5">
							<p className="text-sm font-medium">Enabled</p>
							<p className="text-xs text-muted-foreground">
								On by default. Turn it off to let deployments run until they end
								by themselves.
							</p>
						</div>
						<Switch checked={enabled} onCheckedChange={setEnabled} />
					</div>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
						<div className="flex flex-col gap-1">
							<p className="text-sm font-medium">Idle limit (minutes)</p>
							<Input
								type="number"
								min={MIN_WATCHDOG_IDLE_MINUTES}
								value={idle}
								onChange={(e) => setIdle(e.target.value)}
								className="w-32"
							/>
							<p className="text-xs text-muted-foreground">
								No new log output. Default {DEFAULT_WATCHDOG_IDLE_MINUTES},
								minimum {MIN_WATCHDOG_IDLE_MINUTES}. It must cover the longest
								silent step of your deploys: a rolling replace waiting for the
								new replica to be healthy (up to 15 minutes), big image pulls
								and pushes.
							</p>
						</div>
						<div className="flex flex-col gap-1">
							<p className="text-sm font-medium">Wall time limit (minutes)</p>
							<Input
								type="number"
								min={MIN_WATCHDOG_MAX_MINUTES}
								value={wall}
								onChange={(e) => setWall(e.target.value)}
								className="w-32"
							/>
							<p className="text-xs text-muted-foreground">
								Total run time. Default {DEFAULT_WATCHDOG_MAX_MINUTES}, minimum{" "}
								{MIN_WATCHDOG_MAX_MINUTES}.
							</p>
						</div>
						<Button
							type="button"
							size="sm"
							onClick={onSave}
							isLoading={isSaving}
							disabled={!hasChanges || !parsed.success}
						>
							Save
						</Button>
					</div>
					{problem && <p className="text-xs text-destructive">{problem}</p>}
				</div>

				<div className="flex flex-col gap-3">
					<p className="text-sm font-medium text-muted-foreground">
						Excluded services
					</p>
					{config.exclusions.length > 0 ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Service</TableHead>
									<TableHead>Reason</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{config.exclusions.map((entry) => (
									<TableRow key={`${entry.type}:${entry.id}`}>
										<TableCell>{labelOf(entry.type, entry.id)}</TableCell>
										<TableCell className="text-muted-foreground">
											{entry.reason || "-"}
										</TableCell>
										<TableCell className="text-right">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												isLoading={isRemoving}
												onClick={() => onRemove(entry.type, entry.id)}
											>
												<Trash2 className="size-4 text-destructive" />
												Remove
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<p className="text-sm text-muted-foreground rounded-lg border border-dashed p-4 text-center">
							No exclusions. The watchdog applies to every service.
						</p>
					)}
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<Select value={service} onValueChange={setService}>
							<SelectTrigger className="sm:w-1/2">
								<SelectValue placeholder="Select a service" />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{serviceOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
						<Input
							placeholder="Reason (optional)"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
						/>
						<Button type="button" isLoading={isAdding} onClick={onAdd}>
							Exclude
						</Button>
					</div>
				</div>
			</CardContent>
		</>
	);
};
