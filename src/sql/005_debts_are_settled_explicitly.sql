-- A debt is now something you clear on purpose, not something a top-up absorbs.
--
-- Until now a debt was simply "balance < 0". So the moment somebody handed over
-- cash for anything at all — next week's groceries, a trip they were saving for
-- — their old debt silently vanished into that top-up. Two different events had
-- been collapsed into one number, and the record of who had actually paid back
-- what, and when, did not exist anywhere.
--
-- They are separated from here on:
--
--   incurred    the most a person's spending has ever run ahead of what they
--               had put in, walked over their ledger in date order
--   settled     what they have explicitly paid back or had written off
--   owed        incurred - settled
--
-- A top-up still moves the balance, but it cannot touch `incurred`, so it can
-- no longer wipe a debt. Only a row in this table does that.

CREATE TABLE IF NOT EXISTS debt_settlements (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id   UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  member_id  UUID NOT NULL REFERENCES space_members(id) ON DELETE CASCADE,
  amount     NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  -- TRUE  = they handed the cash over, so it lands in the wallet too.
  -- FALSE = the debt was cleared without any money moving. Only the opening
  --         balances written at the bottom of this file use it, which is why
  --         those rows are not deletable from the app.
  is_cash    BOOLEAN NOT NULL DEFAULT TRUE,
  note       VARCHAR(255),
  settled_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debt_settlements_space ON debt_settlements(space_id, settled_on DESC);
CREATE INDEX IF NOT EXISTS idx_debt_settlements_member ON debt_settlements(member_id);

-- ------------------------------------------------------------ opening balances
--
-- Everything a later top-up had already absorbed has to stay absorbed. Without
-- this, switching the rule on would resurrect every debt anyone had ever been
-- in — including the ones they squared up months ago — as if it were new.
--
-- For each member that gap is: the most they have ever been short by, minus
-- what they are short by right now under the old "balance < 0" rule. It is
-- written as a non-cash settlement so it clears the history without inventing
-- money that never arrived.

WITH shares AS (
  -- Split shares are authoritative; fall back to the pre-split consumer column
  -- for any expense that has none, so nothing is counted twice or missed.
  SELECT e.space_id, es.member_id, es.amount, e.spent_on, e.created_at
    FROM expense_shares es
    JOIN expenses e ON e.id = es.expense_id
  UNION ALL
  SELECT e.space_id, e.member_id, e.amount, e.spent_on, e.created_at
    FROM expenses e
   WHERE e.member_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM expense_shares es WHERE es.expense_id = e.id)
),
ledger AS (
  SELECT space_id, member_id, txn_date AS on_date, created_at,
         CASE WHEN type = 'WITHDRAW' THEN -amount ELSE amount END AS delta
    FROM wallet_transactions
  UNION ALL
  SELECT space_id, member_id, spent_on, created_at, -amount
    FROM shares
),
running AS (
  SELECT space_id, member_id, delta,
         -- Money in is settled before money out at the same instant; rows
         -- written in one transaction share a created_at, and without the
         -- tie-break the walk order would be arbitrary. Must match the window
         -- in lib/balances.js or the opening balances will not line up.
         SUM(delta) OVER (PARTITION BY space_id, member_id
                          ORDER BY on_date, created_at,
                                   CASE WHEN delta >= 0 THEN 0 ELSE 1 END
                          ROWS UNBOUNDED PRECEDING) AS net
    FROM ledger
),
stats AS (
  SELECT space_id,
         member_id,
         GREATEST(0, -MIN(net)) AS incurred,
         SUM(delta)             AS balance
    FROM running
   GROUP BY space_id, member_id
)
INSERT INTO debt_settlements (space_id, member_id, amount, is_cash, note, settled_on)
SELECT space_id,
       member_id,
       ROUND(incurred - GREATEST(0, -balance), 2),
       FALSE,
       'Carried forward — already covered before debts were tracked',
       CURRENT_DATE
  FROM stats
 WHERE incurred - GREATEST(0, -balance) > 0.004;
