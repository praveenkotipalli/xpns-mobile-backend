import { query } from '../db.js';
import { money } from './ids.js';

/**
 * Per-member balance and debt for a space.
 *
 * Two numbers that used to be one. **Balance** is how much of that person's
 * money is sitting in the pot:
 *
 *   balance = cash handed in + debts they paid back - cash handed back - their share of the spending
 *
 * Nobody is ever credited for paying a bill: the money came out of the shared
 * wallet, so it is already accounted for. That keeps one invariant true for any
 * number of people —
 *
 *   sum of balances = total put in - total taken out - total spent = the wallet
 *
 * If someone genuinely pays with their own cash, record it as a top-up for what
 * they handed over plus the expense; the books then balance on their own.
 *
 * **Debt** is deliberately not "balance < 0" any more. It is the most their
 * spending has ever run ahead of what they had put in — walked over the ledger
 * in date order, so it is fixed at the moment it happens — minus whatever they
 * have since settled:
 *
 *   owed = incurred - settled
 *
 * That is what stops a top-up from quietly cancelling a debt. Handing over cash
 * for next week's shopping raises the balance and leaves `incurred` untouched,
 * so the debt stays on the books until someone clears it on purpose and the
 * clearance is recorded with a date and a note. See migration 005.
 */
export async function memberBalances(spaceId) {
  const { rows } = await query(
    `WITH shares AS (
          -- Shares are authoritative, but fall back to the pre-split column
          -- for any row that has none, so an expense can never go uncounted.
          SELECT es.member_id, es.amount, e.spent_on, e.created_at
            FROM expense_shares es
            JOIN expenses e ON e.id = es.expense_id
           WHERE e.space_id = $1
          UNION ALL
          SELECT e.member_id, e.amount, e.spent_on, e.created_at
            FROM expenses e
           WHERE e.space_id = $1
             AND e.member_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM expense_shares es WHERE es.expense_id = e.id)
     ),
     -- Every money movement that can put someone in the red, in date order.
     -- Settlements are deliberately absent: they repay a debt, so counting them
     -- here would let a repayment retroactively shrink the debt it repaid.
     ledger AS (
          SELECT member_id, txn_date AS on_date, created_at,
                 CASE WHEN type = 'WITHDRAW' THEN -amount ELSE amount END AS delta
            FROM wallet_transactions
           WHERE space_id = $1
          UNION ALL
          SELECT member_id, spent_on, created_at, -amount FROM shares
     ),
     running AS (
          SELECT member_id,
                 -- Money in is settled before money out at the same instant.
                 -- Rows written in one transaction share a created_at, so
                 -- without that tie-break the walk order would be arbitrary and
                 -- a top-up could land after the expense it paid for, inventing
                 -- a debt that never existed.
                 SUM(delta) OVER (PARTITION BY member_id
                                  ORDER BY on_date, created_at,
                                           CASE WHEN delta >= 0 THEN 0 ELSE 1 END
                                  ROWS UNBOUNDED PRECEDING) AS net
            FROM ledger
     ),
     -- The deepest that running total has ever gone below zero.
     shortfall AS (
          SELECT member_id, GREATEST(0, -MIN(net)) AS incurred
            FROM running GROUP BY member_id
     ),
     wallet AS (
          SELECT member_id,
                 COALESCE(SUM(amount) FILTER (WHERE type IN ('TOPUP', 'ADJUST')), 0) AS credited,
                 COALESCE(SUM(amount) FILTER (WHERE type = 'WITHDRAW'), 0)           AS withdrawn
            FROM wallet_transactions
           WHERE space_id = $1
           GROUP BY member_id
     ),
     spend AS (
          SELECT member_id, SUM(amount) AS spent, MAX(spent_on) AS last_spent_on
            FROM shares GROUP BY member_id
     ),
     settled AS (
          SELECT member_id,
                 SUM(amount)                                    AS total,
                 COALESCE(SUM(amount) FILTER (WHERE is_cash), 0) AS cash
            FROM debt_settlements
           WHERE space_id = $1
           GROUP BY member_id
     )
     SELECT m.id,
            m.name,
            m.color,
            m.role,
            m.user_id,
            m.is_active,
            COALESCE(w.credited, 0) + COALESCE(st.cash, 0) AS credited,
            COALESCE(w.withdrawn, 0)                       AS withdrawn,
            COALESCE(sp.spent, 0)                          AS spent,
            COALESCE(w.credited, 0) + COALESCE(st.cash, 0)
              - COALESCE(w.withdrawn, 0) - COALESCE(sp.spent, 0) AS balance,
            COALESCE(sf.incurred, 0)                       AS incurred,
            COALESCE(st.total, 0)                          AS settled,
            GREATEST(0, COALESCE(sf.incurred, 0) - COALESCE(st.total, 0)) AS owed,
            sp.last_spent_on
       FROM space_members m
       LEFT JOIN wallet    w  ON w.member_id  = m.id
       LEFT JOIN spend     sp ON sp.member_id = m.id
       LEFT JOIN shortfall sf ON sf.member_id = m.id
       LEFT JOIN settled   st ON st.member_id = m.id
      WHERE m.space_id = $1
      ORDER BY (m.role = 'OWNER') DESC, m.name`,
    [spaceId]
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    role: r.role,
    userId: r.user_id,
    isActive: r.is_active,
    hasAccount: Boolean(r.user_id),
    creditedTotal: Number(r.credited),
    withdrawnTotal: Number(r.withdrawn),
    spentTotal: Number(r.spent),
    balance: money(Number(r.balance)),
    /** Lifetime: the most they have ever been short by. Only ever grows. */
    incurredDebt: money(Number(r.incurred)),
    /** What they have paid back or had written off. */
    settledDebt: money(Number(r.settled)),
    /** What is still on the books — the number the app calls a debt. */
    debt: money(Number(r.owed)),
    lastSpentOn: r.last_spent_on,
  }));
}

export function totalsFrom(members) {
  return members.reduce(
    (acc, m) => ({
      totalBalance: money(acc.totalBalance + m.balance),
      totalCredited: money(acc.totalCredited + m.creditedTotal),
      totalWithdrawn: money(acc.totalWithdrawn + m.withdrawnTotal),
      totalSpent: money(acc.totalSpent + m.spentTotal),
    }),
    { totalBalance: 0, totalCredited: 0, totalWithdrawn: 0, totalSpent: 0 }
  );
}

/**
 * Who should pay whom to square everyone up.
 *
 * Unlike an event — where anyone can pay anyone — every rupee here physically
 * sits with the account holder. So debts are anchored on them: whoever has
 * overspent hands cash to the account holder, not to each other.
 *
 * Driven by `debt`, not by a negative balance, so somebody who has topped the
 * wallet up since overspending still shows what they owe. Clearing it is an
 * explicit act — `POST /api/spaces/debts/settle`.
 */
export function debtsFrom(members) {
  const holder = members.find((m) => m.role === 'OWNER');
  const transfers = [];

  /**
   * Everything still outstanding. Measured straight off the members, never
   * accumulated from the suggested payments below — those can fall short when
   * there is nobody left in credit to be repaid, and a total that quietly
   * disagreed with the members is how money goes missing.
   */
  const totalOwed = money(members.reduce((sum, m) => sum + m.debt, 0));

  if (holder) {
    for (const m of members) {
      if (m.id === holder.id || m.debt <= 0.009) continue;
      transfers.push({
        fromMemberId: m.id,
        fromName: m.name,
        toMemberId: holder.id,
        toName: holder.name,
        amount: m.debt,
      });
    }

    // The account holder can go into the red too, by spending money that
    // belongs to the people still in credit. Name them largest first.
    if (holder.debt > 0.009) {
      let remaining = holder.debt;
      const creditors = members
        .filter((m) => m.id !== holder.id && m.balance > 0.009)
        .sort((a, b) => b.balance - a.balance);

      for (const creditor of creditors) {
        if (remaining <= 0.009) break;
        const pay = money(Math.min(remaining, creditor.balance));
        transfers.push({
          fromMemberId: holder.id,
          fromName: holder.name,
          toMemberId: creditor.id,
          toName: creditor.name,
          amount: pay,
        });
        remaining = money(remaining - pay);
      }
    }
  }

  const allocated = money(transfers.reduce((sum, t) => sum + t.amount, 0));

  return {
    settlements: transfers,
    totalOwed,
    /**
     * Debt the suggestions above could not pair with anyone — only possible
     * when more has been spent than was ever put in, so there is nobody left
     * in credit to be repaid. Surfaced rather than dropped.
     */
    unallocated: money(totalOwed - allocated),
  };
}
