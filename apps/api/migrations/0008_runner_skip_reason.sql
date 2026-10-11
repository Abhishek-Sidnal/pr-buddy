-- A review can now be skipped because the repository reviews itself: its configuration selects
-- runner mode, where a GitHub Action in its own CI does the review. See docs/DESIGN-RUNNER.md.

ALTER TABLE reviews
  DROP CONSTRAINT reviews_skip_reason_check,
  ADD CONSTRAINT reviews_skip_reason_check
    CHECK (skip_reason IN ('closed', 'draft', 'stale', 'runner'));
