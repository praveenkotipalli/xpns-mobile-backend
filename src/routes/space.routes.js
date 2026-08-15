import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { inviteCode } from '../lib/ids.js';
import { debtsFrom, memberBalances, totalsFrom } from '../lib/balances.js';
import { requireAuth, requireSpace, requireSpaceOwner } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Avatar/identity colours, chosen to stay legible on a pure-black background.
// White first so the owner matches the app's monochrome accent.
const MEMBER_COLORS = ['#FFFFFF', '#3ECF8E', '#FF6B6B', '#F5A623', '#B388FF', '#4DD0E1', '#F06292', '#A1A1A1'];

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
    `SELECT e.id, e.item, e.amount, e.spent_on, e.category_key, e.split_mode,
            payer.name AS paid_by_name, payer.color AS paid_by_color,
            sh.people, sh.names, sh.first_color
       FROM expenses e
       LEFT JOIN space_members payer ON payer.id = e.paid_by
       LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS people,
                   STRING_AGG(m.name, ', ' ORDER BY m.name) AS names,
                   MIN(m.color) AS first_color
              FROM expense_shares es
              JOIN space_members m ON m.id = es.member_id
             WHERE es.expense_id = e.id
       ) sh ON TRUE
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
    debts: debtsFrom(members),
    recentExpenses: recent.map((r) => ({
      id: r.id,
      item: r.item,
      amount: Number(r.amount),
      spentOn: r.spent_on,
      categoryKey: r.category_key,
      isSplit: (r.people ?? 0) > 1,
      peopleCount: r.people ?? 0,
      paidByName: r.paid_by_name,
      // "Aijaz" for a solo expense, "3 people" once it is shared.
      memberName: (r.people ?? 0) > 1 ? `${r.people} people` : r.names,
      memberColor: (r.people ?? 0) > 1 ? r.paid_by_color || r.first_color : r.first_color,
    })),
    openEvents: openEvents.map((e) => ({
      id: e.id, name: e.name, type: e.type, startDate: e.start_date,
      participantCount: e.participant_count, total: Number(e.total),
    })),
  });
}));

/**
 * Who owes whom right now.
 *
 * Anyone whose balance has gone negative has consumed more than they put in,
 * so they owe whoever is holding the shared cash. People still in credit do
 * not appear — their own money already covers their share.
 */
router.get('/debts', requireSpace, asyncHandler(async (req, res) => {
  const members = await memberBalances(req.space.id);
  const { settlements, totalOwed } = debtsFrom(members);

  const mine = req.space.memberId;
  return ok(res, {
    myMemberId: mine,
    totalOwed,
    settlements,
    iOwe: settlements.filter((s) => s.fromMemberId === mine),
    owedToMe: settlements.filter((s) => s.toMemberId === mine),
    members: members.map((m) => ({
      id: m.id, name: m.name, color: m.color, balance: m.balance, isMe: m.id === mine,
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
