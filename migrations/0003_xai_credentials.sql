-- Per-user xAI (SuperGrok) OAuth credentials, brokered by the server.
--
-- Tokens are AES-256-GCM encrypted by the app (key: XAI_TOKEN_ENC_KEY) before
-- they reach this table; ciphertexts are bound to (user_id, column) via AAD so a
-- value copied to another row will not decrypt. Plain SQL only, so it applies on
-- both Neon (scripts/migrate.mjs) and the local PGLite fallback (src/lib/db.ts).

create table if not exists xai_credentials (
  user_id            text primary key references "user" ("id") on delete cascade,
  flow               text not null check (flow in ('auth_code', 'device')),
  client_id          text not null,              -- which xAI OAuth client minted it
  subject            text,                       -- id_token sub
  email              text,                       -- id_token email (display only)
  scope              text not null default '',
  access_token_enc   text,
  access_expires_at  timestamptz,
  refresh_token_enc  text,
  key_id             text not null,              -- encryption key id (rotation)
  status             text not null default 'active'
                     check (status in ('active', 'needs_reauth')),
  last_error         text,                       -- short error code, never a token
  version            bigint not null default 0,  -- bumped on every token write
  last_refreshed_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Short-lived OAuth handshakes (auth-code PKCE + device-code). Secrets are
-- stored hashed (state, nonce) or encrypted (code_verifier, device_code).
create table if not exists xai_oauth_pending (
  id                 text primary key,
  user_id            text not null references "user" ("id") on delete cascade,
  kind               text not null check (kind in ('auth_code', 'device')),
  state_hash         text unique,                -- sha256(state), auth_code only
  code_verifier_enc  text,
  nonce_hash         text,
  device_code_enc    text,
  user_code          text,
  verification_uri   text,
  poll_interval_s    integer,
  next_poll_at       timestamptz,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now()
);

create index if not exists xai_oauth_pending_user_idx on xai_oauth_pending (user_id);
create index if not exists xai_oauth_pending_expires_idx on xai_oauth_pending (expires_at);
