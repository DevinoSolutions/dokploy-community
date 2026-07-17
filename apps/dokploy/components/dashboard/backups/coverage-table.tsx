import { ExternalLink, Loader2, TableProperties } from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import { ServiceTypeIcon } from "./service-type-icon";

type CoverageService =
	RouterOutputs["backupPolicy"]["coverage"]["services"][number];
type CoverageEntry = CoverageService["dumpBackups"][number];

// Prefer a policy-managed entry so the cell shows the policy name; fall back to
// the first manual entry.
const pickEntry = (entries: CoverageEntry[]): CoverageEntry | undefined =>
	entries.find((entry) => entry.source === "policy") ?? entries[0];

const CoverageCell = ({
	entries,
	capable,
}: {
	entries: CoverageEntry[];
	capable: boolean;
}) => {
	if (!capable) {
		return <span className="text-xs text-muted-foreground">n/a</span>;
	}
	if (entries.length === 0) {
		return <span className="text-muted-foreground">—</span>;
	}
	const entry = pickEntry(entries);
	if (!entry) {
		return <span className="text-muted-foreground">—</span>;
	}
	return (
		<Badge variant={entry.source === "policy" ? "blue" : "blank"}>
			{entry.source === "policy"
				? `Policy${entry.policyName ? ` · ${entry.policyName}` : ""}`
				: "Manual"}
		</Badge>
	);
};

const statusDotClass = (status?: string) => {
	switch (status) {
		case "done":
		case "success":
			return "bg-green-500";
		case "error":
		case "failed":
			return "bg-red-500";
		case "running":
			return "bg-blue-500 animate-pulse";
		default:
			return "bg-muted-foreground/40";
	}
};

export const CoverageTable = () => {
	const { data, isLoading } = api.backupPolicy.coverage.useQuery();

	// Group the flat service list into project → environment → services while
	// preserving first-seen order.
	const grouped = useMemo(() => {
		const projects = new Map<
			string,
			{
				name: string;
				environments: Map<
					string,
					{ id: string; name: string; services: CoverageService[] }
				>;
			}
		>();
		for (const service of data?.services ?? []) {
			let project = projects.get(service.project.id);
			if (!project) {
				project = { name: service.project.name, environments: new Map() };
				projects.set(service.project.id, project);
			}
			let environment = project.environments.get(service.environment.id);
			if (!environment) {
				environment = {
					id: service.environment.id,
					name: service.environment.name,
					services: [],
				};
				project.environments.set(service.environment.id, environment);
			}
			environment.services.push(service);
		}
		return projects;
	}, [data]);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex flex-row items-center gap-2 text-xl">
					<TableProperties className="size-6 text-muted-foreground" />
					Coverage
				</CardTitle>
				<CardDescription>
					Every service in the organization and how it is backed up. Redis and
					applications are covered via volume backups; Compose databases via
					volumes in v1.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isLoading ? (
					<div className="flex min-h-[20vh] items-center justify-center">
						<Loader2 className="size-6 animate-spin text-muted-foreground" />
					</div>
				) : grouped.size === 0 ? (
					<div className="flex min-h-[20vh] flex-col items-center justify-center gap-3">
						<TableProperties className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No services to show
						</span>
					</div>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Service</TableHead>
									<TableHead>Dump</TableHead>
									<TableHead>Volume</TableHead>
									<TableHead>Destinations</TableHead>
									<TableHead className="text-center">Last run</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{Array.from(grouped.entries()).map(([projectId, project]) =>
									Array.from(project.environments.values()).map(
										(environment) => (
											<Fragment key={`${projectId}-${environment.id}`}>
												<TableRow className="bg-muted/40 hover:bg-muted/40">
													<TableCell
														colSpan={6}
														className="py-2 text-xs font-medium text-muted-foreground"
													>
														{project.name} / {environment.name}
													</TableCell>
												</TableRow>
												{environment.services.map((service) => {
													const destinations = Array.from(
														new Set(
															[...service.dumpBackups, ...service.volumeBackups]
																.map((entry) => entry.destinationName)
																.filter((name) => !!name),
														),
													);
													const lastRunStatus = [
														...service.dumpBackups,
														...service.volumeBackups,
													].find((entry) => entry.lastRunStatus)?.lastRunStatus;
													const notCovered =
														service.dumpBackups.length === 0 &&
														service.volumeBackups.length === 0;
													return (
														<TableRow
															key={service.serviceId}
															className={cn(
																notCovered &&
																	"bg-orange-500/5 hover:bg-orange-500/10",
															)}
														>
															<TableCell>
																<div className="flex items-center gap-2">
																	<ServiceTypeIcon type={service.type} />
																	<span className="font-medium">
																		{service.name}
																	</span>
																	{notCovered && (
																		<Badge variant="orange">Not covered</Badge>
																	)}
																</div>
															</TableCell>
															<TableCell>
																<CoverageCell
																	entries={service.dumpBackups}
																	capable={service.dumpCapable}
																/>
															</TableCell>
															<TableCell>
																<CoverageCell
																	entries={service.volumeBackups}
																	capable
																/>
															</TableCell>
															<TableCell>
																{destinations.length > 0 ? (
																	<span className="text-sm text-muted-foreground">
																		{destinations.join(", ")}
																	</span>
																) : (
																	<span className="text-muted-foreground">
																		—
																	</span>
																)}
															</TableCell>
															<TableCell className="text-center">
																{lastRunStatus ? (
																	<span
																		className={cn(
																			"inline-block size-2 rounded-full",
																			statusDotClass(lastRunStatus),
																		)}
																		title={lastRunStatus}
																	/>
																) : (
																	<span className="text-muted-foreground">
																		—
																	</span>
																)}
															</TableCell>
															<TableCell className="text-right">
																<Link
																	href={`/dashboard/project/${projectId}/environment/${environment.id}`}
																	className="inline-flex items-center text-muted-foreground hover:text-foreground"
																	title="Open service"
																>
																	<ExternalLink className="size-4" />
																</Link>
															</TableCell>
														</TableRow>
													);
												})}
											</Fragment>
										),
									),
								)}
							</TableBody>
						</Table>
					</div>
				)}
				<AlertBlock type="info">
					A policy-managed backup and a manual backup can coexist on the same
					service — the Center marks both and never rewrites your manual
					configuration.
				</AlertBlock>
			</CardContent>
		</Card>
	);
};
