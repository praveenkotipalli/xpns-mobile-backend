-- xpnz-mobile schema
-- Ported and extended from the Spring Boot "expensys" capstone project.
-- The old app had a single `expenses` table (date, item, category, spent, spent_by).
-- Here `spent_by` becomes a real member row so we can track per-person balances.

-- gen_random_uuid() is core Postgres since v13, so no pgcrypto extension needed.

-- ---------------------------------------------------------------- accounts

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A "space" is one shared pool of money (your household / you + your friend).
CREATE TABLE IF NOT EXISTS spaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(120) NOT NULL,
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code VARCHAR(12) NOT NULL UNIQUE,
  currency    VARCHAR(8) NOT NULL DEFAULT 'INR',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Members are the people whose money sits in the pool.
-- user_id is NULL for a member who has no app account yet (you just track their cash).
CREATE TABLE IF NOT EXISTS space_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  name       VARCHAR(120) NOT NULL,
  role       VARCHAR(16) NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'MEMBER')),
  color      VARCHAR(16) NOT NULL DEFAULT '#FFFFFF',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members(space_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_space_members_user
  ON space_members(space_id, user_id) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------- categories

CREATE TABLE IF NOT EXISTS categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id      UUID REFERENCES spaces(id) ON DELETE CASCADE, -- NULL = global default
  key           VARCHAR(64) NOT NULL,
  label         VARCHAR(120) NOT NULL,
  main_category VARCHAR(32) NOT NULL
                CHECK (main_category IN ('ESSENTIAL', 'EXPENSE', 'LOSE_OF_MONEY', 'OTHERS')),
  icon          VARCHAR(32) NOT NULL DEFAULT 'pricetag',
  sort_order    INT NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_global
  ON categories(key) WHERE space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_space
  ON categories(space_id, key) WHERE space_id IS NOT NULL;

-- ---------------------------------------------------------------- wallet

-- Money handed to you in cash / transferred in, per member.
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  member_id  UUID NOT NULL REFERENCES space_members(id) ON DELETE CASCADE,
  type       VARCHAR(16) NOT NULL CHECK (type IN ('TOPUP', 'WITHDRAW', 'ADJUST')),
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  note       VARCHAR(255),
  txn_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_txn_space_date ON wallet_transactions(space_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_member ON wallet_transactions(member_id);

-- ---------------------------------------------------------------- expenses

CREATE TABLE IF NOT EXISTS expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  member_id    UUID NOT NULL REFERENCES space_members(id) ON DELETE RESTRICT, -- the consumer
  item         VARCHAR(255) NOT NULL,
  category_key VARCHAR(64) NOT NULL,
  amount       NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  spent_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  note         VARCHAR(500),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_space_date ON expenses(space_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_member ON expenses(member_id);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(space_id, category_key);

-- ---------------------------------------------------------------- events

CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id    UUID REFERENCES spaces(id) ON DELETE SET NULL,
  name        VARCHAR(160) NOT NULL,
  type        VARCHAR(24) NOT NULL DEFAULT 'OTHER'
              CHECK (type IN ('TRIP', 'RESTAURANT', 'PARTY', 'OTHER')),
  description VARCHAR(500),
  start_date  DATE,
  end_date    DATE,
  invite_code VARCHAR(12) NOT NULL UNIQUE,
  status      VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SETTLED')),
  currency    VARCHAR(8) NOT NULL DEFAULT 'INR',
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A participant may be an app user (logs in from their own phone) or a plain
-- name placeholder added by the organiser.
CREATE TABLE IF NOT EXISTS event_participants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  display_name VARCHAR(120) NOT NULL,
  role         VARCHAR(16) NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('ORGANISER', 'MEMBER')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_participants_user
  ON event_participants(event_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  paid_by       UUID NOT NULL REFERENCES event_participants(id) ON DELETE RESTRICT,
  item          VARCHAR(255) NOT NULL,
  category_key  VARCHAR(64) NOT NULL DEFAULT 'OTHERS',
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  spent_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  split_mode    VARCHAR(16) NOT NULL DEFAULT 'CUSTOM' CHECK (split_mode IN ('EQUAL', 'CUSTOM')),
  note          VARCHAR(500),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_expenses_event ON event_expenses(event_id, spent_on DESC);

-- Custom split: one row per participant who consumed part of this expense.
-- The sum of shares must equal the expense amount (enforced in the service layer).
CREATE TABLE IF NOT EXISTS event_expense_shares (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_expense_id UUID NOT NULL REFERENCES event_expenses(id) ON DELETE CASCADE,
  participant_id   UUID NOT NULL REFERENCES event_participants(id) ON DELETE CASCADE,
  amount           NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  UNIQUE (event_expense_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_event_shares_participant ON event_expense_shares(participant_id);
