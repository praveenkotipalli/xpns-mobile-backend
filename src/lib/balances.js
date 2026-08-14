import { query } from '../db.js';

/**
 * Per-member balance for a space.
 *
 * balance = (money handed in) - (money handed back) - (what that person consumed)
 *
 * TOPUP and ADJUST credit the member, WITHDRAW debits them (cash returned).
 * A negative balance means that person has consumed more than they put in —
 * i.e. they owe the account holder that much.
 */
export async function memberBalances(spaceId) {
  const { rows } = await query(
    `SELECT m.id,
            m.name,
            m.color,
            m.role,
            m.user_id,
            m.is_active,
            COALESCE(w.credited, 0)   AS credited,
            COALESCE(w.withdrawn, 0)  AS withdrawn,
            COALESCE(e.spent, 0)      AS spent,
            COALESCE(w.credited, 0) - COALESCE(w.withdrawn, 0) - COALESCE(e.spent, 0) AS balance,
            e.last_spent_on
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
            SELECT member_id, SUM(amount) AS spent, MAX(spent_on) AS last_spent_on
              FROM expenses
             WHERE space_id = $1
             GROUP BY member_id
       ) e ON e.member_id = m.id
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
    balance: Number(r.balance),
    lastSpentOn: r.last_spent_on,
  }));
}

export function totalsFrom(members) {
  return members.reduce(
    (acc, m) => ({
      totalBalance: acc.totalBalance + m.balance,
      totalCredited: acc.totalCredited + m.creditedTotal,
      totalWithdrawn: acc.totalWithdrawn + m.withdrawnTotal,
      totalSpent: acc.totalSpent + m.spentTotal,
    }),
    { totalBalance: 0, totalCredited: 0, totalWithdrawn: 0, totalSpent: 0 }
  );
}
