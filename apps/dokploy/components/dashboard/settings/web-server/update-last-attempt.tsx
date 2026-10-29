import { getUpdateAttemptPollMs } from "@dokploy/server/utils/dokploy-update-attempt";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, History } from "lucide-react";
import { api } from "@/utils/api";

const ago = (iso: string | undefined) => {
	const date = iso ? new Date(iso) : null;
	return date && !Number.isNaN(date.getTime())
		? formatDistanceToNow(date, { addSuffix: true })
		: "at an unknown time";
};

/** `latest` is only on records written before the resolved tag was kept. */
const targetLabel = (target: string, image: string) =>
	target === "latest" ? (image.split(":").pop() ?? target) : target;

/**
 * The last in-panel update and how it ended, in one line. The server judges
 * the stored status against the running version, so a swap that replaced the
 * job, a failed pull and a version that never changed all show for what they
 * are. Re-read every few seconds while the outcome can still change.
 */
export const UpdateLastAttempt = ({ enabled }: { enabled: boolean }) => {
	const { data: attempt } = api.settings.getLastUpdateAttempt.useQuery(
		undefined,
		{
			enabled,
			retry: false,
			refetchOnWindowFocus: false,
			refetchInterval: (query) =>
				getUpdateAttemptPollMs(query.state.data?.outcome),
		},
	);
	if (!attempt) {
		return null;
	}

	const route = `${attempt.fromVersion} → ${targetLabel(attempt.target, attempt.image)}`;
	const warning =
		"flex items-start gap-2 text-xs text-yellow-600 dark:text-yellow-400";

	switch (attempt.outcome) {
		case "mismatch":
			return (
				<p className={warning}>
					<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
					<span>
						Last update: {route} was submitted {ago(attempt.finishedAt)}, but
						the server is not running it. Check the Dokploy server logs (docker
						service ps dokploy).
					</span>
				</p>
			);
		case "interrupted":
			return (
				<p className={warning}>
					<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
					<span>
						Last update: {route} started {ago(attempt.startedAt)} and did not
						finish; the server is not running it. Check the Dokploy server logs.
					</span>
				</p>
			);
		case "failed":
			return (
				<p className="flex items-start gap-2 text-xs text-destructive">
					<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
					<span>
						Last update: {route}, failed {ago(attempt.finishedAt)}
						{attempt.error ? `: ${attempt.error}` : ""}
					</span>
				</p>
			);
		case "applied":
			return (
				<p className="flex items-start gap-2 text-xs text-muted-foreground">
					<CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
					<span>
						Last update: {route}, applied (started {ago(attempt.startedAt)})
					</span>
				</p>
			);
		default:
			return (
				<p className="flex items-start gap-2 text-xs text-muted-foreground">
					<History className="mt-0.5 h-3 w-3 shrink-0" />
					<span>
						Last update: {route},{" "}
						{attempt.outcome === "submitted"
							? `submitted ${ago(attempt.finishedAt)}`
							: `${attempt.status} since ${ago(attempt.startedAt)}`}
					</span>
				</p>
			);
	}
};
