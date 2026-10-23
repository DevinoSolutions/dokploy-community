import { parse } from "dotenv";

/**
 * Merge for dotenv-style variable blocks (T-7007).
 *
 * Over MCP a read returns every value blank, so a client cannot send the
 * "full set" back. This merges on the server, where the stored values are:
 * keys in `incoming` are updated in place or appended, keys in `unset` are
 * removed, and every other statement (and comment) of `current` is kept
 * byte for byte. Values are never part of an error message.
 */

export class EnvMergeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EnvMergeError";
	}
}

// The statement grammar of the `dotenv` parser that builds the deploy
// environment (same quoting and multiline rules), so spans agree with it.
const STATEMENT =
	/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

interface Statement {
	key: string;
	/** Start of the line the statement begins on (keeps an `export ` prefix). */
	start: number;
	/** Statement end, including its line break when there is one. */
	end: number;
	/** The statement without its line break. */
	text: string;
}

const normalize = (source: string | null | undefined) =>
	(source ?? "").replace(/\r\n?/g, "\n");

const statementsOf = (source: string): Statement[] => {
	const found: Statement[] = [];
	const pattern = new RegExp(STATEMENT.source, STATEMENT.flags);
	let previousEnd = 0;
	for (
		let match = pattern.exec(source);
		match !== null;
		match = pattern.exec(source)
	) {
		const raw = match[0];
		const keyAt = match.index + (raw.length - raw.trimStart().length);
		const bodyEnd = match.index + raw.trimEnd().length;
		const start = Math.max(
			source.lastIndexOf("\n", keyAt - 1) + 1,
			previousEnd,
		);
		const end = source[bodyEnd] === "\n" ? bodyEnd + 1 : bodyEnd;
		found.push({
			key: match[1] as string,
			start,
			end,
			text: source.slice(start, bodyEnd),
		});
		previousEnd = end;
	}
	return found;
};

/**
 * `current` with `incoming`'s variables set and `unset`'s removed.
 *
 * The result is checked against the real parser: kept variables must keep
 * their value, set ones take the incoming value, unset ones must be gone.
 * Anything else throws {@link EnvMergeError} rather than writing a block that
 * does not mean what the caller asked for.
 */
export const mergeEnvText = (
	current: string | null | undefined,
	incoming: string | null | undefined,
	unset: readonly string[] = [],
): string => {
	const base = normalize(current);
	const added = normalize(incoming);
	const removed = new Set(unset);

	const addedByKey = new Map<string, string>();
	for (const statement of statementsOf(added)) {
		addedByKey.set(statement.key, statement.text);
	}
	const conflicting = [...addedByKey.keys()].filter((key) => removed.has(key));
	if (conflicting.length > 0) {
		throw new EnvMergeError(
			`${conflicting.join(", ")} is both set and unset in the same call`,
		);
	}

	const pieces: string[] = [];
	const placed = new Set<string>();
	let position = 0;
	for (const statement of statementsOf(base)) {
		pieces.push(base.slice(position, statement.start));
		position = statement.end;
		if (removed.has(statement.key)) continue;
		const replacement = addedByKey.get(statement.key);
		if (replacement === undefined) {
			pieces.push(base.slice(statement.start, statement.end));
		} else if (!placed.has(statement.key)) {
			pieces.push(`${replacement}\n`);
			placed.add(statement.key);
		}
		// A repeated definition of a replaced key is dropped: the last one won anyway.
	}
	pieces.push(base.slice(position));

	let merged = pieces.join("");
	for (const [key, text] of addedByKey) {
		if (placed.has(key)) continue;
		if (merged !== "" && !merged.endsWith("\n")) merged += "\n";
		merged += `${text}\n`;
	}

	const before = parse(base);
	const after = parse(merged);
	const expected: Record<string, string> = { ...before };
	for (const key of removed) delete expected[key];
	Object.assign(expected, parse(added));
	const wantKeys = Object.keys(expected);
	const sameKeys =
		wantKeys.length === Object.keys(after).length &&
		wantKeys.every((key) => Object.hasOwn(after, key));
	if (!sameKeys || wantKeys.some((key) => after[key] !== expected[key])) {
		throw new EnvMergeError(
			"the merged variables did not round-trip through the parser",
		);
	}
	return merged;
};
