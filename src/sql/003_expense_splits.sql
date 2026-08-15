-- Split one bill across several people, and record who actually paid.
--
-- Until now an expense had exactly one consumer (expenses.member_id). A shared
-- bill like "badam milk 80 for two" had to be entered as two separate rows.
-- Now the consumers live in expense_shares and member_id is only kept so old
-- rows stay readable.

CREATE TABLE IF NOT EXISTS expense_shares (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id  UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT,
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  UNIQUE (expense_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_expense_shares_member ON expense_shares(member_id);
CREATE INDEX IF NOT EXISTS idx_expense_shares_expense ON expense_shares(expense_id);

-- Who fronted the cash.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES space_members(id) ON DELETE SET NULL;

-- TRUE  = paid out of the shared cash the account holder is keeping.
-- FALSE = that person used their own pocket money, so they get credited back.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS from_pot BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS split_mode VARCHAR(16) NOT NULL DEFAULT 'SINGLE';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_split_mode_check') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_split_mode_check
      CHECK (split_mode IN ('SINGLE', 'EQUAL', 'CUSTOM'));
  END IF;
END $$;

-- Every existing expense becomes a single full-amount share for its consumer,
-- so balances are identical before and after this migration.
INSERT INTO expense_shares (expense_id, member_id, amount)
SELECT e.id, e.member_id, e.amount
  FROM expenses e
 WHERE e.member_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Old rows were all paid from the pot by the account holder.
UPDATE expenses e
   SET paid_by = (SELECT m.id FROM space_members m
                   WHERE m.space_id = e.space_id AND m.role = 'OWNER' LIMIT 1)
 WHERE e.paid_by IS NULL;

-- Shares are authoritative from here on.
ALTER TABLE expenses ALTER COLUMN member_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_paid_by ON expenses(paid_by);
