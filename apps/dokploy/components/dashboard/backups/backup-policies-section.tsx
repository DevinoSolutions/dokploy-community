import { DatabaseBackup, Loader2 } from "lucide-react";
import { useMemo } from "react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";
import { BackupPolicyCard } from "./backup-policy-card";
import { HandleBackupPolicy } from "./handle-backup-policy";

export const BackupPoliciesSection = () => {
	const { data: policies, isLoading } = api.backupPolicy.all.useQuery();
	const { data: projects = [] } = api.project.all.useQuery();

	const { projectNameById, environmentNameById } = useMemo(() => {
		const projectMap = new Map<string, string>();
		const environmentMap = new Map<string, string>();
		for (const project of projects) {
			projectMap.set(project.projectId, project.name);
			for (const environment of project.environments ?? []) {
				environmentMap.set(
					environment.environmentId,
					`${project.name} / ${environment.name}`,
				);
			}
		}
		return {
			projectNameById: projectMap,
			environmentNameById: environmentMap,
		};
	}, [projects]);

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row flex-wrap justify-between gap-4">
				<div className="flex flex-col gap-0.5">
					<CardTitle className="flex flex-row items-center gap-2 text-xl">
						<DatabaseBackup className="size-6 text-muted-foreground" />
						Backup Policies
					</CardTitle>
					<CardDescription>
						Automatically back up database dumps and volumes for every service
						in a scope to one destination.
					</CardDescription>
				</div>
				{policies && policies.length > 0 && <HandleBackupPolicy />}
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="flex min-h-[20vh] items-center justify-center">
						<Loader2 className="size-6 animate-spin text-muted-foreground" />
					</div>
				) : !policies || policies.length === 0 ? (
					<div className="flex min-h-[25vh] flex-col items-center justify-center gap-3">
						<DatabaseBackup className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No backup policies yet
						</span>
						<p className="max-w-md text-center text-sm text-muted-foreground">
							Create a policy to back up everything in your organization (or a
							subset of projects and environments) in a couple of clicks.
						</p>
						<HandleBackupPolicy />
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{policies.map((policy) => (
							<BackupPolicyCard
								key={policy.backupPolicyId}
								policy={policy}
								projectNameById={projectNameById}
								environmentNameById={environmentNameById}
							/>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
