import {
	type DeployGuardrails,
	deployHealthCheckSchema,
	deployStallSnapshotSchema,
	HEALTH_CHECK_TIMEOUT_DEFAULT_SECONDS,
	HEALTH_CHECK_TIMEOUT_MAX_SECONDS,
	HEALTH_CHECK_TIMEOUT_MIN_SECONDS,
	STALL_SNAPSHOT_AFTER_DEFAULT_SECONDS,
	STALL_SNAPSHOT_AFTER_MAX_SECONDS,
	STALL_SNAPSHOT_AFTER_MIN_SECONDS,
	STALL_SNAPSHOT_EVERY_DEFAULT_SECONDS,
	STALL_SNAPSHOT_EVERY_MAX_SECONDS,
	STALL_SNAPSHOT_EVERY_MIN_SECONDS,
	STALL_SNAPSHOT_MAX_DEFAULT,
	STALL_SNAPSHOT_MAX_MAX,
	STALL_SNAPSHOT_MAX_MIN,
} from "@dokploy/server/db/validations/compose-guardrails";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
}

const schema = z
	.object({
		phaseTimestamps: z.boolean(),
		dockerEvents: z.boolean(),
		healthCheckEnabled: z.boolean(),
		healthCheckUrl: z.string(),
		healthCheckTimeout: z.string(),
		healthCheckStatus: z.string(),
		stallSnapshotEnabled: z.boolean(),
		stallSnapshotAfter: z.string(),
		stallSnapshotEvery: z.string(),
		stallSnapshotMax: z.string(),
	})
	.superRefine((values, ctx) => {
		if (values.healthCheckEnabled) {
			const parsed = deployHealthCheckSchema.safeParse(toHealthCheck(values));
			if (!parsed.success) {
				const fields: Record<
					string,
					"healthCheckUrl" | "healthCheckTimeout" | "healthCheckStatus"
				> = {
					url: "healthCheckUrl",
					timeoutSeconds: "healthCheckTimeout",
					expectedStatus: "healthCheckStatus",
				};
				for (const issue of parsed.error.issues) {
					ctx.addIssue({
						code: "custom",
						message: issue.message,
						path: [fields[String(issue.path[0])] ?? "healthCheckUrl"],
					});
				}
			}
		}
		if (values.stallSnapshotEnabled) {
			const parsed = deployStallSnapshotSchema.safeParse(
				toStallSnapshot(values),
			);
			if (!parsed.success) {
				const fields: Record<
					string,
					"stallSnapshotAfter" | "stallSnapshotEvery" | "stallSnapshotMax"
				> = {
					afterSeconds: "stallSnapshotAfter",
					everySeconds: "stallSnapshotEvery",
					maxSnapshots: "stallSnapshotMax",
				};
				for (const issue of parsed.error.issues) {
					ctx.addIssue({
						code: "custom",
						message: issue.message,
						path: [fields[String(issue.path[0])] ?? "stallSnapshotAfter"],
					});
				}
			}
		}
	});

type Schema = z.infer<typeof schema>;

const toHealthCheck = (values: {
	healthCheckUrl: string;
	healthCheckTimeout: string;
	healthCheckStatus: string;
}) => ({
	url: values.healthCheckUrl.trim(),
	timeoutSeconds: values.healthCheckTimeout.trim()
		? Number(values.healthCheckTimeout)
		: HEALTH_CHECK_TIMEOUT_DEFAULT_SECONDS,
	expectedStatus: values.healthCheckStatus.trim()
		? Number(values.healthCheckStatus)
		: undefined,
});

// An empty input falls back to the default; anything else is validated as typed.
const toNumber = (value: string, fallback: number) =>
	value.trim() ? Number(value) : fallback;

const toStallSnapshot = (values: {
	stallSnapshotAfter: string;
	stallSnapshotEvery: string;
	stallSnapshotMax: string;
}) => ({
	afterSeconds: toNumber(
		values.stallSnapshotAfter,
		STALL_SNAPSHOT_AFTER_DEFAULT_SECONDS,
	),
	everySeconds: toNumber(
		values.stallSnapshotEvery,
		STALL_SNAPSHOT_EVERY_DEFAULT_SECONDS,
	),
	maxSnapshots: toNumber(values.stallSnapshotMax, STALL_SNAPSHOT_MAX_DEFAULT),
});

// The health check does not apply to swarm stacks, so a stack never saves one
// (a stale value from before the type changed is dropped on the next save).
const toGuardrails = (
	values: Schema,
	isStack: boolean,
): DeployGuardrails | null => {
	const healthCheckEnabled = values.healthCheckEnabled && !isStack;
	if (
		!values.phaseTimestamps &&
		!values.dockerEvents &&
		!healthCheckEnabled &&
		!values.stallSnapshotEnabled
	) {
		return null;
	}
	return {
		phaseTimestamps: values.phaseTimestamps,
		dockerEvents: values.dockerEvents,
		healthCheck: healthCheckEnabled ? toHealthCheck(values) : null,
		stallSnapshot: values.stallSnapshotEnabled ? toStallSnapshot(values) : null,
	};
};

const defaultValues: Schema = {
	phaseTimestamps: false,
	dockerEvents: false,
	healthCheckEnabled: false,
	healthCheckUrl: "",
	healthCheckTimeout: String(HEALTH_CHECK_TIMEOUT_DEFAULT_SECONDS),
	healthCheckStatus: "",
	stallSnapshotEnabled: false,
	stallSnapshotAfter: String(STALL_SNAPSHOT_AFTER_DEFAULT_SECONDS),
	stallSnapshotEvery: String(STALL_SNAPSHOT_EVERY_DEFAULT_SECONDS),
	stallSnapshotMax: String(STALL_SNAPSHOT_MAX_DEFAULT),
};

export const DeployGuardrailsCompose = ({ composeId }: Props) => {
	const { mutateAsync } = api.compose.update.useMutation();
	const { data, refetch } = api.compose.one.useQuery(
		{ composeId },
		{ enabled: !!composeId },
	);

	const form = useForm<Schema>({
		defaultValues,
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			const guardrails = data.deployGuardrails;
			form.reset({
				phaseTimestamps: guardrails?.phaseTimestamps ?? false,
				dockerEvents: guardrails?.dockerEvents ?? false,
				healthCheckEnabled:
					!!guardrails?.healthCheck && data.composeType !== "stack",
				healthCheckUrl: guardrails?.healthCheck?.url ?? "",
				healthCheckTimeout: String(
					guardrails?.healthCheck?.timeoutSeconds ??
						HEALTH_CHECK_TIMEOUT_DEFAULT_SECONDS,
				),
				healthCheckStatus:
					guardrails?.healthCheck?.expectedStatus !== undefined
						? String(guardrails.healthCheck.expectedStatus)
						: "",
				stallSnapshotEnabled: !!guardrails?.stallSnapshot,
				stallSnapshotAfter: String(
					guardrails?.stallSnapshot?.afterSeconds ??
						STALL_SNAPSHOT_AFTER_DEFAULT_SECONDS,
				),
				stallSnapshotEvery: String(
					guardrails?.stallSnapshot?.everySeconds ??
						STALL_SNAPSHOT_EVERY_DEFAULT_SECONDS,
				),
				stallSnapshotMax: String(
					guardrails?.stallSnapshot?.maxSnapshots ?? STALL_SNAPSHOT_MAX_DEFAULT,
				),
			});
		}
	}, [form, data]);

	const healthCheckEnabled = form.watch("healthCheckEnabled");
	const stallSnapshotEnabled = form.watch("stallSnapshotEnabled");
	const isStack = data?.composeType === "stack";

	const onSubmit = async (values: Schema) => {
		await mutateAsync({
			composeId,
			deployGuardrails: toGuardrails(values, isStack),
		})
			.then(async () => {
				await refetch();
				toast.success("Deploy guardrails updated");
			})
			.catch(() => {
				toast.error("Error updating the deploy guardrails");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Deploy guardrails</CardTitle>
				<CardDescription>
					Optional diagnostics for slow or flaky deployments. All of them are
					off by default and change nothing about how the service is deployed.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						id="deploy-guardrails-form"
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="phaseTimestamps"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
									<div className="space-y-0.5">
										<FormLabel>Phase timestamps</FormLabel>
										<FormDescription>
											Write a UTC timestamp and the elapsed seconds at every
											phase boundary of the deploy log (fetch, build or pull,{" "}
											<code>compose up</code>, health check, done or error).
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="dockerEvents"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-sm">
									<div className="space-y-0.5">
										<FormLabel>Capture Docker events</FormLabel>
										<FormDescription>
											Record <code>docker events</code> for this project while{" "}
											<code>compose up</code> runs and append them (last 500
											lines) to the deploy log. Only that window is covered, and
											it runs on the host that runs <code>compose up</code>.
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
						<div className="flex flex-col gap-4 rounded-lg border p-3 shadow-sm">
							<FormField
								control={form.control}
								name="stallSnapshotEnabled"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between">
										<div className="space-y-0.5">
											<FormLabel>Stall snapshots</FormLabel>
											<FormDescription>
												Logs the project's container states while{" "}
												<code>compose up</code> is slow. Observe only.
												{isStack && (
													<>
														{" "}
														For Docker Swarm stacks,{" "}
														<code>docker stack deploy</code> usually returns
														before the tasks converge, so snapshots rarely fire.
													</>
												)}
											</FormDescription>
										</div>
										<FormControl>
											<Switch
												checked={field.value}
												onCheckedChange={field.onChange}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
							{stallSnapshotEnabled && (
								<div className="grid gap-4 md:grid-cols-3">
									<FormField
										control={form.control}
										name="stallSnapshotAfter"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Start after (seconds)</FormLabel>
												<FormControl>
													<Input
														type="number"
														min={STALL_SNAPSHOT_AFTER_MIN_SECONDS}
														max={STALL_SNAPSHOT_AFTER_MAX_SECONDS}
														{...field}
													/>
												</FormControl>
												<FormDescription>
													{STALL_SNAPSHOT_AFTER_MIN_SECONDS} to{" "}
													{STALL_SNAPSHOT_AFTER_MAX_SECONDS}.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="stallSnapshotEvery"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Repeat every (seconds)</FormLabel>
												<FormControl>
													<Input
														type="number"
														min={STALL_SNAPSHOT_EVERY_MIN_SECONDS}
														max={STALL_SNAPSHOT_EVERY_MAX_SECONDS}
														{...field}
													/>
												</FormControl>
												<FormDescription>
													{STALL_SNAPSHOT_EVERY_MIN_SECONDS} to{" "}
													{STALL_SNAPSHOT_EVERY_MAX_SECONDS}.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="stallSnapshotMax"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Maximum snapshots</FormLabel>
												<FormControl>
													<Input
														type="number"
														min={STALL_SNAPSHOT_MAX_MIN}
														max={STALL_SNAPSHOT_MAX_MAX}
														{...field}
													/>
												</FormControl>
												<FormDescription>
													{STALL_SNAPSHOT_MAX_MIN} to {STALL_SNAPSHOT_MAX_MAX}.
													Each lists at most 200 lines and stops when{" "}
													<code>up</code> returns. It runs on the host that runs{" "}
													<code>up</code>.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
							)}
						</div>
						{isStack ? (
							<p className="rounded-lg border p-3 text-sm text-muted-foreground shadow-sm">
								The health check is not available for Docker Swarm stacks:{" "}
								<code>docker stack deploy</code> returns before the services are
								ready, so it could not tell whether the release is healthy.
							</p>
						) : (
							<div className="flex flex-col gap-4 rounded-lg border p-3 shadow-sm">
								<FormField
									control={form.control}
									name="healthCheckEnabled"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between">
											<div className="space-y-0.5">
												<FormLabel>Health check before done</FormLabel>
												<FormDescription>
													After <code>compose up</code> returns, poll a URL from
													the same host every 2 seconds. The deployment is only
													marked done once it answers. On timeout it is marked
													error and the failure notifications are sent. The new
													release is left running; it is not rolled back.
												</FormDescription>
											</div>
											<FormControl>
												<Switch
													checked={field.value}
													onCheckedChange={field.onChange}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
								{healthCheckEnabled && (
									<div className="grid gap-4 md:grid-cols-3">
										<FormField
											control={form.control}
											name="healthCheckUrl"
											render={({ field }) => (
												<FormItem className="md:col-span-3">
													<FormLabel>URL</FormLabel>
													<FormControl>
														<Input
															placeholder="http://localhost:3000/health"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														http or https, as reachable from the host that runs
														the deployment. Up to 5 redirects are followed. Only
														the scheme, host and path are written to the log.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="healthCheckTimeout"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Timeout (seconds)</FormLabel>
													<FormControl>
														<Input
															type="number"
															min={HEALTH_CHECK_TIMEOUT_MIN_SECONDS}
															max={HEALTH_CHECK_TIMEOUT_MAX_SECONDS}
															{...field}
														/>
													</FormControl>
													<FormDescription>
														{HEALTH_CHECK_TIMEOUT_MIN_SECONDS} to{" "}
														{HEALTH_CHECK_TIMEOUT_MAX_SECONDS}.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="healthCheckStatus"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Expected status</FormLabel>
													<FormControl>
														<Input
															type="number"
															placeholder="Any 2xx"
															{...field}
														/>
													</FormControl>
													<FormDescription>
														Leave empty to accept any 2xx.
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									</div>
								)}
							</div>
						)}
						<div className="flex w-full items-end justify-end">
							<Button
								form="deploy-guardrails-form"
								type="submit"
								className="lg:w-fit"
								isLoading={form.formState.isSubmitting}
							>
								Save
							</Button>
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
