import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { query } from '../db.js';
import { ApiError, asyncHandler } from '../lib/http.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

/** Populates req.user from the Bearer token. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Missing Authorization header');

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    throw ApiError.unauthorized('Session expired, please log in again');
  }

  const { rows } = await query('SELECT id, name, email FROM users WHERE id = $1', [payload.sub]);
  if (!rows[0]) throw ApiError.unauthorized('Account no longer exists');

  req.user = rows[0];
  next();
});

/**
 * Resolves the space the caller is acting in and asserts membership.
 * Space comes from ?spaceId / body.spaceId, else the caller's first space.
 * Populates req.space = { id, name, currency, memberId, role }.
 */
export const requireSpace = asyncHandler(async (req, _res, next) => {
  const requested = req.query.spaceId || req.body?.spaceId || req.params.spaceId || null;

  const { rows } = await query(
    `SELECT s.id, s.name, s.currency, s.invite_code, s.owner_id,
            m.id AS member_id, m.role
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      WHERE ($2::uuid IS NULL OR s.id = $2::uuid)
      ORDER BY s.created_at
      LIMIT 1`,
    [req.user.id, requested]
  );

  if (!rows[0]) {
    throw requested
      ? ApiError.forbidden('You are not a member of that space')
      : ApiError.notFound('You have no space yet');
  }

  const s = rows[0];
  req.space = {
    id: s.id,
    name: s.name,
    currency: s.currency,
    inviteCode: s.invite_code,
    ownerId: s.owner_id,
    memberId: s.member_id,
    role: s.role,
  };
  next();
});

export const requireSpaceOwner = asyncHandler(async (req, _res, next) => {
  if (req.space.role !== 'OWNER') throw ApiError.forbidden('Only the space owner can do this');
  next();
});
