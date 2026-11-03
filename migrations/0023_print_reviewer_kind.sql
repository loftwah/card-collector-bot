-- Distinguish a human review decision from an explicitly delegated agent
-- decision. The print review gate still requires a real reviewer identity; this
-- column makes the kind of review visible instead of silently presenting a
-- machine decision as human approval.
ALTER TABLE fb_print_proposal_reviews ADD COLUMN reviewer_kind TEXT NOT NULL DEFAULT 'human'
  CHECK (reviewer_kind IN ('human','agent'));
ALTER TABLE fb_print_proposals ADD COLUMN reviewer_kind TEXT
  CHECK (reviewer_kind IN ('human','agent'));
