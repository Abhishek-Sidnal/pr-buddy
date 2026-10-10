-- Findings that a repository's reporting thresholds hid from a review.

ALTER TABLE reviews
  ADD COLUMN suppressed_finding_count integer NOT NULL DEFAULT 0
  CHECK (suppressed_finding_count >= 0);
