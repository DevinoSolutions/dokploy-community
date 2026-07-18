import {
	Boxes,
	CheckCircle2,
	ChevronRight,
	Folder,
	Layers,
	Loader2,
	Search,
	TriangleAlert,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { ServiceTypeIcon } from "@/components/dashboard/backups/service-type-icon";
import {
	getProjectFaviconUrls,
	ProjectIcon,
} from "@/components/dashboard/projects/project-icon";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { serviceMatchesSearch } from "@/lib/backup-coverage";
import {
	classifyApplicationProvenance,
	classifyComposeChildImage,
	type ImageRestorability,
} from "@/lib/image-provenance";
import { cn } from "@/lib/utils";
import type { RouterOutputs } from "@/utils/api";
import { api } from "@/utils/api";

type ImageService =
	RouterOutputs["backupPolicy"]["imageProvenance"]["services"][number];

const COLUMN_COUNT = 2;

const RESTORABILITY_META: Record<
	ImageRestorability,
	{ label: string; variant: "green" | "orange"; warn: boolean }
> = {
	"re-pullable": { label: "Re-pullable", variant: "green", warn: false },
	"in-registry": { label: "In registry", variant: "green", warn: false },
	"rebuild-only": { label: "Rebuild only", variant: "orange", warn: true },
};

const RestorabilityBadge = ({
	restorability,
	detail,
}: {
	restorability: ImageRestorability;
	detail?: string | null;
}) => {
	const meta = RESTORABILITY_META[restorability];
	return (
		<div className="flex items-center gap-2">
			<Badge variant={meta.variant} className="gap-1">
				{meta.warn ? <TriangleAlert className="size-3" /> : null}
				{meta.label}
			</Badge>
			{detail ? (
				<span
					className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground"
					title={detail}
				>
					{detail}
				</span>
			) : null}
		</div>
	);
};

const ExpandChevron = ({ expanded }: { expanded: boolean }) => (
	<ChevronRight
		className={cn(
			"size-4 shrink-0 text-muted-foreground transition-transform",
			expanded && "rotate-90",
		)}
	/>
);

// Compose children are lazy-loaded on expand (same pattern as the Backup Center
// coverage tree). A child with an `image:` is re-pullable; a `build:` child is
// rebuild-only.
const ComposeImageChildren = ({ composeId }: { composeId: string }) => {
	const { data, isPending } = api.backupPolicy.composeChildren.useQuery({
		composeId,
	});

	if (isPending) {
		return (
			<TableRow>
				<TableCell colSpan={COLUMN_COUNT} className="py-2 pl-16">
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
				<TableCell colSpan={COLUMN_COUNT} className="py-2 pl-16">
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
			{data?.children.map((child) => {
				const provenance = classifyComposeChildImage({ image: child.image });
				return (
					<TableRow key={child.name} className="bg-muted/10">
						<TableCell className="py-2 pl-16">
							<div className="flex items-center gap-2">
								{child.dbKind ? (
									<ServiceTypeIcon type={child.dbKind} />
								) : (
									<Boxes className="size-4 text-muted-foreground" />
								)}
								<span className="text-sm">{child.name}</span>
							</div>
						</TableCell>
						<TableCell className="py-2">
							<RestorabilityBadge
								restorability={provenance.restorability}
								detail={child.image}
							/>
						</TableCell>
					</TableRow>
				);
			})}
		</>
	);
};

interface EnvironmentNode {
	id: string;
	name: string;
	services: ImageService[];
	rebuildOnly: number;
}

interface ProjectNode {
	id: string;
	name: string;
	logo: string | null;
	environments: EnvironmentNode[];
	rebuildOnly: number;
}

// An application's restorability is known up-front; a compose's depends on its
// (lazy) children, so it does not contribute to the up-front counts.
const applicationRestorability = (
	service: ImageService,
): ImageRestorability | null =>
	service.type === "application"
		? classifyApplicationProvenance({
				sourceType: service.sourceType as Parameters<
					typeof classifyApplicationProvenance
				>[0]["sourceType"],
				dockerImage: service.dockerImage,
				registryId: service.registryId,
			}).restorability
		: null;

const RollupBadge = ({ rebuildOnly }: { rebuildOnly: number }) =>
	rebuildOnly > 0 ? (
		<Badge variant="orange" className="gap-1">
			<TriangleAlert className="size-3" />
			{rebuildOnly} rebuild-only
		</Badge>
	) : (
		<CheckCircle2 className="size-4 text-green-500" />
	);

const ApplicationRow = ({ service }: { service: ImageService }) => {
	const provenance = classifyApplicationProvenance({
		sourceType: service.sourceType as Parameters<
			typeof classifyApplicationProvenance
		>[0]["sourceType"],
		dockerImage: service.dockerImage,
		registryId: service.registryId,
	});
	const detail =
		provenance.restorability === "in-registry"
			? service.registryName
			: provenance.image;
	return (
		<TableRow>
			<TableCell className="pl-12">
				<div className="flex items-center gap-2">
					<ServiceTypeIcon type="application" />
					<span className="font-medium">{service.name}</span>
				</div>
			</TableCell>
			<TableCell>
				<RestorabilityBadge
					restorability={provenance.restorability}
					detail={detail}
				/>
			</TableCell>
		</TableRow>
	);
};

export const RegistryImageProvenance = () => {
	const { data, isPending } = api.backupPolicy.imageProvenance.useQuery();
	const [expandOverrides, setExpandOverrides] = useState<
		Record<string, boolean>
	>({});
	const [search, setSearch] = useState("");

	const isExpanded = (key: string, fallback: boolean) =>
		expandOverrides[key] ?? fallback;
	const toggle = (key: string, fallback: boolean) =>
		setExpandOverrides((prev) => ({
			...prev,
			[key]: !(prev[key] ?? fallback),
		}));

	const services = data?.services ?? [];

	const totals = useMemo(() => {
		let rePullable = 0;
		let inRegistry = 0;
		let rebuildOnly = 0;
		for (const service of services) {
			const restorability = applicationRestorability(service);
			if (restorability === "re-pullable") rePullable++;
			else if (restorability === "in-registry") inRegistry++;
			else if (restorability === "rebuild-only") rebuildOnly++;
		}
		return { rePullable, inRegistry, rebuildOnly };
	}, [services]);

	const tree = useMemo<ProjectNode[]>(() => {
		const projects = new Map<
			string,
			ProjectNode & { environmentMap: Map<string, EnvironmentNode> }
		>();
		for (const service of services) {
			if (
				!serviceMatchesSearch(
					{
						name: service.name,
						projectName: service.project.name,
						environmentName: service.environment.name,
					},
					search,
				)
			) {
				continue;
			}
			let project = projects.get(service.project.id);
			if (!project) {
				project = {
					id: service.project.id,
					name: service.project.name,
					logo: service.project.logo,
					environments: [],
					rebuildOnly: 0,
					environmentMap: new Map(),
				};
				projects.set(service.project.id, project);
			}
			let environment = project.environmentMap.get(service.environment.id);
			if (!environment) {
				environment = {
					id: service.environment.id,
					name: service.environment.name,
					services: [],
					rebuildOnly: 0,
				};
				project.environmentMap.set(service.environment.id, environment);
				project.environments.push(environment);
			}
			environment.services.push(service);
			if (applicationRestorability(service) === "rebuild-only") {
				environment.rebuildOnly++;
				project.rebuildOnly++;
			}
		}
		return Array.from(projects.values()).map(
			({ environmentMap: _drop, ...node }) => node,
		);
	}, [services, search]);

	return (
		<Card className="h-full max-w-5xl mx-auto rounded-xl bg-sidebar p-2.5">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader>
					<CardTitle className="flex flex-row items-center gap-2 text-xl">
						<Layers className="size-6 self-center text-muted-foreground" />
						Image restorability
					</CardTitle>
					<CardDescription>
						Whether each service's image can be pulled back without rebuilding,
						and from where. Databases and Redis run standard public images and
						are omitted.
					</CardDescription>
					{!isPending && services.length > 0 ? (
						<div className="flex flex-wrap gap-2 pt-1">
							<Badge variant="green">{totals.rePullable} re-pullable</Badge>
							<Badge variant="green">{totals.inRegistry} in registry</Badge>
							<Badge variant={totals.rebuildOnly > 0 ? "orange" : "blank"}>
								{totals.rebuildOnly} rebuild-only
							</Badge>
						</div>
					) : null}
				</CardHeader>
				<CardContent className="flex flex-col gap-4 border-t py-6">
					{isPending ? (
						<div className="flex min-h-[20vh] items-center justify-center">
							<Loader2 className="size-6 animate-spin text-muted-foreground" />
						</div>
					) : services.length === 0 ? (
						<div className="flex min-h-[20vh] flex-col items-center justify-center gap-3">
							<Layers className="size-8 text-muted-foreground" />
							<span className="text-base text-muted-foreground">
								No applications or compose services yet
							</span>
						</div>
					) : (
						<>
							<div className="relative">
								<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									placeholder="Search by project, service or environment..."
									className="pl-8"
								/>
							</div>
							{tree.length === 0 ? (
								<div className="flex min-h-[10vh] items-center justify-center">
									<span className="text-sm text-muted-foreground">
										No services match your search.
									</span>
								</div>
							) : (
								<div className="overflow-x-auto">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Service</TableHead>
												<TableHead>Restorability</TableHead>
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
																		faviconUrls={getProjectFaviconUrls([])}
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
																			rebuildOnly={project.rebuildOnly}
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
																					{!envExpanded && (
																						<RollupBadge
																							rebuildOnly={
																								environment.rebuildOnly
																							}
																						/>
																					)}
																				</div>
																			</TableCell>
																		</TableRow>
																		{envExpanded &&
																			environment.services.map((service) => {
																				if (service.type === "application") {
																					return (
																						<ApplicationRow
																							key={service.serviceId}
																							service={service}
																						/>
																					);
																				}
																				const composeKey = `c:${service.serviceId}`;
																				const composeExpanded = isExpanded(
																					composeKey,
																					false,
																				);
																				return (
																					<Fragment key={service.serviceId}>
																						<TableRow
																							className="cursor-pointer"
																							onClick={() =>
																								toggle(composeKey, false)
																							}
																						>
																							<TableCell className="pl-12">
																								<div className="flex items-center gap-2">
																									<ExpandChevron
																										expanded={composeExpanded}
																									/>
																									<ServiceTypeIcon type="compose" />
																									<span className="font-medium">
																										{service.name}
																									</span>
																								</div>
																							</TableCell>
																							<TableCell>
																								<span className="text-xs text-muted-foreground">
																									{service.hasComposeFile
																										? "Expand to inspect services"
																										: "No compose file yet"}
																								</span>
																							</TableCell>
																						</TableRow>
																						{composeExpanded && (
																							<ComposeImageChildren
																								composeId={service.serviceId}
																							/>
																						)}
																					</Fragment>
																				);
																			})}
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
				</CardContent>
			</div>
		</Card>
	);
};
