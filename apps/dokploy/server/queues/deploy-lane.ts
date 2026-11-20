import { db } from "@dokploy/server/db";
import { applications, compose } from "@dokploy/server/db/schema";
import { composeFileHasBuildSection } from "@dokploy/server/services/build-origin-shared";
import { eq } from "drizzle-orm";
import { parse } from "yaml";
import type { Lane } from "./in-memory-queue";
import type { DeploymentJob } from "./queue-types";

/**
 * Which lane of the deploy queue a job belongs to (design: T-12497).
 *
 * `pull` is a job that only pulls and starts a prebuilt image. It never uses the
 * build host the build cap protects, so it gets its own cap and does not wait
 * behind builds. Everything else, and every doubt, is `build`, which is how every
 * job was treated before lanes existed. The rules below are therefore
 * conservative: a job is `pull` only when it provably does not build, and any
 * unknown (a failed read, a missing row, a file that does not parse, one that is
 * too big) answers `build`.
 */

/** Pull jobs that may run at once per partition when the env does not say. */
export const PULL_LANE_DEFAULT_CONCURRENCY = 4;
/** The most the env may raise it to. */
export const PULL_LANE_MAX_CONCURRENCY = 16;
/** Name of the env var that sets the pull lane's cap; `0` turns the lane off. */
export const PULL_LANE_CONCURRENCY_ENV = "DOKPLOY_PULL_LANE_CONCURRENCY";

/**
 * The pull lane's cap for a queue partition (a serving host). 4 unless
 * `DOKPLOY_PULL_LANE_CONCURRENCY` says otherwise, clamped to 0..16; `0` is the
 * kill switch (every job is `build`, the queue as it was). The same value for
 * every partition; the argument is there so a per-server value can be added
 * without touching the queue. Not a column or a setting on purpose.
 */
export const resolvePullConcurrency = (
	_partition?: string,
	env: Record<string, string | undefined> = process.env,
): number => {
	const raw = env[PULL_LANE_CONCURRENCY_ENV]?.trim();
	if (raw === undefined || raw === "") return PULL_LANE_DEFAULT_CONCURRENCY;
	const value = Number(raw);
	if (!Number.isFinite(value)) return PULL_LANE_DEFAULT_CONCURRENCY;
	return Math.min(PULL_LANE_MAX_CONCURRENCY, Math.max(0, Math.floor(value)));
};

/** A compose file bigger than this is never read as pull-only (a parse of it is not cheap). */
export const MAX_PULL_COMPOSE_BYTES = 256 * 1024;
/** Aliases a compose file may use (anchors expand into copies); more is a build. */
const MAX_COMPOSE_ALIASES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True only when the stored compose file provably builds nothing: it parses, has
 * no `include`, and every service is an object with an `image` and neither a
 * `build` nor an `extends` key. The YAML parse is the check; it expands merge keys
 * (`<<: *base`) so a `build` inherited through an anchor is seen, and it reads
 * flow style (`web: {image: x, build: .}`) and JSON. The line-based regex the
 * build-origin code uses is a second guard only: on its own it misses both.
 */
export const composeFileIsPullOnly = (file: unknown): boolean => {
	if (typeof file !== "string" || file.trim() === "") return false;
	if (Buffer.byteLength(file, "utf8") > MAX_PULL_COMPOSE_BYTES) return false;
	let document: unknown;
	try {
		document = parse(file, { merge: true, maxAliasCount: MAX_COMPOSE_ALIASES });
	} catch {
		return false;
	}
	if (!isRecord(document) || "include" in document) return false;
	const { services } = document;
	if (!isRecord(services)) return false;
	const all = Object.values(services);
	if (all.length === 0) return false;
	for (const service of all) {
		if (!isRecord(service)) return false;
		if (typeof service.image !== "string" || service.image.trim() === "") {
			return false;
		}
		if ("build" in service || "extends" in service) return false;
	}
	return !composeFileHasBuildSection(file);
};

/** The columns of an application the rules read. */
export interface LaneApplicationRow {
	sourceType: string;
	buildServerId: string | null;
}

/** The columns of a compose the rules read. */
export interface LaneComposeRow {
	sourceType: string;
	buildServerId: string | null;
	command: string;
	composeFile: string | null;
}

/** The two reads the classifier makes, injectable so the rules are testable without a database. */
export interface LaneReaders {
	readApplication: (
		applicationId: string,
	) => Promise<LaneApplicationRow | null | undefined>;
	readCompose: (
		composeId: string,
	) => Promise<LaneComposeRow | null | undefined>;
}

/** Column-limited reads: the whole row is never needed (and a compose row is wide). */
export const dbLaneReaders: LaneReaders = {
	readApplication: (applicationId) =>
		db.query.applications.findFirst({
			where: eq(applications.applicationId, applicationId),
			columns: { sourceType: true, buildServerId: true },
		}),
	readCompose: (composeId) =>
		db.query.compose.findFirst({
			where: eq(compose.composeId, composeId),
			columns: {
				sourceType: true,
				buildServerId: true,
				command: true,
				composeFile: true,
			},
		}),
};

/**
 * A Docker-image application pulls its image and never builds. With a build
 * server the pull, retag and push run on that server, the host the build cap
 * protects, so it stays in the build lane.
 */
const isPullApplication = (
	row: LaneApplicationRow | null | undefined,
): boolean =>
	!!row && row.sourceType === "docker" && row.buildServerId === null;

/**
 * A stored (raw) compose with no build server and no custom command, whose file
 * builds nothing. A git-sourced compose clones, and `up --build` is its default,
 * so it is always `build`; so is a custom command, which can run anything.
 */
const isPullCompose = (row: LaneComposeRow | null | undefined): boolean =>
	!!row &&
	row.sourceType === "raw" &&
	row.buildServerId === null &&
	typeof row.command === "string" &&
	row.command.trim() === "" &&
	composeFileIsPullOnly(row.composeFile);

/**
 * The lane of a queued deploy. Never throws: any error is `build`. Called when
 * the job is queued and once more just before a pull job starts (the service may
 * have been edited while it waited), so it must stay cheap: at most one
 * column-limited read.
 */
export const classifyDeployJob = async (
	data: DeploymentJob,
	readers: LaneReaders = dbLaneReaders,
): Promise<Lane> => {
	try {
		switch (data.applicationType) {
			case "application":
				// A deploy-hook image is deployed by digest and never builds.
				if (data.pinnedImage) return "pull";
				return isPullApplication(
					await readers.readApplication(data.applicationId),
				)
					? "pull"
					: "build";
			case "application-preview":
				// Pulls only when the parent application is a Docker-image one; a git
				// preview clones and builds.
				return isPullApplication(
					await readers.readApplication(data.applicationId),
				)
					? "pull"
					: "build";
			case "compose":
				return isPullCompose(await readers.readCompose(data.composeId))
					? "pull"
					: "build";
			default:
				// compose-preview needs a clone, and so does anything unknown.
				return "build";
		}
	} catch (error) {
		console.debug(
			"Deployment queue: could not classify a job, treating it as a build",
			error instanceof Error ? error.message : error,
		);
		return "build";
	}
};
