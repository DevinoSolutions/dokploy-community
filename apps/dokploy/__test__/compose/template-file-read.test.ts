import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertSafeTemplateGitUrl,
	buildGuardedTemplateReadCommand,
	getTemplateReadRefusal,
	TEMPLATE_CLONE_ENV,
	TEMPLATE_EXIT_REFUSED,
	TEMPLATE_EXIT_TOO_LARGE,
	TEMPLATE_FILE_MAX_BYTES,
	TEMPLATE_LINK_REFUSED_MESSAGE,
} from "@/server/utils/template-file-read";

// The clone loadTemplateFromGit makes is of a repository that is not trusted:
// template.toml is read only when it is a regular file reached without a
// symbolic link (T-8413). The script runs here with a real shell.

const TEMPLATE = '[variables]\nmain_domain = "${domain}"\n';
const SECRET = "HOST-SECRET-VALUE";

const toShellPath = (path: string) => {
	if (process.platform !== "win32") return path;
	const converted = spawnSync("cygpath", ["-u", path], { encoding: "utf8" });
	return converted.status === 0 ? converted.stdout.trim() : path;
};

const run = (root: string, rel: string, maxBytes?: number) => {
	const result = spawnSync(
		"bash",
		["-c", buildGuardedTemplateReadCommand(toShellPath(root), rel, maxBytes)],
		{ encoding: "utf8" },
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};

let base: string;
let outside: string;

const link = (target: string, path: string, type: "file" | "dir") =>
	symlinkSync(target, path, type);

// Creating a link needs a privilege on some systems; probed once, at load.
const linksWork = (() => {
	const probe = mkdtempSync(join(tmpdir(), "tpl-probe-"));
	try {
		writeFileSync(join(probe, "target"), "x");
		link(join(probe, "target"), join(probe, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

let repoCount = 0;
const freshRepo = () => {
	repoCount += 1;
	const repo = join(base, `repo-${repoCount}`);
	mkdirSync(repo, { recursive: true });
	return repo;
};

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "tpl-read-"));
	outside = mkdtempSync(join(tmpdir(), "tpl-outside-"));
	writeFileSync(join(outside, "secret.toml"), SECRET);
	mkdirSync(join(outside, "dir"));
	writeFileSync(join(outside, "dir", "template.toml"), SECRET);
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("reading template.toml from a clone", () => {
	it("reads a regular file", () => {
		const repo = freshRepo();
		writeFileSync(join(repo, "template.toml"), TEMPLATE);
		const result = run(repo, "template.toml");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(TEMPLATE);
	});

	it("reads a regular file in a subdirectory with a space in its name", () => {
		const repo = freshRepo();
		mkdirSync(join(repo, "deploy files", "app"), { recursive: true });
		writeFileSync(join(repo, "deploy files", "app", "template.toml"), TEMPLATE);
		const result = run(repo, "deploy files/app/template.toml");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(TEMPLATE);
	});

	it("reports a missing file as 'no template'", () => {
		const repo = freshRepo();
		const result = run(repo, "template.toml");
		expect(result.status).toBe(42);
		expect(getTemplateReadRefusal({ exitCode: result.status })).toBeNull();
	});

	it("treats a directory named template.toml as 'no template'", () => {
		const repo = freshRepo();
		mkdirSync(join(repo, "template.toml"));
		expect(run(repo, "template.toml").status).toBe(42);
	});

	it("does not take the arguments for shell code", () => {
		const repo = freshRepo();
		const dir = "a'b $(id)";
		mkdirSync(join(repo, dir), { recursive: true });
		writeFileSync(join(repo, dir, "template.toml"), TEMPLATE);
		const result = run(repo, `${dir}/template.toml`);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(TEMPLATE);
	});

	it("refuses a path that climbs out of the clone", () => {
		const repo = freshRepo();
		writeFileSync(join(base, "template.toml"), SECRET);
		const result = run(repo, "../template.toml");
		expect(result.status).toBe(TEMPLATE_EXIT_REFUSED);
		expect(result.stdout).not.toContain(SECRET);
	});

	it("refuses a file above the size limit, and reads one at the limit", () => {
		const repo = freshRepo();
		writeFileSync(join(repo, "template.toml"), "a".repeat(101));
		const big = run(repo, "template.toml", 100);
		expect(big.status).toBe(TEMPLATE_EXIT_TOO_LARGE);
		expect(big.stdout).toBe("");
		writeFileSync(join(repo, "template.toml"), "a".repeat(100));
		expect(run(repo, "template.toml", 100).status).toBe(0);
	});

	it("limits the file to 1 MB by default", () => {
		const repo = freshRepo();
		writeFileSync(
			join(repo, "template.toml"),
			"a".repeat(TEMPLATE_FILE_MAX_BYTES + 1),
		);
		expect(run(repo, "template.toml").status).toBe(TEMPLATE_EXIT_TOO_LARGE);
	});
});

// Every link, even one that stays inside the repository, is refused: only
// regular files are read.
describe("reading template.toml when the clone holds symbolic links", () => {
	it.skipIf(!linksWork)(
		"refuses a template.toml that links to a file outside the clone",
		() => {
			const repo = freshRepo();
			link(join(outside, "secret.toml"), join(repo, "template.toml"), "file");
			const result = run(repo, "template.toml");
			expect(result.status).toBe(TEMPLATE_EXIT_REFUSED);
			expect(result.stdout).not.toContain(SECRET);
			expect(result.stderr).not.toContain(SECRET);
		},
	);

	it.skipIf(!linksWork)(
		"refuses a template.toml that links to a missing target",
		() => {
			const repo = freshRepo();
			link(join(outside, "nope"), join(repo, "template.toml"), "file");
			expect(run(repo, "template.toml").status).toBe(TEMPLATE_EXIT_REFUSED);
		},
	);

	it.skipIf(!linksWork)(
		"refuses a directory component that links outside the clone",
		() => {
			const repo = freshRepo();
			link(join(outside, "dir"), join(repo, "deploy"), "dir");
			const result = run(repo, "deploy/template.toml");
			expect(result.status).toBe(TEMPLATE_EXIT_REFUSED);
			expect(result.stdout).not.toContain(SECRET);
		},
	);

	it.skipIf(!linksWork)(
		"refuses a file link that stays inside the clone",
		() => {
			const repo = freshRepo();
			writeFileSync(join(repo, "real.toml"), TEMPLATE);
			link(join(repo, "real.toml"), join(repo, "template.toml"), "file");
			const result = run(repo, "template.toml");
			expect(result.status).toBe(TEMPLATE_EXIT_REFUSED);
			expect(result.stdout).toBe("");
		},
	);

	it.skipIf(!linksWork)(
		"refuses a directory link that stays inside the clone",
		() => {
			const repo = freshRepo();
			mkdirSync(join(repo, "real"));
			writeFileSync(join(repo, "real", "template.toml"), TEMPLATE);
			link(join(repo, "real"), join(repo, "deploy"), "dir");
			expect(run(repo, "deploy/template.toml").status).toBe(
				TEMPLATE_EXIT_REFUSED,
			);
		},
	);

	it.skipIf(!linksWork)(
		"still reads a regular template.toml next to an unrelated link",
		() => {
			const repo = freshRepo();
			writeFileSync(join(repo, "template.toml"), TEMPLATE);
			link(join(outside, "secret.toml"), join(repo, "logo.png"), "file");
			const result = run(repo, "template.toml");
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(TEMPLATE);
		},
	);
});

describe("the refusal a failed read stands for", () => {
	it("names the symbolic link rule with a neutral message", () => {
		const refusal = getTemplateReadRefusal({ exitCode: TEMPLATE_EXIT_REFUSED });
		expect(refusal?.message).toBe(TEMPLATE_LINK_REFUSED_MESSAGE);
		expect(TEMPLATE_LINK_REFUSED_MESSAGE).toBe(
			"The template repository contains a symbolic link where a file was expected; only regular files inside the repository are read.",
		);
	});

	it("names the size limit", () => {
		expect(
			getTemplateReadRefusal({ exitCode: TEMPLATE_EXIT_TOO_LARGE })?.message,
		).toContain("1 MB");
	});

	it("leaves other failures alone", () => {
		expect(getTemplateReadRefusal({ exitCode: 1 })).toBeNull();
		expect(getTemplateReadRefusal(new Error("boom"))).toBeNull();
		expect(getTemplateReadRefusal(null)).toBeNull();
	});
});

describe("the repository URL", () => {
	it.each([
		"https://github.com/owner/repo.git",
		"http://git.internal:3000/owner/repo",
		"ssh://git@host.example:2222/owner/repo.git",
		"git@github.com:owner/repo.git",
		"https://user:secret@git.example.com/owner/repo.git",
		"https://[2001:db8::1]/r",
		"ssh://git@[2001:db8::1]:22/r",
		"https://git.example.com:8443/owner/repo",
		"ssh://git@host.example:22/owner/repo.git",
		"git@[2001:db8::1]:owner/repo.git",
		"deploy_user@git-1.internal:owner/repo.git",
	])("accepts %s", (url) => {
		expect(() => assertSafeTemplateGitUrl(url)).not.toThrow();
	});

	it.each([
		"file:///etc/dokploy",
		"file://localhost/etc",
		"/etc/dokploy",
		"./repo",
		"../repo",
		"~/repo",
		"C:\\repo",
		"ext::sh -c id",
		"ext::sh%20-c%20id",
		"ext::sh -c id@host:repo",
		"ssh://a@-oProxyCommand=x/repo",
		"ssh://-oProxyCommand=x/repo",
		"ssh://-oProxyCommand=x@host/r",
		"ssh://[-oProxyCommand=x]/r",
		"ssh://[-oX]:22/r",
		"ssh://[::1/r",
		"ssh://host:22x/r",
		"ssh://ho$(id)st/r",
		"https://-u@host/r",
		"a@[-oX]:r",
		"x@ho$(id)st:r",
		"-u@host:r",
		"-oProxyCommand=x:repo",
		"a@-oProxyCommand=x:repo",
		"https://-oProxyCommand=x/repo",
		"https:///repo",
		"host:owner/repo.git",
		"fd::17",
		"-u/bin/sh",
		"--upload-pack=id",
		"git://host/repo.git",
		"ftp://host/repo.git",
		"https://host/repo with space",
		"https://host/repo\nsecond",
		"",
		null,
		undefined,
	])("refuses %j", (url) => {
		expect(() => assertSafeTemplateGitUrl(url)).toThrow(
			/must be an http\(s\) URL/,
		);
	});

	it("refuses a transport helper through the scheme list alone", () => {
		for (const url of ["ext::sh -c id", "fd::17", "ext::sh%20-c%20id"]) {
			expect(() => assertSafeTemplateGitUrl(url)).toThrow();
		}
	});

	it("limits the clone to remote protocols and owner-only files", () => {
		expect(TEMPLATE_CLONE_ENV).toContain("umask 077");
		expect(TEMPLATE_CLONE_ENV).toContain("GIT_ALLOW_PROTOCOL=https:http:ssh");
	});
});
