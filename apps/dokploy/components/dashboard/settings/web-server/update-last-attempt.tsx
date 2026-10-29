import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, History } from "lucide-react";
import { api } from "@/utils/api";

const ago = (iso: string | undefined) => {
	const date = iso ? new Date(iso) : null;
	return date && !Number.isNaN(date.getTime())
		? formatDistanceToNow(date, { addSuffix: true })
		: "at an unknown time";
};

/** `latest` is the release the server resolved, which the image names. */
const targetLabel = (target: string, image: string) =>
	target === "latest" ? (image.split(":").pop() ?? target) : target;

/**
 * The last in-panel update and how it ended, in one line. A submitted update
 * only means Docker took the command: a version that still differs after a few
 * minutes, or a failed pull, is shown as a warning.
 */
export const UpdateLastAttempt = ({ enabled }: { enabled: boolean }) => {
	const { data: attempt } = api.settings.getLastUpdateAttempt.useQuery(
		undefined,
		{ enabled, retry: false, refetchOnWindowFocus: false },
	);
	if (!attempt) {
		return null;
	}

	const route = `${attempt.fromVersion} → ${targetLabel(attempt.target, attempt.image)}`;

	if (attempt.versionMismatch) {
		return (
			<p className="flex items-start gap-2 text-xs text-yellow-600 dark:text-yellow-400">
				<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
				<span>
					Last update: {route} was submitted {ago(attempt.finishedAt)}, but the
					server is not running it. Check the Dokploy server logs (docker service
					ps dokploy).
				</span>
			</p>
		);
	}

	if (attempt.status === "failed") {
		return (
			<p className="flex items-start gap-2 text-xs text-destructive">
				<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
				<span>
					Last update: {route}, failed {ago(attempt.finishedAt)}
					{attempt.error ? `: ${attempt.error}` : ""}
				</span>
			</p>
		);
	}

	const state =
		attempt.status === "submitted"
			? `submitted ${ago(attempt.finishedAt)}`
			: `${attempt.status} since ${ago(attempt.startedAt)}`;
	return (
		<p className="flex items-start gap-2 text-xs text-muted-foreground">
			<History className="mt-0.5 h-3 w-3 shrink-0" />
			<span>
				Last update: {route}, {state}
			</span>
		</p>
	);
};
