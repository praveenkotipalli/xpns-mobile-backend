import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { money } from '../lib/ids.js';
import { memberBalances } from '../lib/balances.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * Personal money — income, savings pots, and what is left in hand.
 *
 * Everything here belongs to a *user*, not a space: a salary, or the pocket
 * money your parents send, is yours wherever you end up spending it. A shared
 * wallet is one of the places it can go, and moving it there is an ordinary
 * wallet top-up against your own member row, so the pool's bookkeeping is
 * untouched and nothing is counted twice.
 *
 *   in hand = income - net savings - net moved into shared wallets
 *
 * Money already inside a shared wallet is deliberately not subtracted again
 * when it gets spent — it left this ledger at the moment of the transfer.
 */
const router = Router();
router.use(requireAuth);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const SOURCES = ['SALARY', 'POCKET_MONEY', 'FREELANCE', 'BONUS', 'GIFT', 'INTEREST', 'REFUND', 'OTHER'];

const periodSchema = z.object({
  month: z.coerce.number().int().min(1).max(12).default(new Date().getMonth() + 1),
  year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
  spaceId: z.string().uuid().optional(),
});

/**
 * Net personal cash that has gone into shared wallets, across every space.
 *
 * Top-ups and debt clearances are money leaving your hands; a withdrawal is the
 * pool handing it back. Only rows against member slots linked to this account
 * count, so cash you are merely holding for somebody else never appears.
 *
 * Takes $1 = user id, $2 = month, $3 = year.
 */
const WALLET_FLOW_SQL = `
  SELECT COALESCE(SUM(delta), 0) AS lifetime,
         COALESCE(SUM(delta) FILTER (WHERE EXTRACT(MONTH FROM on_date) = $2
                                       AND EXTRACT(YEAR  FROM on_date) = $3), 0) AS month
    FROM (
      SELECT w.txn_date AS on_date,
             CASE WHEN w.type = 'WITHDRAW' THEN -w.amount ELSE w.amount END AS delta
        FROM wallet_transactions w
        JOIN space_members m ON m.id = w.member_id
       WHERE m.user_id = $1
      UNION ALL
      SELECT d.settled_on, d.amount
        FROM debt_settlements d
        JOIN space_members m ON m.id = d.member_id
       WHERE m.user_id = $1 AND d.is_cash
    ) flow`;

/* ------------------------------------------------------------------ summary */

/** Everything the Money tab needs for one month, in a single round trip. */
router.get('/summary', asyncHandler(async (req, res) => {
  const f = parse(periodSchema, req.query);
  const args = [req.user.id, f.month, f.year];

  const { rows: [income] } = await query(
    `SELECT COALESCE(SUM(amount), 0) AS lifetime,
            COALESCE(SUM(amount) FILTER (WHERE EXTRACT(MONTH FROM received_on) = $2
                                           AND EXTRACT(YEAR  FROM received_on) = $3), 0) AS month,
            COUNT(*) FILTER (WHERE EXTRACT(MONTH FROM received_on) = $2
                               AND EXTRACT(YEAR  FROM received_on) = $3)::int AS month_count
       FROM income_entries WHERE user_id = $1`,
    args
  );

  const { rows: bySource } = await query(
    `SELECT source, SUM(amount) AS total, COUNT(*)::int AS count
       FROM income_entries
      WHERE user_id = $1
        AND EXTRACT(MONTH FROM received_on) = $2
        AND EXTRACT(YEAR  FROM received_on) = $3
      GROUP BY source
      ORDER BY total DESC`,
    args
  );

  // A goal's balance is deposits minus withdrawals, so dipping into a pot is
  // recorded rather than silently overwriting what was put in.
  const { rows: goals } = await query(
    `SELECT g.id, g.name, g.icon, g.color, g.target_amount, g.is_archived,
            COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'IN'), 0)
              - COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'OUT'), 0) AS saved,
            COALESCE(SUM(CASE WHEN e.direction = 'IN' THEN e.amount ELSE -e.amount END)
                     FILTER (WHERE EXTRACT(MONTH FROM e.entry_on) = $2
                               AND EXTRACT(YEAR  FROM e.entry_on) = $3), 0) AS month_saved,
            MAX(e.entry_on) AS last_entry_on
       FROM savings_goals g
       LEFT JOIN savings_entries e ON e.goal_id = g.id
      WHERE g.user_id = $1
      GROUP BY g.id
      ORDER BY g.is_archived, saved DESC, g.name`,
    args
  );

  const { rows: [wallet] } = await query(WALLET_FLOW_SQL, args);

  /**
   * The shared side, for context only. Resolved softly: somebody who has not
   * joined a space yet still gets a working Money tab rather than a 404.
   */
  const { rows: [space] } = await query(
    `SELECT s.id, s.name, m.id AS member_id
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      WHERE ($2::uuid IS NULL OR s.id = $2::uuid)
      ORDER BY s.created_at
      LIMIT 1`,
    [req.user.id, f.spaceId || null]
  );

  let shared = null;
  if (space) {
    const members = await memberBalances(space.id);
    const me = members.find((m) => m.id === space.member_id);
    const { rows: [spent] } = await query(
      `SELECT COALESCE(SUM(es.amount), 0) AS total
         FROM expense_shares es
         JOIN expenses e ON e.id = es.expense_id
        WHERE es.member_id = $1
          AND EXTRACT(MONTH FROM e.spent_on) = $2
          AND EXTRACT(YEAR  FROM e.spent_on) = $3`,
      [space.member_id, f.month, f.year]
    );
    shared = {
      spaceId: space.id,
      spaceName: space.name,
      walletBalance: me ? me.balance : 0,
      debt: me ? me.debt : 0,
      spentThisMonth: Number(spent.total),
    };
  }

  const savedLifetime = money(goals.reduce((sum, g) => sum + Number(g.saved), 0));
  const savedMonth = money(goals.reduce((sum, g) => sum + Number(g.month_saved), 0));

  // One merged stream so the tab can show what actually happened, in order,
  // rather than three lists the reader has to interleave in their head.
  const { rows: recent } = await query(
    `SELECT * FROM (
        SELECT 'INCOME' AS kind, i.id, i.amount AS amount, i.received_on AS on_date,
               COALESCE(i.label, i.source) AS title, i.source AS detail, i.created_at
          FROM income_entries i
         WHERE i.user_id = $1
        UNION ALL
        SELECT 'SAVING', e.id,
               CASE WHEN e.direction = 'IN' THEN -e.amount ELSE e.amount END,
               e.entry_on, g.name, e.direction, e.created_at
          FROM savings_entries e
          JOIN savings_goals g ON g.id = e.goal_id
         WHERE e.user_id = $1
        UNION ALL
        SELECT 'WALLET', w.id,
               CASE WHEN w.type = 'WITHDRAW' THEN w.amount ELSE -w.amount END,
               w.txn_date, s.name, w.type, w.created_at
          FROM wallet_transactions w
          JOIN space_members m ON m.id = w.member_id
          JOIN spaces s ON s.id = w.space_id
         WHERE m.user_id = $1
     ) t
     ORDER BY on_date DESC, created_at DESC
     LIMIT 12`,
    [req.user.id]
  );

  return ok(res, {
    month: f.month,
    year: f.year,
    monthName: MONTH_NAMES[f.month - 1],
    income: {
      month: Number(income.month),
      lifetime: Number(income.lifetime),
      monthCount: income.month_count,
      bySource: bySource.map((r) => ({ source: r.source, total: Number(r.total), count: r.count })),
    },
    savings: {
      month: savedMonth,
      lifetime: savedLifetime,
      goals: goals.map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        color: g.color,
        targetAmount: g.target_amount === null ? null : Number(g.target_amount),
        isArchived: g.is_archived,
        saved: money(Number(g.saved)),
        monthSaved: money(Number(g.month_saved)),
        lastEntryOn: g.last_entry_on,
      })),
    },
    toWallet: { month: money(Number(wallet.month)), lifetime: money(Number(wallet.lifetime)) },
    /** Personal cash not yet saved or handed to a shared wallet. */
    inHand: money(Number(income.lifetime) - savedLifetime - Number(wallet.lifetime)),
    monthLeft: money(Number(income.month) - savedMonth - Number(wallet.month)),
    shared,
    recent: recent.map((r) => ({
      kind: r.kind,
      id: r.id,
      /** Signed from your hand's point of view: income in, everything else out. */
      amount: Number(r.amount),
      onDate: r.on_date,
      title: r.title,
      detail: r.detail,
    })),
  });
}));

/* ------------------------------------------------------------------- income */

const incomeSchema = z.object({
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  source: z.enum(SOURCES).default('SALARY'),
  label: z.string().trim().max(160).optional(),
  receivedOn: dateString.optional(),
  note: z.string().trim().max(500).optional(),
});

const mapIncome = (r) => ({
  id: r.id,
  source: r.source,
  label: r.label,
  amount: Number(r.amount),
  receivedOn: r.received_on,
  note: r.note,
});

router.post('/income', asyncHandler(async (req, res) => {
  const body = parse(incomeSchema, req.body);
  const { rows: [row] } = await query(
    `INSERT INTO income_entries (user_id, source, label, amount, received_on, note)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
     RETURNING *`,
    [req.user.id, body.source, body.label || null, body.amount, body.receivedOn || null, body.note || null]
  );
  return created(res, mapIncome(row), 'Income added');
}));

router.get('/income', asyncHandler(async (req, res) => {
  const f = parse(z.object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }), req.query);

  const { rows } = await query(
    `SELECT * FROM income_entries
      WHERE user_id = $1
        AND ($2::int IS NULL OR EXTRACT(MONTH FROM received_on) = $2::int)
        AND ($3::int IS NULL OR EXTRACT(YEAR  FROM received_on) = $3::int)
      ORDER BY received_on DESC, created_at DESC
      LIMIT $4`,
    [req.user.id, f.month ?? null, f.year ?? null, f.limit]
  );
  return ok(res, rows.map(mapIncome));
}));

router.delete('/income/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM income_entries WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
  );
  if (!rowCount) throw ApiError.notFound('That income entry is not there');
  return ok(res, null, 'Income removed');
}));

/* -------------------------------------------------------------------- goals */

const goalSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  icon: z.string().trim().max(32).optional(),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour').optional(),
  targetAmount: z.coerce.number().positive().max(99_999_999).optional(),
});

const mapGoal = (r) => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  color: r.color,
  targetAmount: r.target_amount === null ? null : Number(r.target_amount),
  isArchived: r.is_archived,
});

router.get('/goals', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*,
            COALESCE(SUM(CASE WHEN e.direction = 'IN' THEN e.amount ELSE -e.amount END), 0) AS saved
       FROM savings_goals g
       LEFT JOIN savings_entries e ON e.goal_id = g.id
      WHERE g.user_id = $1
      GROUP BY g.id
      ORDER BY g.is_archived, saved DESC, g.name`,
    [req.user.id]
  );
  return ok(res, rows.map((r) => ({ ...mapGoal(r), saved: money(Number(r.saved)), monthSaved: 0 })));
}));

router.post('/goals', asyncHandler(async (req, res) => {
  const body = parse(goalSchema, req.body);
  const { rows: [row] } = await query(
    `INSERT INTO savings_goals (user_id, name, icon, color, target_amount)
     VALUES ($1, $2, COALESCE($3, 'wallet'), COALESCE($4, '#3ECF8E'), $5)
     RETURNING *`,
    [req.user.id, body.name, body.icon || null, body.color || null, body.targetAmount ?? null]
  );
  return created(res, { ...mapGoal(row), saved: 0, monthSaved: 0 }, `${row.name} created`);
}));

router.patch('/goals/:id', asyncHandler(async (req, res) => {
  const body = parse(goalSchema.partial().extend({ isArchived: z.boolean().optional() }), req.body);
  const { rows: [row] } = await query(
    `UPDATE savings_goals
        SET name          = COALESCE($1, name),
            icon          = COALESCE($2, icon),
            color         = COALESCE($3, color),
            target_amount = COALESCE($4, target_amount),
            is_archived   = COALESCE($5, is_archived)
      WHERE id = $6 AND user_id = $7
      RETURNING *`,
    [body.name ?? null, body.icon ?? null, body.color ?? null, body.targetAmount ?? null,
      body.isArchived ?? null, req.params.id, req.user.id]
  );
  if (!row) throw ApiError.notFound('Goal not found');
  return ok(res, mapGoal(row), 'Goal updated');
}));

router.delete('/goals/:id', asyncHandler(async (req, res) => {
  const { rows: [{ count }] } = await query(
    'SELECT COUNT(*)::int AS count FROM savings_entries WHERE goal_id = $1', [req.params.id]
  );
  if (count > 0) {
    // Deleting would take the deposits with it and quietly change how much you
    // have ever saved. Archiving keeps the history and hides the pot.
    const { rowCount } = await query(
      'UPDATE savings_goals SET is_archived = TRUE WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) throw ApiError.notFound('Goal not found');
    return ok(res, { archived: true }, `Archived instead — it has ${count} entries`);
  }
  const { rowCount } = await query(
    'DELETE FROM savings_goals WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
  );
  if (!rowCount) throw ApiError.notFound('Goal not found');
  return ok(res, { deleted: true }, 'Goal removed');
}));

/* ------------------------------------------------------------------ savings */

const savingSchema = z.object({
  goalId: z.string().uuid('must be a goal id'),
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  direction: z.enum(['IN', 'OUT']).default('IN'),
  entryOn: dateString.optional(),
  note: z.string().trim().max(255).optional(),
});

router.post('/savings', asyncHandler(async (req, res) => {
  const body = parse(savingSchema, req.body);

  const { rows: [goal] } = await query(
    `SELECT g.name,
            COALESCE(SUM(CASE WHEN e.direction = 'IN' THEN e.amount ELSE -e.amount END), 0) AS saved
       FROM savings_goals g
       LEFT JOIN savings_entries e ON e.goal_id = g.id
      WHERE g.id = $1 AND g.user_id = $2
      GROUP BY g.id`,
    [body.goalId, req.user.id]
  );
  if (!goal) throw ApiError.notFound('That savings goal is not yours');

  // Taking out more than a pot holds would leave it negative, which is not a
  // thing a savings pot can be.
  if (body.direction === 'OUT' && body.amount - Number(goal.saved) > 0.009) {
    throw ApiError.badRequest(`${goal.name} only holds ${Number(goal.saved).toFixed(2)}`);
  }

  const { rows: [row] } = await query(
    `INSERT INTO savings_entries (user_id, goal_id, direction, amount, entry_on, note)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
     RETURNING *`,
    [req.user.id, body.goalId, body.direction, body.amount, body.entryOn || null, body.note || null]
  );

  const saved = money(Number(goal.saved) + (body.direction === 'IN' ? body.amount : -body.amount));
  return created(res, {
    entry: {
      id: row.id, goalId: row.goal_id, direction: row.direction,
      amount: Number(row.amount), entryOn: row.entry_on, note: row.note,
    },
    goalName: goal.name,
    saved,
  }, body.direction === 'IN' ? `Saved into ${goal.name}` : `Taken out of ${goal.name}`);
}));

router.get('/savings', asyncHandler(async (req, res) => {
  const f = parse(z.object({
    goalId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }), req.query);

  const { rows } = await query(
    `SELECT e.id, e.direction, e.amount, e.entry_on, e.note,
            g.id AS goal_id, g.name AS goal_name, g.color AS goal_color, g.icon AS goal_icon
       FROM savings_entries e
       JOIN savings_goals g ON g.id = e.goal_id
      WHERE e.user_id = $1
        AND ($2::uuid IS NULL OR e.goal_id = $2::uuid)
      ORDER BY e.entry_on DESC, e.created_at DESC
      LIMIT $3`,
    [req.user.id, f.goalId || null, f.limit]
  );

  return ok(res, rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    amount: Number(r.amount),
    entryOn: r.entry_on,
    note: r.note,
    goalId: r.goal_id,
    goalName: r.goal_name,
    goalColor: r.goal_color,
    goalIcon: r.goal_icon,
  })));
}));

router.delete('/savings/:id', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM savings_entries WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
  );
  if (!rowCount) throw ApiError.notFound('That entry is not there');
  return ok(res, null, 'Entry removed');
}));

/* ---------------------------------------------------------------- to wallet */

const toWalletSchema = z.object({
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  spaceId: z.string().uuid().optional(),
  note: z.string().trim().max(255).optional(),
  txnDate: dateString.optional(),
});

/**
 * Move personal money into a shared wallet.
 *
 * Deliberately the same `wallet_transactions` top-up the Add money screen
 * writes, against your own member slot — one ledger for the pool, whichever
 * screen the money came from. All this endpoint adds is finding that slot for
 * you, so you never have to pick yourself out of a list of people.
 */
router.post('/to-wallet', asyncHandler(async (req, res) => {
  const body = parse(toWalletSchema, req.body);

  const { rows: [slot] } = await query(
    `SELECT m.id AS member_id, s.id AS space_id, s.name AS space_name
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      WHERE ($2::uuid IS NULL OR s.id = $2::uuid)
      ORDER BY s.created_at
      LIMIT 1`,
    [req.user.id, body.spaceId || null]
  );
  if (!slot) throw ApiError.notFound('You are not a member of that space');

  const { rows: [row] } = await query(
    `INSERT INTO wallet_transactions (space_id, member_id, type, amount, note, txn_date, created_by)
     VALUES ($1, $2, 'TOPUP', $3, $4, COALESCE($5::date, CURRENT_DATE), $6)
     RETURNING *`,
    [slot.space_id, slot.member_id, body.amount,
      body.note || 'From my own money', body.txnDate || null, req.user.id]
  );

  const members = await memberBalances(slot.space_id);
  const me = members.find((m) => m.id === slot.member_id);

  const { rows: [totals] } = await query(
    `SELECT (SELECT COALESCE(SUM(amount), 0) FROM income_entries WHERE user_id = $1) AS income,
            (SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END), 0)
               FROM savings_entries WHERE user_id = $1) AS saved`,
    [req.user.id]
  );
  // Month/year are irrelevant here — only the lifetime figure is read.
  const { rows: [flow] } = await query(WALLET_FLOW_SQL, [req.user.id, 1, 1900]);
  const inHand = money(Number(totals.income) - Number(totals.saved) - Number(flow.lifetime));

  return created(res, {
    transaction: {
      id: row.id, amount: Number(row.amount), note: row.note, txnDate: row.txn_date,
      spaceId: slot.space_id, spaceName: slot.space_name,
    },
    walletBalance: me ? me.balance : 0,
    inHand,
    // Not an error: you may well be holding cash this app has never been told
    // about. Say so and let the transfer stand.
    warning: inHand < -0.009
      ? `That is more than the income recorded here, so your money in hand now reads ${inHand.toFixed(2)}. Add the missing income to straighten it out.`
      : null,
  }, `Moved into ${slot.space_name}`);
}));

export default router;
