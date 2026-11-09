import pg from 'pg';
import { env } from './env.js';

// Neon serves numeric/decimal as strings by default. Every money column in this
// schema is NUMERIC(12,2) and always fits in a JS number, so parse them eagerly
// — the app never has to remember to Number() a balance.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => (value === null ? null : parseFloat(value)));
// DATE -> 'YYYY-MM-DD' string instead of a timezone-shifted Date object.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  // Neon always needs TLS; a local/dev Postgres usually has none.
  ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(env.databaseUrl) ? false : { rejectUnauthorized: false },
  // Neon's free tier caps concurrent connections; lower PG_POOL_MAX if you hit it.
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', (err) => {
  console.error('[xpnz] Unexpected idle client error', err);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
