/**
 * Columns whose name looks like a secret (see schema-secret-drift.test.ts) and
 * that the service-read redaction in `service-secrets.ts` does not name. Each
 * one has been looked at and sits in exactly one of the two lists below, with
 * the reason. A column that is a secret and is not on a surface that blanks it
 * does not belong here: name it in `service-secrets.ts` instead.
 *
 * Keys are `<sql table name>.<column property>`.
 */

/** Looks like a secret and is not one. */
export const REVIEWED_NOT_SECRET: Record<string, string> = {
	// better-auth account and OAuth tables: timestamps and flags.
	"account.accessTokenExpiresAt": "expiry timestamp, not the token",
	"account.refreshTokenExpiresAt": "expiry timestamp, not the token",
	"account.resetPasswordExpiresAt": "expiry timestamp, not the token",
	"oauth_access_token.accessTokenExpiresAt": "expiry timestamp, not the token",
	"oauth_access_token.refreshTokenExpiresAt": "expiry timestamp, not the token",
	"oauth_client.clientCredentialsScopes": "list of scope names",
	"oauth_client.tokenEndpointAuthMethod": "name of an auth method",
	"oauth_client.dpopBoundAccessTokens": "boolean setting",
	"oauth_resource.accessTokenTtl": "lifetime in seconds",
	"oauth_resource.refreshTokenTtl": "lifetime in seconds",
	"oauth_resource.dpopBoundAccessTokensRequired": "boolean setting",
	"oauth_resource.signingKeyId": "id of a signing key, not the key",
	"passkey.publicKey": "public half of the WebAuthn key",
	"passkey.credentialID": "public credential id the browser presents",
	"ssh-key.publicKey": "public half of the SSH key",
	// Identifiers and digests of things that are not credentials.
	"backup.includeEncryptionKey":
		"boolean: whether the backup file carries the key",
	"deployment.imageDigest": "content digest of a public image layer set",
	"deployment.pinnedPatchDigest": "content digest of a patch set",
	"gha_connection.deployedDigests": "image digests of releases",
	"gha_release.digests": "image digests of a release",
	"deployment_cancel_audit.apiKeyId":
		"id of the API key that cancelled, not the key",
	"dodomain_integration.webhookEndpointId":
		"id of the webhook endpoint at DoDomain",
	"dodomain_integration.webhookUrl":
		"Dokploy's own receiving URL; the secret is webhookSecret",
	"domain.uniqueConfigKey": "unique name of a Traefik config entry",
	"redirect.uniqueConfigKey": "unique name of a Traefik config entry",
	"gha_connection.serviceKey": "service type and id, a lookup key",
	"uptimely_channel_incident.serviceKey": "service type and id, a lookup key",
	"notifly.workflowKey":
		"name of a workflow the user picked; the credential is apiKey (masked)",
	// SCIM bookkeeping: normalized lookup keys and ids.
	"scim_managed_credential.credentialId": "id of a credential row",
	"scim_managed_credential.activeSlotKey": "name of a slot",
	"scim_managed_connection_event.credentialId": "id of a credential row",
	"scim_managed_connection_event.eventKey": "lookup key of an event",
	"scim_connection_binding.connectionKey": "lookup key of a connection",
	"scim_identity_tombstone.externalIdKey":
		"normalized external id, a lookup key",
	"scim_user.connectionUserKey": "normalized lookup key",
	"scim_user.userNameKey": "normalized userName, a lookup key",
	"scim_user.externalIdKey": "normalized external id, a lookup key",
	"scim_user.orderKey": "sort key",
	"scim_projection_grant.grantKey": "lookup key of a grant",
	"scim_group.displayNameKey": "normalized display name, a lookup key",
	"scim_group.externalIdKey": "normalized external id, a lookup key",
	"scim_group.orderKey": "sort key",
	"scim_group_member.membershipKey": "lookup key of a membership",
};

/**
 * A credential that no service read selects: it is only read through its own
 * surface, which has its own masking. Listed so a new column on the same
 * surface still has to be looked at; not audited beyond the pointer given.
 */
export const SECRET_OWN_SURFACE: Record<string, string> = {
	"account.resetPasswordToken":
		"better-auth account row; no router or service selects it",
	"account.confirmationToken":
		"better-auth account row; no router or service selects it",
	"apikey.key":
		"better-auth API key row (hashed); the key is shown once at creation",
	"scim_managed_credential.tokenDigest":
		"digest of a SCIM token, never the token; no router selects it",
	"telemetryProvider.apiSecret":
		"stripped by CREDENTIAL_COLUMNS in services/logs-and-metrics/service.ts",
	"pushover.userKey": "masked by maskSecrets in routers/notification.ts",
	"slack.webhookUrl": "masked by maskSecrets in routers/notification.ts",
	"discord.webhookUrl": "masked by maskSecrets in routers/notification.ts",
	"mattermost.webhookUrl": "masked by maskSecrets in routers/notification.ts",
	"lark.webhookUrl": "masked by maskSecrets in routers/notification.ts",
	"teams.webhookUrl": "masked by maskSecrets in routers/notification.ts",
};
