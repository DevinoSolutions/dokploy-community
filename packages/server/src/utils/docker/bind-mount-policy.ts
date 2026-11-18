import { posix } from "node:path";
import { paths } from "@dokploy/server/constants";

// A bind mount hands a path of the Docker host to a container, and its
// uid/gid/mode make Dokploy run a recursive chown/chmod on that path as the
// Dokploy process. Both reach the whole host, so they are a capability of the
// owner and the admins (a container can plant a symlink in its own service
// directory and bind that, so there is no directory a member or a tenant admin
// may bind on the Dokploy host), and the permission change never runs on a
// path the host cannot afford to have rewritten.
//
// A path that is not absolute is refused rather than guessed. The permission
// change needs the path in its canonical form (no `//`, `/./`, `/../` or
// trailing slash): the value that is checked is then the very value the shell
// command gets, and `link/..` cannot mean one thing to the check and another
// to the kernel.

export const normalizeHostPath = (hostPath: string): string | null => {
	if (typeof hostPath !== "string" || hostPath.includes("\0")) {
		return null;
	}
	if (!hostPath.startsWith("/")) {
		return null;
	}
	const normalized = posix.normalize(hostPath);
	return normalized.length > 1 ? normalized.replace(/\/+$/, "") : "/";
};

// The path as it is when it has no empty, `.` or `..` segment and no trailing
// slash.
export const isCanonicalHostPath = (hostPath: string): boolean =>
	normalizeHostPath(hostPath) === hostPath;

const isWithin = (target: string, root: string) =>
	target === root || target.startsWith(`${root}/`);

// System directories: the directory and everything below it.
const SYSTEM_TREES = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/run",
	"/var/run",
	"/var/lib/docker",
	"/var/lib/containerd",
	"/var/lib/kubelet",
	"/var/lib/dpkg",
	"/var/log",
	"/var/spool",
	"/snap",
	"/lost+found",
	"/root",
];

// Directories whose own tree is data, but which are never a target themselves.
const SYSTEM_ROOTS = [
	"/",
	"/home",
	"/var",
	"/var/lib",
	"/tmp",
	"/mnt",
	"/media",
	"/opt",
	"/srv",
];

const SOCKET_NAME = /\.sock(et)?$/i;

const dokployBasePaths = () => [
	...new Set([paths(true).BASE_PATH, paths(false).BASE_PATH]),
];

// What a service keeps in the Dokploy base directory: one directory per
// service below applications/ and compose/. Everything else in the base
// directory (ssh keys, traefik, certificates, registry, ...) is Dokploy's own.
const isInsideAServiceDirectory = (target: string, base: string) => {
	const roots = [`${base}/applications`, `${base}/compose`];
	return roots.some((root) => target.startsWith(`${root}/`));
};

// Why a recursive chown/chmod must never run on this host path, or null. The
// same answer for everyone, whatever their role.
export const getUnsafePermissionTargetReason = (
	hostPath: string,
): string | null => {
	const target = normalizeHostPath(hostPath);
	if (target === null) {
		return "the host path is not an absolute path";
	}
	if (target !== hostPath) {
		return "the host path is not in its canonical form (no //, /./, /../ or trailing slash)";
	}
	if (target.split("/").includes(".ssh")) {
		return "the host path holds SSH keys";
	}
	if (SOCKET_NAME.test(target)) {
		return "the host path is a socket";
	}
	for (const base of dokployBasePaths()) {
		if (isWithin(target, base)) {
			return isInsideAServiceDirectory(target, base)
				? null
				: "the host path is a Dokploy system directory";
		}
	}
	if (SYSTEM_ROOTS.includes(target)) {
		return "the host path is a system directory";
	}
	if (SYSTEM_TREES.some((root) => isWithin(target, root))) {
		return "the host path is a system directory";
	}
	return null;
};

export type BindMountDecision =
	| { ok: true; hostPath: string }
	| { ok: false; code: "BAD_REQUEST" | "FORBIDDEN"; message: string };

type BindMountRequest = {
	hostPath: string;
	// The caller is an organization owner or admin.
	privilegedRole: boolean;
	// The caller's organization may reach the host the service runs on: always
	// for a remote server, for the Dokploy host only the organization that owns
	// the instance.
	hostReach: boolean;
};

const NOT_ABSOLUTE = "The host path of a bind mount must be an absolute path.";

const MEMBER_REFUSAL = "Only an owner or admin can create bind mounts.";

const HOST_REFUSAL =
	"Only the organization that owns this Dokploy instance can bind mount paths of its host.";

// Whether the caller may bind the host path into the service.
export const evaluateBindMountHostPath = (
	request: BindMountRequest,
): BindMountDecision => {
	const hostPath = normalizeHostPath(request.hostPath);
	if (hostPath === null) {
		return { ok: false, code: "BAD_REQUEST", message: NOT_ABSOLUTE };
	}
	if (!request.privilegedRole) {
		return { ok: false, code: "FORBIDDEN", message: MEMBER_REFUSAL };
	}
	if (!request.hostReach) {
		return { ok: false, code: "FORBIDDEN", message: HOST_REFUSAL };
	}
	return { ok: true, hostPath };
};

// Whether the uid/gid/mode of a bind mount may be applied to the host path.
// The caller needs the same standing as for binding it, and the path must be
// canonical and not a dangerous one, whoever the caller is.
export const evaluateBindMountPermissions = (
	request: BindMountRequest,
): BindMountDecision => {
	const decision = evaluateBindMountHostPath(request);
	if (!decision.ok) {
		return decision;
	}
	const reason = getUnsafePermissionTargetReason(request.hostPath);
	if (reason !== null) {
		return {
			ok: false,
			code: isCanonicalHostPath(request.hostPath) ? "FORBIDDEN" : "BAD_REQUEST",
			message: `Ownership and permissions are not applied to this host path: ${reason}.`,
		};
	}
	return decision;
};
