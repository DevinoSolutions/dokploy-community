import {
	Box,
	CheckCircle2,
	ChevronRight,
	ExternalLink,
	Folder,
	Loader2,
	TableProperties,
	TriangleAlert,
	X,
} from "lucide-react";
import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
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
import {
	type CoverageFacets,
	EMPTY_COVERAGE_FACETS,
	isEnvironmentShownByFacets,
	isProductionEnvironment,
	isServiceShownByFacets,
	normalizeEnvironmentName,
} from "@/lib/backup-coverage";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";
import {
	getProjectFaviconUrls,
	ProjectIcon,
} from "../projects/project-icon";
import { CoverageFilters } from "./coverage-filters";
import { ServiceTypeIcon } from "./service-type-icon";

type CoverageService =
	RouterOutputs["backupPolicy"]["coverage"]["services"][number];
type CoverageEntry = CoverageService["dumpBackups"][number];

const COLUMN_COUNT = 6;

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

const isCovered = (service: CoverageService) =>
	service.dumpBackups.length > 0 || service.volumeBackups.length > 0;

/** Rollup shown on a collapsed project/environment node. */
const RollupBadge = ({ uncovered }: { uncovered: number }) =>
	uncovered > 0 ? (
		<Badge variant="orange" className="gap-1">
			<TriangleAlert className="size-3" />
			{uncovered} not covered
		</Badge>
	) : (
		<CheckCircle2 className="size-4 text-green-500" />
	);

const ExpandChevron = ({ expanded }: { expanded: boolean }) => (
	<ChevronRight
		className={cn(
			"size-4 shrink-0 text-muted-foreground transition-transform",
			expanded && "rotate-90",
		)}
	/>
);

interface EnvironmentNode {
	id: string;
	name: string;
	isProduction: boolean;
	projectName: string;
	visibleServices: CoverageService[];
	hiddenCount: number;
	uncoveredCount: number;
}

interface ProjectNode {
	id: string;
	name: string;
	logo: string | null;
	faviconUrls: string[];
	environments: EnvironmentNode[];
	uncoveredCount: number;
}

// Child containers of a compose service, lazy-loaded on expand.
const ComposeChildRows = ({ composeId }: { composeId: string }) => {
	const { data, isPending } = api.backupPolicy.composeChildren.useQuery({
		composeId,
	});

	if (isPending) {
		return (
			<TableRow>
				<TableCell colSpan={COLUMN_COUNT} className="py-2 pl-[4.25rem]">
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" />
						Loading compose services...
					</span>
				</TableCell>
			</TableRow>
		);
	}

	if (data?.error) {
		return (
			<TableRow>
				<TableCell colSpan={COLUMN_COUNT} className="py-2 pl-[4.25rem]">
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						<TriangleAlert className="size-3.5 text-orange-500" />
						{data.error}
					</span>
				</TableCell>
			</TableRow>
		);
	}

	return (
		<>
			{data?.children.map((child) => (
				<TableRow key={child.name} className="bg-muted/20 hover:bg-muted/30">
					<TableCell className="py-2 pl-[4.25rem]">
						<div className="flex items-center gap-2">
							{child.dbKind ? (
								<ServiceTypeIcon type={child.dbKind} />
							) : (
								<Box className="size-4 text-muted-foreground" />
							)}
							<span className="text-sm">{child.name}</span>
							{child.image && (
								<span className="truncate text-xs text-muted-foreground">
									{child.image}
								</span>
							)}
						</div>
					</TableCell>
					<TableCell className="py-2">
						<span className="text-xs text-muted-foreground">n/a</span>
					</TableCell>
					<TableCell className="py-2">
						{child.volumes.length > 0 ? (
							<div className="flex flex-wrap gap-1">
								{child.volumes.map((volume) => (
									<Badge
										key={volume.name}
										variant={volume.covered ? "green" : "orange"}
										className="gap-1 text-[10px]"
										title={
											volume.covered
												? "Covered by a volume backup"
												: "No volume backup covers this volume"
										}
									>
										{volume.covered ? (
											<CheckCircle2 className="size-3" />
										) : (
											<X className="size-3" />
										)}
										{volume.name}
									</Badge>
								))}
							</div>
						) : (
							<span className="text-muted-foreground">—</span>
						)}
					</TableCell>
					<TableCell className="py-2" />
					<TableCell className="py-2" />
					<TableCell className="py-2" />
				</TableRow>
			))}
		</>
	);
};

export const CoverageTable = () => {
	const { data, isPending } = api.backupPolicy.coverage.useQuery();

	// Expansion overrides keyed by node id; absent = the node-type default
	// (projects expanded, environments and compose nodes collapsed).
	const [expandOverrides, setExpandOverrides] = useState<
		Record<string, boolean>
	>({});
	const [facets, setFacets] = useState<CoverageFacets>(EMPTY_COVERAGE_FACETS);

	const isExpanded = (key: string, fallback: boolean) =>
		expandOverrides[key] ?? fallback;
	const toggle = (key: string, fallback: boolean) =>
		setExpandOverrides((prev) => ({
			...prev,
			[key]: !(prev[key] ?? fallback),
		}));

	// Distinct environment names across the organization (unfiltered) for the
	// environment-name facet — one entry per name, not per project×environment.
	const environmentNames = useMemo<string[]>(() => {
		const seen = new Map<string, string>();
		for (const service of data?.services ?? []) {
			const normalized = normalizeEnvironmentName(service.environment.name);
			if (!seen.has(normalized)) {
				seen.set(normalized, service.environment.name.trim());
			}
		}
		return Array.from(seen.values()).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" }),
		);
	}, [data]);

	// Group the flat service list into project → environment nodes, applying
	// the environment filter, while preserving first-seen order.
	const tree = useMemo<ProjectNode[]>(() => {
		const projects = new Map<
			string,
			ProjectNode & {
				environmentMap: Map<
					string,
					EnvironmentNode & { allServices: CoverageService[] }
				>;
			}
		>();
		for (const service of data?.services ?? []) {
			let project = projects.get(service.project.id);
			if (!project) {
				project = {
					id: service.project.id,
					name: service.project.name,
					logo: service.project.logo,
					faviconUrls: [],
					environments: [],
					uncoveredCount: 0,
					environmentMap: new Map(),
				};
				projects.set(service.project.id, project);
			}
			let environment = project.environmentMap.get(service.environment.id);
			if (!environment) {
				environment = {
					id: service.environment.id,
					name: service.environment.name,
					isProduction: isProductionEnvironment(service.environment.name),
					projectName: service.project.name,
					visibleServices: [],
					hiddenCount: 0,
					uncoveredCount: 0,
					allServices: [],
				};
				project.environmentMap.set(service.environment.id, environment);
			}
			environment.allServices.push(service);
		}

		const result: ProjectNode[] = [];
		for (const project of projects.values()) {
			const allProjectDomains: Array<{ host: string; https: boolean }> = [];
			for (const environment of project.environmentMap.values()) {
				for (const service of environment.allServices) {
					allProjectDomains.push(...service.domains);
				}
			}
			project.faviconUrls = getProjectFaviconUrls(allProjectDomains);

			for (const environment of project.environmentMap.values()) {
				// An environment excluded by the name facet disappears entirely;
				// the other facets hide services but keep the "(N hidden)" hint.
				if (!isEnvironmentShownByFacets(environment.name, facets)) continue;
				environment.visibleServices = environment.allServices.filter(
					(service) =>
						isServiceShownByFacets(
							service,
							environment.name,
							isCovered(service),
							facets,
						),
				);
				environment.hiddenCount =
					environment.allServices.length -
					environment.visibleServices.length;
				environment.uncoveredCount = environment.visibleServices.filter(
					(service) => !isCovered(service),
				).length;
				// Keep fully-filtered environments visible so their "(N hidden)"
				// hint reveals that the filter is active.
				project.environments.push(environment);
				project.uncoveredCount += environment.uncoveredCount;
			}
			if (project.environments.length > 0) {
				const { environmentMap: _environmentMap, ...node } = project;
				result.push(node);
			}
		}
		return result;
	}, [data, facets]);

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="flex flex-row items-center gap-2 text-xl">
					<TableProperties className="size-6 text-muted-foreground" />
					Coverage
				</CardTitle>
				<CardDescription>
					Every service in the organization and how it is backed up. Redis and
					applications are covered via volume backups; expand a compose to see
					the databases and volumes inside it.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{isPending ? (
					<div className="flex min-h-[20vh] items-center justify-center">
						<Loader2 className="size-6 animate-spin text-muted-foreground" />
					</div>
				) : (data?.services.length ?? 0) === 0 ? (
					<div className="flex min-h-[20vh] flex-col items-center justify-center gap-3">
						<TableProperties className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No services to show
						</span>
					</div>
				) : (
					<>
						<CoverageFilters
							environmentNames={environmentNames}
							facets={facets}
							onChange={setFacets}
						/>
						{tree.length === 0 ? (
							<div className="flex min-h-[10vh] flex-col items-center justify-center gap-2">
								<span className="text-sm text-muted-foreground">
									Everything is hidden by the current filters.
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
										{tree.map((project) => {
											const projectExpanded = isExpanded(
												`p:${project.id}`,
												true,
											);
											return (
												<Fragment key={project.id}>
													<TableRow
														className="cursor-pointer bg-muted/40 hover:bg-muted/60"
														onClick={() => toggle(`p:${project.id}`, true)}
													>
														<TableCell
															colSpan={COLUMN_COUNT}
															className="py-2"
														>
															<div className="flex items-center gap-2">
																<ExpandChevron expanded={projectExpanded} />
																<ProjectIcon
																	logo={project.logo}
																	faviconUrls={project.faviconUrls}
																	className="size-4 rounded-sm object-contain"
																	fallback={
																		<Folder className="size-4 text-muted-foreground" />
																	}
																/>
																<span className="font-medium">
																	{project.name}
																</span>
																{!projectExpanded && (
																	<RollupBadge
																		uncovered={project.uncoveredCount}
																	/>
																)}
															</div>
														</TableCell>
													</TableRow>
													{projectExpanded &&
														project.environments.map((environment) => {
															const envKey = `e:${environment.id}`;
															const envExpanded = isExpanded(envKey, false);
															return (
																<Fragment key={environment.id}>
																	<TableRow
																		className="cursor-pointer hover:bg-muted/40"
																		onClick={() => toggle(envKey, false)}
																	>
																		<TableCell
																			colSpan={COLUMN_COUNT}
																			className="py-2 pl-8"
																		>
																			<div className="flex items-center gap-2">
																				<ExpandChevron
																					expanded={envExpanded}
																				/>
																				<span className="text-sm">
																					{environment.name}
																				</span>
																				{environment.hiddenCount > 0 && (
																					<span className="text-xs text-muted-foreground">
																						({environment.hiddenCount} hidden)
																					</span>
																				)}
																				{!envExpanded &&
																					environment.visibleServices.length >
																						0 && (
																						<RollupBadge
																							uncovered={
																								environment.uncoveredCount
																							}
																						/>
																					)}
																			</div>
																		</TableCell>
																	</TableRow>
																	{envExpanded &&
																		environment.visibleServices.map(
																			(service) => {
																				const destinations = Array.from(
																					new Set(
																						[
																							...service.dumpBackups,
																							...service.volumeBackups,
																						]
																							.map(
																								(entry) =>
																									entry.destinationName,
																							)
																							.filter((name) => !!name),
																					),
																				);
																				const lastRunStatus = [
																					...service.dumpBackups,
																					...service.volumeBackups,
																				].find(
																					(entry) => entry.lastRunStatus,
																				)?.lastRunStatus;
																				const notCovered =
																					!isCovered(service);
																				const composeKey = `c:${service.serviceId}`;
																				const composeExpanded =
																					service.type === "compose" &&
																					isExpanded(composeKey, false);
																				return (
																					<Fragment key={service.serviceId}>
																						<TableRow
																							className={cn(
																								notCovered &&
																									"bg-orange-500/5 hover:bg-orange-500/10",
																								service.type === "compose" &&
																									"cursor-pointer",
																							)}
																							onClick={
																								service.type === "compose"
																									? () =>
																											toggle(
																												composeKey,
																												false,
																											)
																									: undefined
																							}
																						>
																							<TableCell className="pl-12">
																								<div className="flex items-center gap-2">
																									{service.type ===
																										"compose" && (
																										<ExpandChevron
																											expanded={
																												composeExpanded
																											}
																										/>
																									)}
																									<ServiceTypeIcon
																										type={service.type}
																									/>
																									<span className="font-medium">
																										{service.name}
																									</span>
																									{notCovered && (
																										<Badge variant="orange">
																											Not covered
																										</Badge>
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
																									entries={
																										service.volumeBackups
																									}
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
																											statusDotClass(
																												lastRunStatus,
																											),
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
																									href={`/dashboard/project/${project.id}/environment/${environment.id}`}
																									className="inline-flex items-center text-muted-foreground hover:text-foreground"
																									title="Open service"
																									onClick={(event) =>
																										event.stopPropagation()
																									}
																								>
																									<ExternalLink className="size-4" />
																								</Link>
																							</TableCell>
																						</TableRow>
																						{composeExpanded && (
																							<ComposeChildRows
																								composeId={service.serviceId}
																							/>
																						)}
																					</Fragment>
																				);
																			},
																		)}
																</Fragment>
															);
														})}
												</Fragment>
											);
										})}
									</TableBody>
								</Table>
							</div>
						)}
					</>
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
