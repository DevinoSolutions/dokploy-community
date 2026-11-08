import {
	presentReleaseStatus,
	presentRetry,
} from "@dokploy/server/services/gha-connect/present";
import {
	decideRegistryRetry,
	describeRegistryRetry,
	exhaustedNote,
	isRegistryAccessError,
	MAX_REGISTRY_RETRIES,
	REGISTRY_RETRY_DELAYS_MS,
	registryRetryText,
} from "@dokploy/server/services/gha-connect/registry-retry";
import { describe, expect, it } from "vitest";
import { describeProviderStatus } from "../../components/dashboard/shared/gha-provider-model";

const DENIED =
	'Container did not stay running after deployment: Task rejected: Get "https://ghcr.io/v2/DevinoSolutions/voicelabs/landing/manifests/sha256:' +
	"a".repeat(64) +
	'": denied: denied';

describe("which failed deploys are registry access errors", () => {
	it.each([
		["the GHCR denial seen on 2026-11-08", DENIED],
		[
			"unauthorized on a rejected task",
			'Task rejected: Head "https://ghcr.io/v2/o/r/manifests/sha256:b": unauthorized',
		],
		[
			"manifest unknown on a rejected task",
			"Container did not stay running after deployment: Task rejected: manifest unknown",
		],
		[
			"a manifest that is not found",
			'Task rejected: Get "https://ghcr.io/v2/o/r/manifests/sha256:c": not found',
		],
		[
			"a pull error of a compose stack deploy",
			"Error response from daemon: pull access denied for ghcr.io/o/r, repository does not exist",
		],
	])("matches %s", (_name, message) => {
		expect(isRegistryAccessError(message)).toBe(true);
	});

	it.each([
		["nothing", undefined],
		["an empty text", ""],
		[
			"a container that crashed",
			"Container did not stay running after deployment: Task failed: task: non-zero exit (1)",
		],
		[
			"a crash that says not found",
			"Container did not stay running after deployment: Task failed: exec: node: not found",
		],
		[
			"a rejection that has nothing to do with the registry",
			"Container did not stay running after deployment: Task rejected: no suitable node (insufficient resources on 1 node)",
		],
		[
			"a rollback",
			"Container did not stay running after deployment: Service update rollback_started: update rolled back",
		],
		["a build error", "Error building, check the logs for details."],
		[
			"a mount problem (permission denied)",
			'Container did not stay running after deployment: Task rejected: invalid mount config for type "bind": mkdir /data: permission denied',
		],
		[
			"permission denied next to a manifest URL",
			"Task rejected: open /var/lib/docker/v2/o/r/manifests/sha256:a: permission denied",
		],
		[
			"a plain not found that is not tied to a registry URL",
			"Container did not stay running after deployment: Task rejected: image not found in the local cache",
		],
		[
			"a bare denied with no registry wording",
			"Container did not stay running after deployment: Task rejected: denied",
		],
		[
			"a /v2/ URL that is not the registry API",
			"Task failed: GET https://api.example.com/v2/users unauthorized",
		],
		[
			"an unauthorized API call during a failed task",
			"Task rejected: hook GET https://api.example.com/v2/users/manifests-list unauthorized",
		],
	])("does not match %s", (_name, message) => {
		expect(isRegistryAccessError(message)).toBe(false);
	});
});

describe("the retry schedule", () => {
	it("waits 60, 120, 240 and 300 seconds: four retries, 12 minutes in all", () => {
		expect(REGISTRY_RETRY_DELAYS_MS).toEqual([
			60_000, 120_000, 240_000, 300_000,
		]);
		expect(MAX_REGISTRY_RETRIES).toBe(4);
		expect(REGISTRY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(720_000);
	});

	it("a registry error schedules the next retry with its delay", () => {
		const attempts = [0, 1, 2, 3].map((retriesDone) =>
			decideRegistryRetry({ registryAccess: true, retriesDone }),
		);
		expect(attempts).toEqual([
			{ kind: "retry", attempt: 1, delayMs: 60_000 },
			{ kind: "retry", attempt: 2, delayMs: 120_000 },
			{ kind: "retry", attempt: 3, delayMs: 240_000 },
			{ kind: "retry", attempt: 4, delayMs: 300_000 },
		]);
	});

	it("is exhausted after the fourth retry", () => {
		expect(
			decideRegistryRetry({ registryAccess: true, retriesDone: 4 }),
		).toEqual({ kind: "exhausted" });
	});

	it("any other error settles as failed, as before", () => {
		for (const retriesDone of [0, 2, 4]) {
			expect(
				decideRegistryRetry({ registryAccess: false, retriesDone }),
			).toEqual({ kind: "settle" });
		}
	});
});

describe("what GitHub and the dashboard say while a retry waits", () => {
	it("says the image is not readable yet and counts the retries", () => {
		expect(registryRetryText(1, 60_000)).toBe(
			"Image not readable at the registry yet; retrying in 60 s (1/4)",
		);
		expect(registryRetryText(4, 300_000)).toBe(
			"Image not readable at the registry yet; retrying in 300 s (4/4)",
		);
	});

	it("counts down on the dashboard and says now once the time came", () => {
		const retryAt = new Date("2026-11-08T10:01:00Z");
		expect(
			describeRegistryRetry(
				{ attempt: 1, retryAt },
				new Date("2026-11-08T10:00:15Z"),
			),
		).toBe("Image not readable at the registry yet; retrying in 45 s (1/4)");
		expect(
			describeRegistryRetry(
				{ attempt: 2, retryAt },
				new Date("2026-11-08T10:01:00Z"),
			),
		).toBe("Image not readable at the registry yet; retrying now (2/4)");
	});

	it("the failure note names the commit and the retries", () => {
		expect(exhaustedNote("a".repeat(40))).toBe(
			"Release aaaaaaa failed: the registry still did not serve the image after 4 retries.",
		);
	});
});

describe("how a waiting release is presented", () => {
	const now = new Date("2026-11-08T10:00:00Z");
	const waiting = {
		status: "accepted",
		delivery: "pull",
		retryAt: new Date("2026-11-08T10:02:00Z"),
		retryAttempt: 2,
	};

	it("an accepted release with a retry time is retrying; every other status is as stored", () => {
		expect(presentReleaseStatus(waiting)).toBe("retrying");
		expect(presentReleaseStatus({ ...waiting, retryAt: null })).toBe(
			"accepted",
		);
		expect(presentReleaseStatus({ ...waiting, status: "failed" })).toBe(
			"failed",
		);
		expect(presentReleaseStatus({ ...waiting, status: "superseded" })).toBe(
			"superseded",
		);
	});

	it("the connection shows the retry sentence, attempt and time", () => {
		expect(presentRetry([waiting], now)).toEqual({
			attempt: 2,
			max: 4,
			retryAt: waiting.retryAt,
			statusText:
				"Image not readable at the registry yet; retrying in 120 s (2/4)",
		});
	});

	it("nothing waits: no retry", () => {
		expect(presentRetry([], now)).toBeNull();
		expect(
			presentRetry(
				[
					{ ...waiting, retryAt: null },
					{ ...waiting, status: "failed" },
				],
				now,
			),
		).toBeNull();
	});

	it("the Provider tab shows a Retrying pill and keeps the sentence", () => {
		const status = describeProviderStatus({
			state: "connected",
			statusText:
				"Image not readable at the registry yet; retrying in 60 s (1/4)",
			lastError: null,
			repository: "DevinoSolutions/voicelabs",
			workflowPath: ".github/workflows/dokploy.yml",
			trackedBranch: "main",
			environment: "production",
			serviceKey: "landing",
			deployedSha: null,
			deployedRunId: null,
			deployedAt: null,
			lastActivityAt: null,
			retry: { attempt: 1, max: 4 },
		});
		expect(status.pill).toEqual({ label: "Retrying", tone: "warn" });
		expect(status.sentence).toBe(
			"Image not readable at the registry yet; retrying in 60 s (1/4)",
		);
	});
});
