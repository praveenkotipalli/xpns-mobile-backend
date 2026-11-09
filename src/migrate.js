import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), 'sql');

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );

  const files = readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(sqlDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  + ${file}`);
      ran += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\n[xpnz] Migration failed: ${file}\n`, err.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(ran === 0 ? '\n[xpnz] Database already up to date.' : `\n[xpnz] Applied ${ran} migration(s).`);
  await pool.end();
}

main();
