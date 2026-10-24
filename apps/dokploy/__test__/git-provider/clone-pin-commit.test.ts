import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "shell-quote";
import { afterAll, describe, expect, it, vi } from "vitest";

// T-7282: a compose's build-server clone is pinned to the commit its serving
// host checked. Covers the pin script (pure and in a real shell against real
// git repositories) and every provider that appends it.

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(async () => ({
		githubId: "gh-1",
		githubUrl: "https://github.com",
		githubAppId: 1,
		githubPrivateKey: "key",
		githubInstallationId: "42",
	})),
}));
vi.mock("@octokit/auth-app", () => ({
	createAppAuth: vi.fn(),
}));
vi.mock("octokit", () => ({
	Octokit: class {
		auth = async () => ({ token: "gh-token" });
	},
}));
vi.mock("@dokploy/server/services/gitlab", () => ({
	findGitlabById: vi.fn(async () => ({
		gitlabId: "gl-1",
		gitlabUrl: "https://gitlab.example.com",
		gitlabInternalUrl: null,
		accessToken: "gl-token",
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
	})),
	updateGitlab: vi.fn(),
}));
vi.mock("@dokploy/server/services/gitea", () => ({
	findGiteaById: vi.fn(async () => ({
		giteaId: "gt-1",
		giteaUrl: "https://gitea.example.com:3000",
		giteaInternalUrl: null,
		accessToken: "gt-token",
	})),
	updateGitea: vi.fn(),
}));
vi.mock("@dokploy/server/services/bitbucket", () => ({
	findBitbucketById: vi.fn(async () => ({
		apiToken: null,
		bitbucketUsername: "acme-dev",
		appPassword: "app-pass",
	})),
}));

const { cloneBitbucketRepository } = await import(
	"@dokploy/server/utils/providers/bitbucket"
);
const { cloneGitRepository } = await import(
	"@dokploy/server/utils/providers/git"
);
const { cloneGithubRepository } = await import(
	"@dokploy/server/utils/providers/github"
);
const { cloneGitlabRepository } = await import(
	"@dokploy/server/utils/providers/gitlab"
);
const { cloneGiteaRepository } = await import(
	"@dokploy/server/utils/providers/gitea"
);
const {
	buildPinCommitCommand,
	getCheckedOutCommitCommand,
	isCommitSha,
	parseCheckedOutCommit,
} = await import("@dokploy/server/utils/providers/pin-commit");
const { getReusableCloneProbeCommand, REUSABLE_CLONE_ANSWER } = await import(
	"@dokploy/server/utils/builders/compose-remote-build"
);

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Every `-c <value>` pair git is given, as the shell would split them. */
const gitConfigArgs = (command: string): string[] => {
	const tokens = parse(command);
	const values: string[] = [];
	tokens.forEach((token, index) => {
		const next = tokens[index + 1];
		if (token === "-c" && typeof next === "string") values.push(next);
	});
	return values;
};

describe("commit ids", () => {
	it("accepts only a full lower-case SHA-1", () => {
		expect(isCommitSha(SHA)).toBe(true);
		for (const bad of [
			"",
			SHA.slice(0, 39),
			`${SHA}0`,
			SHA.toUpperCase(),
			`${SHA.slice(0, 39)}g`,
			`${SHA.slice(0, 30)};rm -rf /`,
			`$(id)${SHA.slice(5)}`,
			` ${SHA}`,
			null,
			undefined,
			42,
		]) {
			expect(isCommitSha(bad), String(bad)).toBe(false);
		}
	});

	it("parses what the commit read printed, and nothing else", () => {
		expect(parseCheckedOutCommit(`${SHA}\n`)).toBe(SHA);
		expect(parseCheckedOutCommit("")).toBeNull();
		expect(parseCheckedOutCommit(undefined)).toBeNull();
		expect(parseCheckedOutCommit(`warning\n${SHA}`)).toBeNull();
		expect(parseCheckedOutCommit("HEAD")).toBeNull();
	});

	it("refuses to build a pin or a probe from an invalid commit id", () => {
		for (const bad of ["main", `${SHA.slice(0, 39)}'`, "$(reboot)"]) {
			expect(() =>
				buildPinCommitCommand({ outputPath: "/code", commitSha: bad }),
			).toThrow(/invalid commit id/);
			expect(() => getReusableCloneProbeCommand("/code", bad)).toThrow(
				/invalid commit id/,
			);
		}
	});

	it("quotes the checkout path in the pin and the commit read", () => {
		const path = "/etc/dokploy/compose/a b;$(id)/code";
		for (const command of [
			buildPinCommitCommand({ outputPath: path, commitSha: SHA }),
			getCheckedOutCommitCommand(path),
		]) {
			// Every occurrence opens one single-quoted word (the path, or a
			// path under it such as its .git directory), closed before any
			// other shell text.
			const occurrences = command.split(path).length - 1;
			expect(occurrences).toBeGreaterThan(0);
			const words = command.match(/'[^']*'/g) ?? [];
			const quoted = words.filter((word) =>
				word.startsWith(`'${path}`),
			).length;
			expect(quoted).toBe(occurrences);
		}
	});

	it("puts the credentials on the fetch and the submodule update only", () => {
		const command = buildPinCommitCommand({
			outputPath: "/code",
			commitSha: SHA,
			enableSubmodules: true,
			authConfig: "-c 'http.https://h/.extraHeader=Authorization: Basic eA=='",
		});
		expect(command).toMatch(
			/git -c '[^']+' -C \/code fetch --progress --depth 1 origin -- 0123/,
		);
		expect(command).toMatch(
			/git -c '[^']+' -C \/code submodule update --init --recursive/,
		);
		expect(command).toContain(`git -C /code checkout -q --detach ${SHA}`);
		expect(command.match(/extraHeader/g)).toHaveLength(2);
	});

	it("leaves the submodules alone when they are not enabled", () => {
		expect(
			buildPinCommitCommand({ outputPath: "/code", commitSha: SHA }),
		).not.toContain("submodule");
	});
});

describe("providers append the pin only when asked", () => {
	const remote = { appName: "my-app", serverId: "build-1" };
	const gitlabRow = { gitlabOwner: "acme", gitlabRepository: "web" };
	const clones = {
		github: (pinCommit?: string) =>
			cloneGithubRepository({
				...remote,
				type: "compose",
				owner: "acme",
				repository: "web",
				branch: "main",
				githubId: "gh-1",
				enableSubmodules: false,
				pinCommit,
			}),
		githubHeadRef: (pinCommit?: string) =>
			cloneGithubRepository({
				...remote,
				type: "compose",
				owner: "acme",
				repository: "web",
				branch: "feature",
				headRef: "refs/pull/7/head",
				githubId: "gh-1",
				enableSubmodules: false,
				pinCommit,
			}),
		gitlab: (pinCommit?: string) =>
			cloneGitlabRepository({
				...remote,
				type: "compose",
				// The full row: the clone's requirements check reads these too.
				...gitlabRow,
				gitlabBranch: "main",
				gitlabId: "gl-1",
				gitlabPathNamespace: "acme/web",
				enableSubmodules: false,
				pinCommit,
			}),
		gitea: (pinCommit?: string) =>
			cloneGiteaRepository({
				...remote,
				type: "compose",
				giteaBranch: "main",
				giteaId: "gt-1",
				giteaOwner: "acme",
				giteaRepository: "web",
				enableSubmodules: false,
				pinCommit,
			}),
		bitbucket: (pinCommit?: string) =>
			cloneBitbucketRepository({
				...remote,
				type: "compose",
				bitbucketRepository: "web",
				bitbucketOwner: "acme",
				bitbucketBranch: "main",
				bitbucketId: "bb-1",
				enableSubmodules: false,
				pinCommit,
			}),
		git: (pinCommit?: string) =>
			cloneGitRepository({
				...remote,
				type: "compose",
				customGitUrl: "https://git.example.com/acme/web.git",
				customGitBranch: "main",
				enableSubmodules: false,
				pinCommit,
			}),
	};

	for (const [name, clone] of Object.entries(clones)) {
		it(`${name}: unchanged without a pin, pinned to the commit with one`, async () => {
			const plain = await clone();
			const pinned = await clone(SHA);
			expect(plain).not.toContain(SHA);
			expect(plain).not.toContain("--detach");
			// The pin is appended to the very same clone, after it.
			expect(pinned.startsWith(plain)).toBe(true);
			const pin = pinned.slice(plain.length);
			expect(pin).toContain(`checkout -q --detach ${SHA}`);
			expect(pin).toContain(`origin -- ${SHA}`);
			expect(pin).toMatch(/compose[\\/]+my-app[\\/]+code/);
			// A provider with header credentials puts the same header on the
			// pin's fetch; none of them puts a secret anywhere else.
			const plainHeaders = gitConfigArgs(plain);
			const pinHeaders = gitConfigArgs(pin);
			if (name === "git") {
				expect(pinHeaders).toEqual([]);
			} else {
				expect(pinHeaders).toEqual([plainHeaders[0]]);
			}
		});
	}

	it("refuses an invalid commit before any command is built", async () => {
		await expect(clones.github("main")).rejects.toThrow(/invalid commit id/);
	});
});

// Real `sh` and `git`, against a real origin that moves on after the commit
// the serving host checked. Skipped where there is no sh or git.
const available = (command: string, args: string[]) =>
	spawnSync(command, args, { stdio: "ignore" }).status === 0;
const hasShellAndGit =
	available("sh", ["-c", "true"]) && available("git", ["--version"]);

describe.skipIf(!hasShellAndGit)(
	"commit pin (real sh + git)",
	{ timeout: 90_000 },
	() => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pin-commit-")));
		afterAll(() => rmSync(root, { recursive: true, force: true }));

		const posix = (path: string) => path.replace(/\\/g, "/");
		const sh = (command: string) =>
			spawnSync("sh", ["-c", command], { encoding: "utf8" });
		const git = (cwd: string, ...args: string[]) => {
			const result = spawnSync(
				"git",
				[
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@t",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd, encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			return result.stdout.trim();
		};

		const origin = join(root, "origin");
		mkdirSync(origin);
		git(origin, "init", "-q", "-b", "main");
		git(origin, "commit", "-q", "--allow-empty", "-m", "checked");
		const checked = git(origin, "rev-parse", "HEAD");
		// `file://` so `--depth 1` really is a shallow clone, as on a build server.
		const originUrl = `file://${posix(origin)}`;

		const shallowClone = (name: string) => {
			const dir = posix(join(root, name));
			git(
				root,
				"clone",
				"-q",
				"--depth",
				"1",
				"--branch",
				"main",
				originUrl,
				dir,
			);
			return dir;
		};
		const head = (dir: string) => git(dir, "rev-parse", "HEAD");
		const pin = (dir: string, commitSha: string) =>
			sh(`set -e;${buildPinCommitCommand({ outputPath: dir, commitSha })}`);

		it("keeps a clone that already is the commit, without fetching", () => {
			const dir = shallowClone("same");
			const result = pin(dir, checked);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).not.toContain("Checking out commit");
			expect(head(dir)).toBe(checked);
		});

		it("moves a clone of a newer tip back to the checked commit", () => {
			// The push that landed between the serving host's and the build
			// server's clone.
			git(origin, "commit", "-q", "--allow-empty", "-m", "pushed later");
			const pushed = git(origin, "rev-parse", "HEAD");
			expect(pushed).not.toBe(checked);

			const dir = shallowClone("moved");
			expect(head(dir)).toBe(pushed);
			const result = pin(dir, checked);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain(`Checking out commit ${checked}`);
			expect(head(dir)).toBe(checked);
			expect(
				parseCheckedOutCommit(sh(getCheckedOutCommitCommand(dir)).stdout),
			).toBe(checked);
		});

		it("fails, and never ends on the tip, when the commit cannot be fetched", () => {
			const dir = shallowClone("missing");
			const tip = head(dir);
			const result = pin(dir, "f".repeat(40));
			expect(result.status).not.toBe(0);
			expect(result.stdout).toContain("Could not fetch commit");
			expect(head(dir)).toBe(tip);
			// What the build server then reads is not the requested commit.
			expect(
				parseCheckedOutCommit(sh(getCheckedOutCommitCommand(dir)).stdout),
			).not.toBe("f".repeat(40));
		});

		it("reads no commit from a directory that is not a checkout of its own", () => {
			const inside = posix(join(origin, "nested"));
			mkdirSync(inside);
			expect(sh(getCheckedOutCommitCommand(inside)).stdout.trim()).toBe("");
			expect(
				sh(
					getCheckedOutCommitCommand(posix(join(root, "absent"))),
				).stdout.trim(),
			).toBe("");
		});

		it("reuses a finished checkout only when it is the given commit", () => {
			const dir = shallowClone("reuse");
			sh(`touch '${dir}/.git/dokploy-clone-ok'`);
			const probe = (commit?: string) =>
				sh(getReusableCloneProbeCommand(dir, commit)).stdout.includes(
					REUSABLE_CLONE_ANSWER,
				);
			expect(probe()).toBe(true);
			expect(probe(head(dir))).toBe(true);
			expect(probe(checked)).toBe(head(dir) === checked);
			expect(probe("e".repeat(40))).toBe(false);
		});

		// A HEAD that names a missing object reads as no commit.
		it("reads no commit when HEAD names an object the repository does not have", () => {
			const dir = shallowClone("forged");
			sh(`touch '${dir}/.git/dokploy-clone-ok'`);
			const forged = "b".repeat(40);
			writeFileSync(`${dir}/.git/HEAD`, `${forged}\n`);
			expect(sh(getCheckedOutCommitCommand(dir)).stdout.trim()).toBe("");
			expect(
				sh(getReusableCloneProbeCommand(dir, forged)).stdout,
			).not.toContain(REUSABLE_CLONE_ANSWER);
		});

		// A checkout whose git directory is a link is not a checkout of its
		// own.
		const canLink = (() => {
			const probe = join(root, "link-probe");
			try {
				symlinkSync(root, probe, "dir");
				rmSync(probe, { force: true });
				return true;
			} catch {
				return false;
			}
		})();
		it.skipIf(!canLink)("reads no commit through a linked .git", () => {
			const other = shallowClone("other");
			const dir = posix(join(root, "linked"));
			mkdirSync(dir);
			symlinkSync(`${other}/.git`, `${dir}/.git`, "dir");
			sh(`touch '${other}/.git/dokploy-clone-ok'`);
			expect(sh(getCheckedOutCommitCommand(dir)).stdout.trim()).toBe("");
			expect(
				sh(getReusableCloneProbeCommand(dir, head(other))).stdout,
			).not.toContain(REUSABLE_CLONE_ANSWER);
		});

		// A checkout counts only with its own object store and refs.
		const borrowedSetup = (name: string) => {
			const dir = shallowClone(name);
			sh(`touch '${dir}/.git/dokploy-clone-ok'`);
			const own = head(dir);
			expect(
				parseCheckedOutCommit(sh(getCheckedOutCommitCommand(dir)).stdout),
			).toBe(own);
			// A commit only another repository on the host has.
			const other = posix(join(root, `${name}-other`));
			mkdirSync(other);
			git(other, "init", "-q", "-b", "main");
			git(other, "commit", "-q", "--allow-empty", "-m", "elsewhere");
			const foreign = git(other, "rev-parse", "HEAD");
			return { dir, other, foreign };
		};
		const refusedAsOwnCheckout = (dir: string, commit: string) => {
			expect(sh(getCheckedOutCommitCommand(dir)).stdout.trim()).toBe("");
			expect(
				sh(getReusableCloneProbeCommand(dir, commit)).stdout,
			).not.toContain(REUSABLE_CLONE_ANSWER);
		};

		it("reads no commit when the objects come from another repository (alternates)", () => {
			const { dir, other, foreign } = borrowedSetup("alternates");
			writeFileSync(
				`${dir}/.git/objects/info/alternates`,
				`${other}/.git/objects\n`,
			);
			writeFileSync(`${dir}/.git/HEAD`, `${foreign}\n`);
			// Git itself resolves the borrowed commit...
			expect(git(dir, "rev-parse", "--verify", "-q", "HEAD^{commit}")).toBe(
				foreign,
			);
			// ...the pin does not take it.
			refusedAsOwnCheckout(dir, foreign);
		});

		it("reads no commit when the .git has http-alternates", () => {
			const { dir, foreign } = borrowedSetup("http-alternates");
			writeFileSync(
				`${dir}/.git/objects/info/http-alternates`,
				"https://example.invalid/objects\n",
			);
			refusedAsOwnCheckout(dir, foreign);
			refusedAsOwnCheckout(dir, head(dir));
		});

		it("reads no commit when the .git takes its common dir from another repository", () => {
			const { dir, other, foreign } = borrowedSetup("commondir");
			writeFileSync(`${dir}/.git/commondir`, `${other}/.git\n`);
			writeFileSync(`${dir}/.git/HEAD`, `${foreign}\n`);
			refusedAsOwnCheckout(dir, foreign);
		});

		it.skipIf(!canLink)(
			"reads no commit when .git/objects is a link to another store",
			() => {
				const { dir, other, foreign } = borrowedSetup("linked-objects");
				rmSync(`${dir}/.git/objects`, { recursive: true, force: true });
				symlinkSync(`${other}/.git/objects`, `${dir}/.git/objects`, "dir");
				writeFileSync(`${dir}/.git/HEAD`, `${foreign}\n`);
				refusedAsOwnCheckout(dir, foreign);
			},
		);

		// A submodule only the newer tip has leaves nothing behind once the
		// checkout is pinned to the older commit.
		it("removes what only the newer tip had, a submodule included", () => {
			// Local submodules need file transport allowed (git >= 2.38).
			const env = {
				...process.env,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "protocol.file.allow",
				GIT_CONFIG_VALUE_0: "always",
			};
			const gitEnv = (cwd: string, ...args: string[]) => {
				const result = spawnSync(
					"git",
					["-c", "user.name=t", "-c", "user.email=t@t", ...args],
					{ cwd, encoding: "utf8", env },
				);
				expect(result.status, result.stderr).toBe(0);
				return result.stdout.trim();
			};
			const sub = posix(join(root, "sub-origin"));
			mkdirSync(sub);
			gitEnv(sub, "init", "-q", "-b", "main");
			writeFileSync(`${sub}/tip-only.txt`, "from the tip\n");
			gitEnv(sub, "add", ".");
			gitEnv(sub, "commit", "-q", "-m", "sub");

			const repo = posix(join(root, "sm-origin"));
			mkdirSync(repo);
			gitEnv(repo, "init", "-q", "-b", "main");
			writeFileSync(`${repo}/docker-compose.yml`, "services: {}\n");
			gitEnv(repo, "add", ".");
			gitEnv(repo, "commit", "-q", "-m", "checked");
			const older = gitEnv(repo, "rev-parse", "HEAD");
			gitEnv(repo, "submodule", "add", "-q", `file://${sub}`, "X");
			gitEnv(repo, "commit", "-q", "-m", "tip adds a submodule");

			const dir = posix(join(root, "sm-clone"));
			gitEnv(
				root,
				"clone",
				"-q",
				"--depth",
				"1",
				"--recurse-submodules",
				"--branch",
				"main",
				`file://${repo}`,
				dir,
			);
			expect(existsSync(`${dir}/X/tip-only.txt`)).toBe(true);

			const result = spawnSync(
				"sh",
				[
					"-c",
					`set -e;${buildPinCommitCommand({ outputPath: dir, commitSha: older, enableSubmodules: true })}`,
				],
				{ encoding: "utf8", env },
			);
			expect(result.status, result.stdout + result.stderr).toBe(0);
			expect(gitEnv(dir, "rev-parse", "HEAD")).toBe(older);
			expect(existsSync(`${dir}/X`)).toBe(false);
			expect(gitEnv(dir, "status", "--porcelain", "--ignored")).toBe("");
		});
	},
);
