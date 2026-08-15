-- Fix: some expenses were credited back to whoever paid them.
--
-- Migration 003 added `from_pot`, and the API guessed its value from whether
-- the payer happened to be the space OWNER. In a space someone else created,
-- that guess made every bill you paid look like your own pocket money, so the
-- amount was refunded to your balance and the wallet total read too high.
--
-- There is only one rule now, and it holds for any number of people:
--
--     wallet = money put in - money taken out - everything spent
--
-- Someone paying with their own cash is recorded the honest way instead: a
-- top-up for the cash they handed over, then the expense. Two entries, and the
-- books still balance.

UPDATE expenses SET from_pot = TRUE WHERE from_pot = FALSE;

-- Kept only so old rows keep their column; nothing reads it any more.
COMMENT ON COLUMN expenses.from_pot IS
  'Unused. Every expense comes out of the shared wallet; see migration 004.';
