import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { inviteCode } from '../lib/ids.js';
import { requireAuth, signToken } from '../middleware/auth.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(2, 'must be at least 2 characters').max(120),
  email: z.string().trim().toLowerCase().email('must be a valid email'),
  password: z.string().min(6, 'must be at least 6 characters').max(128),
  spaceName: z.string().trim().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('must be a valid email'),
  password: z.string().min(1, 'is required'),
});

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

/**
 * Register. Creates the account, its personal space, and the owner member row
 * in one transaction so a new user always lands on a usable dashboard.
 */
router.post('/register', asyncHandler(async (req, res) => {
  const body = parse(registerSchema, req.body);

  const existing = await query('SELECT 1 FROM users WHERE email = $1', [body.email]);
  if (existing.rowCount) throw ApiError.conflict('An account with that email already exists');

  const passwordHash = await bcrypt.hash(body.password, 10);

  const result = await withTransaction(async (client) => {
    const { rows: [user] } = await client.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [body.name, body.email, passwordHash]
    );

    const spaceName = body.spaceName || `${body.name.split(' ')[0]}'s Money`;
    const { rows: [space] } = await client.query(
      'INSERT INTO spaces (name, owner_id, invite_code) VALUES ($1, $2, $3) RETURNING id, name, currency, invite_code',
      [spaceName, user.id, inviteCode()]
    );

    await client.query(
      `INSERT INTO space_members (space_id, user_id, name, role, color)
       VALUES ($1, $2, $3, 'OWNER', '#FFFFFF')`,
      [space.id, user.id, user.name]
    );

    return { user, space };
  });

  return created(res, {
    token: signToken(result.user),
    user: publicUser(result.user),
    space: {
      id: result.space.id,
      name: result.space.name,
      currency: result.space.currency,
      inviteCode: result.space.invite_code,
    },
  }, 'Account created');
}));

router.post('/login', asyncHandler(async (req, res) => {
  const body = parse(loginSchema, req.body);

  const { rows: [user] } = await query(
    'SELECT id, name, email, password_hash FROM users WHERE email = $1',
    [body.email]
  );
  // Same message either way — don't leak which emails are registered.
  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    throw ApiError.unauthorized('Incorrect email or password');
  }

  return ok(res, { token: signToken(user), user: publicUser(user) }, 'Welcome back');
}));

/** Current user + every space they belong to (used to bootstrap the app on launch). */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.currency, s.invite_code, m.role, m.id AS member_id
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      ORDER BY s.created_at`,
    [req.user.id]
  );

  return ok(res, {
    user: publicUser(req.user),
    spaces: rows.map((s) => ({
      id: s.id,
      name: s.name,
      currency: s.currency,
      inviteCode: s.invite_code,
      role: s.role,
      memberId: s.member_id,
    })),
  });
}));

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'is required'),
  newPassword: z.string().min(6, 'must be at least 6 characters').max(128),
});

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const body = parse(changePasswordSchema, req.body);
  const { rows: [user] } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);

  if (!(await bcrypt.compare(body.currentPassword, user.password_hash))) {
    throw ApiError.badRequest('Current password is incorrect');
  }

  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    await bcrypt.hash(body.newPassword, 10),
    req.user.id,
  ]);

  return ok(res, null, 'Password updated');
}));

export default router;
