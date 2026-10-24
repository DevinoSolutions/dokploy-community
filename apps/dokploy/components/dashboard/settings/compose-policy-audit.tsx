import { ShieldCheck, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
 * "Restricted compose: audit mode (read-only)": an opt-in switch of the
 * organization, the composes it skips, and the latest findings grouped by
 * compose. The audit only records what a sandbox WOULD refuse; it never blocks
 * or changes a deploy. Shown on the Deployments settings page, owners and
 * admins only (the page and every procedure are gated).
 */
export const ComposePolicyAudit = () => {
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: settings, refetch } = api.composePolicy.settings.useQuery();
	const { data: findings, refetch: refetchFindings } =
		api.composePolicy.findings.useQuery({ limit: 200 });
	const { mutateAsync: updateSettings, isPending: isSaving } =
		api.composePolicy.updateSettings.useMutation();
	const { mutateAsync: removeExclusion, isPending: isRemoving } =
		api.composePolicy.removeExclusion.useMutation();

	const groups = useMemo(() => {
		const byCompose = new Map<
			string,
			{ name: string; rows: NonNullable<typeof findings> }
		>();
		for (const finding of findings ?? []) {
			const group = byCompose.get(finding.composeId) ?? {
				name: finding.composeName ?? `${finding.composeId} (deleted)`,
				rows: [],
			};
			group.rows.push(finding);
			byCompose.set(finding.composeId, group);
		}
		return [...byCompose.entries()];
	}, [findings]);

	if (isCloud) return null;

	const onToggle = async (auditEnabled: boolean) => {
		await updateSettings({ auditEnabled })
			.then(async () => {
				await refetch();
				toast.success(
					auditEnabled
						? "Restricted compose audit turned on"
						: "Restricted compose audit turned off",
				);
			})
			.catch((error) => {
				toast.error(error.message || "Error saving the setting");
			});
	};

	const onRemove = async (composeId: string) => {
		await removeExclusion({ composeId })
			.then(async () => {
				await refetch();
				toast.success("Compose is audited again");
			})
			.catch((error) => {
				toast.error(error.message || "Error removing the exclusion");
			});
	};

	return (
		<>
			<CardHeader className="flex flex-row items-center justify-between gap-4">
				<div className="flex flex-row items-center gap-2">
					<ShieldCheck className="size-6 text-muted-foreground" />
					<div>
						<CardTitle className="text-xl">
							Restricted compose: audit mode (read-only)
						</CardTitle>
						<CardDescription>
							When on, every compose deploy of this organization records what a
							restricted-compose sandbox would refuse (host-privilege keys,
							system and Docker-socket binds, shared volumes, build contexts
							outside the project, custom commands, unreadable files). It only
							records: it never blocks, fails or changes a deploy. Findings go
							to the deployment log (lines starting with{" "}
							<code>[restricted-compose audit]</code>) and to the list below.
							Off by default.
						</CardDescription>
					</div>
				</div>
				<Switch
					checked={settings?.auditEnabled ?? false}
					disabled={isSaving || !settings}
					onCheckedChange={onToggle}
				/>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				<div className="flex flex-col gap-2">
					<p className="text-sm font-medium text-muted-foreground">
						Excluded composes
					</p>
					{settings && settings.exclusions.length > 0 ? (
						<div className="flex flex-col gap-2">
							{settings.exclusions.map((entry) => (
								<div
									key={entry.id}
									className="flex items-center justify-between gap-2 rounded-lg border p-2 text-sm"
								>
									<span>
										{entry.name ?? `${entry.id} (deleted)`}
										{entry.reason ? ` - ${entry.reason}` : ""}
									</span>
									<Button
										variant="ghost"
										size="icon"
										disabled={isRemoving}
										onClick={() => onRemove(entry.id)}
									>
										<Trash2 className="size-4" />
									</Button>
								</div>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground rounded-lg border border-dashed p-4 text-center">
							No compose is excluded. Exclude one from its Advanced tab.
						</p>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<p className="text-sm font-medium text-muted-foreground">
							Latest findings
						</p>
						<Button variant="ghost" size="sm" onClick={() => refetchFindings()}>
							Refresh
						</Button>
					</div>
					{groups.length === 0 ? (
						<p className="text-sm text-muted-foreground rounded-lg border border-dashed p-4 text-center">
							No findings yet.
						</p>
					) : (
						groups.map(([composeId, group]) => (
							<div key={composeId} className="flex flex-col gap-1">
								<p className="text-sm font-medium">
									{group.name}{" "}
									<Badge variant="secondary">{group.rows.length}</Badge>
								</p>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>When</TableHead>
											<TableHead>Service</TableHead>
											<TableHead>Rule</TableHead>
											<TableHead>Detail</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{group.rows.map((row) => (
											<TableRow key={row.id}>
												<TableCell className="whitespace-nowrap">
													{new Date(row.createdAt).toLocaleString()}
												</TableCell>
												<TableCell>{row.serviceName}</TableCell>
												<TableCell>
													<code>{row.ruleId}</code>
												</TableCell>
												<TableCell className="break-all">
													{row.detail}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						))
					)}
				</div>
			</CardContent>
		</>
	);
};
