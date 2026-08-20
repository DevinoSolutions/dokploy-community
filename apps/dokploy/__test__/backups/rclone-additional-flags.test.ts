import { execSync } from "node:child_process";
import {
	getRcloneCredentials,
	quoteAdditionalFlags,
} from "@dokploy/server/utils/backups/utils";
import { parse } from "shell-quote";
import { describe, expect, it } from "vitest";

/**
 * Destination `additionalFlags` are user-supplied strings that end up
 * interpolated into the rclone shell command line (test connection, database
 * backups, volume backups, restores). They must reach rclone as inert argv
 * tokens, never as shell syntax.
 *
 * `parse()` is shell-quote's POSIX word splitter: it returns plain strings for
 * literal words and `{ op: ";" }`-style objects for shell operators, so it
 * models exactly what /bin/sh would do with the command line we build.
 */
const MARK = "/tmp/dokploy_rclone_pwned";

const buildCommand = (flags: string[]) =>
	`rclone ls ${flags.join(" ")} ':s3:bucket/'`;

// Tokenize the assembled command line the way a POSIX shell would.
const tokenize = (flags: string[]) => parse(buildCommand(flags));

const payloads = [
	`--foo; touch ${MARK}`,
	`$(touch ${MARK})`,
	`\`touch ${MARK}\``,
	`--foo && touch ${MARK}`,
	`--foo | touch ${MARK}`,
	`--foo' ; touch ${MARK} ; '`,
	`--foo" ; touch ${MARK} ; "`,
	`--foo$(touch ${MARK})`,
	`--foo\`touch ${MARK}\``,
	`--foo > ${MARK}`,
];

const s3Destination = {
	provider: "s3",
	bucket: "bucket",
	accessKey: "ak",
	secretAccessKey: "sk",
	region: "us-east-1",
	endpoint: "https://s3.example.com",
	additionalFlags: null as string[] | null,
};

describe("quoteAdditionalFlags", () => {
	it("returns an empty list when there are no flags", () => {
		expect(quoteAdditionalFlags(null)).toEqual([]);
		expect(quoteAdditionalFlags(undefined)).toEqual([]);
		expect(quoteAdditionalFlags([])).toEqual([]);
	});

	it("keeps legitimate flags working as separate argv words", () => {
		const flags = [
			"--s3-no-check-bucket",
			"--transfers=4",
			"--s3-force-path-style",
			"--checksum",
			"--bwlimit=10M",
		];

		expect(tokenize(quoteAdditionalFlags(flags))).toEqual([
			"rclone",
			"ls",
			...flags,
			":s3:bucket/",
		]);
	});

	it("leaves schema-valid flags byte-identical", () => {
		const flags = [
			"--s3-no-check-bucket",
			"--checksum",
			"--transfers=4",
			"--drive-root-folder-id=abc123",
			"--bwlimit=10M",
		];

		expect(quoteAdditionalFlags(flags)).toEqual(flags);
	});

	// Negative control: without quoting, the very same payloads split the
	// command line into extra words and shell operators.
	it("negative control: unquoted flags do inject shell operators", () => {
		const tokens = parse(buildCommand([`--foo; touch ${MARK}`]));

		expect(tokens).toContainEqual({ op: ";" });
		expect(tokens).toContain("touch");
	});

	for (const payload of payloads) {
		it(`neutralizes ${JSON.stringify(payload)}`, () => {
			const tokens = tokenize(quoteAdditionalFlags([payload]));

			// One inert literal argument, no operators, nothing added.
			expect(tokens).toEqual(["rclone", "ls", payload, ":s3:bucket/"]);
			expect(tokens.every((token) => typeof token === "string")).toBe(true);
		});
	}
});

describe("getRcloneCredentials quotes destination additionalFlags", () => {
	it("neutralizes an injected flag on an S3 destination", () => {
		const tokens = tokenize(
			getRcloneCredentials({
				...s3Destination,
				additionalFlags: [`--foo; touch ${MARK}`],
			}),
		);

		expect(tokens).toContain(`--foo; touch ${MARK}`);
		expect(tokens.every((token) => typeof token === "string")).toBe(true);
	});

	it("neutralizes an injected flag on a generic rclone destination", () => {
		const tokens = tokenize(
			getRcloneCredentials({
				...s3Destination,
				provider: "GenericRclone",
				additionalFlags: [`--foo; touch ${MARK}`],
			}),
		);

		expect(tokens).toEqual([
			"rclone",
			"ls",
			`--foo; touch ${MARK}`,
			":s3:bucket/",
		]);
	});

	it("keeps the S3 credential flags intact alongside a legitimate flag", () => {
		const tokens = tokenize(
			getRcloneCredentials({
				...s3Destination,
				additionalFlags: ["--transfers=4"],
			}),
		);

		expect(tokens).toContain("--s3-access-key-id=ak");
		expect(tokens).toContain("--s3-region=us-east-1");
		expect(tokens).toContain("--s3-no-check-bucket");
		expect(tokens).toContain("--transfers=4");
	});
});

// The tokenizer above models a POSIX shell; this suite proves it against a real
// one. `printf '%s\n'` stands in for the rclone binary and echoes back the argv
// it actually received, so no temporary files or path assumptions are involved.
// Skipped on Windows, which has no /bin/bash for execSync.
describe.skipIf(process.platform === "win32")(
	"additionalFlags against a real shell",
	() => {
		const PWNED = "PWNED";

		const runShell = (flags: string[]) => {
			const stdout = execSync(
				`printf '%s\\n' ls ${flags.join(" ")} ':s3:bucket/'`,
				{ shell: "/bin/bash", encoding: "utf8" },
			);
			return stdout.split("\n").filter(Boolean);
		};

		it("passes legitimate flags through as separate argv words", () => {
			const argv = runShell(
				quoteAdditionalFlags(["--s3-no-check-bucket", "--transfers=4"]),
			);

			expect(argv).toEqual([
				"ls",
				"--s3-no-check-bucket",
				"--transfers=4",
				":s3:bucket/",
			]);
		});

		it("does not execute an injected command", () => {
			const argv = runShell(quoteAdditionalFlags([`--foo; echo ${PWNED}`]));

			expect(argv).toEqual(["ls", `--foo; echo ${PWNED}`, ":s3:bucket/"]);
			expect(argv).not.toContain(PWNED);
		});

		it("does not execute an injected command substitution", () => {
			const argv = runShell(quoteAdditionalFlags([`--foo$(echo ${PWNED})`]));

			expect(argv).toEqual(["ls", `--foo$(echo ${PWNED})`, ":s3:bucket/"]);
		});

		it("negative control: the unquoted payload does execute", () => {
			const argv = runShell([`--foo; echo ${PWNED}`]);

			expect(argv).toContain(PWNED);
		});
	},
);
