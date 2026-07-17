import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	CheckIcon,
	ChevronsUpDown,
	PenBoxIcon,
	PlusIcon,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { ScheduleFormField } from "../application/schedules/handle-schedules";
import {
	type BackupServiceType,
	SERVICE_TYPE_LABELS,
} from "./service-type-icon";

// Client mirror of BACKUP_POLICY_SERVICE_TYPES (kept local so we don't import
// server db schema into the client bundle).
const SERVICE_TYPES: BackupServiceType[] = [
	"application",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"compose",
	"libsql",
];

const Schema = z
	.object({
		name: z.string().min(1, "Name is required"),
		scopeType: z.enum(["organization", "projects", "environments"]),
		scopeIds: z.array(z.string()),
		includeDatabases: z.boolean(),
		includeVolumes: z.boolean(),
		serviceTypeFilter: z.array(z.enum(SERVICE_TYPES)),
		destinationId: z.string().min(1, "Destination is required"),
		schedule: z.string().min(1, "Schedule (Cron) is required"),
		prefix: z.string().optional(),
		keepLatestCount: z.coerce.number().optional(),
		enabled: z.boolean(),
	})
	.superRefine((data, ctx) => {
		if (data.scopeType !== "organization" && data.scopeIds.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					data.scopeType === "projects"
						? "Select at least one project"
						: "Select at least one environment",
				path: ["scopeIds"],
			});
		}
		if (!data.includeDatabases && !data.includeVolumes) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enable database dumps, volume backups, or both",
				path: ["includeDatabases"],
			});
		}
	});

type SchemaType = z.infer<typeof Schema>;

interface Props {
	backupPolicyId?: string;
}

export const HandleBackupPolicy = ({ backupPolicyId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const utils = api.useUtils();

	const { data: destinations = [], isLoading: isLoadingDestinations } =
		api.destination.all.useQuery();
	const { data: projects = [] } = api.project.all.useQuery();
	const { data: policy } = api.backupPolicy.one.useQuery(
		{ backupPolicyId: backupPolicyId ?? "" },
		{ enabled: !!backupPolicyId && isOpen },
	);

	const { mutateAsync, isPending } = backupPolicyId
		? api.backupPolicy.update.useMutation()
		: api.backupPolicy.create.useMutation();

	const form = useForm({
		defaultValues: {
			name: "",
			scopeType: "organization" as SchemaType["scopeType"],
			scopeIds: [] as string[],
			includeDatabases: true,
			includeVolumes: false,
			serviceTypeFilter: [] as BackupServiceType[],
			destinationId: "",
			schedule: "",
			prefix: "",
			keepLatestCount: undefined as number | undefined,
			enabled: true,
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		if (policy && backupPolicyId) {
			form.reset({
				name: policy.name,
				scopeType: policy.scopeType,
				scopeIds: policy.scopeIds ?? [],
				includeDatabases: policy.includeDatabases,
				includeVolumes: policy.includeVolumes,
				serviceTypeFilter:
					(policy.serviceTypeFilter as BackupServiceType[]) ?? [],
				destinationId: policy.destinationId,
				schedule: policy.schedule,
				prefix: policy.prefix ?? "",
				keepLatestCount: policy.keepLatestCount ?? undefined,
				enabled: policy.enabled,
			});
		}
	}, [policy, backupPolicyId, form]);

	const scopeType = form.watch("scopeType");
	const scopeIds = form.watch("scopeIds");
	const serviceTypeFilter = form.watch("serviceTypeFilter");

	const toggleId = (id: string) => {
		const current = form.getValues("scopeIds");
		form.setValue(
			"scopeIds",
			current.includes(id)
				? current.filter((value) => value !== id)
				: [...current, id],
			{ shouldValidate: true },
		);
	};

	const toggleServiceType = (type: BackupServiceType) => {
		const current = form.getValues("serviceTypeFilter");
		form.setValue(
			"serviceTypeFilter",
			current.includes(type)
				? current.filter((value) => value !== type)
				: [...current, type],
		);
	};

	const selectProductionEnvironments = () => {
		const productionIds = projects
			.flatMap((project) => project.environments ?? [])
			.filter((environment) => environment.name.toLowerCase() === "production")
			.map((environment) => environment.environmentId);
		form.setValue("scopeType", "environments");
		form.setValue("scopeIds", productionIds, { shouldValidate: true });
		if (productionIds.length === 0) {
			toast.info('No environments named "production" were found');
		}
	};

	const onSubmit = async (data: SchemaType) => {
		await mutateAsync({
			...(backupPolicyId ? { backupPolicyId } : {}),
			name: data.name,
			scopeType: data.scopeType,
			scopeIds: data.scopeType === "organization" ? [] : data.scopeIds,
			includeDatabases: data.includeDatabases,
			includeVolumes: data.includeVolumes,
			serviceTypeFilter: data.serviceTypeFilter,
			destinationId: data.destinationId,
			schedule: data.schedule,
			prefix: data.prefix || undefined,
			keepLatestCount: data.keepLatestCount ?? undefined,
			enabled: data.enabled,
		} as any)
			.then(async () => {
				toast.success(
					`Backup policy ${backupPolicyId ? "updated" : "created"}`,
				);
				await utils.backupPolicy.all.invalidate();
				await utils.backupPolicy.coverage.invalidate();
				setIsOpen(false);
				if (!backupPolicyId) form.reset();
			})
			.catch(() => {
				toast.error(
					`Error ${backupPolicyId ? "updating" : "creating"} the backup policy`,
				);
			});
	};

	const scopeSummary =
		scopeType === "organization"
			? "All environments in the organization"
			: `${scopeIds.length} ${scopeType === "projects" ? "project" : "environment"}${
					scopeIds.length === 1 ? "" : "s"
				} selected`;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				{backupPolicyId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10 size-8"
					>
						<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button>
						<PlusIcon className="h-4 w-4" />
						Create Policy
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{backupPolicyId ? "Update Backup Policy" : "Create Backup Policy"}
					</DialogTitle>
					<DialogDescription>
						A policy automatically materializes database dump and volume backup
						schedules for every matching service.
					</DialogDescription>
				</DialogHeader>

				{destinations.length === 0 && (
					<AlertBlock type="warning">
						You need at least one S3 destination first. Add one under{" "}
						<Link
							href="/dashboard/settings/destinations"
							className="text-foreground underline"
						>
							S3 Destinations
						</Link>
						.
					</AlertBlock>
				)}

				<Form {...form}>
					<form
						id="hook-form-backup-policy"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Production backups" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="scopeType"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center justify-between">
										<FormLabel>Scope</FormLabel>
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="h-7"
											onClick={selectProductionEnvironments}
										>
											<Sparkles className="mr-1 size-3.5" />
											Production environments
										</Button>
									</div>
									<Select
										value={field.value}
										onValueChange={(value) => {
											field.onChange(value);
											form.setValue("scopeIds", [], { shouldValidate: true });
										}}
									>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="organization">
												Entire organization
											</SelectItem>
											<SelectItem value="projects">
												Specific projects
											</SelectItem>
											<SelectItem value="environments">
												Specific environments
											</SelectItem>
										</SelectContent>
									</Select>
									<FormDescription>{scopeSummary}</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						{scopeType === "projects" && (
							<FormField
								control={form.control}
								name="scopeIds"
								render={() => (
									<FormItem>
										<FormLabel>Projects</FormLabel>
										<Popover>
											<PopoverTrigger asChild>
												<FormControl>
													<Button
														variant="outline"
														className="w-full justify-between"
													>
														{scopeIds.length > 0
															? `${scopeIds.length} selected`
															: "Select projects"}
														<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
													</Button>
												</FormControl>
											</PopoverTrigger>
											<PopoverContent className="p-0" align="start">
												<Command>
													<CommandInput
														placeholder="Search projects..."
														className="h-9"
													/>
													<CommandEmpty>No projects found.</CommandEmpty>
													<ScrollArea className="h-64">
														<CommandGroup>
															{projects.map((project) => (
																<CommandItem
																	value={project.name}
																	key={project.projectId}
																	onSelect={() => toggleId(project.projectId)}
																>
																	{project.name}
																	<CheckIcon
																		className={cn(
																			"ml-auto h-4 w-4",
																			scopeIds.includes(project.projectId)
																				? "opacity-100"
																				: "opacity-0",
																		)}
																	/>
																</CommandItem>
															))}
														</CommandGroup>
													</ScrollArea>
												</Command>
											</PopoverContent>
										</Popover>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						{scopeType === "environments" && (
							<FormField
								control={form.control}
								name="scopeIds"
								render={() => (
									<FormItem>
										<FormLabel>Environments</FormLabel>
										<Popover>
											<PopoverTrigger asChild>
												<FormControl>
													<Button
														variant="outline"
														className="w-full justify-between"
													>
														{scopeIds.length > 0
															? `${scopeIds.length} selected`
															: "Select environments"}
														<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
													</Button>
												</FormControl>
											</PopoverTrigger>
											<PopoverContent className="p-0" align="start">
												<Command>
													<CommandInput
														placeholder="Search environments..."
														className="h-9"
													/>
													<CommandEmpty>No environments found.</CommandEmpty>
													<ScrollArea className="h-64">
														{projects.map((project) => (
															<CommandGroup
																key={project.projectId}
																heading={project.name}
															>
																{(project.environments ?? []).map(
																	(environment) => (
																		<CommandItem
																			value={`${project.name} ${environment.name}`}
																			key={environment.environmentId}
																			onSelect={() =>
																				toggleId(environment.environmentId)
																			}
																		>
																			{environment.name}
																			<CheckIcon
																				className={cn(
																					"ml-auto h-4 w-4",
																					scopeIds.includes(
																						environment.environmentId,
																					)
																						? "opacity-100"
																						: "opacity-0",
																				)}
																			/>
																		</CommandItem>
																	),
																)}
															</CommandGroup>
														))}
													</ScrollArea>
												</Command>
											</PopoverContent>
										</Popover>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						<div className="flex flex-col gap-3 rounded-lg border p-3">
							<FormField
								control={form.control}
								name="includeDatabases"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between">
										<div className="space-y-0.5">
											<FormLabel>Database dumps</FormLabel>
											<FormDescription>
												Logical dumps for PostgreSQL, MySQL, MariaDB, MongoDB
												and LibSQL.
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
								name="includeVolumes"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between">
										<div className="space-y-0.5">
											<FormLabel>Volume backups</FormLabel>
											<FormDescription>
												Redis, applications and Compose are covered via volume
												backups.
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
								name="includeDatabases"
								render={() => <FormMessage />}
							/>
						</div>

						<FormField
							control={form.control}
							name="serviceTypeFilter"
							render={() => (
								<FormItem>
									<FormLabel>Service types (optional)</FormLabel>
									<Popover>
										<PopoverTrigger asChild>
											<FormControl>
												<Button
													variant="outline"
													className="w-full justify-between font-normal"
												>
													{serviceTypeFilter.length > 0
														? `${serviceTypeFilter.length} selected`
														: "All applicable service types"}
													<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
												</Button>
											</FormControl>
										</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
											<Command>
												<CommandInput
													placeholder="Filter service types..."
													className="h-9"
												/>
												<CommandEmpty>No service types.</CommandEmpty>
												<CommandGroup>
													{SERVICE_TYPES.map((type) => (
														<CommandItem
															value={type}
															key={type}
															onSelect={() => toggleServiceType(type)}
														>
															{SERVICE_TYPE_LABELS[type]}
															<CheckIcon
																className={cn(
																	"ml-auto h-4 w-4",
																	serviceTypeFilter.includes(type)
																		? "opacity-100"
																		: "opacity-0",
																)}
															/>
														</CommandItem>
													))}
												</CommandGroup>
											</Command>
										</PopoverContent>
									</Popover>
									{serviceTypeFilter.length > 0 && (
										<div className="flex flex-wrap gap-1.5 pt-1">
											{serviceTypeFilter.map((type) => (
												<Badge key={type} variant="blank">
													{SERVICE_TYPE_LABELS[type]}
												</Badge>
											))}
										</div>
									)}
									<FormDescription>
										Leave empty to cover every applicable service type.
									</FormDescription>
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Destination</FormLabel>
									<Popover>
										<PopoverTrigger asChild>
											<FormControl>
												<Button
													variant="outline"
													className={cn(
														"w-full justify-between",
														!field.value && "text-muted-foreground",
													)}
												>
													{isLoadingDestinations
														? "Loading..."
														: field.value
															? destinations.find(
																	(destination) =>
																		destination.destinationId === field.value,
																)?.name
															: "Select Destination"}
													<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
												</Button>
											</FormControl>
										</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
											<Command>
												<CommandInput
													placeholder="Search Destination..."
													className="h-9"
												/>
												<CommandEmpty>No destinations found.</CommandEmpty>
												<ScrollArea className="h-64">
													<CommandGroup>
														{destinations.map((destination) => (
															<CommandItem
																value={destination.destinationId}
																key={destination.destinationId}
																onSelect={() => {
																	form.setValue(
																		"destinationId",
																		destination.destinationId,
																		{ shouldValidate: true },
																	);
																}}
															>
																{destination.name}
																<CheckIcon
																	className={cn(
																		"ml-auto h-4 w-4",
																		destination.destinationId === field.value
																			? "opacity-100"
																			: "opacity-0",
																	)}
																/>
															</CommandItem>
														))}
													</CommandGroup>
												</ScrollArea>
											</Command>
										</PopoverContent>
									</Popover>
									<FormMessage />
								</FormItem>
							)}
						/>

						<ScheduleFormField name="schedule" formControl={form.control} />

						<FormField
							control={form.control}
							name="prefix"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Prefix (optional)</FormLabel>
									<FormControl>
										<Input placeholder="backups/" {...field} />
									</FormControl>
									<FormDescription>
										Base path in the bucket. Each service gets{" "}
										<code>{"<prefix>/<project>/<service>"}</code>.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="keepLatestCount"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Keep the latest</FormLabel>
									<FormControl>
										<Input
											type="number"
											placeholder="Keeps all backups if left empty"
											{...field}
											value={field.value as number | undefined}
										/>
									</FormControl>
									<FormDescription>
										Optional. If provided, only keeps the latest N backups per
										service in the cloud.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="enabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<FormLabel>Enabled</FormLabel>
										<FormDescription>
											Enable or disable every backup this policy manages.
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
					</form>
				</Form>

				<DialogFooter>
					<Button
						isLoading={isPending}
						form="hook-form-backup-policy"
						type="submit"
						disabled={destinations.length === 0}
					>
						{backupPolicyId ? "Update" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
