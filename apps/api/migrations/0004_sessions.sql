-- Dashboard sessions.
--
-- The cookie a browser holds is never stored: only its SHA-256, so a copy of this table is not a
-- set of working sessions. No GitHub token is kept. See docs/DESIGN-DASHBOARD.md.

CREATE TABLE sessions (
  -- Hex SHA-256 of the session token.
  token_hash       text        PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- GitHub's numeric ID and login of the person who signed in.
  user_id          bigint      NOT NULL,
  login            text        NOT NULL,
  -- The installations GitHub said this person could access when they signed in.
  installation_ids bigint[]    NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,

  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- The dashboard pages reviews of one repository by time.
CREATE INDEX reviews_repository_started_at_idx ON reviews (repository_id, started_at DESC, id DESC);
