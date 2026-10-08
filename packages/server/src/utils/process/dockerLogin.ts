import {
	getSafeRegistryLoginCommand,
	type RegistryLoginData,
} from "@dokploy/server/db/schema";
import { truncateOutputTail } from "./ExecError";
import { execAsync, execAsyncRemote } from "./execAsync";
import { redactSecrets } from "./redactSecrets";

/** Chars of docker's output kept in the login failure message. */
const LOGIN_FAILURE_TAIL = 500;

/**
 * Why a login failed, from docker's own output. The failure is rethrown as a
 * plain Error (see runDockerLogin), so it is redacted here: the secret fed on
 * stdin is scrubbed even if docker echoed it back.
 */
const describeLoginFailure = (error: unknown, secret: string): string => {
	const output = error as { stderr?: unknown; stdout?: unknown };
	const detail =
		(typeof output?.stderr === "string" && output.stderr) ||
		(typeof output?.stdout === "string" && output.stdout) ||
		(error instanceof Error ? error.message : String(error));
	let tail = truncateOutputTail(redactSecrets(detail), LOGIN_FAILURE_TAIL);
	if (secret) tail = tail.split(secret).join("***");
	return tail;
};

type RemoteOptions = NonNullable<Parameters<typeof execAsyncRemote>[3]>;
export type LoginCancelable = RemoteOptions["cancelable"];

/**
 * Logs Docker into a registry on `serverId`, or on this host without one.
 * The password travels on the command's stdin: it must never be part of a
 * command line, which every user on the host can read through `ps`.
 *
 * A failure is thrown as a plain Error ("Registry login failed for <url>: ..."),
 * not an ExecError: the deploy flows write only plain errors to the deployment
 * log and leave ExecErrors to the command's own output, which a login run
 * outside the build script does not have.
 */
export const runDockerLogin = async (
	data: RegistryLoginData,
	serverId?: string | null,
	options?: {
		/** Lets a deployment cancel stop a remote login. */
		cancelable?: LoginCancelable;
	},
): Promise<void> => {
	const { command, stdin } = getSafeRegistryLoginCommand(data);
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command, undefined, {
				stdin,
				cancelable: options?.cancelable,
			});
		} else {
			await execAsync(command, { stdin });
		}
	} catch (error) {
		throw new Error(
			`Registry login failed for ${data.registryUrl || "Docker Hub"}: ${describeLoginFailure(error, stdin)}`,
		);
	}
};
