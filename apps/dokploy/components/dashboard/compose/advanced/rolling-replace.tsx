import {
	composeRollingReplaceSchema,
	ROLLING_DRAIN_DEFAULT_SECONDS,
	ROLLING_DRAIN_MAX_SECONDS,
	ROLLING_DRAIN_MIN_SECONDS,
	ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS,
	ROLLING_HEALTH_TIMEOUT_MAX_SECONDS,
	ROLLING_HEALTH_TIMEOUT_MIN_SECONDS,
} from "@dokploy/server/db/validations/compose-rolling";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

/** An empty input falls back to the default; anything else is validated as typed. */
const toNumber = (value: string, fallback: number) =>
	value.trim() ? Number(value) : fallback;

export const RollingReplaceCompose = ({ composeId }: Props) => {
	const utils = api.useUtils();
	const { mutateAsync } = api.compose.update.useMutation();
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: !!composeId },
	);

	const [enabled, setEnabled] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [timeout, setTimeoutValue] = useState(
		String(ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS),
	);
	const [drain, setDrain] = useState(String(ROLLING_DRAIN_DEFAULT_SECONDS));
	const [saving, setSaving] = useState(false);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!data) return;
		const rolling = data.rollingReplace;
		setEnabled(rolling?.enabled ?? false);
		setSelected(rolling?.services ?? []);
		setTimeoutValue(
			String(
				rolling?.healthTimeoutSeconds ?? ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS,
			),
		);
		setDrain(String(rolling?.drainSeconds ?? ROLLING_DRAIN_DEFAULT_SECONDS));
	}, [data]);

	const timeoutSeconds = toNumber(
		timeout,
		ROLLING_HEALTH_TIMEOUT_DEFAULT_SECONDS,
	);
	const drainSeconds = toNumber(drain, ROLLING_DRAIN_DEFAULT_SECONDS);
	const isStack = data?.composeType === "stack";

	const { data: report, refetch: refetchReport } =
		api.compose.rollingEligibility.useQuery(
			{ composeId, type: "cache" },
			{ enabled: !!composeId, retry: false },
		);

	const candidate = {
		enabled,
		services: selected,
		healthTimeoutSeconds: timeoutSeconds,
		drainSeconds,
	};
	const parsed = composeRollingReplaceSchema.safeParse(candidate);
	const formError = parsed.success
		? null
		: (parsed.error.issues[0]?.message ?? "Invalid settings");

	const toggleService = (name: string, checked: boolean) => {
		setSelected((current) =>
			checked
				? current.includes(name)
					? current
					: [...current, name]
				: current.filter((service) => service !== name),
		);
	};

	const loadServices = async () => {
		setLoading(true);
		try {
			await utils.compose.rollingEligibility.fetch(
				{ composeId, type: "fetch" },
				{ staleTime: 0 },
			);
			await refetchReport();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not load the services",
			);
		} finally {
			setLoading(false);
		}
	};

	const onSave = async () => {
		if (!parsed.success) {
			toast.error(formError ?? "Invalid settings");
			return;
		}
		setSaving(true);
		await mutateAsync({
			composeId,
			// Off with nothing chosen is stored as no setting at all.
			rollingReplace:
				!parsed.data.enabled && parsed.data.services.length === 0
					? null
					: parsed.data,
		})
			.then(async () => {
				await refetch();
				await refetchReport();
				toast.success("Rolling replace updated");
			})
			.catch((error) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Error updating rolling replace",
				);
			})
			.finally(() => setSaving(false));
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Rolling replace</CardTitle>
				<CardDescription>
					Optional, per service, off by default. A selected service is replaced
					by starting a second replica from the new release, waiting until it is
					healthy and only then stopping the old container. A new replica that
					never becomes healthy is removed and the old container keeps serving.
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				{isStack ? (
					<div className="grid gap-3 rounded-lg border p-3 text-sm text-muted-foreground shadow-sm">
						<p>
							Rolling replace is not available for Docker Swarm stacks. Swarm
							rolls a service by itself when the compose asks for it:{" "}
							<code>deploy.update_config.order: start-first</code> together with
							a <code>healthcheck</code>. Dokploy never adds either.
						</p>
						{report?.available && report.stackWarnings.length > 0 && (
							<ul className="grid gap-1">
								{report.stackWarnings.map((warning) => (
									<li key={warning.service}>
										<span className="font-medium text-foreground">
											{warning.service}
										</span>
										: {warning.issues.join("; ")}
									</li>
								))}
							</ul>
						)}
					</div>
				) : (
					<>
						<div className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
							<div className="space-y-0.5">
								<Label>Enable rolling replace</Label>
								<p className="text-sm text-muted-foreground">
									Only the services selected below are rolled; the others are
									deployed as before.
								</p>
							</div>
							<Switch checked={enabled} onCheckedChange={setEnabled} />
						</div>

						<div className="grid gap-2 rounded-lg border p-3 shadow-sm">
							<div className="flex items-center justify-between">
								<Label>Services to roll</Label>
								<Button
									type="button"
									variant="outline"
									size="sm"
									isLoading={loading}
									onClick={loadServices}
								>
									Load services from source
								</Button>
							</div>
							{!report ? (
								<p className="text-sm text-muted-foreground">Loading...</p>
							) : !report.available ? (
								<p className="text-sm text-muted-foreground">{report.reason}</p>
							) : (
								<ul className="grid gap-2">
									{report.services.map((service) => {
										const isSelected = selected.includes(service.name);
										return (
											<li key={service.name} className="grid gap-1">
												<div className="flex items-center gap-2">
													<Checkbox
														id={`rolling-${service.name}`}
														checked={isSelected}
														// A selected service that stopped qualifying can
														// still be unticked.
														disabled={!service.eligible && !isSelected}
														onCheckedChange={(checked) =>
															toggleService(service.name, checked === true)
														}
													/>
													<Label htmlFor={`rolling-${service.name}`}>
														{service.name}
													</Label>
													{service.eligible ? (
														<span className="text-xs text-muted-foreground">
															eligible
														</span>
													) : (
														<span className="text-xs text-destructive">
															not eligible
														</span>
													)}
												</div>
												{!service.eligible && (
													<ul className="ml-6 list-disc text-xs text-muted-foreground">
														{service.blockers.map((blocker) => (
															<li key={blocker.code}>{blocker.message}</li>
														))}
													</ul>
												)}
											</li>
										);
									})}
								</ul>
							)}
							<p className="text-xs text-muted-foreground">
								Databases and other stateful services never belong here. Not
								detected, so your call: singleton workers (two copies run during
								the overlap), migrations at container start (the new version
								migrates while the old one serves), volumes that take an
								exclusive lock (SQLite), and exclusive devices or resource
								limits (doubled during the overlap).
							</p>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<div className="grid gap-2">
								<Label htmlFor="rolling-timeout">
									Health timeout (seconds)
								</Label>
								<Input
									id="rolling-timeout"
									type="number"
									min={ROLLING_HEALTH_TIMEOUT_MIN_SECONDS}
									max={ROLLING_HEALTH_TIMEOUT_MAX_SECONDS}
									value={timeout}
									onChange={(event) => setTimeoutValue(event.target.value)}
								/>
								<p className="text-xs text-muted-foreground">
									{ROLLING_HEALTH_TIMEOUT_MIN_SECONDS} to{" "}
									{ROLLING_HEALTH_TIMEOUT_MAX_SECONDS}. Raised automatically
									when a service's{" "}
									<code>start_period + retries x (interval + timeout)</code>{" "}
									needs longer.
								</p>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="rolling-drain">Drain delay (seconds)</Label>
								<Input
									id="rolling-drain"
									type="number"
									min={ROLLING_DRAIN_MIN_SECONDS}
									max={ROLLING_DRAIN_MAX_SECONDS}
									value={drain}
									onChange={(event) => setDrain(event.target.value)}
								/>
								<p className="text-xs text-muted-foreground">
									{ROLLING_DRAIN_MIN_SECONDS} to {ROLLING_DRAIN_MAX_SECONDS}.
									Wait between "new replica healthy" and "stop the old
									container". It does not make the old container unroutable: add
									a Traefik retry middleware for the stop window (see the docs).
								</p>
							</div>
						</div>

						{formError && enabled && (
							<p className="text-sm text-destructive">{formError}</p>
						)}
						<div className="flex w-full items-end justify-end">
							<Button
								type="button"
								className="lg:w-fit"
								isLoading={saving}
								disabled={enabled && !parsed.success}
								onClick={onSave}
							>
								Save
							</Button>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
};
