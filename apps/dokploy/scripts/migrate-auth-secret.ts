/**
 * Use this command to automatically migrate the auth secret: curl -sSL https://dokploy.com/security/0.29.3.sh | bash
 * Migration script: re-encrypt data tied to BETTER_AUTH_SECRET after rotating it.
 *
 * - 2FA secrets and backup codes are re-encrypted.
 * - Client secrets of confidential MCP OAuth clients (oauth_client) are
 *   re-encrypted. Clients migrated from better-auth 1.6 keep their
 *   "dokploy-legacy-plain:" value, which does not depend on the secret.
 * - Refresh-token replay responses (oauth_refresh_token.rotation_replay_response)
 *   are cleared. They only serve a retry within the refresh grace window, and
 *   a client that retries after the restart is answered invalid_grant for that
 *   one stale token, as after any expired window.
 *
 * Not covered: SCIM connection tokens are stored as digests keyed with
 * DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET or, when it is unset, with a key derived
 * from the auth secret. A digest cannot be re-keyed, so without that variable
 * every SCIM token stops working after the rotation: rotate each connection's
 * token in Settings and update the identity provider. (Setting or changing
 * the variable has the same effect.) See docs/better-auth-1.7-upgrade.md.
 *
 * Usage:
 *   OLD_SECRET=<old_secret> NEW_SECRET=<new_secret> npx tsx apps/dokploy/scripts/migrate-auth-secret.ts
 *
 * Both OLD_SECRET and NEW_SECRET are required.
 * Run this BEFORE restarting Dokploy with the new secret.
 */
import { db } from "@dokploy/server/db";
import {
	oauthClient,
	oauthRefreshToken,
	twoFactor,
} from "@dokploy/server/db/schema";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { eq, isNotNull } from "drizzle-orm";

/** Mirrors LEGACY_PLAINTEXT_CLIENT_SECRET_PREFIX in packages/server/src/lib/auth.ts. */
const LEGACY_PLAINTEXT_CLIENT_SECRET_PREFIX = "dokploy-legacy-plain:";

const OLD_SECRET = process.env.OLD_SECRET as string;
const NEW_SECRET = process.env.NEW_SECRET as string;

if (!OLD_SECRET || !NEW_SECRET) {
	console.error(
		"❌ OLD_SECRET and NEW_SECRET environment variables are required.",
	);
	console.error(
		"   Usage: OLD_SECRET=<old> NEW_SECRET=<new> npx tsx apps/dokploy/scripts/migrate-auth-secret.ts",
	);
	process.exit(1);
}

if (OLD_SECRET === NEW_SECRET) {
	console.error("❌ OLD_SECRET and NEW_SECRET must be different.");
	process.exit(1);
}

async function reEncrypt(
	value: string,
	oldSecret: string,
	newSecret: string,
): Promise<string> {
	const plaintext = await symmetricDecrypt({ key: oldSecret, data: value });
	return symmetricEncrypt({ key: newSecret, data: plaintext });
}

async function main() {
	console.log("🔍 Fetching 2FA records...");
	const records = await db.select().from(twoFactor);
	const clients = (
		await db
			.select({ id: oauthClient.id, clientSecret: oauthClient.clientSecret })
			.from(oauthClient)
			.where(isNotNull(oauthClient.clientSecret))
	).filter(
		(client) =>
			client.clientSecret &&
			!client.clientSecret.startsWith(LEGACY_PLAINTEXT_CLIENT_SECRET_PREFIX),
	);

	console.log(`📦 Found ${records.length} 2FA record(s) to migrate.`);
	console.log(
		`📦 Found ${clients.length} encrypted OAuth client secret(s) to migrate.`,
	);

	let migrated = 0;
	let failed = 0;

	await db.transaction(async (tx) => {
		for (const client of clients) {
			try {
				await tx
					.update(oauthClient)
					.set({
						clientSecret: await reEncrypt(
							client.clientSecret as string,
							OLD_SECRET,
							NEW_SECRET,
						),
					})
					.where(eq(oauthClient.id, client.id));
			} catch (err) {
				console.error(`❌ Failed to migrate OAuth client ${client.id}:`, err);
				failed++;
				throw err; // rollback the whole transaction
			}
		}

		const cleared = await tx
			.update(oauthRefreshToken)
			.set({ rotationReplayResponse: null })
			.where(isNotNull(oauthRefreshToken.rotationReplayResponse))
			.returning({ id: oauthRefreshToken.id });
		console.log(
			`🧹 Cleared ${cleared.length} refresh-token replay response(s).`,
		);

		for (const record of records) {
			try {
				const [newSecret, newBackupCodes] = await Promise.all([
					reEncrypt(record.secret, OLD_SECRET, NEW_SECRET),
					reEncrypt(record.backupCodes, OLD_SECRET, NEW_SECRET),
				]);

				await tx
					.update(twoFactor)
					.set({ secret: newSecret, backupCodes: newBackupCodes })
					.where(eq(twoFactor.id, record.id));

				migrated++;
			} catch (err) {
				console.error(
					`❌ Failed to migrate record ${record.id} (userId: ${record.userId}):`,
					err,
				);
				failed++;
				throw err; // rollback the whole transaction
			}
		}
	});

	console.log(`✅ Migrated ${migrated} 2FA record(s) successfully.`);
	console.log(`✅ Migrated ${clients.length} OAuth client secret(s).`);
	console.log(
		"⚠️  SCIM tokens are not migrated: unless DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET is set, rotate each SCIM connection's token in Settings after the restart.",
	);

	if (failed > 0) {
		console.error(
			`❌ ${failed} record(s) failed — transaction was rolled back.`,
		);
		process.exit(1);
	} else {
		process.exit(0);
	}
}

main().catch((err) => {
	console.error("❌ Migration failed:", err);
	process.exit(1);
});
