import { ShieldOff, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

interface UnitOption {
	/** `application:<id>` or `compose:<id>`, so one Select can carry both. */
	value: string;
	label: string;
}

export const BuildPolicyExclusions = () => {
	const [unit, setUnit] = useState("");
	const [reason, setReason] = useState("");

	const { data: exclusions, refetch } = api.buildPolicy.exclusions.useQuery();
	const { data: projects } = api.project.all.useQuery();

	const { mutateAsync: addExclusion, isPending: isAdding } =
		api.buildPolicy.addExclusion.useMutation();
	const { mutateAsync: removeExclusion, isPending: isRemoving } =
		api.buildPolicy.removeExclusion.useMutation();

	const unitOptions = useMemo<UnitOption[]>(() => {
		const options: UnitOption[] = [];
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

	const onAdd = async () => {
		if (!unit) {
			toast.error("Select a service to exclude");
			return;
		}
		const [type, id] = unit.split(":");
		await addExclusion({
			applicationId: type === "application" ? id : undefined,
			composeId: type === "compose" ? id : undefined,
			reason: reason.trim() || undefined,
		})
			.then(async () => {
				await refetch();
				setUnit("");
				setReason("");
				toast.success("Exclusion added");
			})
			.catch(() => {
				toast.error("Error adding exclusion");
			});
	};

	const onRemove = async (buildPolicyExclusionId: string) => {
		await removeExclusion({ buildPolicyExclusionId })
			.then(async () => {
				await refetch();
				toast.success("Exclusion removed");
			})
			.catch(() => {
				toast.error("Error removing exclusion");
			});
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<ShieldOff className="size-6 text-muted-foreground self-center" />
								Build Policy Exclusions
							</CardTitle>
							<CardDescription>
								Services that keep building locally while enforcement is on.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-4 py-6 border-t">
						{exclusions && exclusions.length > 0 ? (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Service</TableHead>
										<TableHead>Reason</TableHead>
										<TableHead>Created</TableHead>
										<TableHead className="text-right">Actions</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{exclusions.map((exclusion) => (
										<TableRow key={exclusion.buildPolicyExclusionId}>
											<TableCell>
												{exclusion.application?.name ??
													exclusion.compose?.name ??
													"Unknown"}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{exclusion.reason || "-"}
											</TableCell>
											<TableCell className="text-muted-foreground">
												{new Date(exclusion.createdAt).toLocaleString()}
											</TableCell>
											<TableCell className="text-right">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													isLoading={isRemoving}
													onClick={() =>
														onRemove(exclusion.buildPolicyExclusionId)
													}
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
							<p className="text-sm text-muted-foreground">
								No exclusions. Every eligible service follows the build policy.
							</p>
						)}

						<div className="flex flex-col gap-2 sm:flex-row sm:items-center border-t pt-4">
							<Select value={unit} onValueChange={setUnit}>
								<SelectTrigger className="sm:w-1/2">
									<SelectValue placeholder="Select a service" />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{unitOptions.map((option) => (
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
								Add
							</Button>
						</div>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
