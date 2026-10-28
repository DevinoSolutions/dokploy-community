import { singleQuote } from "./docker/env-file";

/**
 * One shell line that defines `__dokploy_nl` and `__dokploy_cr`, the
 * characters a path here never has (a line feed, a carriage return). Each is
 * made on one line from one printf, so that the line endings of a script cannot
 * change them. The resolvers and `__dokploy_dir_inside` refuse a path with
 * either in it, and read each result with a marker so that the end of a name
 * is kept (command substitution drops trailing line feeds).
 */
export const LINE_BREAK_DEFINITIONS =
	"__dokploy_cr=$(printf '\\n\\rx'); __dokploy_nl=${__dokploy_cr%\"${__dokploy_cr#?}\"}; __dokploy_cr=${__dokploy_cr#?}; __dokploy_cr=${__dokploy_cr%x}";

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
	// Both are defined in the first line (see `LINE_BREAK_DEFINITIONS`).
	LINE_BREAK_DEFINITIONS,
	"if realpath -m -- / >/dev/null 2>&1; then",
	'\t__dokploy_resolve() { [ "${#__dokploy_nl}" = 1 ] && [ "${#__dokploy_cr}" = 1 ] || return 1; case "$1" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; __dokploy_x=$(realpath -m -- "$1" && echo .) || return 1; __dokploy_x=${__dokploy_x%??}; case "$__dokploy_x" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; printf "%s\\n" "$__dokploy_x"; }',
	"elif readlink -f -- / >/dev/null 2>&1; then",
	// `readlink -f` (busybox) needs the path to exist but for its last part:
	// resolve the deepest part that exists and append the rest as it is.
	// A relative input fails (the walk up ends at /, which it never reaches).
	// A link whose target is missing is followed here, one hop at a time from
	// the link's own directory (at most 40), as on full hosts. Anything that
	// cannot be followed fails, and so does a path with a control character.
	'\t__dokploy_resolve() { __dokploy_r=$1 __dokploy_t= __dokploy_n=0; [ "${#__dokploy_nl}" = 1 ] && [ "${#__dokploy_cr}" = 1 ] || return 1; [ "${__dokploy_r#/}" != "$__dokploy_r" ] || return 1; case "$__dokploy_r" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; while :; do while [ ! -e "$__dokploy_r" ] && [ ! -L "$__dokploy_r" ] && [ "$__dokploy_r" != / ]; do __dokploy_t=/${__dokploy_r##*/}$__dokploy_t; __dokploy_r=${__dokploy_r%/*}; __dokploy_r=${__dokploy_r:-/}; done; case "$__dokploy_t" in */..|*/../*) return 1;; esac; if [ -e "$__dokploy_r" ] || [ ! -L "$__dokploy_r" ]; then break; fi; __dokploy_n=$((__dokploy_n+1)); [ "$__dokploy_n" -le 40 ] || return 1; __dokploy_l=$(readlink -- "$__dokploy_r" && echo .) || return 1; __dokploy_l=${__dokploy_l%??}; [ -n "$__dokploy_l" ] || return 1; __dokploy_d=${__dokploy_r%/*}; __dokploy_d=$(cd -P -- "${__dokploy_d:-/}" 2>/dev/null && pwd -P && echo .) || return 1; __dokploy_d=${__dokploy_d%??}; case "$__dokploy_l$__dokploy_d" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; case "$__dokploy_l" in /*) __dokploy_r=$__dokploy_l;; *) __dokploy_r=${__dokploy_d%/}/$__dokploy_l;; esac; done; __dokploy_r=$(readlink -f -- "$__dokploy_r" && echo .) || return 1; __dokploy_r=${__dokploy_r%??}; case "$__dokploy_r" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; [ -z "$__dokploy_t" ] || __dokploy_r=${__dokploy_r%/}; printf "%s%s\\n" "$__dokploy_r" "$__dokploy_t"; }',
	"else",
	`\t${unavailable}`,
	"fi",
	'__dokploy_inside() { __dokploy_c=$(__dokploy_resolve "$1") && [ -d "$__dokploy_c" ] && __dokploy_p=$(__dokploy_resolve "$2") || return 1; case "$__dokploy_p" in "$__dokploy_c"|"$__dokploy_c"/*) return 0;; esac; return 1; }',
];

const DIR_INSIDE_BODY =
	'__dokploy_dir_inside() { [ "${#__dokploy_nl}" = 1 ] && [ "${#__dokploy_cr}" = 1 ] || return 1; case "$1$2" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; __dokploy_c=$(cd -P -- "$1" 2>/dev/null && pwd -P && echo .) && __dokploy_p=$(cd -P -- "$2" 2>/dev/null && pwd -P && echo .) || return 1; __dokploy_c=${__dokploy_c%??}; __dokploy_p=${__dokploy_p%??}; case "$__dokploy_c$__dokploy_p" in *"$__dokploy_nl"*|*"$__dokploy_cr"*) return 1;; esac; case "$__dokploy_p" in "$__dokploy_c"|"$__dokploy_c"/*) return 0;; esac; return 1; }';

/**
 * Shell (the line break definitions, then one line) that defines
 * `__dokploy_dir_inside DIRECTORY PLACE`: it succeeds when PLACE, an existing
 * directory, resolves (every link in its path followed, `cd -P`) to DIRECTORY
 * or to a place inside it, and fails for a name with a line feed or a carriage
 * return in it. It needs no `realpath`, so a script can carry it on any host;
 * `getPathResolverLines` is the one that also handles a place that does not
 * exist yet.
 */
export const DIRECTORY_INSIDE_FUNCTION = `${LINE_BREAK_DEFINITIONS}
${DIR_INSIDE_BODY}`;

/**
 * Shell function `__dokploy_put SOURCE DESTINATION CODE_DIRECTORY` that puts a
 * copy of SOURCE at DESTINATION without ever writing through a link. It moves
 * into the physical directory of DESTINATION (`cd -P`), checks that this is
 * CODE_DIRECTORY or inside it, writes a temporary file in that directory
 * (`mktemp`, which no link can point at), gives it the mode and owner of the
 * file it replaces (644 when there is none), and renames it over the name
 * (`mv -f -T`, which replaces a link instead of following it). There is no
 * fallback to a plain `mv`, which moves the file into a directory the name
 * links to, and no probe for `-T`, which would run in the checkout: a host
 * whose `mv` fails is refused with `mvRefusal`. A checkout that is
 * written concurrently, by a container that has it mounted, can swap a link
 * in at any moment; `rm` then `cat >` would write through it. `refusal` is
 * printed when the directory is outside CODE_DIRECTORY (status 3). The
 * temporary file is removed on any failure.
 */
export const getAtomicPutFunction = (refusal: string, mvRefusal: string) =>
	`__dokploy_put() { ( cd -P -- "\${2%/*}" 2>/dev/null || exit 1; __dp_h=$(pwd -P) && __dp_c=$(cd -P -- "$3" 2>/dev/null && pwd -P) || exit 1; case "$__dp_h" in "$__dp_c"|"$__dp_c"/*) ;; *) echo ${singleQuote(refusal)} >&2; exit 3;; esac; __dp_n=\${2##*/}; [ ! -d "./$__dp_n" ] || exit 1; __dp_t=$(mktemp ./.dokploy-put-XXXXXX) || exit 1; if cat -- "$1" > "$__dp_t"; then if [ -f "$__dp_n" ] && [ ! -L "$__dp_n" ] && chmod --reference="$__dp_n" "$__dp_t" 2>/dev/null; then chown --reference="$__dp_n" "$__dp_t" 2>/dev/null; true; else chmod 644 "$__dp_t"; fi && { mv -f -T -- "$__dp_t" "./$__dp_n" 2>/dev/null && exit 0; echo ${singleQuote(mvRefusal)} >&2; }; fi; rm -f -- "$__dp_t"; exit 1 ); }`;
