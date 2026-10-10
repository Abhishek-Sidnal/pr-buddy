-- An installation's own AI provider and key, and a record of who changed it.
--
-- The key is stored encrypted under a master key that is not in this database. See
-- docs/DESIGN-AI-KEYS.md.

-- What each installation of a session is called and whether the person owns it. The IDs stay in
-- installation_ids, which every read filters by.
ALTER TABLE sessions ADD COLUMN installations jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE installation_ai_keys (
  installation_id bigint      PRIMARY KEY,
  provider        text        NOT NULL CHECK (provider IN ('anthropic', 'openai', 'bedrock')),
  model           text        NOT NULL,
  -- Only for Bedrock.
  region          text,
  -- AES-256-GCM: ciphertext with its authentication tag, and the nonce used for this save.
  key_ciphertext  bytea       NOT NULL,
  key_nonce       bytea       NOT NULL CHECK (octet_length(key_nonce) = 12),
  -- Which master key encrypted it, so that the master key can be rotated.
  key_id          text        NOT NULL,
  -- The last four characters of the key, so that an owner can recognise it.
  key_hint        text        NOT NULL CHECK (char_length(key_hint) <= 4),
  -- GitHub's ID of the person who saved it.
  updated_by      bigint      NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK ((provider = 'bedrock') = (region IS NOT NULL))
);

CREATE TABLE audit_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  installation_id bigint      NOT NULL,
  -- GitHub's ID of the person who acted.
  user_id         bigint      NOT NULL,
  action          text        NOT NULL CHECK (action IN ('ai-key-saved', 'ai-key-removed')),
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_installation_idx ON audit_events (installation_id, occurred_at DESC);
