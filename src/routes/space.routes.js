import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { inviteCode } from '../lib/ids.js';
import { memberBalances, totalsFrom } from '../lib/balances.js';
import { requireAuth, requireSpace, requireSpaceOwner } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const MEMBER_COLORS = ['#6C8CFF', '#31C48D', '#F98080', '#FDBA8C', '#AC94FA', '#16BDCA', '#E879F9', '#FACC15'];

/* ------------------------------------------------------------------ spaces */

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.currency, s.invite_code, m.role
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      ORDER BY s.created_at`,
    [req.user.id]
  );
  return ok(res, rows.map((s) => ({
    id: s.id, name: s.name, currency: s.currency, inviteCode: s.invite_code, role: s.role,
  })));
}));

const createSpaceSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  currency: z.string().trim().max(8).default('INR'),
});

router.post('/', asyncHandler(async (req, res) => {
  const body = parse(createSpaceSchema, req.body);
  const space = await withTransaction(async (client) => {
    const { rows: [s] } = await client.query(
      'INSERT INTO spaces (name, owner_id, invite_code, currency) VALUES ($1, $2, $3, $4) RETURNING *',
      [body.name, req.user.id, inviteCode(), body.currency]
    );
    await client.query(
      `INSERT INTO space_members (space_id, user_id, name, role, color)
       VALUES ($1, $2, $3, 'OWNER', $4)`,
      [s.id, req.user.id, req.user.name, MEMBER_COLORS[0]]
    );
    return s;
  });
  return created(res, {
    id: space.id, name: space.name, currency: space.currency, inviteCode: space.invite_code, role: 'OWNER',
  }, 'Space created');
}));

/** Join an existing space with its invite code — links you to a member slot. */
const joinSchema = z.object({
  code: z.string().trim().toUpperCase().min(4).max(12),
  /** Optionally claim an existing unlinked member row instead of creating a new one. */
  claimMemberId: z.string().uuid().optional(),
});

router.post('/join', asyncHandler(async (req, res) => {
  const body = parse(joinSchema, req.body);

  const { rows: [space] } = await query('SELECT * FROM spaces WHERE invite_code = $1', [body.code]);
  if (!space) throw ApiError.notFound('No space found for that code');

  const existing = await query(
    'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
    [space.id, req.user.id]
  );
  if (existing.rowCount) return ok(res, { id: space.id, name: space.name }, 'You are already in this space');

  await withTransaction(async (client) => {
    if (body.claimMemberId) {
      const { rowCount } = await client.query(
        `UPDATE space_members SET user_id = $1
          WHERE id = $2 AND space_id = $3 AND user_id IS NULL`,
        [req.user.id, body.claimMemberId, space.id]
      );
      if (rowCount) return;
      throw ApiError.conflict('That member is already linked to an account');
    }
    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*)::int AS count FROM space_members WHERE space_id = $1', [space.id]
    );
    await client.query(
      `INSERT INTO space_members (space_id, user_id, name, role, color)
       VALUES ($1, $2, $3, 'MEMBER', $4)`,
      [space.id, req.user.id, req.user.name, MEMBER_COLORS[count % MEMBER_COLORS.length]]
    );
  });

  return ok(res, { id: space.id, name: space.name, currency: space.currency }, `Joined ${space.name}`);
}));

/* --------------------------------------------------------------- dashboard */

/**
 * Everything the dashboard needs in one round trip: the pooled total, each
 * member's own balance (shown when you tap the total), and recent activity.
 */
router.get('/summary', requireSpace, asyncHandler(async (req, res) => {
  const members = await memberBalances(req.space.id);
  const totals = totalsFrom(members);

  const { rows: [monthRow] } = await query(
    `SELECT COALESCE(SUM(amount), 0) AS spent, COUNT(*)::int AS count
       FROM expenses
      WHERE space_id = $1
        AND spent_on >= date_trunc('month', CURRENT_DATE)::date`,
    [req.space.id]
  );

  const { rows: recent } = await query(
    `SELECT e.id, e.item, e.amount, e.spent_on, e.category_key, m.name AS member_name, m.color AS member_color
       FROM expenses e
       JOIN space_members m ON m.id = e.member_id
      WHERE e.space_id = $1
      ORDER BY e.spent_on DESC, e.created_at DESC
      LIMIT 8`,
    [req.space.id]
  );

  const { rows: openEvents } = await query(
    `SELECT e.id, e.name, e.type, e.start_date,
            (SELECT COUNT(*)::int FROM event_participants p WHERE p.event_id = e.id) AS participant_count,
            (SELECT COALESCE(SUM(x.amount), 0) FROM event_expenses x WHERE x.event_id = e.id) AS total
       FROM events e
       JOIN event_participants p ON p.event_id = e.id AND p.user_id = $1
      WHERE e.status = 'OPEN'
      ORDER BY e.created_at DESC
      LIMIT 5`,
    [req.user.id]
  );

  return ok(res, {
    space: { id: req.space.id, name: req.space.name, currency: req.space.currency, inviteCode: req.space.inviteCode, role: req.space.role },
    ...totals,
    myMemberId: req.space.memberId,
    monthSpent: Number(monthRow.spent),
    monthExpenseCount: monthRow.count,
    members,
    recentExpenses: recent.map((r) => ({
      id: r.id,
      item: r.item,
      amount: Number(r.amount),
      spentOn: r.spent_on,
      categoryKey: r.category_key,
      memberName: r.member_name,
      memberColor: r.member_color,
    })),
    openEvents: openEvents.map((e) => ({
      id: e.id, name: e.name, type: e.type, startDate: e.start_date,
      participantCount: e.participant_count, total: Number(e.total),
    })),
  });
}));

/* ----------------------------------------------------------------- members */

router.get('/members', requireSpace, asyncHandler(async (req, res) => {
  return ok(res, await memberBalances(req.space.id));
}));

const memberSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(120),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour').optional(),
});

router.post('/members', requireSpace, asyncHandler(async (req, res) => {
  const body = parse(memberSchema, req.body);
  const { rows: [{ count }] } = await query(
    'SELECT COUNT(*)::int AS count FROM space_members WHERE space_id = $1', [req.space.id]
  );
  const { rows: [member] } = await query(
    `INSERT INTO space_members (space_id, name, color) VALUES ($1, $2, $3) RETURNING *`,
    [req.space.id, body.name, body.color || MEMBER_COLORS[count % MEMBER_COLORS.length]]
  );
  return created(res, {
    id: member.id, name: member.name, color: member.color, role: member.role,
    hasAccount: false, balance: 0, creditedTotal: 0, withdrawnTotal: 0, spentTotal: 0,
  }, `${member.name} added`);
}));

router.patch('/members/:memberId', requireSpace, asyncHandler(async (req, res) => {
  const body = parse(memberSchema.partial().extend({ isActive: z.boolean().optional() }), req.body);
  const { rows: [member] } = await query(
    `UPDATE space_members
        SET name      = COALESCE($1, name),
            color     = COALESCE($2, color),
            is_active = COALESCE($3, is_active)
      WHERE id = $4 AND space_id = $5
      RETURNING *`,
    [body.name ?? null, body.color ?? null, body.isActive ?? null, req.params.memberId, req.space.id]
  );
  if (!member) throw ApiError.notFound('Member not found');
  return ok(res, { id: member.id, name: member.name, color: member.color, isActive: member.is_active }, 'Member updated');
}));

router.delete('/members/:memberId', requireSpace, requireSpaceOwner, asyncHandler(async (req, res) => {
  const { rows: [member] } = await query(
    'SELECT * FROM space_members WHERE id = $1 AND space_id = $2', [req.params.memberId, req.space.id]
  );
  if (!member) throw ApiError.notFound('Member not found');
  if (member.role === 'OWNER') throw ApiError.badRequest('The space owner cannot be removed');

  const { rows: [{ count }] } = await query(
    'SELECT COUNT(*)::int AS count FROM expenses WHERE member_id = $1', [member.id]
  );
  if (count > 0) {
    // Keep the history intact — deactivate instead of destroying past expenses.
    await query('UPDATE space_members SET is_active = FALSE WHERE id = $1', [member.id]);
    return ok(res, { deactivated: true }, `${member.name} has ${count} expense(s), so they were archived instead of deleted`);
  }

  await query('DELETE FROM space_members WHERE id = $1', [member.id]);
  return ok(res, { deleted: true }, `${member.name} removed`);
}));

export default router;
