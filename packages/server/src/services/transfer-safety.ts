import { IS_CLOUD } from "@dokploy/server/constants";
import type { ServiceType } from "@dokploy/server/db/schema";
import { logger } from "@dokploy/server/lib/logger";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import {
	evaluateBindMountHostPath,
	getUnsafePermissionTargetReason,
} from "@dokploy/server/utils/docker/bind-mount-policy";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import {
	findRefusedComposeVolumes,
	findRefusedVolumeMounts,
} from "./volume-binding";

// Checks that run before a transfer touches anything: which server may receive
// the service, which volumes and directories the transfer would write over on
// that server, and which host paths may be copied at all. They sit around the
// transfer in services/transfer.ts rather than inside it, so that file can
// follow upstream.
//
// Every check fails closed: a command that cannot be run, or an answer that
// cannot be read, refuses the transfer instead of letting it through.

type Logger = (line: string) => void;

const q = (value: string) => quote([value]);

// A check that cannot answer in this time refuses the transfer: a stalled
// image pull or ssh link must not hang the request.
export const CHECK_TIMEOUT_MS = 60_000;

const runOn = (serverId: string | null, command: string) =>
	serverId
		? execAsyncRemote(serverId, command, undefined, {
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			})
		: execAsync(command, { timeout: CHECK_TIMEOUT_MS });

// The first line of what a host said, cut short: it is shown to the caller.
const detail = (error: unknown) =>
	(error instanceof Error ? error.message.split("\n")[0] : "")?.slice(0, 160) ||
	"unknown error";

// Docker's own rule for the name of a volume. A name outside it is never a
// named volume: Docker reads one that starts with `/` as a host path (a bind
// mount of the whole path) and one with a space or a quote as something else,
// so it is not copied by name, whatever the shell would do with it.
const DOCKER_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

export const isDockerVolumeName = (name: string) =>
	DOCKER_VOLUME_NAME.test(name);

// A name that comes from a stored mount or a compose file is the user's text:
// it is printed in a message, never as part of a command.
const show = (value: string) => JSON.stringify(value.slice(0, 120));

export type TransferCaller = {
	// The caller is an owner or an admin of the organization.
	privilegedRole: boolean;
	// The caller's organization may reach the Dokploy host (see
	// canAccessLocalHost in the API layer).
	localHostReach: boolean;
};

// What the create routes of applications, composes and databases apply to a
// service that has no server: with the instance set to remote servers only, the
// Dokploy host takes no new service. A transfer to it is a new service on it.
export const assertTransferTargetAllowed = async (
	targetServerId: string | null,
) => {
	if (targetServerId) {
		return;
	}
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The Dokploy server is not available as a target",
		});
	}
	const settings = await getWebServerSettings();
	if (!settings || settings.remoteServersOnly) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"This Dokploy instance is set to remote servers only, so a service cannot be transferred to the Dokploy server. Choose a remote server.",
		});
	}
};

type VolumeState = "missing" | "empty" | "non-empty";

// Only an explicit "no such volume" / "no such file" is missing. Any other
// failure (docker daemon down, permission denied, a listing that errors) exits
// non-zero, which the caller reads as "could not check" and refuses.
// `docker volume inspect` goes first because `docker run -v name:` would create
// a volume that does not exist; the volume is only read (`:ro`).
export const volumeStateCommand = (volume: string) =>
	`err=$(docker volume inspect ${q(volume)} 2>&1 >/dev/null); rc=$?; if [ $rc -eq 0 ]; then docker run --rm -v ${q(volume)}:/data:ro alpine sh -c 'if ! out=$(find /data -mindepth 1 -maxdepth 1 -print -quit 2>&1); then echo "$out" >&2; exit 1; fi; if [ -n "$out" ]; then echo non-empty; else echo empty; fi'; elif printf %s "$err" | grep -qi 'no such volume'; then echo missing; else echo "$err" >&2; exit 1; fi`;

export const directoryStateCommand = (directory: string) =>
	`kind=$(stat -c %F -- ${q(directory)} 2>&1); rc=$?; if [ $rc -ne 0 ]; then case "$kind" in *'No such file or directory'*) echo missing;; *) echo "$kind" >&2; exit 1;; esac; elif [ "$kind" != directory ]; then echo "not a directory" >&2; exit 1; elif ! out=$(find ${q(directory)} -mindepth 1 -maxdepth 1 -print -quit 2>&1); then echo "$out" >&2; exit 1; elif [ -n "$out" ]; then echo non-empty; else echo empty; fi`;

const readState = async (
	serverId: string | null,
	command: string,
): Promise<VolumeState> => {
	const { stdout } = await runOn(serverId, command);
	const answer = stdout.trim();
	if (answer === "missing" || answer === "empty" || answer === "non-empty") {
		return answer;
	}
	throw new Error(`unexpected answer ${show(answer)}`);
};

const stateOrBlocker = async (
	serverId: string | null,
	command: string,
	label: string,
): Promise<{ state: VolumeState | null; blocker: string | null }> => {
	try {
		return { state: await readState(serverId, command), blocker: null };
	} catch (error) {
		return {
			state: null,
			blocker: `Could not check ${label} on the target server (${detail(
				error,
			)}), so the transfer is refused.`,
		};
	}
};

export type PlannedVolume = {
	name: string;
	// Data already on the target server under this name.
	targetState: VolumeState | null;
	// The caller agreed to write over what the target holds.
	overwrite: boolean;
};

export type PlannedBindMount = {
	hostPath: string;
	existsOnSource: boolean;
	targetState: VolumeState | null;
	overwrite: boolean;
};

export type ComposeHostBind = {
	service: string;
	source: string;
	target: string | null;
	kind: "absolute" | "relative" | "home" | "variable";
};

export type TransferPlan = {
	volumes: PlannedVolume[];
	bindMounts: PlannedBindMount[];
	// Host paths a compose file binds that the transfer does not copy: only the
	// bind mounts stored on the service are copied. Report only.
	composeHostBinds: ComposeHostBind[];
	composeBindScan: { scanned: boolean; note: string | null };
	// What the target would lose without the caller's say-so.
	needsOverwrite: string[];
	// Why the transfer is refused as it stands (needsOverwrite is not in it).
	blockers: string[];
};

export type InspectTransferInput = {
	serviceType: ServiceType;
	serviceId: string;
	appName: string;
	volumes: string[];
	bindMounts: string[];
	// The compose file's own declared names. Only a compose has any.
	isCompose: boolean;
	sourceServerId: string | null;
	targetServerId: string | null;
	overwriteTargets: string[];
	caller: TransferCaller;
};

export const inspectTransferPlan = async (
	input: InspectTransferInput,
): Promise<TransferPlan> => {
	const approved = new Set(input.overwriteTargets);
	const blockers: string[] = [];
	const needsOverwrite: string[] = [];
	const volumes: PlannedVolume[] = [];
	const bindMounts: PlannedBindMount[] = [];

	// Volumes ---------------------------------------------------------------
	const wellNamed = input.volumes.filter((name) => {
		if (isDockerVolumeName(name)) {
			return true;
		}
		blockers.push(
			`Volume ${show(name)} is refused: it is not a valid Docker volume name.`,
		);
		return false;
	});

	// The names are bound to the service's own namespace on both hosts (T-6822):
	// a transfer reads a volume by name on the source and writes it by name on the
	// target, so another organization's volume is never copied out of or over.
	const servers = [input.sourceServerId, input.targetServerId];
	let refusedNames = new Set<string>();
	try {
		const refused = await findRefusedVolumeMounts(
			wellNamed.map((volumeName) => ({ type: "volume", volumeName })),
			{ serviceType: input.serviceType, serviceId: input.serviceId },
			{ serverIds: servers },
		);
		if (input.isCompose) {
			refused.push(
				...(await findRefusedComposeVolumes(
					{ composeId: input.serviceId, appName: input.appName },
					wellNamed.map((volumeName) => ({ volumeName })),
					{ serverIds: servers },
				)),
			);
		}
		refusedNames = new Set(refused.map((entry) => entry.volumeName));
		for (const entry of refused) {
			blockers.push(`Transfer refused: ${entry.message}`);
		}
	} catch (error) {
		logger.error(
			{ err: error, serviceId: input.serviceId },
			"[Transfer] The volume ownership check failed",
		);
		blockers.push(
			"Could not check who the volumes belong to, so the transfer is refused. The error is in the server log.",
		);
		refusedNames = new Set(wellNamed);
	}

	for (const name of wellNamed) {
		if (refusedNames.has(name)) {
			continue;
		}
		const { state, blocker } = await stateOrBlocker(
			input.targetServerId,
			volumeStateCommand(name),
			`volume ${show(name)}`,
		);
		if (blocker) {
			blockers.push(blocker);
		}
		const overwrite = approved.has(name);
		volumes.push({ name, targetState: state, overwrite });
		if (state === "non-empty" && !overwrite) {
			needsOverwrite.push(name);
		}
	}

	// Bind mounts -----------------------------------------------------------
	const touchesLocalHost =
		input.sourceServerId === null || input.targetServerId === null;
	for (const hostPath of input.bindMounts) {
		const decision = evaluateBindMountHostPath({
			hostPath,
			privilegedRole: input.caller.privilegedRole,
			hostReach:
				input.caller.privilegedRole &&
				(!touchesLocalHost || input.caller.localHostReach),
		});
		if (!decision.ok) {
			blockers.push(
				`Bind mount ${show(hostPath)} is refused: ${decision.message}`,
			);
			continue;
		}
		const unsafe = getUnsafePermissionTargetReason(hostPath);
		if (unsafe !== null) {
			blockers.push(
				`Bind mount ${show(hostPath)} is refused: ${unsafe}, and a transfer copies it recursively.`,
			);
			continue;
		}
		// Only "missing" on the source skips the target: the transfer copies
		// nothing then. A source that cannot be read refuses.
		let existsOnSource = false;
		try {
			existsOnSource =
				(await readState(
					input.sourceServerId,
					directoryStateCommand(hostPath),
				)) !== "missing";
		} catch (error) {
			blockers.push(
				`Could not check bind mount ${show(hostPath)} on the source server (${detail(error)}), so the transfer is refused.`,
			);
			continue;
		}
		const { state, blocker } = existsOnSource
			? await stateOrBlocker(
					input.targetServerId,
					directoryStateCommand(hostPath),
					`bind mount ${show(hostPath)}`,
				)
			: { state: null, blocker: null };
		if (blocker) {
			blockers.push(blocker);
		}
		const overwrite = approved.has(hostPath);
		bindMounts.push({
			hostPath,
			existsOnSource,
			targetState: state,
			overwrite,
		});
		if (state === "non-empty" && !overwrite) {
			needsOverwrite.push(hostPath);
		}
	}

	return {
		volumes,
		bindMounts,
		composeHostBinds: [],
		composeBindScan: { scanned: false, note: null },
		needsOverwrite,
		blockers,
	};
};

// The text of the refusal, or null when the transfer may go ahead.
export const describeTransferRefusal = (plan: TransferPlan) => {
	const lines = [...plan.blockers];
	if (plan.needsOverwrite.length > 0) {
		lines.push(
			`The target server already holds data under ${plan.needsOverwrite
				.map(show)
				.join(
					", ",
				)}. The transfer would write over it. Empty or rename it on the target server, or repeat the transfer naming each one in overwriteTargets to write over it.`,
		);
	}
	return lines.length > 0 ? lines.join(" ") : null;
};

export const assertTransferPlanAllowed = (plan: TransferPlan) => {
	const refusal = describeTransferRefusal(plan);
	if (refusal === null) {
		return;
	}
	throw new TRPCError({
		code: plan.blockers.length > 0 ? "BAD_REQUEST" : "CONFLICT",
		message: `Transfer refused before anything was moved. ${refusal}`,
	});
};

// A compose file's bind mounts of host paths -----------------------------------

const classifySource = (source: string): ComposeHostBind["kind"] | null => {
	if (source.startsWith("/")) return "absolute";
	if (source === "." || source === ".." || /^\.\.?\//.test(source)) {
		return "relative";
	}
	if (source.startsWith("~")) return "home";
	if (source.startsWith("$")) return "variable";
	return null;
};

// `../files/...` is where Dokploy keeps the file mounts of a compose; they are
// recreated on the target from the stored mounts.
const isDokployFilesPath = (source: string) =>
	source === "../files" || source.startsWith("../files/");

const readBind = (service: string, entry: unknown): ComposeHostBind | null => {
	if (typeof entry === "string") {
		// "source:target[:mode]" is a bind when the source looks like a path;
		// a bare "target" or a "name:target" is an anonymous or named volume.
		const [source, target] = entry.split(":");
		if (!entry.includes(":") || !source) return null;
		const kind = classifySource(source);
		if (!kind || isDokployFilesPath(source)) return null;
		return { service, source, target: target ?? null, kind };
	}
	if (entry && typeof entry === "object") {
		const long = entry as {
			type?: unknown;
			source?: unknown;
			target?: unknown;
		};
		if (long.type !== "bind" || typeof long.source !== "string") return null;
		const kind = classifySource(long.source);
		if (!kind || isDokployFilesPath(long.source)) return null;
		return {
			service,
			source: long.source,
			target: typeof long.target === "string" ? long.target : null,
			kind,
		};
	}
	return null;
};

// The host paths a parsed compose file binds into its services. The stored
// bind mounts of the service (`alreadyMoved`) are copied by the transfer and
// are left out.
export const scanComposeHostBinds = (
	spec: unknown,
	alreadyMoved: string[] = [],
): ComposeHostBind[] => {
	const found: ComposeHostBind[] = [];
	const moved = new Set(alreadyMoved);
	const services = (spec as { services?: unknown } | null)?.services;
	if (!services || typeof services !== "object") {
		return found;
	}
	for (const [name, definition] of Object.entries(services)) {
		const volumes = (definition as { volumes?: unknown } | null)?.volumes;
		if (!Array.isArray(volumes)) continue;
		for (const entry of volumes) {
			const bind = readBind(name, entry);
			if (bind && !moved.has(bind.source)) {
				found.push(bind);
			}
		}
	}
	return found;
};

export const describeComposeHostBind = (bind: ComposeHostBind) =>
	`${bind.service}: ${show(bind.source)}${bind.target ? ` -> ${show(bind.target)}` : ""}`;

export const logComposeHostBinds = (binds: ComposeHostBind[], log: Logger) => {
	if (binds.length === 0) return;
	log(
		`Warning: ${binds.length} host path(s) bound by the compose file will NOT be copied: ${binds
			.map(describeComposeHostBind)
			.join("; ")}`,
	);
};

// The same check at the moment the data lands: the plan was made before the
// service was stopped, and a volume or directory can have been filled since.
// Throws unless the target is empty, missing, or named in overwriteTargets.
export const assertTargetStillClear = async ({
	targetServerId,
	kind,
	name,
	overwriteTargets,
}: {
	targetServerId: string | null;
	kind: "volume" | "directory";
	name: string;
	overwriteTargets: string[];
}) => {
	if (overwriteTargets.includes(name)) {
		return;
	}
	let state: VolumeState;
	try {
		state = await readState(
			targetServerId,
			kind === "volume"
				? volumeStateCommand(name)
				: directoryStateCommand(name),
		);
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Transfer refused: could not check ${kind} ${show(name)} on the target server (${detail(error)}).`,
		});
	}
	if (state === "non-empty") {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Transfer refused: the target server now holds data under ${show(name)}, and it is not listed in overwriteTargets.`,
		});
	}
};
