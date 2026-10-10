-- What an AI model was asked during a review, and what came of it.
--
-- The text of its suggestions is not stored: a model that has read the code may quote it, and
-- this database holds no source code. See docs/DESIGN-AI.md.

CREATE TABLE ai_reviews (
  review_id                uuid    PRIMARY KEY REFERENCES reviews (id) ON DELETE CASCADE,
  -- The service that received the pull request content, and the model that answered.
  provider                 text    NOT NULL,
  model                    text    NOT NULL,
  status                   text    NOT NULL CHECK (status IN ('completed', 'skipped', 'failed')),
  failure_reason           text    CHECK (
    failure_reason IN ('timeout', 'provider-error', 'invalid-response')
  ),
  -- The name of the provider's error, never its message.
  error_name               text,
  finding_count            integer NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  suppressed_finding_count integer NOT NULL DEFAULT 0 CHECK (suppressed_finding_count >= 0),
  rejected_finding_count   integer NOT NULL DEFAULT 0 CHECK (rejected_finding_count >= 0),
  sent_file_count          integer NOT NULL DEFAULT 0 CHECK (sent_file_count >= 0),
  omitted_file_count       integer NOT NULL DEFAULT 0 CHECK (omitted_file_count >= 0),
  -- Unknown when the provider does not report usage, or failed before answering.
  input_tokens             bigint  CHECK (input_tokens >= 0),
  output_tokens            bigint  CHECK (output_tokens >= 0),
  duration_ms              integer NOT NULL CHECK (duration_ms >= 0),

  CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
  CHECK (failure_reason = 'provider-error' OR error_name IS NULL)
);
