import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { memberBalances } from '../lib/balances.js';
import { today } from '../lib/dates.js';
import { requireAuth, requireSpace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireSpace);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const addMoneySchema = z.object({
  memberId: z.string().uuid('must be a member id'),
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  type: z.enum(['TOPUP', 'WITHDRAW', 'ADJUST']).default('TOPUP'),
  note: z.string().trim().max(255).optional(),
  txnDate: dateString.optional(),
  spaceId: z.string().uuid().optional(),
});

/** Add money to (or take money out of) a member's pot. */
router.post('/', asyncHandler(async (req, res) => {
  const body = parse(addMoneySchema, req.body);

  const { rowCount } = await query(
    'SELECT 1 FROM space_members WHERE id = $1 AND space_id = $2', [body.memberId, req.space.id]
  );
  if (!rowCount) throw ApiError.notFound('That member is not in this space');

  const { rows: [txn] } = await query(
    `INSERT INTO wallet_transactions (space_id, member_id, type, amount, note, txn_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7)
     RETURNING *`,
    [req.space.id, body.memberId, body.type, body.amount, body.note || null, body.txnDate || today(), req.user.id]
  );

  const members = await memberBalances(req.space.id);
  const member = members.find((m) => m.id === body.memberId);

  return created(res, {
    transaction: {
      id: txn.id, memberId: txn.member_id, type: txn.type,
      amount: Number(txn.amount), note: txn.note, txnDate: txn.txn_date,
    },
    member,
  }, body.type === 'WITHDRAW' ? 'Money taken out' : 'Money added');
}));

/** Wallet history, newest first. Optionally filtered to one member. */
router.get('/', asyncHandler(async (req, res) => {
  const filters = parse(z.object({
    memberId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }), req.query);

  const { rows } = await query(
    `SELECT w.id, w.type, w.amount, w.note, w.txn_date, w.created_at,
            m.id AS member_id, m.name AS member_name, m.color AS member_color,
            u.name AS added_by
       FROM wallet_transactions w
       JOIN space_members m ON m.id = w.member_id
       LEFT JOIN users u ON u.id = w.created_by
      WHERE w.space_id = $1
        AND ($2::uuid IS NULL OR w.member_id = $2::uuid)
      ORDER BY w.txn_date DESC, w.created_at DESC
      LIMIT $3 OFFSET $4`,
    [req.space.id, filters.memberId || null, filters.limit, filters.offset]
  );

  return ok(res, rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: Number(r.amount),
    note: r.note,
    txnDate: r.txn_date,
    memberId: r.member_id,
    memberName: r.member_name,
    memberColor: r.member_color,
    addedBy: r.added_by,
  })));
}));

router.delete('/:txnId', asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM wallet_transactions WHERE id = $1 AND space_id = $2',
    [req.params.txnId, req.space.id]
  );
  if (!rowCount) throw ApiError.notFound('Transaction not found');
  return ok(res, null, 'Transaction deleted');
}));

export default router;
