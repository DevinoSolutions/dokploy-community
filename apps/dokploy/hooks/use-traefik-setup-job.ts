import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/utils/api";
import { isConnectionLost } from "@/utils/is-connection-lost";
import {
	newTraefikSetupJobId,
	waitForTraefikSetup,
} from "@/utils/wait-for-traefik-setup";

const HEALTH_CHECK_URL = "/api/health";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

// So a hung request ends before the wait does.
const REQUEST_TIMEOUT_MS = 10_000;

const checkHealth = async () => {
	try {
		const response = await fetch(HEALTH_CHECK_URL, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
};

export interface UseTraefikSetupJobOptions {
	serverId?: string;
	/** Shown once the change is saved and Traefik is being recreated. */
	applyingMessage: string;
	/** Shown when Traefik has been recreated and the dashboard answers again. */
	successMessage: string;
	/** Start of the error toast; the failure's first line follows it. */
	failureMessage: string;
	/** Called when the run ended, whether it worked or not. */
	onSettled?: (ok: boolean) => void | Promise<void>;
}

// For the saves that return before the queued Traefik recreate has run (env,
// ports, dashboard): reports success only once that run has finished.
export const useTraefikSetupJob = ({
	serverId,
	applyingMessage,
	successMessage,
	failureMessage,
	onSettled,
}: UseTraefikSetupJobOptions) => {
	const [isExecuting, setIsExecuting] = useState(false);
	const utils = api.useUtils();

	const execute = useCallback(
		async (save: (jobId: string) => Promise<unknown>): Promise<boolean> => {
			const jobId = newTraefikSetupJobId();
			setIsExecuting(true);
			try {
				try {
					await save(jobId);
				} catch (error) {
					// The reply can be lost while the save itself goes on.
					if (!isConnectionLost(error)) {
						throw error;
					}
				}
				const toastId = toast.loading(applyingMessage);
				const result = await waitForTraefikSetup({
					getStatus: () =>
						utils.client.settings.getTraefikSetupJob.query(
							{ serverId, jobId },
							{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
						),
					isHealthy: checkHealth,
					sleep,
					now: Date.now,
				});
				if (result.status === "applied") {
					toast.success(successMessage, { id: toastId });
				} else if (result.status === "failed") {
					toast.error(
						result.error
							? `${failureMessage}: ${result.error}`
							: `${failureMessage}.`,
						{ id: toastId },
					);
				} else {
					toast.warning(
						"Saved, but couldn't confirm it was applied. Check View Logs.",
						{ id: toastId },
					);
				}
				const applied = result.status === "applied";
				await onSettled?.(applied);
				return applied;
			} finally {
				setIsExecuting(false);
			}
		},
		[
			serverId,
			applyingMessage,
			successMessage,
			failureMessage,
			onSettled,
			utils,
		],
	);

	return { execute, isExecuting };
};
