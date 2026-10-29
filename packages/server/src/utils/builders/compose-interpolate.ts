/**
 * Compose-style variable interpolation, used only to judge which services a
 * rolling replace can take (`deploy.replicas: ${WEB_REPLICAS:-1}`, a port range
 * built from variables). It never changes the compose file that is written and
 * deployed: callers interpolate a copy of the spec.
 *
 * Follows the Compose specification:
 * - `$$` is a literal `$`;
 * - `$VAR` and `${VAR}` are the value, or "" when VAR is unset;
 * - `${VAR:-default}` / `${VAR-default}`: default when VAR is unset or empty /
 *   unset;
 * - `${VAR:+alt}` / `${VAR+alt}`: alt when VAR is set and not empty / set,
 *   otherwise "";
 * - `${VAR:?err}` / `${VAR?err}`: an error when VAR is unset or empty / unset;
 * - a default or alt can hold expressions of its own (`${A:-${B:-54000}}`);
 * - a `$` that starts none of the above is kept as it is.
 *
 * Anything else (`${` with an invalid name or modifier, an unclosed brace, a
 * required variable that is unset, a variable whose value cannot be known)
 * throws a `ComposeInterpolationError`: the caller then keeps the raw spec.
 */

export class ComposeInterpolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ComposeInterpolationError";
	}
}

/**
 * What a variable is for the interpolation: its value, `undefined` when it is
 * not set, or `UNKNOWN_VALUE` when Dokploy cannot know what Compose will see
 * (the lookup then throws).
 */
export const UNKNOWN_VALUE: unique symbol = Symbol("unknown compose variable");

export type ComposeVariableLookup = (
	name: string,
) => string | undefined | typeof UNKNOWN_VALUE;

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_]/;

const readName = (text: string, start: number) => {
	let end = start;
	if (end < text.length && NAME_START.test(text[end] ?? "")) {
		end++;
		while (end < text.length && NAME_PART.test(text[end] ?? "")) end++;
	}
	return text.slice(start, end);
};

interface ScanResult {
	value: string;
	/** Index just past what was read (past the closing `}` when `inBraces`). */
	end: number;
}

/**
 * Reads `text` from `start`. With `inBraces`, stops at the `}` that closes the
 * current `${...}` (a nested `${...}` is read whole first). With `evaluate`
 * off nothing is looked up: a branch that is not taken is only skipped over.
 */
const scan = (
	text: string,
	start: number,
	inBraces: boolean,
	evaluate: boolean,
	lookup: ComposeVariableLookup,
): ScanResult => {
	let out = "";
	let i = start;
	while (i < text.length) {
		const char = text[i];
		if (inBraces && char === "}") return { value: out, end: i + 1 };
		if (char !== "$") {
			out += char;
			i++;
			continue;
		}
		const next = text[i + 1];
		if (next === "$") {
			out += "$";
			i += 2;
			continue;
		}
		if (next === "{") {
			const braced = scanBraced(text, i + 2, evaluate, lookup);
			out += braced.value;
			i = braced.end;
			continue;
		}
		const name = readName(text, i + 1);
		if (name === "") {
			// `$` followed by anything else (a digit, a space, the end) is literal.
			out += "$";
			i++;
			continue;
		}
		if (evaluate) out += resolve(name, lookup) ?? "";
		i += 1 + name.length;
	}
	if (inBraces) {
		throw new ComposeInterpolationError("A ${ is never closed.");
	}
	return { value: out, end: i };
};

const resolve = (name: string, lookup: ComposeVariableLookup) => {
	const value = lookup(name);
	if (value === UNKNOWN_VALUE) {
		throw new ComposeInterpolationError(
			`The value of ${name} is not known before the deploy runs.`,
		);
	}
	return value;
};

/** Reads `NAME[modifier text]}` after a `${`. */
const scanBraced = (
	text: string,
	start: number,
	evaluate: boolean,
	lookup: ComposeVariableLookup,
): ScanResult => {
	const name = readName(text, start);
	if (name === "") {
		throw new ComposeInterpolationError(
			`Invalid variable reference at "${text.slice(start - 2, start + 10)}".`,
		);
	}
	let i = start + name.length;
	if (text[i] === "}") {
		return {
			value: evaluate ? (resolve(name, lookup) ?? "") : "",
			end: i + 1,
		};
	}
	const colon = text[i] === ":";
	if (colon) i++;
	const operator = text[i];
	if (operator !== "-" && operator !== "+" && operator !== "?") {
		throw new ComposeInterpolationError(
			`Invalid variable reference \${${name}${colon ? ":" : ""}${operator ?? ""}...}.`,
		);
	}
	i++;
	const value = evaluate ? resolve(name, lookup) : undefined;
	const isSet = value !== undefined;
	const isFilled = isSet && value !== "";
	const present = colon ? isFilled : isSet;
	if (operator === "-") {
		const rest = scan(text, i, true, evaluate && !present, lookup);
		return { value: present ? (value ?? "") : rest.value, end: rest.end };
	}
	if (operator === "+") {
		const rest = scan(text, i, true, evaluate && present, lookup);
		return { value: present ? rest.value : "", end: rest.end };
	}
	// `?`: the message is read (it may hold expressions) only to find the end.
	const rest = scan(text, i, true, false, lookup);
	if (evaluate && !present) {
		throw new ComposeInterpolationError(
			`Required variable ${name} is ${isSet ? "empty" : "not set"}.`,
		);
	}
	return { value: value ?? "", end: rest.end };
};

/** Interpolates one string. Throws `ComposeInterpolationError`. */
export const interpolateComposeString = (
	text: string,
	lookup: ComposeVariableLookup,
): string => {
	if (!text.includes("$")) return text;
	return scan(text, 0, false, true, lookup).value;
};

/**
 * A deep copy of `value` with every string value interpolated (mapping keys
 * are left as they are). Numbers, booleans and null are copied unchanged.
 * Throws `ComposeInterpolationError`.
 */
export const interpolateComposeValue = <T>(
	value: T,
	lookup: ComposeVariableLookup,
): T => {
	if (typeof value === "string") {
		return interpolateComposeString(value, lookup) as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => interpolateComposeValue(item, lookup)) as T;
	}
	if (typeof value === "object" && value !== null) {
		const copy: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			copy[key] = interpolateComposeValue(item, lookup);
		}
		return copy as T;
	}
	return value;
};

/** A lookup over a fixed map: names in `unknown` throw, others are unset. */
export const createComposeVariableLookup = (
	values: ReadonlyMap<string, string>,
	unknown: ReadonlySet<string> = new Set(),
): ComposeVariableLookup => {
	return (name) => {
		if (unknown.has(name)) return UNKNOWN_VALUE;
		return values.get(name);
	};
};
