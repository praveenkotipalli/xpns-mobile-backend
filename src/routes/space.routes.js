import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { inviteCode, money } from '../lib/ids.js';
import { monthStart, today } from '../lib/dates.js';
import { debtsFrom, memberBalances, totalsFrom } from '../lib/balances.js';
import { requireAuth, requireSpace, requireSpaceOwner } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Avatar/identity colours, chosen to stay legible on a pure-black background.
// White first so the owner matches the app's monochrome accent.
const MEMBER_COLORS = ['#FFFFFF', '#3ECF8E', '#FF6B6B', '#F5A623', '#B388FF', '#4DD0E1', '#F06292', '#A1A1A1'];

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** "  Likhit   Kumar " and "likhit kumar" are the same person's name. */
const normaliseName = (name) => String(name).trim().toLowerCase().replace(/\s+/g, ' ');

/* ------------------------------------------------------------------ spaces */

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.currency, s.invite_code, m.role, m.id AS member_id
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      ORDER BY s.created_at`,
    [req.user.id]
  );
  // memberId matches /api/auth/me. Without it, the app lost track of which
  // member row was "you" after creating or joining a space, and the expense
  // form defaulted the payer to the space owner instead.
  return ok(res, rows.map((s) => ({
    id: s.id, name: s.name, currency: s.currency, inviteCode: s.invite_code, role: s.role, memberId: s.member_id,
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

  const claimed = await withTransaction(async (client) => {
    if (body.claimMemberId) {
      const { rows: [row] } = await client.query(
        `UPDATE space_members SET user_id = $1, is_active = TRUE
          WHERE id = $2 AND space_id = $3 AND user_id IS NULL
          RETURNING name`,
        [req.user.id, body.claimMemberId, space.id]
      );
      if (row) return row.name;
      throw ApiError.conflict('That member is already linked to an account');
    }

    /*
     * The owner usually adds people by name long before they install the app.
     * Joining used to create a second row for the same person, so the money
     * and spending stayed on the old one — and that person then saw their own
     * name in the debts list ("Likhit owes you", shown to Likhit). Link them to
     * that row instead, when exactly one unlinked row has their name (full
     * name first, then first name). Anything ambiguous gets a fresh row, and
     * the owner can merge it later.
     */
    const { rows: placeholders } = await client.query(
      `SELECT id, name FROM space_members
        WHERE space_id = $1 AND user_id IS NULL AND role <> 'OWNER'`,
      [space.id]
    );
    const fullName = normaliseName(req.user.name);
    const firstName = fullName.split(' ')[0];
    let matches = placeholders.filter((p) => normaliseName(p.name) === fullName);
    if (!matches.length) matches = placeholders.filter((p) => normaliseName(p.name) === firstName);

    if (matches.length === 1) {
      const { rowCount } = await client.query(
        'UPDATE space_members SET user_id = $1, is_active = TRUE WHERE id = $2 AND user_id IS NULL',
        [req.user.id, matches[0].id]
      );
      if (rowCount) return matches[0].name;
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*)::int AS count FROM space_members WHERE space_id = $1', [space.id]
    );
    await client.query(
      `INSERT INTO space_members (space_id, user_id, name, role, color)
       VALUES ($1, $2, $3, 'MEMBER', $4)`,
      [space.id, req.user.id, req.user.name, MEMBER_COLORS[count % MEMBER_COLORS.length]]
    );
    return null;
  });

  return ok(
    res,
    { id: space.id, name: space.name, currency: space.currency, linkedTo: claimed },
    claimed ? `Joined ${space.name} as ${claimed}` : `Joined ${space.name}`
  );
}));

/* --------------------------------------------------------------- dashboard */

/**
 * Everything the dashboard needs in one round trip: the pooled total, each
 * member's own balance (shown when you tap the total), and recent activity.
 */
router.get('/summary', requireSpace, asyncHandler(async (req, res) => {
  const members = await memberBalances(req.space.id);
  const totals = totalsFrom(members);
  const debts = debtsFrom(members);

  /**
   * Two different true answers to "how much have we got":
   *
   *   totalBalance   — the cash actually sitting in the account right now.
   *   settledBalance — what it would hold once every outstanding debt is paid.
   *
   * The second is simply the first plus everything still owed, because settling
   * a debt is cash arriving. It is no longer "the sum of the positive balances"
   * — a debt now outlives the top-up that used to hide it, so the two figures
   * would disagree for anyone who has overspent and put money in since.
   */
  const settledBalance = money(totals.totalBalance + debts.totalOwed);

  const { rows: [monthRow] } = await query(
    `SELECT COALESCE(SUM(amount), 0) AS spent, COUNT(*)::int AS count
       FROM expenses
      WHERE space_id = $1
        AND spent_on >= $2::date`,
    [req.space.id, monthStart()]
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
      ORDER BY e.created_at DESC
      LIMIT 8`,
    [req.space.id]
  );

  // The money-in side of the dashboard, mirroring recent expenses. Only
  // credits: a withdrawal is money leaving, and lives in the full history.
  //
  // Both "recent" lists are ordered by when the entry was *recorded*. They
  // used to sort by the date typed on the form, so cash handed over last week
  // and entered today sank below newer-dated rows and never appeared — the
  // total moved but the entry you had just made was nowhere to be seen.
  const { rows: recentMoney } = await query(
    `SELECT w.id, w.type, w.amount, w.note, w.txn_date,
            m.name AS member_name, m.color AS member_color
       FROM wallet_transactions w
       JOIN space_members m ON m.id = w.member_id
      WHERE w.space_id = $1
        AND w.type IN ('TOPUP', 'ADJUST')
      ORDER BY w.created_at DESC
      LIMIT 8`,
    [req.space.id]
  );

  // Events are shared by invite code rather than by space, but one that was
  // started from another space belongs to that space's dashboard, not this one.
  const { rows: openEvents } = await query(
    `SELECT e.id, e.name, e.type, e.start_date,
            (SELECT COUNT(*)::int FROM event_participants p WHERE p.event_id = e.id) AS participant_count,
            (SELECT COALESCE(SUM(x.amount), 0) FROM event_expenses x WHERE x.event_id = e.id) AS total
       FROM events e
       JOIN event_participants p ON p.event_id = e.id AND p.user_id = $1
      WHERE e.status = 'OPEN'
        AND (e.space_id IS NULL OR e.space_id = $2)
      ORDER BY e.created_at DESC
      LIMIT 5`,
    [req.user.id, req.space.id]
  );

  return ok(res, {
    space: { id: req.space.id, name: req.space.name, currency: req.space.currency, inviteCode: req.space.inviteCode, role: req.space.role },
    ...totals,
    settledBalance,
    myMemberId: req.space.memberId,
    monthSpent: Number(monthRow.spent),
    monthExpenseCount: monthRow.count,
    members,
    debts,
    recentMoney: recentMoney.map((r) => ({
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      note: r.note,
      txnDate: r.txn_date,
      memberName: r.member_name,
      memberColor: r.member_color,
    })),
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
 * Anyone who has consumed more than they put in owes whoever is holding the
 * shared cash, and keeps owing it until the debt is cleared through
 * `/debts/settle` — topping the wallet up no longer counts as paying it back.
 */
router.get('/debts', requireSpace, asyncHandler(async (req, res) => {
  const members = await memberBalances(req.space.id);
  const { settlements, totalOwed, unallocated } = debtsFrom(members);

  const mine = req.space.memberId;
  return ok(res, {
    myMemberId: mine,
    totalOwed,
    unallocated,
    settlements,
    iOwe: settlements.filter((s) => s.fromMemberId === mine),
    owedToMe: settlements.filter((s) => s.toMemberId === mine),
    members: members.map((m) => ({
      id: m.id, name: m.name, color: m.color, balance: m.balance, debt: m.debt, isMe: m.id === mine,
    })),
  });
}));

/* ------------------------------------------------------------ clearing debts */

const settleSchema = z.object({
  memberId: z.string().uuid('must be a member id'),
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  note: z.string().trim().max(255).optional(),
  settledOn: dateString.optional(),
  spaceId: z.string().uuid().optional(),
});

/**
 * Record that someone has paid back what they owed — all of it or part.
 *
 * This is the only thing that reduces a debt. Adding money to the wallet does
 * not, on purpose: cash handed over for next week's shopping is not a
 * repayment, and treating it as one used to erase the debt with no record of
 * it ever having been settled.
 *
 * The cash lands in the wallet as well, so the pot and the member's balance
 * both go up by the amount — they really did hand it over.
 */
router.post('/debts/settle', requireSpace, asyncHandler(async (req, res) => {
  const body = parse(settleSchema, req.body);

  // Check and write under one per-space lock, so two phones clearing the same
  // debt at the same moment cannot both pass the "owes at most" check.
  const { member, row } = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settle:${req.space.id}`]);

    const before = await memberBalances(req.space.id, client);
    const debtor = before.find((m) => m.id === body.memberId);
    if (!debtor) throw ApiError.notFound('That member is not in this space');
    if (debtor.debt <= 0.009) throw ApiError.badRequest(`${debtor.name} does not owe anything right now`);

    // Overpaying would push the debt below zero and read as credit that was never
    // given. Partial is fine; more than the whole debt is not.
    if (body.amount - debtor.debt > 0.009) {
      throw ApiError.badRequest(
        `${debtor.name} only owes ${debtor.debt.toFixed(2)} — clear that much or less`
      );
    }

    const { rows: [inserted] } = await client.query(
      `INSERT INTO debt_settlements (space_id, member_id, amount, note, settled_on, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6)
       RETURNING *`,
      [req.space.id, body.memberId, body.amount, body.note || null, body.settledOn || today(), req.user.id]
    );
    return { member: debtor, row: inserted };
  });

  const members = await memberBalances(req.space.id);
  const after = members.find((m) => m.id === body.memberId);

  return created(res, {
    settlement: {
      id: row.id,
      memberId: row.member_id,
      memberName: member.name,
      memberColor: member.color,
      amount: Number(row.amount),
      note: row.note,
      settledOn: row.settled_on,
      isCash: row.is_cash,
      recordedBy: req.user.name,
    },
    members,
    debts: debtsFrom(members),
  }, after && after.debt > 0.009
    ? `${member.name} still owes ${after.debt.toFixed(2)}`
    : `${member.name} is all square`);
}));

/** Every debt that has been cleared, newest first. */
router.get('/debts/history', requireSpace, asyncHandler(async (req, res) => {
  const filters = parse(z.object({
    memberId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }), req.query);

  const { rows } = await query(
    `SELECT d.id, d.amount, d.note, d.settled_on, d.is_cash,
            m.id AS member_id, m.name AS member_name, m.color AS member_color,
            u.name AS recorded_by
       FROM debt_settlements d
       JOIN space_members m ON m.id = d.member_id
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.space_id = $1
        AND ($2::uuid IS NULL OR d.member_id = $2::uuid)
      ORDER BY d.settled_on DESC, d.created_at DESC
      LIMIT $3`,
    [req.space.id, filters.memberId || null, filters.limit]
  );

  return ok(res, rows.map((r) => ({
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    memberColor: r.member_color,
    amount: Number(r.amount),
    note: r.note,
    settledOn: r.settled_on,
    isCash: r.is_cash,
    recordedBy: r.recorded_by,
  })));
}));

/** Undo a clearance — the debt comes back and the cash leaves the wallet again. */
router.delete('/debts/settle/:settlementId', requireSpace, asyncHandler(async (req, res) => {
  // `is_cash = TRUE` guards the opening balances written by migration 005:
  // deleting one of those would resurrect a debt that was settled long before
  // the app started tracking them.
  const { rowCount } = await query(
    'DELETE FROM debt_settlements WHERE id = $1 AND space_id = $2 AND is_cash = TRUE',
    [req.params.settlementId, req.space.id]
  );
  if (!rowCount) throw ApiError.notFound('That clearance is not there, or is a carried-forward entry');

  const members = await memberBalances(req.space.id);
  return ok(res, { members, debts: debtsFrom(members) }, 'Clearance removed');
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
    incurredDebt: 0, settledDebt: 0, debt: 0,
  }, `${member.name} added`);
}));

router.patch('/members/:memberId', requireSpace, asyncHandler(async (req, res) => {
  const body = parse(memberSchema.partial().extend({ isActive: z.boolean().optional() }), req.body);

  // The account holder keeps the cash; archiving them would hide the person
  // every debt is paid to from every form.
  if (body.isActive === false) {
    const { rows: [target] } = await query(
      'SELECT role FROM space_members WHERE id = $1 AND space_id = $2', [req.params.memberId, req.space.id]
    );
    if (target?.role === 'OWNER') throw ApiError.badRequest('The space owner cannot be archived');
  }

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

  /*
   * Anything on the books keeps the row. This used to count only the legacy
   * expenses.member_id column, so someone whose only history was money they
   * had put in was deleted outright — and the cascade took their top-ups and
   * debt clearances with them, silently shrinking the wallet. Someone on a
   * split bill failed with a 500 instead.
   */
  const { rows: [{ count }] } = await query(
    `SELECT (SELECT COUNT(*) FROM expense_shares      WHERE member_id = $1)
          + (SELECT COUNT(*) FROM expenses            WHERE member_id = $1 OR paid_by = $1)
          + (SELECT COUNT(*) FROM wallet_transactions WHERE member_id = $1)
          + (SELECT COUNT(*) FROM debt_settlements    WHERE member_id = $1) AS count`,
    [member.id]
  );
  if (Number(count) > 0) {
    // Keep the history intact — archive instead of destroying it.
    await query('UPDATE space_members SET is_active = FALSE WHERE id = $1', [member.id]);
    return ok(res, { deactivated: true }, `${member.name} has money or expenses on record, so they were archived instead of deleted`);
  }

  await query('DELETE FROM space_members WHERE id = $1', [member.id]);
  return ok(res, { deleted: true }, `${member.name} removed`);
}));

/* ----------------------------------------------------------- merging people */

const mergeSchema = z.object({
  intoMemberId: z.string().uuid('must be a member id'),
  spaceId: z.string().uuid().optional(),
});

/**
 * Fold a name-only member into another member of the same space — for the
 * person who was added by name and then joined with the code before joining
 * linked them up, and so appears twice.
 *
 * Every rupee moves across: their top-ups, their shares of every bill (added
 * together where both rows were on the same one), bills they paid, and debt
 * clearances. The name-only row is then removed. Balances and debts are
 * recomputed from the combined ledger, so nothing is created or lost.
 *
 * The owner can merge any two people. Anyone else can only claim a row as
 * themselves: merge it into their own member row.
 */
router.post('/members/:memberId/merge', requireSpace, asyncHandler(async (req, res) => {
  const body = parse(mergeSchema, req.body);
  const sourceId = req.params.memberId;
  if (sourceId === body.intoMemberId) throw ApiError.badRequest('Pick two different people');

  const isOwner = req.space.role === 'OWNER';
  if (!isOwner && body.intoMemberId !== req.space.memberId) {
    throw ApiError.forbidden('Only the space owner can merge other people');
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, name, role, user_id FROM space_members
        WHERE space_id = $1 AND id = ANY($2::uuid[])
        FOR UPDATE`,
      [req.space.id, [sourceId, body.intoMemberId]]
    );
    const source = rows.find((m) => m.id === sourceId);
    const target = rows.find((m) => m.id === body.intoMemberId);
    if (!source || !target) throw ApiError.notFound('Both people must be in this space');
    if (source.role === 'OWNER') throw ApiError.badRequest('The space owner cannot be merged away');
    if (source.user_id) {
      throw ApiError.badRequest(`${source.name} has their own account, so that row cannot be merged away`);
    }

    // Same bill on both rows: add the shares together rather than keep two.
    await client.query(
      `UPDATE expense_shares t
          SET amount = t.amount + s.amount
         FROM expense_shares s
        WHERE s.member_id = $1 AND t.member_id = $2 AND t.expense_id = s.expense_id`,
      [source.id, target.id]
    );
    await client.query(
      `DELETE FROM expense_shares s
        WHERE s.member_id = $1
          AND EXISTS (SELECT 1 FROM expense_shares t WHERE t.expense_id = s.expense_id AND t.member_id = $2)`,
      [source.id, target.id]
    );
    await client.query('UPDATE expense_shares      SET member_id = $2 WHERE member_id = $1', [source.id, target.id]);
    await client.query('UPDATE expenses            SET member_id = $2 WHERE member_id = $1', [source.id, target.id]);
    await client.query('UPDATE expenses            SET paid_by   = $2 WHERE paid_by   = $1', [source.id, target.id]);
    await client.query('UPDATE wallet_transactions SET member_id = $2 WHERE member_id = $1', [source.id, target.id]);
    await client.query('UPDATE debt_settlements    SET member_id = $2 WHERE member_id = $1', [source.id, target.id]);

    // A bill that now has a single consumer keeps the legacy column in step.
    await client.query(
      `UPDATE expenses e
          SET member_id = (SELECT es.member_id FROM expense_shares es WHERE es.expense_id = e.id)
        WHERE e.space_id = $1
          AND (SELECT COUNT(*) FROM expense_shares es WHERE es.expense_id = e.id) = 1`,
      [req.space.id]
    );

    await client.query('DELETE FROM space_members WHERE id = $1', [source.id]);
    return { source, target };
  });

  const members = await memberBalances(req.space.id);
  return ok(
    res,
    { mergedInto: result.target.id, members, debts: debtsFrom(members) },
    `${result.source.name} merged into ${result.target.name}`
  );
}));

export default router;
