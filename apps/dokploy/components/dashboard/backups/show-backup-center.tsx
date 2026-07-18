import { useRouter } from "next/router";
import { ServerFilter } from "@/components/shared/server-filter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityTab } from "./activity-tab";
import { BackupPoliciesSection } from "./backup-policies-section";
import { CoverageTable } from "./coverage-table";
import { InstanceBackupCard } from "./instance-backup-card";

const TABS = ["coverage", "policies", "instance", "activity"] as const;
type BackupTab = (typeof TABS)[number];

export const ShowBackupCenter = () => {
	const router = useRouter();
	const tab: BackupTab =
		typeof router.query.tab === "string" &&
		(TABS as readonly string[]).includes(router.query.tab)
			? (router.query.tab as BackupTab)
			: "coverage";

	const setTab = (value: string) => {
		router.replace(
			{ pathname: router.pathname, query: { ...router.query, tab: value } },
			undefined,
			{ shallow: true },
		);
	};

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
			<Tabs value={tab} onValueChange={setTab} className="w-full">
				<TabsList>
					<TabsTrigger value="coverage">Coverage</TabsTrigger>
					<TabsTrigger value="policies">Policies</TabsTrigger>
					<TabsTrigger value="instance">Instance</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
				</TabsList>
				{/* Coverage and Activity are scoped by the "Viewing server" selector;
				    Policies and Instance are org-wide and never server-scoped. */}
				<TabsContent value="coverage" className="mt-4">
					<ServerFilter>
						{(serverId) => <CoverageTable serverId={serverId} />}
					</ServerFilter>
				</TabsContent>
				<TabsContent value="policies" className="mt-4">
					<BackupPoliciesSection />
				</TabsContent>
				<TabsContent value="instance" className="mt-4">
					<InstanceBackupCard />
				</TabsContent>
				<TabsContent value="activity" className="mt-4">
					<ServerFilter>
						{(serverId) => <ActivityTab serverId={serverId} />}
					</ServerFilter>
				</TabsContent>
			</Tabs>
		</div>
	);
};
