import { query } from '../db.js';
import { money } from './ids.js';

/**
 * Per-member balance for a space.
 *
 *   balance = cash handed in - cash handed back - their share of the spending
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
 * A negative balance means that person has consumed more than they put in,
 * i.e. they owe the group.
 */
export async function memberBalances(spaceId) {
  const { rows } = await query(
    `SELECT m.id,
            m.name,
            m.color,
            m.role,
            m.user_id,
            m.is_active,
            COALESCE(w.credited, 0)  AS credited,
            COALESCE(w.withdrawn, 0) AS withdrawn,
            COALESCE(s.spent, 0)     AS spent,
            COALESCE(w.credited, 0) - COALESCE(w.withdrawn, 0) - COALESCE(s.spent, 0) AS balance,
            s.last_spent_on
       FROM space_members m
       LEFT JOIN (
            SELECT member_id,
                   SUM(amount) FILTER (WHERE type IN ('TOPUP', 'ADJUST')) AS credited,
                   SUM(amount) FILTER (WHERE type = 'WITHDRAW')           AS withdrawn
              FROM wallet_transactions
             WHERE space_id = $1
             GROUP BY member_id
       ) w ON w.member_id = m.id
       LEFT JOIN (
            -- Shares are authoritative, but fall back to the pre-split column
            -- for any row that has none, so an expense can never go uncounted.
            SELECT member_id, SUM(amount) AS spent, MAX(spent_on) AS last_spent_on
              FROM (
                SELECT es.member_id, es.amount, e.spent_on
                  FROM expense_shares es
                  JOIN expenses e ON e.id = es.expense_id
                 WHERE e.space_id = $1
                UNION ALL
                SELECT e.member_id, e.amount, e.spent_on
                  FROM expenses e
                 WHERE e.space_id = $1
                   AND e.member_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM expense_shares es WHERE es.expense_id = e.id)
              ) all_shares
             GROUP BY member_id
       ) s ON s.member_id = m.id
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
 * overspent hands cash to the account holder, not to each other. Members whose
 * own money still covers their spending do not appear at all.
 */
export function debtsFrom(members) {
  const holder = members.find((m) => m.role === 'OWNER');
  const transfers = [];

  /**
   * What everyone in the red has to hand back. This is measured straight off
   * the balances, never accumulated from the suggested payments below — those
   * can fall short when the wallet itself has gone negative, and a total that
   * quietly disagreed with the balances is how money goes missing.
   */
  const totalOwed = money(members.reduce((sum, m) => sum + Math.max(-m.balance, 0), 0));

  if (holder) {
    for (const m of members) {
      if (m.id === holder.id || m.balance >= -0.009) continue;
      transfers.push({
        fromMemberId: m.id,
        fromName: m.name,
        toMemberId: holder.id,
        toName: holder.name,
        amount: money(-m.balance),
      });
    }

    // The account holder can go into the red too, by spending money that
    // belongs to the people still in credit. Name them largest first.
    if (holder.balance < -0.009) {
      let remaining = money(-holder.balance);
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
