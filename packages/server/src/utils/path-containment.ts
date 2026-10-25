/**
 * Shell lines that define two functions for a script that checks, on the host
 * that runs it, where a path of the repository's checkout really leads:
 *
 * - `__dokploy_resolve PATH`: the path with its links resolved (`realpath -m`,
 *   or `readlink -f` where that is all there is; a missing tail is fine);
 * - `__dokploy_inside DIRECTORY PATH`: succeeds when PATH resolves to
 *   DIRECTORY (which has to exist) or to a place inside it.
 *
 * `unavailable` is the command that runs when the host has neither tool. It
 * decides what a host that cannot check does: refuse (a build, T-8282) or
 * carry on without the file.
 */
export const getPathResolverLines = (unavailable: string) => [
	"if realpath -m -- / >/dev/null 2>&1; then",
	'\t__dokploy_resolve() { realpath -m -- "$1"; }',
	"elif readlink -f -- / >/dev/null 2>&1; then",
	// `readlink -f` (busybox) needs the path to exist but for its last part:
	// resolve the deepest part that exists and append the rest as it is.
	'\t__dokploy_resolve() { __dokploy_r=$1 __dokploy_t=; while [ ! -e "$__dokploy_r" ] && [ ! -L "$__dokploy_r" ] && [ "$__dokploy_r" != / ]; do __dokploy_t=/${__dokploy_r##*/}$__dokploy_t; __dokploy_r=${__dokploy_r%/*}; __dokploy_r=${__dokploy_r:-/}; done; case "$__dokploy_t" in */..|*/../*) return 1;; esac; __dokploy_r=$(readlink -f -- "$__dokploy_r") && printf "%s%s\\n" "$__dokploy_r" "$__dokploy_t"; }',
	"else",
	`\t${unavailable}`,
	"fi",
	'__dokploy_inside() { __dokploy_c=$(__dokploy_resolve "$1") && [ -d "$__dokploy_c" ] && __dokploy_p=$(__dokploy_resolve "$2") || return 1; case "$__dokploy_p" in "$__dokploy_c"|"$__dokploy_c"/*) return 0;; esac; return 1; }',
];

/**
 * One shell line that defines `__dokploy_dir_inside DIRECTORY PLACE`: it
 * succeeds when PLACE, an existing directory, resolves (every link in its path
 * followed, `cd -P`) to DIRECTORY or to a place inside it. It needs no
 * `realpath`, so a script can carry it on any host; `getPathResolverLines`
 * is the one that also handles a place that does not exist yet.
 */
export const DIRECTORY_INSIDE_FUNCTION =
	'__dokploy_dir_inside() { __dokploy_c=$(cd -P -- "$1" 2>/dev/null && pwd -P) && __dokploy_p=$(cd -P -- "$2" 2>/dev/null && pwd -P) || return 1; case "$__dokploy_p" in "$__dokploy_c"|"$__dokploy_c"/*) return 0;; esac; return 1; }';
