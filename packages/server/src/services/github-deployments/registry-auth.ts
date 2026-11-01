import { runDockerLogin } from "@dokploy/server/utils/process/dockerLogin";
import { loadGhcrCredentials } from "./store";

/**
 * Registry credentials for private ghcr.io images, from the GitHub connection
 * of a service that follows GitHub Deployments (T-12166). The token is read at
 * pull time and handed straight to Docker; it is never stored on the service,
 * returned by an API or written to a log.
 */

export const isGhcrImage = (image: string | null | undefined) =>
	typeof image === "string" &&
	image.trim().toLowerCase().startsWith("ghcr.io/");

/** The Docker auth config of an application's watch, or undefined. */
export const ghcrAuthConfigForApplication = async (
	applicationId: string,
	image: string | null | undefined,
) => {
	if (!isGhcrImage(image)) return undefined;
	const credentials = await loadGhcrCredentials("application", applicationId);
	if (!credentials) return undefined;
	return {
		username: credentials.username,
		password: credentials.password,
		serveraddress: credentials.registryUrl,
	};
};

/**
 * `docker login ghcr.io` on the host that will run the stack, with the
 * password on stdin (never in argv). Does nothing for a compose without a
 * watch. A failed login is reported but never fails the deploy: a public image
 * still pulls, and a private one fails at the pull with Docker's own message.
 */
export const loginGhcrForCompose = async (
	composeId: string,
	serverId: string | null | undefined,
) => {
	const credentials = await loadGhcrCredentials("compose", composeId);
	if (!credentials) return;
	try {
		await runDockerLogin(
			{
				registryType: "cloud",
				registryUrl: credentials.registryUrl,
				username: credentials.username,
				password: credentials.password,
			},
			serverId,
		);
	} catch (error) {
		console.warn(
			"GitHub deployments: could not log in to ghcr.io:",
			error instanceof Error ? error.message : "unknown error",
		);
	}
};

/**
 * `docker login ghcr.io` on the host that pulls an application's image, with
 * the password on stdin. A no-op unless the image is on ghcr.io and the
 * application has an active watch. A failed login never fails the deploy.
 */
export const loginGhcrForApplication = async (
	applicationId: string,
	image: string | null | undefined,
	serverId: string | null | undefined,
) => {
	if (!isGhcrImage(image)) return;
	const credentials = await loadGhcrCredentials("application", applicationId);
	if (!credentials) return;
	try {
		await runDockerLogin(
			{
				registryType: "cloud",
				registryUrl: credentials.registryUrl,
				username: credentials.username,
				password: credentials.password,
			},
			serverId,
		);
	} catch (error) {
		console.warn(
			"GitHub deployments: could not log in to ghcr.io:",
			error instanceof Error ? error.message : "unknown error",
		);
	}
};
