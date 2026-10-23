---
title: "Dokploy MCP Server with OAuth"
description: "Connect Claude Code or another MCP client to Dokploy Community Edition at /api/mcp with browser OAuth sign-in, per-grant scopes or an API key."
permalink: /mcp-server/
---

# Dokploy MCP server with OAuth sign-in

[Dokploy Community Edition](https://dokploy-community.devino.ca/) serves its own remote [MCP](https://modelcontextprotocol.io) server from the Dokploy panel itself, at `https://<your-dokploy-host>/api/mcp`. An MCP client talks to it over HTTPS (Streamable HTTP), so there is no local process to run and no API key to create. Upstream Dokploy v0.30.8 has no MCP endpoint and no MCP OAuth flow. The fork adds both.

This page covers the sign-in flow, the scopes you grant, the clients it works with, and the limits. For a short answer see the [FAQ](https://dokploy-community.devino.ca/faq/#how-do-i-connect-claude-code-to-dokploy-with-mcp).

## What the server exposes

The tool list is built from the Dokploy API routers, so a tool is named after its API procedure, for example `application-deploy`, `compose-deploy` or `deployment-queueList`. Each tool belongs to one scope. A connection only sees the tools its scopes allow, and the permissions of the user behind the connection still apply underneath.

## Connect Claude Code

Add the server with your own panel address, then sign in once in the browser.

```bash
claude mcp add --transport http --scope user dokploy https://<your-dokploy-host>/api/mcp
```

1. In Claude Code run `/mcp`, pick the `dokploy` server and choose Authenticate.
2. The browser opens the Dokploy consent page. Sign in to Dokploy if you are not already.
3. Choose the scopes to grant (see below) and approve.
4. The client stores its tokens and reconnects on its own.

The MCP Server card on the Settings, Profile page shows the endpoint and the exact add command for your instance, and lists every client you have authorized.

## How the OAuth flow works

The server publishes standard discovery documents, so a compatible client configures itself:

- OAuth 2.1 authorization code flow with PKCE (`S256` only).
- Dynamic client registration, so no client id has to be created by hand.
- Protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414), with the issuer taken from your configured Dokploy address rather than from the request host.
- Access tokens last 30 days and refresh tokens 365 days, sliding on every refresh. A rotated refresh token is still accepted for 5 minutes, so a dropped response does not strand the client. The environment variables `DOKPLOY_MCP_ACCESS_TOKEN_HOURS`, `DOKPLOY_MCP_REFRESH_TOKEN_DAYS` and `DOKPLOY_MCP_REFRESH_GRACE_SECONDS` change these.

## Scopes

The consent page shows one toggle per scope. Delete and Administration are off by default.

| Scope | On by default | What it allows |
| --- | --- | --- |
| `dokploy:read` | yes | List and inspect projects, services, deployments, logs and settings |
| `dokploy:deploy` | yes | Deploy, redeploy, start, stop, restart, rebuild, roll back, cancel builds, clean deployment history |
| `dokploy:services:write` | yes | Create and update applications, Compose stacks, databases, domains, ports, mounts, schedules, patches and tags |
| `dokploy:services:delete` | no | Delete services and their resources |
| `dokploy:projects:write` | yes | Create, update and duplicate projects and environments |
| `dokploy:projects:delete` | no | Delete projects and environments |
| `dokploy:backups` | yes | Backups, backup policies, volume backups and destinations |
| `dokploy:admin` | no | Servers, registries, git providers, notifications, certificates, users, organization settings, and reading stored credentials |

## Revoke a client

Open Settings, Profile, find the MCP Server card and revoke the client. Its tokens stop working.

## Use an API key instead

A client that cannot do the browser sign-in, or an unattended agent, can send a Dokploy API key in the `x-api-key` header. The key acts as the member who created it and is subject to the per-key rate limit. **An API-key connection is not scoped:** it gets all eight scopes, including Administration and both delete scopes, and only the member's own role limits what it can do. Use a key from a member with a restricted role, or prefer OAuth when you want to grant less.

```bash
claude mcp add --transport http --scope user dokploy https://<your-dokploy-host>/api/mcp --header "x-api-key: <key>"
```

## Which clients work

Any MCP client that supports the Streamable HTTP transport and either OAuth with dynamic client registration or a custom header. Claude Code is the client this guide was written and verified against. Dynamic client registration only accepts redirect URIs that are `https` or `http` on a loopback address (`localhost`, `127.0.0.1` or `[::1]`), so any other client must use such a redirect URI. Clients that only run local stdio servers need a bridge.

## Limits

- The server needs a public address. Set a domain under Settings, Server, or set `BETTER_AUTH_URL`. Without one the Profile card says the server is unconfigured.
- `DOKPLOY_MCP_DISABLED=true` removes the endpoint entirely.
- An OAuth tool call is only as powerful as the scopes you granted and the user's own role. Grant the least you need, and keep Administration off for routine agents. This does not apply to API keys, which always get every scope.
- Secret values are not returned by default. Through MCP, `application-one`, `compose-one` and the database `*-one` tools blank the environment, build args and secrets, passwords, webhook tokens and similar fields (the reply carries `secretsRedacted: true`). To get them back a call must pass `includeEnv: true` and the grant must include `dokploy:admin`; without that scope the flag is ignored. This is enforced on the server, not only in the tool schema. Use `application-envKeys` or `compose-envKeys` when you only need variable names: they return the keys, never the values, under the read scope.
- Redaction covers stored secret fields, not free-form configuration. A literal secret pasted into a Compose file, a command or a file mount still reads back under the read scope. Other tools that return a project or environment record, such as `environment-one`, can still include environment values.

## Related guides

- [Deploy queue controls](https://dokploy-community.devino.ca/deploy-queue/): deploy with priority and remove waiting jobs, also available as MCP tools.
- [Enforced remote builds](https://dokploy-community.devino.ca/build-policy/)
- [FAQ](https://dokploy-community.devino.ca/faq/) and the [home page](https://dokploy-community.devino.ca/)
- Source: [MCP server code](https://github.com/DevinoSolutions/dokploy-community/tree/canary/apps/dokploy/server/mcp) and the [README section](https://github.com/DevinoSolutions/dokploy-community#remote-mcp-server-with-oauth-fork-original)
