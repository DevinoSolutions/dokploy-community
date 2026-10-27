import { Database, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/utils/api";

const migrations = (count: number) =>
	`${count} database migration${count === 1 ? "" : "s"}`;

const MigrationList = ({ tags }: { tags: string[] }) => (
	<ul className="mt-1 max-h-24 overflow-y-auto font-mono text-xs">
		{tags.map((tag) => (
			<li key={tag}>{tag}</li>
		))}
	</ul>
);

/**
 * What installing `version` does to the database, from the migrations the
 * running version has and the ones the target ships. Informational only: it
 * never blocks the install, and a failed check says so.
 */
export const UpdateMigrationNotice = ({
	version,
	debounceMs = 0,
}: {
	version: string;
	/** Waits this long after `version` stops changing, for a typed tag. */
	debounceMs?: number;
}) => {
	const [settledVersion, setSettledVersion] = useState(version);
	useEffect(() => {
		if (debounceMs <= 0) {
			setSettledVersion(version);
			return;
		}
		const timer = setTimeout(() => setSettledVersion(version), debounceMs);
		return () => clearTimeout(timer);
	}, [version, debounceMs]);

	const { data, isLoading, isError } =
		api.settings.getUpdateMigrationDelta.useQuery(
			{ version: settledVersion },
			{
				retry: false,
				refetchOnWindowFocus: false,
				staleTime: 5 * 60_000,
			},
		);

	if (isLoading || settledVersion !== version) {
		return (
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				<Loader2 className="h-3 w-3 animate-spin" />
				Checking database migrations...
			</p>
		);
	}

	if (isError || !data || data.status !== "ok") {
		return (
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				<Database className="h-3 w-3 shrink-0" />
				Couldn't check migrations for this version.
			</p>
		);
	}

	const { applies, staysApplied } = data;
	if (applies.length === 0 && staysApplied.length === 0) {
		return (
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				<Database className="h-3 w-3 shrink-0" />
				No database migrations to apply.
			</p>
		);
	}

	return (
		<div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
			{applies.length > 0 && (
				<div>
					<p>
						This update applies {migrations(applies.length)}
						{applies.length === 1 ? `: ${applies[0]}` : ":"}
					</p>
					{applies.length > 1 && <MigrationList tags={applies} />}
				</div>
			)}
			{staysApplied.length > 0 && (
				<div>
					<p>
						{migrations(staysApplied.length)} from the running version{" "}
						{staysApplied.length === 1 ? "stays" : "stay"} applied
						{staysApplied.length === 1 ? `: ${staysApplied[0]}` : ":"}
					</p>
					{staysApplied.length > 1 && <MigrationList tags={staysApplied} />}
				</div>
			)}
			<p className="text-yellow-600 dark:text-yellow-400">
				Rolling back only switches the image. It does not undo migrations.
			</p>
		</div>
	);
};
