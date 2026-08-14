import { ZodError } from 'zod';

/** Error with an HTTP status attached; thrown anywhere, rendered by errorHandler. */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }

  static badRequest(message, details) { return new ApiError(400, message, details); }
  static unauthorized(message = 'Not authenticated') { return new ApiError(401, message); }
  static forbidden(message = 'You do not have access to this') { return new ApiError(403, message); }
  static notFound(message = 'Not found') { return new ApiError(404, message); }
  static conflict(message) { return new ApiError(409, message); }
}

/** Wrap an async route handler so rejected promises reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export const ok = (res, data, message) => res.json({ success: true, message, data });
export const created = (res, data, message) => res.status(201).json({ success: true, message, data });

/** Parse `body` with a zod schema, converting failures into a 400. */
export function parse(schema, body) {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.errors[0];
      const field = first.path.join('.');
      throw ApiError.badRequest(field ? `${field}: ${first.message}` : first.message, err.errors);
    }
    throw err;
  }
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, message: err.message, details: err.details });
  }
  // Postgres unique violation
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'That record already exists' });
  }
  console.error('[xpns] Unhandled error:', err);
  return res.status(500).json({ success: false, message: 'Internal server error' });
}
