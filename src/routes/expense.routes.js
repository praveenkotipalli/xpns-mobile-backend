import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { debtsFrom, memberBalances } from '../lib/balances.js';
import { resolveShares } from '../lib/splits.js';
import { requireAuth, requireSpace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireSpace);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const expenseSchema = z.object({
  item: z.string().trim().min(1, 'is required').max(255),
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  categoryKey: z.string().trim().min(1, 'is required').max(64),
  spentOn: dateString.optional(),
  note: z.string().trim().max(500).optional(),

  /**
   * Who handed over the cash. Recorded for the receipt only — it never moves
   * anyone's balance, because the money left the shared wallet either way.
   */
  paidBy: z.string().uuid().optional(),

  splitMode: z.enum(['SINGLE', 'EQUAL', 'CUSTOM']).default('SINGLE'),
  /** SINGLE */
  memberId: z.string().uuid().optional(),
  /** EQUAL */
  memberIds: z.array(z.string().uuid()).optional(),
  /** CUSTOM */
  shares: z.array(z.object({
    memberId: z.string().uuid(),
    amount: z.coerce.number().min(0),
  })).optional(),

  spaceId: z.string().uuid().optional(),
});

async function assertCategory(spaceId, key) {
  const { rowCount } = await query(
    'SELECT 1 FROM categories WHERE key = $1 AND (space_id IS NULL OR space_id = $2)',
    [key, spaceId]
  );
  if (!rowCount) throw ApiError.badRequest(`Unknown category "${key}"`);
}

async function spaceMembers(spaceId) {
  const { rows } = await query(
    'SELECT id, name, role FROM space_members WHERE space_id = $1', [spaceId]
  );
  return rows;
}

/**
 * Log an expense. Each consumer's balance drops by their share; we allow that
 * to go negative and report who now owes whom so the UI can show it.
 */
router.post('/', asyncHandler(async (req, res) => {
  const body = parse(expenseSchema, req.body);
  await assertCategory(req.space.id, body.categoryKey);

  const members = await spaceMembers(req.space.id);
  const validIds = new Set(members.map((m) => m.id));

  const paidBy = body.paidBy || req.space.memberId;
  if (!validIds.has(paidBy)) throw ApiError.badRequest('The payer is not in this space');
  const payer = members.find((m) => m.id === paidBy);

  const shares = resolveShares({
    mode: body.splitMode,
    amount: body.amount,
    singleId: body.memberId,
    ids: body.memberIds,
    shares: body.shares?.map((s) => ({ id: s.memberId, amount: s.amount })),
  }, validIds);

  const expenseId = await withTransaction(async (client) => {
    const { rows: [expense] } = await client.query(
      `INSERT INTO expenses
         (space_id, member_id, item, category_key, amount, spent_on, note, created_by,
          paid_by, from_pot, split_mode)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, $9, TRUE, $10)
       RETURNING id`,
      [req.space.id,
       shares.length === 1 ? shares[0].id : null, // legacy single-consumer column
       body.item, body.categoryKey, body.amount, body.spentOn || null, body.note || null,
       req.user.id, paidBy, body.splitMode]
    );
    for (const share of shares) {
      await client.query(
        'INSERT INTO expense_shares (expense_id, member_id, amount) VALUES ($1, $2, $3)',
        [expense.id, share.id, share.amount]
      );
    }
    return expense.id;
  });

  const balances = await memberBalances(req.space.id);
  const byId = new Map(balances.map((m) => [m.id, m]));
  const overdrawn = shares
    .map((s) => byId.get(s.id))
    .filter((m) => m && m.balance < 0);

  return created(res, {
    id: expenseId,
    paidBy,
    paidByName: payer.name,
    splitMode: body.splitMode,
    shares: shares.map((s) => ({
      memberId: s.id,
      memberName: byId.get(s.id)?.name,
      amount: s.amount,
    })),
    members: balances,
    debts: debtsFrom(balances),
    warning: overdrawn.length
      ? overdrawn
          .map((m) => `${m.name} is now at ${m.balance.toFixed(2)} and owes that back.`)
          .join(' ')
      : null,
  }, 'Expense saved');
}));

/** List expenses with their payer and full split. */
router.get('/', asyncHandler(async (req, res) => {
  const f = parse(z.object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    memberId: z.string().uuid().optional(),
    categoryKey: z.string().max(64).optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
    search: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }), req.query);

  const { rows } = await query(
    `SELECT e.*,
            c.label AS category_label, c.main_category, c.icon,
            payer.name AS paid_by_name, payer.color AS paid_by_color
       FROM expenses e
       LEFT JOIN categories c ON c.key = e.category_key
                             AND (c.space_id IS NULL OR c.space_id = e.space_id)
       LEFT JOIN space_members payer ON payer.id = e.paid_by
      WHERE e.space_id = $1
        AND ($2::int  IS NULL OR EXTRACT(MONTH FROM e.spent_on) = $2::int)
        AND ($3::int  IS NULL OR EXTRACT(YEAR  FROM e.spent_on) = $3::int)
        AND ($4::uuid IS NULL OR EXISTS (
              SELECT 1 FROM expense_shares es
               WHERE es.expense_id = e.id AND es.member_id = $4::uuid))
        AND ($5::text IS NULL OR e.category_key = $5::text)
        AND ($6::date IS NULL OR e.spent_on >= $6::date)
        AND ($7::date IS NULL OR e.spent_on <= $7::date)
        AND ($8::text IS NULL OR e.item ILIKE '%' || $8::text || '%')
      ORDER BY e.spent_on DESC, e.created_at DESC
      LIMIT $9 OFFSET $10`,
    [req.space.id, f.month ?? null, f.year ?? null, f.memberId || null, f.categoryKey || null,
     f.startDate || null, f.endDate || null, f.search || null, f.limit, f.offset]
  );

  const shares = rows.length
    ? (await query(
        `SELECT es.expense_id, es.member_id, es.amount, m.name, m.color
           FROM expense_shares es
           JOIN space_members m ON m.id = es.member_id
          WHERE es.expense_id = ANY($1::uuid[])`,
        [rows.map((r) => r.id)]
      )).rows
    : [];

  const byExpense = new Map();
  for (const s of shares) {
    if (!byExpense.has(s.expense_id)) byExpense.set(s.expense_id, []);
    byExpense.get(s.expense_id).push({
      memberId: s.member_id, memberName: s.name, memberColor: s.color, amount: Number(s.amount),
    });
  }

  return ok(res, rows.map((r) => {
    const list = byExpense.get(r.id) || [];
    return {
      id: r.id,
      item: r.item,
      amount: Number(r.amount),
      categoryKey: r.category_key,
      categoryLabel: r.category_label || r.category_key,
      mainCategory: r.main_category,
      icon: r.icon,
      spentOn: r.spent_on,
      note: r.note,
      splitMode: r.split_mode,
      paidBy: r.paid_by,
      paidByName: r.paid_by_name,
      paidByColor: r.paid_by_color,
      shares: list,
      isSplit: list.length > 1,
      // Convenience for single-consumer rows, which is still the common case.
      memberId: list.length === 1 ? list[0].memberId : null,
      memberName: list.length === 1 ? list[0].memberName : `${list.length} people`,
      memberColor: list.length === 1 ? list[0].memberColor : r.paid_by_color,
    };
  }));
}));

router.get('/:expenseId', asyncHandler(async (req, res) => {
  const { rows: [e] } = await query(
    `SELECT e.*, payer.name AS paid_by_name
       FROM expenses e
       LEFT JOIN space_members payer ON payer.id = e.paid_by
      WHERE e.id = $1 AND e.space_id = $2`,
    [req.params.expenseId, req.space.id]
  );
  if (!e) throw ApiError.notFound('Expense not found');

  const { rows: shares } = await query(
    `SELECT es.member_id, es.amount, m.name, m.color
       FROM expense_shares es
       JOIN space_members m ON m.id = es.member_id
      WHERE es.expense_id = $1`,
    [e.id]
  );

  return ok(res, {
    id: e.id,
    item: e.item,
    amount: Number(e.amount),
    categoryKey: e.category_key,
    spentOn: e.spent_on,
    note: e.note,
    splitMode: e.split_mode,
    paidBy: e.paid_by,
    paidByName: e.paid_by_name,
    shares: shares.map((s) => ({
      memberId: s.member_id, memberName: s.name, memberColor: s.color, amount: Number(s.amount),
    })),
  });
}));

router.patch('/:expenseId', asyncHandler(async (req, res) => {
  const body = parse(expenseSchema.partial(), req.body);
  if (body.categoryKey) await assertCategory(req.space.id, body.categoryKey);

  const { rows: [existing] } = await query(
    'SELECT * FROM expenses WHERE id = $1 AND space_id = $2',
    [req.params.expenseId, req.space.id]
  );
  if (!existing) throw ApiError.notFound('Expense not found');

  const members = await spaceMembers(req.space.id);
  const validIds = new Set(members.map((m) => m.id));

  const paidBy = body.paidBy || existing.paid_by;
  if (paidBy && !validIds.has(paidBy)) throw ApiError.badRequest('The payer is not in this space');

  const amount = body.amount ?? Number(existing.amount);
  // Only recompute the split when the request actually describes one.
  const respreads = body.splitMode || body.memberId || body.memberIds || body.shares;
  const shares = respreads
    ? resolveShares({
        mode: body.splitMode || existing.split_mode,
        amount,
        singleId: body.memberId,
        ids: body.memberIds,
        shares: body.shares?.map((s) => ({ id: s.memberId, amount: s.amount })),
      }, validIds)
    : null;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE expenses
          SET item         = COALESCE($1, item),
              amount       = COALESCE($2, amount),
              category_key = COALESCE($3, category_key),
              spent_on     = COALESCE($4::date, spent_on),
              note         = COALESCE($5, note),
              paid_by      = $6,
              split_mode   = COALESCE($7, split_mode)
        WHERE id = $8`,
      [body.item ?? null, body.amount ?? null, body.categoryKey ?? null, body.spentOn ?? null,
       body.note ?? null, paidBy, body.splitMode ?? null, existing.id]
    );

    if (shares) {
      await client.query('DELETE FROM expense_shares WHERE expense_id = $1', [existing.id]);
      for (const share of shares) {
        await client.query(
          'INSERT INTO expense_shares (expense_id, member_id, amount) VALUES ($1, $2, $3)',
          [existing.id, share.id, share.amount]
        );
      }
      await client.query('UPDATE expenses SET member_id = $1 WHERE id = $2',
        [shares.length === 1 ? shares[0].id : null, existing.id]);
    } else if (body.amount !== undefined) {
      // Amount changed without a new split — keep a single share in step.
      const { rows: current } = await client.query(
        'SELECT member_id FROM expense_shares WHERE expense_id = $1', [existing.id]
      );
      if (current.length === 1) {
        await client.query('UPDATE expense_shares SET amount = $1 WHERE expense_id = $2',
          [body.amount, existing.id]);
      } else {
        throw ApiError.badRequest('This bill is split — send the new split along with the amount');
      }
    }
  });

  const balances = await memberBalances(req.space.id);
  return ok(res, { id: existing.id, members: balances, debts: debtsFrom(balances) }, 'Expense updated');
}));

router.delete('/:expenseId', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM expenses WHERE id = $1 AND space_id = $2', [req.params.expenseId, req.space.id]
  );
  if (!rowCount) throw ApiError.notFound('Expense not found');
  return ok(res, null, 'Expense deleted');
}));

export default router;
