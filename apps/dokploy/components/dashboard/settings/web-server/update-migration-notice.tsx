import { Database, Loader2 } from "lucide-react";
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
export const UpdateMigrationNotice = ({ version }: { version: string }) => {
	const { data, isLoading, isError } =
		api.settings.getUpdateMigrationDelta.useQuery(
			{ version },
			{ retry: false, refetchOnWindowFocus: false },
		);

	if (isLoading) {
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
					<p className="mt-1 text-yellow-600 dark:text-yellow-400">
						Rolling back later only switches the image. It does not undo{" "}
						{applies.length === 1 ? "this migration" : "these migrations"}.
					</p>
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
					<p className="mt-1 text-yellow-600 dark:text-yellow-400">
						Rolling back only switches the image. It does not undo migrations.
					</p>
				</div>
			)}
		</div>
	);
};
