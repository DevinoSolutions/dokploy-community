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
- `x-api-key` access to `/api/mcp` and the 429-on-throttle answer are unchanged.

**Existing grants keep working.** Migration 0211 copies every live client,
token and consent from the 1.6 tables (`oauth_application`,
`oauth_access_token`, `oauth_consent`) into the 1.7 tables (`oauth_client`,
`oauth_refresh_token`, `oauth_provider_access_token`,
`oauth_provider_consent`). Tokens are stored hashed, the way the 1.7 provider
expects. MCP clients do not have to authorize again.

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
advertised issuer.

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

## Rollback

Revert the upgrade PR and redeploy. The 1.6 tables are never changed by the
upgrade, so 1.6 finds the grants it issued. Grants made or refreshed after the
upgrade exist only in the 1.7 tables, so those MCP clients must authorize again
after a rollback. SCIM connections created on 1.7 do not exist on 1.6.
