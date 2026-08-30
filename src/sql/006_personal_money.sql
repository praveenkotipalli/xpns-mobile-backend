-- Your own money, before it ever reaches a shared wallet.
--
-- Everything up to now has been about a *pool*: cash several people hand over,
-- and what gets spent out of it. None of that answers the question this table
-- set exists for — what came in this month, and where did it go.
--
-- These rows belong to a user, not a space, because a salary or the pocket
-- money your parents send is yours wherever you spend it. The shared wallet is
-- one of the places it can go, and that transfer is an ordinary
-- wallet_transactions top-up against your own member row, so nothing here
-- duplicates the pool's bookkeeping.
--
--   in hand = income - (saved - taken back out of savings) - moved to a wallet
--
-- Money already inside a shared wallet is deliberately NOT counted again when
-- it gets spent: it left this ledger the moment it was transferred.

-- ------------------------------------------------------------------- income

CREATE TABLE IF NOT EXISTS income_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      VARCHAR(24) NOT NULL DEFAULT 'SALARY'
              CHECK (source IN ('SALARY', 'POCKET_MONEY', 'FREELANCE', 'BONUS',
                                'GIFT', 'INTEREST', 'REFUND', 'OTHER')),
  -- What this particular payment was, e.g. "August salary", "Dad - monthly".
  label       VARCHAR(160),
  amount      NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  received_on DATE NOT NULL DEFAULT CURRENT_DATE,
  note        VARCHAR(500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_income_user_date ON income_entries(user_id, received_on DESC);

-- ------------------------------------------------------------------ savings

-- "Savings, on what" - a named pot rather than one undifferentiated number, so
-- money set aside for a bike is never confused with an emergency fund.
CREATE TABLE IF NOT EXISTS savings_goals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(120) NOT NULL,
  icon          VARCHAR(32) NOT NULL DEFAULT 'wallet',
  color         VARCHAR(16) NOT NULL DEFAULT '#3ECF8E',
  -- Optional. A pot with no target is an open-ended one, not a broken one.
  target_amount NUMERIC(12, 2) CHECK (target_amount IS NULL OR target_amount > 0),
  is_archived   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_savings_goal_name ON savings_goals(user_id, lower(name));

-- Deposits and withdrawals, so a pot can be dipped into without losing the
-- record of what was put in.
CREATE TABLE IF NOT EXISTS savings_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id    UUID NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  direction  VARCHAR(8) NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  entry_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  note       VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_savings_entries_goal ON savings_entries(goal_id, entry_on DESC);
CREATE INDEX IF NOT EXISTS idx_savings_entries_user ON savings_entries(user_id, entry_on DESC);
