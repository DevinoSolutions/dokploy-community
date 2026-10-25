import { apiSaveGitProvider } from "@dokploy/server/db/schema";
import {
	assertSafeGitUrl,
	GIT_URL_REFUSED_MESSAGE,
	GIT_URL_SAVE_CHARACTER_MESSAGE,
	isSafeGitUrl,
} from "@dokploy/server/utils/providers/git-url";
import { describe, expect, it } from "vitest";

// The form and API schema, the save-time check and the deploy-time check hold
// one rule for a custom git URL (T-8498): what the input schema accepts is what
// assertSafeGitUrl accepts. The save schema adds the character rule of the
// older pattern; the deploy check does not, so stored URLs keep deploying.
// Internal and loopback hosts pass on purpose.

const ACCEPTED = [
	"https://github.com/owner/repo.git",
	"http://gitlab.example.com/group/subgroup/repo.git",
	"https://user:token@git.example.com/o/r.git",
	"ssh://git@gitlab.com:22/owner/repo.git",
	"ssh://git@gitea.example.com/owner/repo.git",
	"git@github.com:org/repo.git",
	"git@gitea.example.com:owner/repo.git",
	// Self-hosted forges on a LAN are a real use, so internal hosts are allowed.
	"http://169.254.169.254/latest",
	"http://localhost:3000/o/r.git",
	"https://192.168.1.10/o/r.git",
];

const REFUSED = [
	"",
	"git@-oX:r",
	"-oProxyCommand=x:r",
	"-u--upload-pack=x:r",
	"-git@host:r",
	"file:///etc",
	"/srv/x",
	"../x",
	"ext::sh -c id",
	"fd::3",
	"git://github.com/o/r.git",
	"github.com:o/r.git",
	"HTTPS://github.com/o/r.git",
	"Ssh://git@host/o/r.git",
	" https://github.com/o/r.git",
	"https://github.com/o/r.git ",
	"https://github.com/o/r.git\n",
	"https://exämple.com/o/r.git",
	"https://-oProxyCommand=x/r",
	"git@github.com:o/r with space.git",
	"https://h/\\x",
];

// Allowed by the shared rule (the clone quotes the URL, see
// git-clone-command-injection.test.ts) but refused by the save schema, as the
// older pattern did.
const SAVE_ONLY_REFUSED = [
	"https://github.com/o/r.git;id",
	"https://github.com/o/$(id)",
	"https://github.com/o/`id`",
	"https://github.com/o/r.git|id",
	"git@github.com:o/r.git&id",
	"https://github.com/o/r<x>.git",
	"https://github.com/o/r'x'.git",
	'https://github.com/o/r"x".git',
	"https://github.com/o/{r}.git",
	"https://github.com/o/[r].git",
	"git@[2001:db8::1]:owner/repo.git",
	"https://[::1]:3000/o/r.git",
];

const SCHEMA_INPUT = {
	applicationId: "app-1",
	customGitBranch: "main",
	customGitBuildPath: "/",
	watchPaths: [],
	enableSubmodules: false,
	customGitSSHKeyId: null,
};

const schemaIssues = (customGitUrl: string) => {
	const result = apiSaveGitProvider.safeParse({
		...SCHEMA_INPUT,
		customGitUrl,
	});
	return result.success
		? []
		: result.error.issues.filter((issue) => issue.path[0] === "customGitUrl");
};

describe("one git URL rule for the form schema and the deploy check", () => {
	it.each(ACCEPTED)("accepts %s in both", (url) => {
		expect(schemaIssues(url)).toEqual([]);
		expect(isSafeGitUrl(url)).toBe(true);
		expect(() => assertSafeGitUrl(url)).not.toThrow();
	});

	it.each(REFUSED)("refuses %j in both", (url) => {
		expect(schemaIssues(url).length).toBeGreaterThan(0);
		expect(isSafeGitUrl(url)).toBe(false);
		expect(() => assertSafeGitUrl(url)).toThrow(GIT_URL_REFUSED_MESSAGE);
	});

	it("agrees on every case outside the save-only character rule", () => {
		for (const url of [...ACCEPTED, ...REFUSED]) {
			expect(schemaIssues(url).length === 0, url).toBe(isSafeGitUrl(url));
		}
	});

	it("gives the user the same neutral message as the deploy check", () => {
		expect(schemaIssues("git@-oX:r").map((issue) => issue.message)).toEqual([
			GIT_URL_REFUSED_MESSAGE,
		]);
	});

	it("keeps an empty value a required-field error, as before", () => {
		const [issue] = schemaIssues("");
		expect(issue?.code).toBe("too_small");
	});
});

describe("the save schema keeps the character rule of the older pattern", () => {
	it.each(SAVE_ONLY_REFUSED)(
		"refuses %j in the schema, and the deploy check still accepts it",
		(url) => {
			expect(schemaIssues(url).map((issue) => issue.message)).toEqual([
				GIT_URL_SAVE_CHARACTER_MESSAGE,
			]);
			expect(isSafeGitUrl(url)).toBe(true);
			expect(() => assertSafeGitUrl(url)).not.toThrow();
		},
	);

	it("refuses exactly the characters the older pattern refused", () => {
		for (const char of [
			..."; | & $ ` ( ) { } [ ] < > ' \" \\".replace(/ /g, ""),
		]) {
			expect(
				schemaIssues(`https://h.example/o/r${char}x`).length,
				char,
			).toBeGreaterThan(0);
		}
		for (const char of [
			"-",
			"_",
			".",
			"~",
			"%",
			"+",
			"=",
			"@",
			":",
			"#",
			"?",
		]) {
			expect(schemaIssues(`https://h.example/o/r${char}x`), char).toEqual([]);
		}
	});

	it("only ever refuses what the shared rule accepts, never the reverse", () => {
		for (const url of [...ACCEPTED, ...REFUSED, ...SAVE_ONLY_REFUSED]) {
			if (schemaIssues(url).length === 0) {
				expect(isSafeGitUrl(url), url).toBe(true);
			}
		}
	});
});
