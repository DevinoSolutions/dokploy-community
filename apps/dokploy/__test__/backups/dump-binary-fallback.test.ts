import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	getDumpBinarySelection,
	getMariadbBackupCommand,
	getMysqlBackupCommand,
} from "@dokploy/server/utils/backups/utils";
import {
	getClientBinarySelection,
	getMariadbRestoreCommand,
	getMysqlRestoreCommand,
} from "@dokploy/server/utils/restore/utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// MariaDB 11+ renamed mysqldump -> mariadb-dump; older MariaDB and MySQL images
// only ship mysqldump. Users also register MariaDB containers as "mysql"
// services, so both runners must resolve the binary at run time.

const binDir = path.join(tmpdir(), `dokploy_dumpbin_${process.pid}`);

const fakeBinary = (name: string) => {
	const file = path.join(binDir, name);
	writeFileSync(file, "#!/bin/sh\nexit 0\n");
	chmodSync(file, 0o755);
};

// Evaluate a selection snippet with ONLY `available` on PATH and report which
// binary it picked.
const resolveBinary = (
	snippet: string,
	variable: string,
	available: string,
) => {
	rmSync(binDir, { recursive: true, force: true });
	mkdirSync(binDir, { recursive: true });
	fakeBinary(available);
	// A minimal PATH is essential: the CI image ships a real mysqldump, which
	// would mask the fallback branch.
	return execFileSync("/bin/sh", ["-c", `${snippet} echo "$${variable}"`], {
		env: { PATH: binDir, NODE_ENV: "test" } as NodeJS.ProcessEnv,
		encoding: "utf-8",
	}).trim();
};

beforeAll(() => {
	mkdirSync(binDir, { recursive: true });
});

afterAll(() => {
	rmSync(binDir, { recursive: true, force: true });
});

// The selection snippet is POSIX sh; only run it where a POSIX shell exists
// (CI is Linux, developer machines may be Windows).
describe.skipIf(!existsSync("/bin/sh"))("dump binary selection", () => {
	it("prefers mariadb-dump but falls back to mysqldump", () => {
		const snippet = getDumpBinarySelection("mariadb-dump");
		expect(resolveBinary(snippet, "DUMP_BIN", "mariadb-dump")).toBe(
			"mariadb-dump",
		);
		expect(resolveBinary(snippet, "DUMP_BIN", "mysqldump")).toBe("mysqldump");
	});

	it("prefers mysqldump but falls back to mariadb-dump", () => {
		const snippet = getDumpBinarySelection("mysqldump");
		expect(resolveBinary(snippet, "DUMP_BIN", "mysqldump")).toBe("mysqldump");
		expect(resolveBinary(snippet, "DUMP_BIN", "mariadb-dump")).toBe(
			"mariadb-dump",
		);
	});

	it("prefers the mariadb client but falls back to mysql", () => {
		const snippet = getClientBinarySelection("mariadb");
		expect(resolveBinary(snippet, "CLIENT_BIN", "mariadb")).toBe("mariadb");
		expect(resolveBinary(snippet, "CLIENT_BIN", "mysql")).toBe("mysql");
	});

	it("prefers the mysql client but falls back to mariadb", () => {
		const snippet = getClientBinarySelection("mysql");
		expect(resolveBinary(snippet, "CLIENT_BIN", "mysql")).toBe("mysql");
		expect(resolveBinary(snippet, "CLIENT_BIN", "mariadb")).toBe("mariadb");
	});
});

describe("backup commands use the resolved binary", () => {
	it("mariadb backup keeps its flags and pipes through gzip", () => {
		const command = getMariadbBackupCommand("db", "user", "pw");
		expect(command).toContain("command -v mariadb-dump");
		expect(command).toContain("DUMP_BIN=mysqldump");
		expect(command).toContain(
			'"$DUMP_BIN" --user="$DB_USER" --password="$DB_PASS" --single-transaction --quick --databases "$DB_NAME" | gzip',
		);
		// Credentials still travel as env vars, never inline.
		expect(command).toContain("-e DB_PASS=pw");
	});

	it("mysql backup keeps its flags and pipes through gzip", () => {
		const command = getMysqlBackupCommand("db", "pw");
		expect(command).toContain("command -v mysqldump");
		expect(command).toContain("DUMP_BIN=mariadb-dump");
		expect(command).toContain(
			'"$DUMP_BIN" --default-character-set=utf8mb4 -u root --password="$DB_PASS" --single-transaction --no-tablespaces --quick "$DB_NAME" | gzip',
		);
		expect(command).toContain("set -o pipefail");
	});

	it("restore commands resolve their client binary too", () => {
		expect(getMariadbRestoreCommand("db", "user", "pw")).toContain(
			'"$CLIENT_BIN" -u "$DB_USER" -p"$DB_PASS" "$DB_NAME"',
		);
		expect(getMysqlRestoreCommand("db", "pw")).toContain(
			'"$CLIENT_BIN" -u root -p"$DB_PASS" "$DB_NAME"',
		);
	});
});
