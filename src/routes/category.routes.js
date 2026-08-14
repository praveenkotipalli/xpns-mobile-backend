import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError, asyncHandler, created, ok, parse } from '../lib/http.js';
import { requireAuth, requireSpace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireSpace);

const serialise = (c) => ({
  key: c.key,
  label: c.label,
  mainCategory: c.main_category,
  icon: c.icon,
  isCustom: Boolean(c.space_id),
});

/** Global defaults plus any custom categories this space has added. */
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM categories
      WHERE space_id IS NULL OR space_id = $1
      ORDER BY sort_order, label`,
    [req.space.id]
  );
  return ok(res, rows.map(serialise));
}));

const categorySchema = z.object({
  label: z.string().trim().min(1, 'is required').max(120),
  mainCategory: z.enum(['ESSENTIAL', 'EXPENSE', 'LOSE_OF_MONEY', 'OTHERS']).default('EXPENSE'),
  icon: z.string().trim().max(32).default('pricetag'),
  spaceId: z.string().uuid().optional(),
});

router.post('/', asyncHandler(async (req, res) => {
  const body = parse(categorySchema, req.body);
  const key = body.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
  if (!key) throw ApiError.badRequest('Category name must contain letters or numbers');

  const clash = await query(
    'SELECT 1 FROM categories WHERE key = $1 AND (space_id IS NULL OR space_id = $2)', [key, req.space.id]
  );
  if (clash.rowCount) throw ApiError.conflict('A category with that name already exists');

  const { rows: [c] } = await query(
    `INSERT INTO categories (space_id, key, label, main_category, icon, sort_order)
     VALUES ($1, $2, $3, $4, $5, 500) RETURNING *`,
    [req.space.id, key, body.label, body.mainCategory, body.icon]
  );
  return created(res, serialise(c), 'Category added');
}));

router.delete('/:key', asyncHandler(async (req, res) => {
  const { rows: [{ count }] } = await query(
    'SELECT COUNT(*)::int AS count FROM expenses WHERE space_id = $1 AND category_key = $2',
    [req.space.id, req.params.key]
  );
  if (count > 0) throw ApiError.badRequest(`${count} expense(s) still use this category`);

  const { rowCount } = await query(
    'DELETE FROM categories WHERE key = $1 AND space_id = $2', [req.params.key, req.space.id]
  );
  if (!rowCount) throw ApiError.notFound('Custom category not found (built-in ones cannot be deleted)');
  return ok(res, null, 'Category deleted');
}));

export default router;
