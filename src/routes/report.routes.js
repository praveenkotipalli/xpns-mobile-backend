import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, ok, parse } from '../lib/http.js';
import { requireAuth, requireSpace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireSpace);

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/**
 * Month-by-month totals for a year, mirroring MonthlyReport from the Spring app.
 * Each month carries a per-category and per-member breakdown.
 */
router.get('/monthly', asyncHandler(async (req, res) => {
  const f = parse(z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    memberId: z.string().uuid().optional(),
    groupBy: z.enum(['SUB', 'MAIN']).default('SUB'),
  }), req.query);

  const groupExpr = f.groupBy === 'MAIN' ? 'COALESCE(c.main_category, \'OTHERS\')' : 'e.category_key';

  const { rows } = await query(
    `SELECT EXTRACT(MONTH FROM e.spent_on)::int AS month_no,
            ${groupExpr}                        AS group_key,
            MAX(COALESCE(c.label, e.category_key)) AS group_label,
            MAX(COALESCE(c.main_category, 'OTHERS')) AS main_category,
            MAX(COALESCE(c.icon, 'pricetag'))   AS icon,
            SUM(e.amount)                       AS total,
            COUNT(*)::int                       AS count
       FROM expenses e
       LEFT JOIN categories c ON c.key = e.category_key
                             AND (c.space_id IS NULL OR c.space_id = e.space_id)
      WHERE e.space_id = $1
        AND EXTRACT(YEAR FROM e.spent_on) = $2
        AND ($3::uuid IS NULL OR e.member_id = $3::uuid)
      GROUP BY month_no, group_key
      ORDER BY month_no, total DESC`,
    [req.space.id, f.year, f.memberId || null]
  );

  const { rows: byMember } = await query(
    `SELECT EXTRACT(MONTH FROM e.spent_on)::int AS month_no,
            m.id, m.name, m.color, SUM(e.amount) AS total
       FROM expenses e
       JOIN space_members m ON m.id = e.member_id
      WHERE e.space_id = $1 AND EXTRACT(YEAR FROM e.spent_on) = $2
        AND ($3::uuid IS NULL OR e.member_id = $3::uuid)
      GROUP BY month_no, m.id, m.name, m.color
      ORDER BY month_no, total DESC`,
    [req.space.id, f.year, f.memberId || null]
  );

  const months = new Map();
  const monthEntry = (n) => {
    if (!months.has(n)) {
      months.set(n, { month: MONTH_NAMES[n - 1], monthNo: n, total: 0, breakdown: [], members: [] });
    }
    return months.get(n);
  };

  for (const r of rows) {
    const m = monthEntry(r.month_no);
    const total = Number(r.total);
    m.total += total;
    m.breakdown.push({
      key: r.group_key,
      label: f.groupBy === 'MAIN' ? titleise(r.group_key) : r.group_label,
      mainCategory: r.main_category,
      icon: r.icon,
      total,
      count: r.count,
    });
  }

  for (const r of byMember) {
    monthEntry(r.month_no).members.push({
      id: r.id, name: r.name, color: r.color, total: Number(r.total),
    });
  }

  const list = [...months.values()].sort((a, b) => a.monthNo - b.monthNo);
  // Percentages are easier to compute here than in every chart on the client.
  for (const m of list) {
    for (const b of m.breakdown) b.percentage = m.total ? round(b.total * 100 / m.total) : 0;
    for (const p of m.members) p.percentage = m.total ? round(p.total * 100 / m.total) : 0;
  }

  return ok(res, {
    year: f.year,
    groupBy: f.groupBy,
    yearTotal: round(list.reduce((sum, m) => sum + m.total, 0)),
    months: list,
  });
}));

/** Single-period snapshot used by the Reports tab header. */
router.get('/summary', asyncHandler(async (req, res) => {
  const now = new Date();
  const f = parse(z.object({
    month: z.coerce.number().int().min(1).max(12).default(now.getMonth() + 1),
    year: z.coerce.number().int().min(2000).max(2100).default(now.getFullYear()),
    memberId: z.string().uuid().optional(),
  }), req.query);

  const params = [req.space.id, f.month, f.year, f.memberId || null];
  const where = `e.space_id = $1
     AND EXTRACT(MONTH FROM e.spent_on) = $2
     AND EXTRACT(YEAR  FROM e.spent_on) = $3
     AND ($4::uuid IS NULL OR e.member_id = $4::uuid)`;

  const [{ rows: totalRows }, { rows: catRows }, { rows: memberRows }, { rows: mainRows }, { rows: dayRows }] =
    await Promise.all([
      query(`SELECT COALESCE(SUM(e.amount), 0) AS total, COUNT(*)::int AS count FROM expenses e WHERE ${where}`, params),
      query(
        `SELECT e.category_key AS key, MAX(COALESCE(c.label, e.category_key)) AS label,
                MAX(COALESCE(c.icon, 'pricetag')) AS icon, SUM(e.amount) AS total, COUNT(*)::int AS count
           FROM expenses e
           LEFT JOIN categories c ON c.key = e.category_key AND (c.space_id IS NULL OR c.space_id = e.space_id)
          WHERE ${where} GROUP BY e.category_key ORDER BY total DESC`, params),
      query(
        `SELECT m.id, m.name, m.color, SUM(e.amount) AS total, COUNT(*)::int AS count
           FROM expenses e JOIN space_members m ON m.id = e.member_id
          WHERE ${where} GROUP BY m.id, m.name, m.color ORDER BY total DESC`, params),
      query(
        `SELECT COALESCE(c.main_category, 'OTHERS') AS key, SUM(e.amount) AS total
           FROM expenses e
           LEFT JOIN categories c ON c.key = e.category_key AND (c.space_id IS NULL OR c.space_id = e.space_id)
          WHERE ${where} GROUP BY 1 ORDER BY total DESC`, params),
      query(`SELECT e.spent_on AS day, SUM(e.amount) AS total FROM expenses e WHERE ${where} GROUP BY day ORDER BY day`, params),
    ]);

  const total = Number(totalRows[0].total);
  const withPct = (r) => ({ ...r, total: Number(r.total), percentage: total ? round(Number(r.total) * 100 / total) : 0 });

  return ok(res, {
    month: f.month,
    monthName: MONTH_NAMES[f.month - 1],
    year: f.year,
    total,
    count: totalRows[0].count,
    byCategory: catRows.map(withPct),
    byMember: memberRows.map(withPct),
    byMainCategory: mainRows.map((r) => ({ ...withPct(r), label: titleise(r.key) })),
    daily: dayRows.map((r) => ({ date: r.day, total: Number(r.total) })),
  });
}));

const round = (n) => Math.round(n * 100) / 100;
const titleise = (key) =>
  key.toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\w/g, (ch) => ch.toUpperCase());

export default router;
