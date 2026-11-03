#!/usr/bin/env node
// Copies the release-manifest fixtures of DevinoSolutions/dokploy-release into
// the fork's tests and pins them with a hash.
//
//   node scripts/vendor-gha-fixtures.mjs <path to a checkout of dokploy-release>
//
// The hash algorithm is the one apps/dokploy/__test__/gha-connect/manifest.test.ts
// recomputes, so a hand edit of a vendored fixture fails that test.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
	console.error("usage: vendor-gha-fixtures.mjs <dokploy-release checkout>");
	process.exit(2);
}
const from = resolve(source, "fixtures");
const to = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"apps/dokploy/__test__/gha-connect/fixtures",
);

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const read = (file) => readFileSync(join(to, file), "utf8");
const index = JSON.parse(read("index.json"));
const hash = createHash("sha256");
for (const entry of [...index].sort((a, b) => a.file.localeCompare(b.file))) {
	hash.update(entry.file).update("\0").update(read(entry.file)).update("\0");
}
hash.update(read("index.json"));

let commit = null;
try {
	commit = execFileSync("git", ["-C", resolve(source), "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	// Not a git checkout: the hash still pins the content.
}
writeFileSync(
	join(to, "SOURCE.json"),
	`${JSON.stringify({ repository: "DevinoSolutions/dokploy-release", commit, sha256: hash.digest("hex") }, null, 2)}\n`,
);
console.log(`vendored ${index.length} fixtures from ${from}`);
