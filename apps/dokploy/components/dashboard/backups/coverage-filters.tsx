import { Check, Layers, ListFilter, Minus, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	type CoverageFacets,
	DATABASE_SERVICE_TYPES,
	type DbKind,
	EMPTY_COVERAGE_FACETS,
	hasExplicitFacets,
	isDatabaseServiceType,
	type ServiceType,
} from "@/lib/backup-coverage";
import { cn } from "@/lib/utils";

export type { CoverageFacets };

interface Props {
	/** Distinct environment names across the organization. */
	environmentNames: string[];
	facets: CoverageFacets;
	onChange: (facets: CoverageFacets) => void;
}

const DB_TYPE_LABELS: Record<DbKind, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
	mariadb: "MariaDB",
	mongo: "MongoDB",
	redis: "Redis",
	libsql: "LibSQL",
};

const toggleValue = <T,>(values: T[], value: T): T[] =>
	values.includes(value)
		? values.filter((entry) => entry !== value)
		: [...values, value];

/** Tri-state box matching the coverage tree's checkbox styling. */
const FacetBox = ({
	state,
}: {
	state: "checked" | "indeterminate" | "unchecked";
}) => (
	<span
		className={cn(
			"flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary",
			state === "unchecked"
				? "bg-transparent"
				: "bg-primary text-primary-foreground",
		)}
	>
		{state === "checked" && <Check className="size-3" />}
		{state === "indeterminate" && <Minus className="size-3" />}
	</span>
);

const FacetRow = ({
	label,
	state,
	indented,
	onClick,
	trailing,
}: {
	label: string;
	state: "checked" | "indeterminate" | "unchecked";
	indented?: boolean;
	onClick: () => void;
	trailing?: string;
}) => (
	<button
		type="button"
		className={cn(
			"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
			indented && "pl-8",
		)}
		onClick={onClick}
	>
		<FacetBox state={state} />
		<span className="truncate">{label}</span>
		{trailing && (
			<span className="ml-auto truncate text-xs text-muted-foreground">
				{trailing}
			</span>
		)}
	</button>
);

const FacetCount = ({ count }: { count: number }) =>
	count > 0 ? (
		<Badge variant="blue" className="px-1.5 text-[10px]">
			{count}
		</Badge>
	) : null;

const FacetHeader = ({
	label,
	onClear,
	showClear,
}: {
	label: string;
	onClear: () => void;
	showClear: boolean;
}) => (
	<div className="flex items-center justify-between border-b px-3 py-2">
		<span className="text-sm font-medium">{label}</span>
		{showClear && (
			<Button
				variant="ghost"
				size="sm"
				className="h-7 px-2 text-xs"
				onClick={onClear}
			>
				Clear
			</Button>
		)}
	</div>
);

/**
 * Global facet filters of the Backup Center coverage tree: environment names,
 * service types (with a "Databases" group) and a "Not covered only" toggle.
 * Without any explicit selection the default rule applies — production
 * environments in full, plus databases & volume-backed services elsewhere.
 */
export const CoverageFilters = ({
	environmentNames,
	facets,
	onChange,
}: Props) => {
	const explicit = hasExplicitFacets(facets);
	const selectedDbCount = facets.serviceTypes.filter(
		isDatabaseServiceType,
	).length;
	const databasesState =
		selectedDbCount === DATABASE_SERVICE_TYPES.length
			? "checked"
			: selectedDbCount > 0
				? "indeterminate"
				: "unchecked";

	const setEnvironmentNames = (environmentNames: string[]) =>
		onChange({ ...facets, environmentNames });
	const setServiceTypes = (serviceTypes: ServiceType[]) =>
		onChange({ ...facets, serviceTypes });

	const toggleDatabases = () => {
		const nonDatabases = facets.serviceTypes.filter(
			(type) => !isDatabaseServiceType(type),
		);
		setServiceTypes(
			databasesState === "checked"
				? nonDatabases
				: [...nonDatabases, ...DATABASE_SERVICE_TYPES],
		);
	};

	const typeState = (type: ServiceType) =>
		facets.serviceTypes.includes(type) ? "checked" : "unchecked";

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Popover>
				<PopoverTrigger asChild>
					<Button variant="outline" size="sm" className="h-8 gap-2">
						<ListFilter className="size-4" />
						Environments
						<FacetCount count={facets.environmentNames.length} />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-64 p-0">
					<FacetHeader
						label="Environments"
						showClear={facets.environmentNames.length > 0}
						onClear={() => setEnvironmentNames([])}
					/>
					<div className="max-h-72 overflow-y-auto p-1">
						{environmentNames.map((name) => (
							<FacetRow
								key={name}
								label={name}
								state={
									facets.environmentNames.includes(name)
										? "checked"
										: "unchecked"
								}
								onClick={() =>
									setEnvironmentNames(
										toggleValue(facets.environmentNames, name),
									)
								}
							/>
						))}
					</div>
					<div className="border-t px-3 py-2 text-[11px] leading-4 text-muted-foreground">
						Environments with the selected names are shown in every project.
					</div>
				</PopoverContent>
			</Popover>
			<Popover>
				<PopoverTrigger asChild>
					<Button variant="outline" size="sm" className="h-8 gap-2">
						<Layers className="size-4" />
						Service types
						<FacetCount count={facets.serviceTypes.length} />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-64 p-0">
					<FacetHeader
						label="Service types"
						showClear={facets.serviceTypes.length > 0}
						onClear={() => setServiceTypes([])}
					/>
					<div className="max-h-72 overflow-y-auto p-1">
						<FacetRow
							label="Databases"
							state={databasesState}
							onClick={toggleDatabases}
						/>
						{DATABASE_SERVICE_TYPES.map((type) => (
							<FacetRow
								key={type}
								label={DB_TYPE_LABELS[type]}
								state={typeState(type)}
								indented
								onClick={() =>
									setServiceTypes(toggleValue(facets.serviceTypes, type))
								}
							/>
						))}
						<FacetRow
							label="Applications"
							state={typeState("application")}
							onClick={() =>
								setServiceTypes(toggleValue(facets.serviceTypes, "application"))
							}
						/>
						<FacetRow
							label="Compose"
							state={typeState("compose")}
							onClick={() =>
								setServiceTypes(toggleValue(facets.serviceTypes, "compose"))
							}
						/>
					</div>
				</PopoverContent>
			</Popover>
			<Button
				variant={facets.notCoveredOnly ? "secondary" : "outline"}
				size="sm"
				className="h-8 gap-2"
				aria-pressed={facets.notCoveredOnly}
				onClick={() =>
					onChange({ ...facets, notCoveredOnly: !facets.notCoveredOnly })
				}
			>
				<TriangleAlert
					className={cn("size-4", facets.notCoveredOnly && "text-orange-500")}
				/>
				Not covered only
			</Button>
			{explicit ? (
				<Button
					variant="ghost"
					size="sm"
					className="h-8 px-2 text-xs text-muted-foreground"
					onClick={() => onChange(EMPTY_COVERAGE_FACETS)}
				>
					Reset to default
				</Button>
			) : (
				<span className="text-xs text-muted-foreground">
					Default: production in full, plus databases &amp; volume-backed
					services elsewhere.
				</span>
			)}
		</div>
	);
};
