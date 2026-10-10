-- Review history and webhook delivery memory.
--
-- Nothing here holds pull request titles, descriptions, patches or file contents. File paths
-- appear inside findings; see docs/DESIGN-STORAGE.md.

CREATE TABLE repositories (
  -- GitHub's own repository ID, which survives renames and transfers.
  id              bigint      PRIMARY KEY,
  -- The GitHub App installation the repository was last seen through. Reads are scoped by it.
  installation_id bigint      NOT NULL,
  owner           text        NOT NULL,
  name            text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX repositories_installation_id_idx ON repositories (installation_id);

CREATE TABLE reviews (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id       bigint      NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  pull_request_number integer     NOT NULL CHECK (pull_request_number > 0),
  -- Unknown when a review failed before the pull request could be fetched.
  head_sha            text,
  base_sha            text,
  status              text        NOT NULL CHECK (status IN ('completed', 'skipped', 'failed')),
  skip_reason         text        CHECK (skip_reason IN ('closed', 'draft', 'stale')),
  comment_action      text        CHECK (comment_action IN ('created', 'updated', 'none')),
  finding_count       integer     NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  skipped_file_count  integer     NOT NULL DEFAULT 0 CHECK (skipped_file_count >= 0),
  omitted_patch_count integer     NOT NULL DEFAULT 0 CHECK (omitted_patch_count >= 0),
  -- The name and HTTP status of the error, never its message.
  error_name          text,
  error_status        integer,
  started_at          timestamptz NOT NULL,
  completed_at        timestamptz NOT NULL,

  CHECK (completed_at >= started_at),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK ((status = 'completed') = (comment_action IS NOT NULL)),
  CHECK (status = 'failed' OR error_name IS NULL)
);

CREATE INDEX reviews_pull_request_idx
  ON reviews (repository_id, pull_request_number, started_at DESC);

CREATE TABLE rule_executions (
  review_id     uuid    NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  rule_id       text    NOT NULL,
  rule_version  text    NOT NULL,
  status        text    NOT NULL CHECK (status IN ('completed', 'disabled', 'failed')),
  finding_count integer NOT NULL CHECK (finding_count >= 0),
  duration_ms   integer NOT NULL CHECK (duration_ms >= 0),

  PRIMARY KEY (review_id, rule_id)
);

CREATE TABLE findings (
  review_id  uuid    NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  -- Order of the finding within its review, as reported.
  position   integer NOT NULL CHECK (position >= 0),
  rule_id    text    NOT NULL,
  severity   text    NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  confidence real    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  message    text    NOT NULL,
  file_path  text,
  line       integer CHECK (line > 0),
  suggestion text,
  evidence   jsonb   NOT NULL,

  PRIMARY KEY (review_id, position),
  CHECK (line IS NULL OR file_path IS NOT NULL)
);

CREATE TABLE webhook_deliveries (
  delivery_id text        PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_deliveries_received_at_idx ON webhook_deliveries (received_at);
