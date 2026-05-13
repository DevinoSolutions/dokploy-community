import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import type { Client } from "ssh2";

/**
 * Per-deployment job context that flows through every async call
 * (deployApplication → getBuildCommand → execAsync / execAsyncRemote)
 * via Node's AsyncLocalStorage.
 *
 * NOTE on the `Symbol.for(...)` singleton dance below: the dokploy app
 * bundles `@dokploy/server` as an *external* dependency, so this file
 * gets loaded twice in production — once for the app's own code, once
 * for the workspace package. Without pinning the instances on
 * `globalThis`, the AsyncLocalStorage / child registries would be two
 * separate copies, and context set in the worker handler would be
 * invisible to `execAsync`. Cancel would then have nothing to kill.
 */
export interface JobContext {
	jobId: string;
	/** null = LOCAL (Dokploy host); otherwise the remote serverId. */
	serverId: string | null;
}

const STORE_KEY = Symbol.for("dokploy.jobContext.store");
const LOCAL_KEY = Symbol.for("dokploy.jobContext.localChildren");
const REMOTE_KEY = Symbol.for("dokploy.jobContext.remoteSshClients");

type GlobalShared = typeof globalThis & {
	[STORE_KEY]?: AsyncLocalStorage<JobContext>;
	[LOCAL_KEY]?: Map<string, Set<ChildProcess>>;
	[REMOTE_KEY]?: Map<string, Set<Client>>;
};

const g = globalThis as GlobalShared;

export const dokployJobContext: AsyncLocalStorage<JobContext> =
	g[STORE_KEY] ?? (g[STORE_KEY] = new AsyncLocalStorage<JobContext>());

const localChildren: Map<string, Set<ChildProcess>> = g[LOCAL_KEY] ??
(g[LOCAL_KEY] = new Map());

const remoteSshClients: Map<string, Set<Client>> = g[REMOTE_KEY] ??
(g[REMOTE_KEY] = new Map());

export const getCurrentJob = (): JobContext | undefined =>
	dokployJobContext.getStore();

/** Marker injected into the deploy command line for `pkill -f` matching. */
export const jobMarker = (jobId: string): string => `DOKPLOY_JOB_ID=${jobId}`;

export const trackLocalChild = (jobId: string, child: ChildProcess): void => {
	let set = localChildren.get(jobId);
	if (!set) {
		set = new Set();
		localChildren.set(jobId, set);
	}
	set.add(child);
	const cleanup = () => {
		const s = localChildren.get(jobId);
		s?.delete(child);
		if (s && s.size === 0) localChildren.delete(jobId);
	};
	child.once("exit", cleanup);
	child.once("close", cleanup);
};

export const trackSshClient = (jobId: string, client: Client): void => {
	let set = remoteSshClients.get(jobId);
	if (!set) {
		set = new Set();
		remoteSshClients.set(jobId, set);
	}
	set.add(client);
	const cleanup = () => {
		const s = remoteSshClients.get(jobId);
		s?.delete(client);
		if (s && s.size === 0) remoteSshClients.delete(jobId);
	};
	client.once("end", cleanup);
	client.once("close", cleanup);
};

/**
 * Kill every process this job spawned.
 *
 * LOCAL: SIGKILL the process group (PGID = child.pid; the shell was
 * spawned with `detached: true`), tearing down sh, `docker compose`
 * and `docker build` in one shot.
 *
 * REMOTE: close the ssh client; sshd hangs up the session, taking
 * the remote command tree with it. Best-effort — some sshd configs
 * don't signal exec-mode children.
 *
 * Limitation: BuildKit RUN-step containers are owned by dockerd and
 * live outside our process group, so an in-flight RUN step runs to
 * natural completion before the build aborts. Sub-second RUN-step
 * cancel requires BuildKit's gRPC Cancel API with session-ID
 * tracking, which is out of scope.
 */
export const killJobProcesses = (
	jobId: string,
): { local: number; remote: number } => {
	let local = 0;
	let remote = 0;
	const localSet = localChildren.get(jobId);
	const sshSet = remoteSshClients.get(jobId);
	if (localSet) {
		for (const child of localSet) {
			if (!child.pid) continue;
			try {
				// Try the process group first (works when the child was
				// spawned with detached:true so PGID = child.pid). If the
				// group doesn't exist (ESRCH), fall back to killing the
				// shell's PID — that closes its stdio, which docker
				// compose / docker build CLIs treat as a cancel signal.
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
				local++;
			} catch {
				// Process already gone — nothing more to do.
			}
		}
		localChildren.delete(jobId);
	}
	if (sshSet) {
		for (const client of sshSet) {
			try {
				client.end();
				remote++;
			} catch {}
		}
		remoteSshClients.delete(jobId);
	}
	return { local, remote };
};
