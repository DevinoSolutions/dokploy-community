/**
 * Shell fragments that keep nixpacks from leaving temporary directories on the
 * host that runs the build (T-12494).
 *
 * `nixpacks build` writes its plan and Dockerfile into a `nixpacks.XXXXXX`
 * directory under `$TMPDIR` and only removes it when it exits normally. A
 * build that is killed, cancelled or stopped by the stuck-deployment watchdog
 * leaves that directory behind, and on a build server whose `/tmp` is a tmpfs
 * the leftovers eventually fill it (ENOSPC).
 *
 * Two fragments, both plain POSIX `sh` and both used by the nixpacks build
 * script, which runs identically on the Dokploy host and on a build server:
 *
 * - `getNixpacksTempSetupCommand` creates a directory of our own, points
 *   nixpacks' `TMPDIR` at it, and removes it on every way the script can end
 *   (EXIT, plus HUP / INT / TERM, which a cancel sends to the build's process
 *   group). The directory is itself named `nixpacks.*`, so what a SIGKILL
 *   (no trap can run) leaves behind is reaped by the sweeper below.
 * - `getNixpacksTempSweepCommand` removes `nixpacks.*` directories older than a
 *   day, directly under the temp directory and nowhere else.
 */

/** A nixpacks build never runs this long; older directories are orphans. */
export const NIXPACKS_TEMP_MAX_AGE_MINUTES = 24 * 60;

/** Name of the shell variable that holds the per-build directory. */
export const NIXPACKS_TEMP_VARIABLE = "DOKPLOY_NIXPACKS_TMP";

/** Name of the shell function that removes the per-build directory. */
export const NIXPACKS_TEMP_CLEANUP_FUNCTION = "dokploy_nixpacks_tmp_cleanup";

/**
 * Deletes `nixpacks.*` directories older than `NIXPACKS_TEMP_MAX_AGE_MINUTES`
 * that sit directly in the temp directory: `-maxdepth 1` and `-type d` (which
 * does not match a symlink) keep it from reaching anything else, and failures
 * never fail the build.
 */
export const getNixpacksTempSweepCommand = () =>
	`find "\${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'nixpacks.*' -mmin +${NIXPACKS_TEMP_MAX_AGE_MINUTES} -exec rm -rf {} + >/dev/null 2>&1 || true;`;

/**
 * Creates the per-build directory and arranges its removal. If the directory
 * cannot be created (a full disk, say) the build goes on with the normal temp
 * directory, as it did before.
 *
 * The removal only ever deletes a path that looks like what `mktemp` made
 * here, so an empty or unexpected variable never reaches `rm -rf`. A signal
 * trap ends the script with the conventional 128+n status, which is what a
 * cancelled build reports anyway, and runs the EXIT trap on the way out.
 */
export const getNixpacksTempSetupCommand = () =>
	[
		`${NIXPACKS_TEMP_CLEANUP_FUNCTION}() { case "$${NIXPACKS_TEMP_VARIABLE}" in */nixpacks.*) rm -rf -- "$${NIXPACKS_TEMP_VARIABLE}";; esac; ${NIXPACKS_TEMP_VARIABLE}=""; };`,
		`${NIXPACKS_TEMP_VARIABLE}=$(mktemp -d "\${TMPDIR:-/tmp}/nixpacks.XXXXXXXX" 2>/dev/null) || ${NIXPACKS_TEMP_VARIABLE}="";`,
		`trap '${NIXPACKS_TEMP_CLEANUP_FUNCTION}' EXIT;`,
		"trap 'exit 129' HUP;",
		"trap 'exit 130' INT;",
		"trap 'exit 143' TERM;",
	].join("\n");

/**
 * Assignment placed in front of the `nixpacks` command (and its env-file
 * loader) so that nixpacks, and the docker client it starts, use the per-build
 * directory as their temp directory.
 */
export const getNixpacksTempEnvAssignment = () =>
	`TMPDIR="\${${NIXPACKS_TEMP_VARIABLE}:-\${TMPDIR:-/tmp}}" `;
