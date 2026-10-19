# better-auth 1.7 upgrade notes

The fork moved from better-auth 1.6.33 to 1.7.7 (all `@better-auth/*`
packages, `@better-fetch/fetch` 1.3.2, `zod` ^4.5.4). This page lists what
changes for an instance that upgrades, and what stays the same.

## Remote MCP server (OAuth)

The 1.6 in-core `mcp` plugin is gone. The OAuth server behind `/api/mcp` is now
`@better-auth/oauth-provider`, with the same behaviour Dokploy had before:

- the same eight `dokploy:*` scopes plus `openid` and `offline_access`;
- the fork's consent page (`/mcp/authorize`) stays the only way to approve a
  client, and dynamic client registration keeps the same redirect gate
  (http loopback or https only);
- the same lifetimes and knobs: `DOKPLOY_MCP_ACCESS_TOKEN_HOURS`,
  `DOKPLOY_MCP_REFRESH_TOKEN_DAYS`, `DOKPLOY_MCP_REFRESH_GRACE_SECONDS`;
- a refresh token presented again after its grace window is refused on its own
  (`invalid_grant`), and the grant the other sessions share stays valid;
- sessions that refresh the same token at the same moment all receive the same
  new tokens. Refresh requests are serialized per token (in process, plus a
  Postgres advisory lock so several replicas serialize too), and the requests
  that wait receive the first one's response from the replay record;
- token revocation and introspection (`/api/auth/oauth2/revoke`,
  `/api/auth/oauth2/introspect`) stay closed, as in 1.6. The provider's revoke
  deletes every token of the grant when it sees an already-rotated refresh
  token, which would log out every session sharing it. Revoke a client from
  the MCP Server card in Settings → Profile instead;
- `x-api-key` access to `/api/mcp` and the 429-on-throttle answer are unchanged.

**Existing grants keep working.** Migration 0211 copied every live client,
token and consent from the 1.6 tables (`oauth_application`,
`oauth_access_token`, `oauth_consent`) into the 1.7 tables (`oauth_client`,
`oauth_refresh_token`, `oauth_provider_access_token`,
`oauth_provider_consent`). Tokens are stored hashed, the way the 1.7 provider
expects. MCP clients do not have to authorize again. Migration 0220 later
dropped the 1.6 tables (see Rollback).

The 1.6 endpoint URLs stay as aliases, so clients that cached them keep
working:

| 1.6 URL | 1.7 URL |
| --- | --- |
| `/api/auth/mcp/token` | `/api/auth/oauth2/token` |
| `/api/auth/mcp/register` | `/api/auth/oauth2/register` |
| `/api/auth/mcp/authorize` | `/api/auth/oauth2/authorize` |

The discovery documents (`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`) now advertise the 1.7 URLs.
Authorization responses carry an RFC 9207 `iss` parameter equal to the
advertised issuer. The authorize endpoint accepts GET only.

MCP clients send the MCP endpoint URL as the RFC 8707 `resource` on every
authorize and token request. The advertised value (`resource` in the
protected-resource document: the `BETTER_AUTH_URL` origin, else
`https://<configured host>`, plus `/api/mcp`) is accepted, and so are the
variants clients send for it: a trailing slash, `http`, or another host name
this instance is reached under (the request's `Host`/`X-Forwarded-Host`, or the
configured web server host). Any other value is refused with
`invalid_target`.

A confidential client (one registered with a client secret) migrated from 1.6
must authenticate at the token endpoint with `client_secret_basic`, the
default 1.6 advertised. Claude Code and other CLI clients are public clients
and are not affected.

## SSO

- **SAML ACS URL.** New SAML providers receive responses at
  `/api/auth/sso/saml2/sp/acs/<providerId>`. The 1.6 URL
  `/api/auth/sso/saml2/callback/<providerId>` stays an alias, and providers
  registered before the upgrade keep it, so no IdP needs reconfiguring. Settings
  shows the URL each provider is registered with.
- **IdP-initiated SAML stays off.** 1.7 accepts only responses to a login this
  instance started (SP-initiated). An IdP dashboard tile that posts a response
  unprompted is refused. Start the login from Dokploy instead.
- **No user id mapping.** 1.7 always identifies an OIDC user by the `sub`
  claim and a SAML user by the NameID. Both were the Dokploy defaults, so only a
  provider with a hand-edited id mapping is affected.
- SAML providers configured without IdP metadata XML were identified by their
  issuer. 1.7 needs that explicitly; migration 0211 records it, and the
  dialog sends it for new providers.

## SCIM

1.7 replaced SCIM provider tokens with managed connections. **SCIM tokens issued
before the upgrade stop working.** After upgrading:

1. Open Settings → SSO → Manage SCIM and create a new connection.
2. Paste the new endpoint token into the identity provider.
3. Let the identity provider push its directory again (Okta: "Push now";
   Entra ID: "Restart provisioning").

Provisioned users who already exist keep their account and their organization
role. A connection's token can be rotated (the old one keeps working until it
expires) or the connection removed.

The token digest key is derived from the auth secret. Set
`DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET` (32 characters or more) to use a separate
key; changing either one invalidates every SCIM token.

## Two-factor authentication

No change for users. Enabling 2FA still sets up an authenticator app.

## Rotating BETTER_AUTH_SECRET

More data depends on the auth secret than before. Run
`apps/dokploy/scripts/migrate-auth-secret.ts` with `OLD_SECRET` and
`NEW_SECRET` before restarting with the new secret. It:

- re-encrypts 2FA secrets and backup codes (as before);
- re-encrypts the client secrets of confidential MCP OAuth clients, which 1.7
  stores encrypted with the auth secret (clients migrated from 1.6 keep their
  plaintext-marked value, which does not depend on the secret);
- clears the stored refresh-token replay responses, which are encrypted with
  the auth secret and only serve a retry within the refresh grace window.

It cannot carry over **SCIM tokens**: they are stored as digests keyed with
`DOKPLOY_SCIM_CREDENTIAL_HASH_SECRET`, or with a key derived from the auth
secret when that variable is unset, and a digest cannot be re-keyed. Without
the variable, rotate every SCIM connection's token in Settings after the
restart and paste it into the identity provider.

MCP access and refresh tokens are stored as plain SHA-256 digests and survive
a rotation.

## Rollback

Rolling back to better-auth 1.6 is no longer possible. Migration 0220 drops
the 1.6 tables (`oauth_consent`, `oauth_access_token` and
`oauth_application`), which held every grant in plaintext, so there is nothing
left for 1.6 to find. After 0220 has run, do not redeploy an older release.
Releases before community.13 (better-auth 1.6) cannot run at all without the
1.6 tables. Releases community.13 through the one before 0220 still read and
delete 1.6 rows in the daily token purge and when a client is revoked, so on
those the purge fails and revoking a client in Settings errors until 0220's
release is back.

Until 0220 shipped, the 1.6 tables were kept as the rollback copy: the upgrade
never changed a live 1.6 row, 1.7 only deleted expired 1.6 token rows (the
daily purge) and the rows of a client a user revoked in Settings, and grants
made or refreshed after the upgrade existed only in the 1.7 tables. SCIM
connections created on 1.7 do not exist on 1.6.

## Follow-up after a soak

Done. A forced refresh test passed on production after the upgrade and the
fork moved on, so migration 0220 dropped `oauth_consent`,
`oauth_access_token` and `oauth_application` (the plaintext 1.6 tokens go with
them) and the `legacy*` schema exports and their purge/revoke code were
removed. The 1.7 tables are unchanged.
