import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { inviteCode, money } from '../lib/ids.js';
import { equalShares, settlements } from '../lib/settle.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/**
 * Loads the event and asserts the caller is a participant.
 * req.event = the event row; req.participant = the caller's participant row.
 */
const loadEvent = asyncHandler(async (req, _res, next) => {
  const { rows: [event] } = await query('SELECT * FROM events WHERE id = $1', [req.params.eventId]);
  if (!event) throw ApiError.notFound('Event not found');

  const { rows: [participant] } = await query(
    'SELECT * FROM event_participants WHERE event_id = $1 AND user_id = $2',
    [event.id, req.user.id]
  );
  if (!participant) throw ApiError.forbidden('You are not part of this event');

  req.event = event;
  req.participant = participant;
  next();
});

const requireOrganiser = asyncHandler(async (req, _res, next) => {
  if (req.participant.role !== 'ORGANISER') throw ApiError.forbidden('Only the organiser can do this');
  next();
});

/* ------------------------------------------------------------------ events */

/** Every event the caller takes part in, with their own net position. */
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*,
            (SELECT COUNT(*)::int FROM event_participants p WHERE p.event_id = e.id) AS participant_count,
            (SELECT COALESCE(SUM(x.amount), 0) FROM event_expenses x WHERE x.event_id = e.id) AS total,
            (SELECT COALESCE(SUM(x.amount), 0) FROM event_expenses x WHERE x.paid_by = me.id) AS my_paid,
            (SELECT COALESCE(SUM(s.amount), 0) FROM event_expense_shares s WHERE s.participant_id = me.id) AS my_share
       FROM events e
       JOIN event_participants me ON me.event_id = e.id AND me.user_id = $1
      ORDER BY (e.status = 'OPEN') DESC, COALESCE(e.start_date, e.created_at::date) DESC`,
    [req.user.id]
  );

  return ok(res, rows.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    description: e.description,
    startDate: e.start_date,
    endDate: e.end_date,
    status: e.status,
    currency: e.currency,
    inviteCode: e.invite_code,
    participantCount: e.participant_count,
    total: Number(e.total),
    myPaid: Number(e.my_paid),
    myShare: Number(e.my_share),
    myNet: money(Number(e.my_paid) - Number(e.my_share)),
  })));
}));

const createEventSchema = z.object({
  name: z.string().trim().min(1, 'is required').max(160),
  type: z.enum(['TRIP', 'RESTAURANT', 'PARTY', 'OTHER']).default('OTHER'),
  description: z.string().trim().max(500).optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  currency: z.string().trim().max(8).default('INR'),
  spaceId: z.string().uuid().optional(),
  /** Names of people who have no account yet — added as placeholders you can log for. */
  participants: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});

router.post('/', asyncHandler(async (req, res) => {
  const body = parse(createEventSchema, req.body);

  const event = await withTransaction(async (client) => {
    const { rows: [e] } = await client.query(
      `INSERT INTO events (space_id, name, type, description, start_date, end_date, currency, invite_code, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9) RETURNING *`,
      [body.spaceId || null, body.name, body.type, body.description || null,
       body.startDate || null, body.endDate || null, body.currency, inviteCode(), req.user.id]
    );

    await client.query(
      `INSERT INTO event_participants (event_id, user_id, display_name, role)
       VALUES ($1, $2, $3, 'ORGANISER')`,
      [e.id, req.user.id, req.user.name]
    );

    for (const name of body.participants) {
      await client.query(
        'INSERT INTO event_participants (event_id, display_name) VALUES ($1, $2)', [e.id, name]
      );
    }
    return e;
  });

  return created(res, { id: event.id, name: event.name, inviteCode: event.invite_code }, 'Event created');
}));

/** Join with the event's share code — you then log your own spending from your account. */
router.post('/join', asyncHandler(async (req, res) => {
  const body = parse(z.object({
    code: z.string().trim().toUpperCase().min(4).max(12),
    claimParticipantId: z.string().uuid().optional(),
  }), req.body);

  const { rows: [event] } = await query('SELECT * FROM events WHERE invite_code = $1', [body.code]);
  if (!event) throw ApiError.notFound('No event found for that code');
  if (event.status === 'SETTLED') throw ApiError.badRequest('That event is already settled');

  const existing = await query(
    'SELECT id FROM event_participants WHERE event_id = $1 AND user_id = $2', [event.id, req.user.id]
  );
  if (existing.rowCount) return ok(res, { id: event.id, name: event.name }, 'You are already in this event');

  if (body.claimParticipantId) {
    // Take over a placeholder the organiser created for you, keeping its history.
    const { rowCount } = await query(
      `UPDATE event_participants SET user_id = $1, display_name = $2
        WHERE id = $3 AND event_id = $4 AND user_id IS NULL`,
      [req.user.id, req.user.name, body.claimParticipantId, event.id]
    );
    if (!rowCount) throw ApiError.conflict('That person is already linked to an account');
  } else {
    await query(
      'INSERT INTO event_participants (event_id, user_id, display_name) VALUES ($1, $2, $3)',
      [event.id, req.user.id, req.user.name]
    );
  }

  return ok(res, { id: event.id, name: event.name }, `Joined ${event.name}`);
}));

/** Peek at an event by code before joining (shows placeholders you might claim). */
router.get('/lookup/:code', asyncHandler(async (req, res) => {
  const { rows: [event] } = await query(
    'SELECT id, name, type, start_date, status FROM events WHERE invite_code = $1',
    [req.params.code.toUpperCase()]
  );
  if (!event) throw ApiError.notFound('No event found for that code');

  const { rows: participants } = await query(
    `SELECT id, display_name, user_id IS NOT NULL AS claimed
       FROM event_participants WHERE event_id = $1 ORDER BY joined_at`,
    [event.id]
  );

  return ok(res, {
    id: event.id,
    name: event.name,
    type: event.type,
    startDate: event.start_date,
    status: event.status,
    participants: participants.map((p) => ({ id: p.id, name: p.display_name, claimed: p.claimed })),
  });
}));

/** Full event view: participants with net positions, expenses, and who-pays-whom. */
router.get('/:eventId', loadEvent, asyncHandler(async (req, res) => {
  const { rows: participants } = await query(
    `SELECT p.id, p.display_name, p.role, p.user_id,
            COALESCE(paid.total, 0)  AS paid,
            COALESCE(share.total, 0) AS share
       FROM event_participants p
       LEFT JOIN (SELECT paid_by, SUM(amount) AS total FROM event_expenses WHERE event_id = $1 GROUP BY paid_by) paid
              ON paid.paid_by = p.id
       LEFT JOIN (SELECT s.participant_id, SUM(s.amount) AS total
                    FROM event_expense_shares s
                    JOIN event_expenses x ON x.id = s.event_expense_id
                   WHERE x.event_id = $1 GROUP BY s.participant_id) share
              ON share.participant_id = p.id
      WHERE p.event_id = $1
      ORDER BY (p.role = 'ORGANISER') DESC, p.joined_at`,
    [req.event.id]
  );

  const { rows: expenseRows } = await query(
    `SELECT x.*, p.display_name AS paid_by_name, c.label AS category_label, c.icon
       FROM event_expenses x
       JOIN event_participants p ON p.id = x.paid_by
       LEFT JOIN categories c ON c.key = x.category_key AND c.space_id IS NULL
      WHERE x.event_id = $1
      ORDER BY x.spent_on DESC, x.created_at DESC`,
    [req.event.id]
  );

  const { rows: shareRows } = await query(
    `SELECT s.event_expense_id, s.participant_id, s.amount, p.display_name
       FROM event_expense_shares s
       JOIN event_participants p ON p.id = s.participant_id
       JOIN event_expenses x ON x.id = s.event_expense_id
      WHERE x.event_id = $1`,
    [req.event.id]
  );

  const sharesByExpense = new Map();
  for (const s of shareRows) {
    if (!sharesByExpense.has(s.event_expense_id)) sharesByExpense.set(s.event_expense_id, []);
    sharesByExpense.get(s.event_expense_id).push({
      participantId: s.participant_id, name: s.display_name, amount: Number(s.amount),
    });
  }

  const people = participants.map((p) => ({
    id: p.id,
    name: p.display_name,
    role: p.role,
    userId: p.user_id,
    isMe: p.user_id === req.user.id,
    hasAccount: Boolean(p.user_id),
    paid: Number(p.paid),
    share: Number(p.share),
    net: money(Number(p.paid) - Number(p.share)),
  }));

  const total = money(expenseRows.reduce((sum, e) => sum + Number(e.amount), 0));

  return ok(res, {
    id: req.event.id,
    name: req.event.name,
    type: req.event.type,
    description: req.event.description,
    startDate: req.event.start_date,
    endDate: req.event.end_date,
    status: req.event.status,
    currency: req.event.currency,
    inviteCode: req.event.invite_code,
    isOrganiser: req.participant.role === 'ORGANISER',
    myParticipantId: req.participant.id,
    total,
    myShare: people.find((p) => p.isMe)?.share ?? 0,
    participants: people,
    expenses: expenseRows.map((e) => ({
      id: e.id,
      item: e.item,
      amount: Number(e.amount),
      categoryKey: e.category_key,
      categoryLabel: e.category_label || e.category_key,
      icon: e.icon || 'pricetag',
      spentOn: e.spent_on,
      note: e.note,
      splitMode: e.split_mode,
      paidBy: e.paid_by,
      paidByName: e.paid_by_name,
      shares: sharesByExpense.get(e.id) || [],
    })),
    settlements: settlements(people),
  });
}));

const updateEventSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  status: z.enum(['OPEN', 'SETTLED']).optional(),
});

router.patch('/:eventId', loadEvent, requireOrganiser, asyncHandler(async (req, res) => {
  const body = parse(updateEventSchema, req.body);
  const { rows: [e] } = await query(
    `UPDATE events SET name = COALESCE($1, name),
                       description = COALESCE($2, description),
                       start_date = COALESCE($3::date, start_date),
                       end_date = COALESCE($4::date, end_date),
                       status = COALESCE($5, status)
      WHERE id = $6 RETURNING *`,
    [body.name ?? null, body.description ?? null, body.startDate ?? null,
     body.endDate ?? null, body.status ?? null, req.event.id]
  );
  return ok(res, { id: e.id, name: e.name, status: e.status }, 'Event updated');
}));

router.delete('/:eventId', loadEvent, requireOrganiser, asyncHandler(async (req, res) => {
  await query('DELETE FROM events WHERE id = $1', [req.event.id]);
  return ok(res, null, 'Event deleted');
}));

/* ------------------------------------------------------------ participants */

router.post('/:eventId/participants', loadEvent, asyncHandler(async (req, res) => {
  const body = parse(z.object({ displayName: z.string().trim().min(1, 'is required').max(120) }), req.body);
  const { rows: [p] } = await query(
    'INSERT INTO event_participants (event_id, display_name) VALUES ($1, $2) RETURNING *',
    [req.event.id, body.displayName]
  );
  return created(res, {
    id: p.id, name: p.display_name, role: p.role, hasAccount: false, paid: 0, share: 0, net: 0,
  }, `${p.display_name} added`);
}));

router.delete('/:eventId/participants/:participantId', loadEvent, requireOrganiser, asyncHandler(async (req, res) => {
  const { rows: [p] } = await query(
    'SELECT * FROM event_participants WHERE id = $1 AND event_id = $2',
    [req.params.participantId, req.event.id]
  );
  if (!p) throw ApiError.notFound('Participant not found');
  if (p.role === 'ORGANISER') throw ApiError.badRequest('The organiser cannot be removed');

  const { rows: [{ count }] } = await query(
    `SELECT (SELECT COUNT(*) FROM event_expenses WHERE paid_by = $1)
          + (SELECT COUNT(*) FROM event_expense_shares WHERE participant_id = $1) AS count`,
    [p.id]
  );
  if (Number(count) > 0) throw ApiError.badRequest(`${p.display_name} is already on some expenses — remove those first`);

  await query('DELETE FROM event_participants WHERE id = $1', [p.id]);
  return ok(res, null, `${p.display_name} removed`);
}));

/* ---------------------------------------------------------- event expenses */

const eventExpenseSchema = z.object({
  item: z.string().trim().min(1, 'is required').max(255),
  amount: z.coerce.number().positive('must be greater than zero').max(99_999_999),
  categoryKey: z.string().trim().max(64).default('OTHERS'),
  paidBy: z.string().uuid('choose who paid'),
  spentOn: dateString.optional(),
  note: z.string().trim().max(500).optional(),
  splitMode: z.enum(['EQUAL', 'CUSTOM']).default('CUSTOM'),
  /** EQUAL: who to divide between. */
  participantIds: z.array(z.string().uuid()).min(1).optional(),
  /** CUSTOM: exactly what each person owes; must add up to `amount`. */
  shares: z.array(z.object({
    participantId: z.string().uuid(),
    amount: z.coerce.number().min(0),
  })).min(1).optional(),
});

/** Normalise either split mode into a [{participantId, amount}] list that sums to `amount`. */
function resolveShares(body, validIds) {
  if (body.splitMode === 'EQUAL') {
    const ids = body.participantIds?.length ? body.participantIds : [...validIds];
    for (const id of ids) if (!validIds.has(id)) throw ApiError.badRequest('A selected person is not in this event');
    const amounts = equalShares(body.amount, ids.length);
    return ids.map((participantId, i) => ({ participantId, amount: amounts[i] }));
  }

  if (!body.shares?.length) throw ApiError.badRequest('Enter how much each person owes');

  const seen = new Set();
  for (const s of body.shares) {
    if (!validIds.has(s.participantId)) throw ApiError.badRequest('A selected person is not in this event');
    if (seen.has(s.participantId)) throw ApiError.badRequest('The same person is listed twice');
    seen.add(s.participantId);
  }

  const shares = body.shares.filter((s) => s.amount > 0).map((s) => ({ ...s, amount: money(s.amount) }));
  if (!shares.length) throw ApiError.badRequest('At least one person must have a share above zero');

  const sum = money(shares.reduce((t, s) => t + s.amount, 0));
  if (Math.abs(sum - money(body.amount)) > 0.01) {
    throw ApiError.badRequest(`Shares add up to ${sum.toFixed(2)} but the expense is ${money(body.amount).toFixed(2)}`);
  }
  return shares;
}

router.post('/:eventId/expenses', loadEvent, asyncHandler(async (req, res) => {
  if (req.event.status === 'SETTLED') throw ApiError.badRequest('This event is settled — reopen it to add expenses');
  const body = parse(eventExpenseSchema, req.body);

  const { rows: participants } = await query(
    'SELECT id FROM event_participants WHERE event_id = $1', [req.event.id]
  );
  const validIds = new Set(participants.map((p) => p.id));
  if (!validIds.has(body.paidBy)) throw ApiError.badRequest('The payer is not in this event');

  const shares = resolveShares(body, validIds);

  const expenseId = await withTransaction(async (client) => {
    const { rows: [x] } = await client.query(
      `INSERT INTO event_expenses (event_id, paid_by, item, category_key, amount, spent_on, split_mode, note, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8, $9) RETURNING id`,
      [req.event.id, body.paidBy, body.item, body.categoryKey, body.amount,
       body.spentOn || null, body.splitMode, body.note || null, req.user.id]
    );
    for (const s of shares) {
      await client.query(
        'INSERT INTO event_expense_shares (event_expense_id, participant_id, amount) VALUES ($1, $2, $3)',
        [x.id, s.participantId, s.amount]
      );
    }
    return x.id;
  });

  return created(res, { id: expenseId, shares }, 'Expense added to event');
}));

router.patch('/:eventId/expenses/:expenseId', loadEvent, asyncHandler(async (req, res) => {
  const body = parse(eventExpenseSchema, req.body);

  const { rows: [existing] } = await query(
    'SELECT * FROM event_expenses WHERE id = $1 AND event_id = $2',
    [req.params.expenseId, req.event.id]
  );
  if (!existing) throw ApiError.notFound('Expense not found');

  const { rows: participants } = await query(
    'SELECT id FROM event_participants WHERE event_id = $1', [req.event.id]
  );
  const validIds = new Set(participants.map((p) => p.id));
  if (!validIds.has(body.paidBy)) throw ApiError.badRequest('The payer is not in this event');

  const shares = resolveShares(body, validIds);

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE event_expenses
          SET item = $1, amount = $2, category_key = $3, paid_by = $4,
              spent_on = COALESCE($5::date, spent_on), split_mode = $6, note = $7
        WHERE id = $8`,
      [body.item, body.amount, body.categoryKey, body.paidBy,
       body.spentOn || null, body.splitMode, body.note || null, existing.id]
    );
    await client.query('DELETE FROM event_expense_shares WHERE event_expense_id = $1', [existing.id]);
    for (const s of shares) {
      await client.query(
        'INSERT INTO event_expense_shares (event_expense_id, participant_id, amount) VALUES ($1, $2, $3)',
        [existing.id, s.participantId, s.amount]
      );
    }
  });

  return ok(res, { id: existing.id, shares }, 'Expense updated');
}));

router.delete('/:eventId/expenses/:expenseId', loadEvent, asyncHandler(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM event_expenses WHERE id = $1 AND event_id = $2',
    [req.params.expenseId, req.event.id]
  );
  if (!rowCount) throw ApiError.notFound('Expense not found');
  return ok(res, null, 'Expense deleted');
}));

export default router;
