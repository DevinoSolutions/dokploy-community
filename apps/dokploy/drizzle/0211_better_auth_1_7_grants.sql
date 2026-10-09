-- Carries live better-auth 1.6 grants into the 1.7 tables created by 0210, so
-- MCP clients authorized before the upgrade keep working without a new
-- browser authorization. Data only: the 1.6 tables are read, never changed,
-- and stay in place as the rollback copy.
--
-- Token format: 1.6 stored tokens in plaintext; the 1.7 provider (storeTokens:
-- "hashed") looks them up by base64url(SHA-256(token)) without padding. The
-- expression below produces exactly that (`hashOAuthToken` in
-- packages/server/src/services/mcp-oauth.ts). A SHA-256 digest is 44 base64
-- characters, so `encode` never wraps it.
--
-- Client secrets: 1.6 stored them in plaintext; 1.7 stores them encrypted
-- with the auth secret, which SQL cannot do. Migrated confidential clients get
-- the "dokploy-legacy-plain:" prefix that `oauthClientSecretStorage` in
-- packages/server/src/lib/auth.ts verifies as plaintext.
--
-- Idempotent: clients are copied per row (NOT EXISTS + ON CONFLICT), and the
-- token and consent copy runs only while the 1.7 token tables are still empty,
-- so a re-run can never bring back a token the provider has since rotated or
-- revoked. Only rows 1.6 would still accept are copied: an unexpired access
-- token, or an unexpired refresh token issued with offline_access, owned by a
-- user. Timestamps are compared in UTC, the zone the columns are written in.

-- 1. Client registrations.
INSERT INTO "oauth_client" (
	"id", "client_id", "client_secret", "disabled", "user_id", "created_at",
	"updated_at", "name", "icon", "redirect_uris", "token_endpoint_auth_method",
	"application_type", "grant_types", "response_types"
)
SELECT
	a."id",
	a."client_id",
	CASE
		WHEN a."type" = 'public' OR coalesce(a."client_secret", '') = '' THEN NULL
		ELSE 'dokploy-legacy-plain:' || a."client_secret"
	END,
	a."disabled",
	a."user_id",
	a."created_at",
	a."updated_at",
	a."name",
	a."icon",
	array_remove(string_to_array(a."redirect_urls", ','), ''),
	CASE WHEN a."type" = 'public' THEN 'none' ELSE 'client_secret_basic' END,
	-- RFC 8252 loopback redirects (Claude Code and other CLIs) are native
	-- clients; 1.7 refuses http loopback redirects for web clients.
	CASE
		WHEN a."redirect_urls" ~ '(^|,)http://(localhost|127\.0\.0\.1|\[::1\])([:/,]|$)'
			THEN 'native'
		ELSE 'web'
	END,
	ARRAY['authorization_code', 'refresh_token'],
	ARRAY['code']
FROM "oauth_application" a
WHERE NOT EXISTS (
	SELECT 1 FROM "oauth_client" c WHERE c."client_id" = a."client_id"
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 2. Tokens and consents, once.
DO $$
DECLARE
	now_utc timestamp := timezone('UTC', now());
BEGIN
	IF EXISTS (SELECT 1 FROM "oauth_refresh_token")
		OR EXISTS (SELECT 1 FROM "oauth_provider_access_token") THEN
		RETURN;
	END IF;

	-- Refresh tokens. Each 1.6 row carried one access/refresh pair; the row id
	-- is kept so the access token below can point at its refresh token.
	INSERT INTO "oauth_refresh_token" (
		"id", "token", "client_id", "user_id", "expires_at", "created_at", "scopes"
	)
	SELECT
		t."id",
		rtrim(translate(encode(sha256(convert_to(t."refresh_token", 'UTF8')), 'base64'), '+/', '-_'), '='),
		t."client_id",
		t."user_id",
		t."refresh_token_expires_at",
		t."created_at",
		array_remove(string_to_array(t."scopes", ' '), '')
	FROM "oauth_access_token" t
	JOIN "oauth_client" c ON c."client_id" = t."client_id"
	WHERE t."user_id" IS NOT NULL
		AND coalesce(t."refresh_token", '') <> ''
		AND t."refresh_token_expires_at" > now_utc
		AND 'offline_access' = ANY (string_to_array(t."scopes", ' '))
	ON CONFLICT DO NOTHING;

	-- Access tokens.
	INSERT INTO "oauth_provider_access_token" (
		"id", "token", "client_id", "user_id", "refresh_id", "expires_at",
		"created_at", "scopes"
	)
	SELECT
		t."id",
		rtrim(translate(encode(sha256(convert_to(t."access_token", 'UTF8')), 'base64'), '+/', '-_'), '='),
		t."client_id",
		t."user_id",
		r."id",
		t."access_token_expires_at",
		t."created_at",
		array_remove(string_to_array(t."scopes", ' '), '')
	FROM "oauth_access_token" t
	JOIN "oauth_client" c ON c."client_id" = t."client_id"
	LEFT JOIN "oauth_refresh_token" r ON r."id" = t."id"
	WHERE t."user_id" IS NOT NULL
		AND t."access_token_expires_at" > now_utc
	ON CONFLICT DO NOTHING;

	-- Consents recorded by the fork's consent page ("authorized at" in
	-- Settings). The page records a fresh one on every approval.
	INSERT INTO "oauth_provider_consent" (
		"id", "client_id", "user_id", "scopes", "created_at", "updated_at"
	)
	SELECT
		k."id",
		k."client_id",
		k."user_id",
		array_remove(string_to_array(k."scopes", ' '), ''),
		k."created_at",
		k."updated_at"
	FROM "oauth_consent" k
	JOIN "oauth_client" c ON c."client_id" = k."client_id"
	ON CONFLICT DO NOTHING;
END $$;
--> statement-breakpoint
-- 3. SAML providers configured without IdP metadata XML. 1.6 identified the
-- IdP by the provider's issuer when idpMetadata.entityID was absent; 1.7
-- refuses such a provider at sign-in. Record the same value explicitly. Rows
-- with metadata XML, an explicit entityID, or unparsable JSON are left alone.
DO $$
DECLARE
	r record;
	cfg jsonb;
BEGIN
	FOR r IN
		SELECT "id", "issuer", "saml_config" FROM "sso_provider"
		WHERE coalesce("saml_config", '') <> ''
	LOOP
		BEGIN
			cfg := r."saml_config"::jsonb;
		EXCEPTION
			WHEN others THEN CONTINUE;
		END;
		IF jsonb_typeof(cfg) = 'object'
			AND coalesce(cfg #>> '{idpMetadata,metadata}', '') = ''
			AND coalesce(cfg #>> '{idpMetadata,entityID}', '') = '' THEN
			UPDATE "sso_provider"
			SET "saml_config" = jsonb_set(
				cfg,
				'{idpMetadata}',
				CASE
					WHEN jsonb_typeof(cfg -> 'idpMetadata') = 'object' THEN cfg -> 'idpMetadata'
					ELSE '{}'::jsonb
				END || jsonb_build_object(
					'entityID',
					coalesce(nullif(cfg ->> 'issuer', ''), r."issuer")
				)
			)::text
			WHERE "id" = r."id";
		END IF;
	END LOOP;
END $$;
