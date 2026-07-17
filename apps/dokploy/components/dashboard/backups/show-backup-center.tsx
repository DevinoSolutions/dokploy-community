import { BackupPoliciesSection } from "./backup-policies-section";
import { CoverageTable } from "./coverage-table";
import { InstanceBackupCard } from "./instance-backup-card";

export const ShowBackupCenter = () => {
	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
			<BackupPoliciesSection />
			<InstanceBackupCard />
			<CoverageTable />
		</div>
	);
};
