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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The space a request names, from the URL, the query string or the body.
 *
 * The app sends it as `?spaceId=`; some screens also put it in the body. When
 * both are present they must agree — otherwise the membership check would run
 * against one space while the handler wrote to the other.
 */
export function requestedSpaceId(req) {
  const named = [req.params?.spaceId, req.query?.spaceId, req.body?.spaceId]
    .filter((value) => value !== undefined && value !== null && value !== '');

  for (const value of named) {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw ApiError.badRequest('spaceId is not a valid space id');
    }
  }
  if (new Set(named.map((id) => id.toLowerCase())).size > 1) {
    throw ApiError.badRequest('The request names two different spaces');
  }
  return named[0] || null;
}

/**
 * The caller's membership in one space, or null.
 *
 * Isolation rule: a request acts in the space it names, and nowhere else. The
 * old fallback quietly picked the caller's *oldest* space whenever a request
 * did not name one, so money moved from the Money tab landed in a different
 * space from the one on screen and seemed to vanish. Now a space is only
 * inferred when there is no choice to make — the caller belongs to exactly one.
 *
 * `{ strict: false }` returns null instead of throwing, for screens that only
 * show the shared side as context.
 */
export async function resolveSpace(userId, requested, { strict = true } = {}) {
  const { rows } = await query(
    `SELECT s.id, s.name, s.currency, s.invite_code, s.owner_id,
            m.id AS member_id, m.role
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      WHERE ($2::uuid IS NULL OR s.id = $2::uuid)
      ORDER BY s.created_at
      LIMIT 2`,
    [userId, requested]
  );

  let problem = null;
  if (requested && !rows.length) problem = ApiError.forbidden('You are not a member of that space');
  else if (!rows.length) problem = ApiError.notFound('You have no space yet');
  else if (rows.length > 1) problem = ApiError.badRequest('Choose which space this is for');

  if (problem) {
    if (strict) throw problem;
    return null;
  }

  const s = rows[0];
  return {
    id: s.id,
    name: s.name,
    currency: s.currency,
    inviteCode: s.invite_code,
    ownerId: s.owner_id,
    memberId: s.member_id,
    role: s.role,
  };
}

/**
 * Resolves the space the caller is acting in and asserts membership.
 * Populates req.space = { id, name, currency, inviteCode, ownerId, memberId, role }.
 */
export const requireSpace = asyncHandler(async (req, _res, next) => {
  req.space = await resolveSpace(req.user.id, requestedSpaceId(req));
  next();
});

export const requireSpaceOwner = asyncHandler(async (req, _res, next) => {
  if (req.space.role !== 'OWNER') throw ApiError.forbidden('Only the space owner can do this');
  next();
});
