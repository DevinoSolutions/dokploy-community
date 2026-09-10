import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const buildPolicySchema = z.object({
	enforceRemoteBuilds: z.boolean(),
	defaultBuildServerId: z.string(),
	defaultRegistryId: z.string(),
	requiredChecksTimeoutMinutes: z.number().int().min(1).max(720),
});

type BuildPolicyForm = z.infer<typeof buildPolicySchema>;

export const BuildPolicy = () => {
	const { data, refetch } = api.buildPolicy.settings.useQuery();
	const { data: buildServers } = api.server.buildServers.useQuery();
	const { data: registries } = api.registry.all.useQuery();
	const { mutateAsync, isPending } =
		api.buildPolicy.updateSettings.useMutation();

	const form = useForm<BuildPolicyForm>({
		defaultValues: {
			enforceRemoteBuilds: false,
			defaultBuildServerId: "none",
			defaultRegistryId: "none",
			requiredChecksTimeoutMinutes: 30,
		},
		resolver: zodResolver(buildPolicySchema),
	});

	const enforceRemoteBuilds = form.watch("enforceRemoteBuilds");
	const defaultBuildServerId = form.watch("defaultBuildServerId");
	const defaultRegistryId = form.watch("defaultRegistryId");

	useEffect(() => {
		if (data) {
			form.reset({
				enforceRemoteBuilds: data.enforceRemoteBuilds,
				defaultBuildServerId: data.defaultBuildServerId ?? "none",
				defaultRegistryId: data.defaultRegistryId ?? "none",
				requiredChecksTimeoutMinutes: data.requiredChecksTimeoutMinutes,
			});
		}
	}, [form, data]);

	const isMisconfigured =
		enforceRemoteBuilds &&
		(defaultBuildServerId === "none" || defaultRegistryId === "none");

	const onSubmit = async (formData: BuildPolicyForm) => {
		await mutateAsync({
			enforceRemoteBuilds: formData.enforceRemoteBuilds,
			defaultBuildServerId:
				formData.defaultBuildServerId === "none"
					? null
					: formData.defaultBuildServerId,
			defaultRegistryId:
				formData.defaultRegistryId === "none"
					? null
					: formData.defaultRegistryId,
			requiredChecksTimeoutMinutes: formData.requiredChecksTimeoutMinutes,
		})
			.then(async () => {
				await refetch();
				toast.success("Build policy settings saved");
			})
			.catch(() => {
				toast.error("Error saving build policy settings");
			});
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<ShieldCheck className="size-6 text-muted-foreground self-center" />
								Build Policy
							</CardTitle>
							<CardDescription>
								Force GitHub-sourced applications to build on the organization
								build server, push to the registry, and deploy by digest.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-4 py-6 border-t">
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								className="space-y-4"
							>
								<FormField
									control={form.control}
									name="enforceRemoteBuilds"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between p-3 border rounded-lg shadow-sm">
											<div className="space-y-0.5">
												<FormLabel>Enforce Remote Builds</FormLabel>
												<FormDescription>
													When enabled, GitHub-sourced applications are pinned
													to the organization build server and deployed by
													image digest.
												</FormDescription>
												<FormMessage />
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

								{isMisconfigured && (
									<AlertBlock type="warning">
										Enforcement is on but no default build server or registry is
										selected. Deploys of GitHub-sourced applications will fail
										with a clear error rather than silently building locally.
									</AlertBlock>
								)}

								<FormField
									control={form.control}
									name="defaultBuildServerId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Default Build Server</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value || "none"}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select a build server" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													<SelectGroup>
														<SelectItem value="none">
															<span className="flex items-center gap-2">
																<span>None</span>
															</span>
														</SelectItem>
														{buildServers?.map((server) => (
															<SelectItem
																key={server.serverId}
																value={server.serverId}
															>
																<span className="flex items-center gap-2 justify-between w-full">
																	<span>{server.name}</span>
																	<span className="text-muted-foreground text-xs">
																		{server.ipAddress}
																	</span>
																</span>
															</SelectItem>
														))}
														<SelectLabel>
															Build Servers ({buildServers?.length || 0})
														</SelectLabel>
													</SelectGroup>
												</SelectContent>
											</Select>
											<FormDescription>
												Every enforced unit builds on this server.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="defaultRegistryId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Default Registry</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value || "none"}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select a registry" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													<SelectGroup>
														<SelectItem value="none">
															<span className="flex items-center gap-2">
																<span>None</span>
															</span>
														</SelectItem>
														{registries?.map((registry) => (
															<SelectItem
																key={registry.registryId}
																value={registry.registryId}
															>
																{registry.registryName}
															</SelectItem>
														))}
														<SelectLabel>
															Registries ({registries?.length || 0})
														</SelectLabel>
													</SelectGroup>
												</SelectContent>
											</Select>
											<FormDescription>
												The built image is pushed here and pulled back by
												digest at deploy time.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="requiredChecksTimeoutMinutes"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Required Checks Timeout (minutes)</FormLabel>
											<FormControl>
												<Input
													type="number"
													min={1}
													max={720}
													value={field.value}
													onChange={(e) =>
														field.onChange(e.target.valueAsNumber)
													}
												/>
											</FormControl>
											<FormDescription>
												How long a deploy waits for a unit's required GitHub
												check runs before failing. Between 1 and 720 minutes.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>

								<div className="flex w-full justify-end pt-4">
									<Button isLoading={isPending} type="submit">
										Save
									</Button>
								</div>
							</form>
						</Form>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
