import { Check, ListFilter, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Visibility mode of an environment in the coverage tree:
 * - "default": production environments show everything, other environments
 *   show only databases and services with named volumes;
 * - "all": show every service in the environment;
 * - "hidden": hide the environment entirely.
 */
export type EnvironmentMode = "default" | "all" | "hidden";

export interface FilterEnvironment {
	id: string;
	name: string;
	projectName: string;
	isProduction: boolean;
}

interface Props {
	environments: FilterEnvironment[];
	modes: Record<string, EnvironmentMode>;
	onChange: (modes: Record<string, EnvironmentMode>) => void;
}

const modeOf = (
	modes: Record<string, EnvironmentMode>,
	envId: string,
): EnvironmentMode => modes[envId] ?? "default";

// For production environments "default" already shows everything, so the
// toggle is binary (shown/hidden). Non-production environments cycle through
// the three states.
const nextMode = (
	current: EnvironmentMode,
	isProduction: boolean,
): EnvironmentMode => {
	if (isProduction) {
		return current === "hidden" ? "default" : "hidden";
	}
	switch (current) {
		case "default":
			return "all";
		case "all":
			return "hidden";
		default:
			return "default";
	}
};

const ModeBox = ({
	mode,
	isProduction,
}: {
	mode: EnvironmentMode;
	isProduction: boolean;
}) => {
	const showsEverything = mode === "all" || (isProduction && mode === "default");
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-sm border border-primary",
				mode === "hidden"
					? "bg-transparent"
					: "bg-primary text-primary-foreground",
			)}
		>
			{mode !== "hidden" &&
				(showsEverything ? (
					<Check className="size-3" />
				) : (
					<Minus className="size-3" />
				))}
		</span>
	);
};

export const CoverageEnvFilter = ({ environments, modes, onChange }: Props) => {
	const overrides = environments.filter(
		(environment) => modeOf(modes, environment.id) !== "default",
	).length;

	const setAll = (mode: EnvironmentMode | "default") => {
		if (mode === "default") {
			onChange({});
			return;
		}
		onChange(
			Object.fromEntries(
				environments.map((environment) => [environment.id, mode]),
			),
		);
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="h-8 gap-2">
					<ListFilter className="size-4" />
					Environments
					{overrides > 0 && (
						<Badge variant="blue" className="px-1.5 text-[10px]">
							{overrides}
						</Badge>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-0">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="text-sm font-medium">Environments</span>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={() => setAll("all")}
						>
							Show all
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={() => setAll("default")}
						>
							Reset
						</Button>
					</div>
				</div>
				<div className="max-h-72 overflow-y-auto p-1">
					{environments.map((environment) => {
						const mode = modeOf(modes, environment.id);
						return (
							<button
								key={environment.id}
								type="button"
								className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
								onClick={() =>
									onChange({
										...modes,
										[environment.id]: nextMode(
											mode,
											environment.isProduction,
										),
									})
								}
							>
								<ModeBox mode={mode} isProduction={environment.isProduction} />
								<span className="truncate">{environment.name}</span>
								<span className="ml-auto truncate text-xs text-muted-foreground">
									{environment.projectName}
								</span>
							</button>
						);
					})}
				</div>
				<div className="border-t px-3 py-2 text-[11px] leading-4 text-muted-foreground">
					<span className="font-medium">✓</span> everything ·{" "}
					<span className="font-medium">–</span> databases &amp; volumes only ·
					empty = hidden. Non-production environments default to databases and
					services with named volumes.
				</div>
			</PopoverContent>
		</Popover>
	);
};
