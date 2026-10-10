-- Reviews that were requested and have not finished. A webhook is acknowledged before its review
-- runs; these rows are what lets a restart in between pick the review up again.
--
-- Identifiers only: no title, commit or code. See docs/DESIGN-STORAGE.md, section 10.

CREATE TABLE pending_reviews (
  repository_id       bigint      NOT NULL,
  pull_request_number integer     NOT NULL CHECK (pull_request_number > 0),
  installation_id     bigint      NOT NULL,
  owner               text        NOT NULL,
  name                text        NOT NULL,
  -- The webhook action that asked for the review, kept for the log.
  action              text        NOT NULL,
  -- Raised by every new request for the same pull request. A review deletes the row only if the
  -- generation is still the one it started with.
  generation          integer     NOT NULL DEFAULT 1 CHECK (generation > 0),
  -- Reviews of this request that failed.
  attempts            integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  requested_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (repository_id, pull_request_number)
);

CREATE INDEX pending_reviews_installation_id_idx ON pending_reviews (installation_id);

-- Retention deletes reviews by age.
CREATE INDEX reviews_started_at_idx ON reviews (started_at);
