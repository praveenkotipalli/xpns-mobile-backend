import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { memberBalances } from '../lib/balances.js';
import { requireAuth, requireSpace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireSpace);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const expenseSchema = z.object({
  item: z.string().trim().min(1, 'is required').max(255),
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  categoryKey: z.string().trim().min(1, 'is required').max(64),
  memberId: z.string().uuid('choose who this was spent on'),
  spentOn: dateString.optional(),
  note: z.string().trim().max(500).optional(),
  spaceId: z.string().uuid().optional(),
});

async function assertCategory(spaceId, key) {
  const { rowCount } = await query(
    'SELECT 1 FROM categories WHERE key = $1 AND (space_id IS NULL OR space_id = $2)',
    [key, spaceId]
  );
  if (!rowCount) throw ApiError.badRequest(`Unknown category "${key}"`);
}

/**
 * Log an expense against a consumer. The consumer's balance drops by the amount;
 * we allow it to go negative and return a warning so the UI can flag it.
 */
router.post('/', asyncHandler(async (req, res) => {
  const body = parse(expenseSchema, req.body);
  await assertCategory(req.space.id, body.categoryKey);

  const { rows: [member] } = await query(
    'SELECT id, name FROM space_members WHERE id = $1 AND space_id = $2',
    [body.memberId, req.space.id]
  );
  if (!member) throw ApiError.notFound('That member is not in this space');

  const { rows: [expense] } = await query(
    `INSERT INTO expenses (space_id, member_id, item, category_key, amount, spent_on, note, created_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8)
     RETURNING *`,
    [req.space.id, body.memberId, body.item, body.categoryKey, body.amount,
     body.spentOn || null, body.note || null, req.user.id]
  );

  const balances = await memberBalances(req.space.id);
  const updated = balances.find((m) => m.id === body.memberId);

  return created(res, {
    expense: serialise(expense, member),
    member: updated,
    warning: updated.balance < 0
      ? `${member.name}'s balance is now ${updated.balance.toFixed(2)} — they have spent more than they put in.`
      : null,
  }, 'Expense saved');
}));

function serialise(e, member) {
  return {
    id: e.id,
    item: e.item,
    amount: Number(e.amount),
    categoryKey: e.category_key,
    spentOn: e.spent_on,
    note: e.note,
    memberId: e.member_id,
    memberName: member?.name,
  };
}

/** List expenses with the filters the old Spring app exposed: month, year, member, category. */
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
    `SELECT e.*, m.name AS member_name, m.color AS member_color,
            c.label AS category_label, c.main_category, c.icon
       FROM expenses e
       JOIN space_members m ON m.id = e.member_id
       LEFT JOIN categories c ON c.key = e.category_key
                             AND (c.space_id IS NULL OR c.space_id = e.space_id)
      WHERE e.space_id = $1
        AND ($2::int  IS NULL OR EXTRACT(MONTH FROM e.spent_on) = $2::int)
        AND ($3::int  IS NULL OR EXTRACT(YEAR  FROM e.spent_on) = $3::int)
        AND ($4::uuid IS NULL OR e.member_id = $4::uuid)
        AND ($5::text IS NULL OR e.category_key = $5::text)
        AND ($6::date IS NULL OR e.spent_on >= $6::date)
        AND ($7::date IS NULL OR e.spent_on <= $7::date)
        AND ($8::text IS NULL OR e.item ILIKE '%' || $8::text || '%')
      ORDER BY e.spent_on DESC, e.created_at DESC
      LIMIT $9 OFFSET $10`,
    [req.space.id, f.month ?? null, f.year ?? null, f.memberId || null, f.categoryKey || null,
     f.startDate || null, f.endDate || null, f.search || null, f.limit, f.offset]
  );

  return ok(res, rows.map((r) => ({
    id: r.id,
    item: r.item,
    amount: Number(r.amount),
    categoryKey: r.category_key,
    categoryLabel: r.category_label || r.category_key,
    mainCategory: r.main_category,
    icon: r.icon,
    spentOn: r.spent_on,
    note: r.note,
    memberId: r.member_id,
    memberName: r.member_name,
    memberColor: r.member_color,
  })));
}));

router.get('/:expenseId', asyncHandler(async (req, res) => {
  const { rows: [e] } = await query(
    `SELECT e.*, m.name AS member_name FROM expenses e
       JOIN space_members m ON m.id = e.member_id
      WHERE e.id = $1 AND e.space_id = $2`,
    [req.params.expenseId, req.space.id]
  );
  if (!e) throw ApiError.notFound('Expense not found');
  return ok(res, serialise(e, { name: e.member_name }));
}));

router.patch('/:expenseId', asyncHandler(async (req, res) => {
  const body = parse(expenseSchema.partial(), req.body);
  if (body.categoryKey) await assertCategory(req.space.id, body.categoryKey);

  const { rows: [e] } = await query(
    `UPDATE expenses
        SET item         = COALESCE($1, item),
            amount       = COALESCE($2, amount),
            category_key = COALESCE($3, category_key),
            member_id    = COALESCE($4::uuid, member_id),
            spent_on     = COALESCE($5::date, spent_on),
            note         = COALESCE($6, note)
      WHERE id = $7 AND space_id = $8
      RETURNING *`,
    [body.item ?? null, body.amount ?? null, body.categoryKey ?? null, body.memberId ?? null,
     body.spentOn ?? null, body.note ?? null, req.params.expenseId, req.space.id]
  );
  if (!e) throw ApiError.notFound('Expense not found');

  const { rows: [member] } = await query('SELECT name FROM space_members WHERE id = $1', [e.member_id]);
  return ok(res, serialise(e, member), 'Expense updated');
}));

router.delete('/:expenseId', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM expenses WHERE id = $1 AND space_id = $2', [req.params.expenseId, req.space.id]
  );
  if (!rowCount) throw ApiError.notFound('Expense not found');
  return ok(res, null, 'Expense deleted');
}));

export default router;
