import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`\n[xpns] Missing required env var: ${name}`);
    console.error('[xpns] Copy server/.env.example to server/.env and fill it in.\n');
    process.exit(1);
  }
  return value;
}

/**
 * Accept the JDBC connection string Neon shows on its Java tab and convert it
 * to the URL node-postgres understands.
 *
 *   jdbc:postgresql://host/db?user=U&password=P&sslmode=require
 *   -> postgresql://U:P@host/db?sslmode=require
 *
 * Without this, `pg` silently fails to parse the host and falls back to
 * 127.0.0.1:5432, producing a baffling ECONNREFUSED on a cloud deploy.
 */
export function normalizeDatabaseUrl(raw) {
  // Env UIs and copy-paste love to bring along quotes and stray whitespace.
  let url = String(raw).trim().replace(/^["']|["']$/g, '');

  if (url.startsWith('jdbc:')) {
    url = url.slice('jdbc:'.length);

    const [base, queryString = ''] = url.split('?');
    const params = new URLSearchParams(queryString);

    const user = params.get('user');
    const password = params.get('password');
    params.delete('user');
    params.delete('password');
    // JDBC-only option that node-postgres does not understand.
    params.delete('channelBinding');

    if (user && !base.includes('@')) {
      const [scheme, hostAndPath] = base.split('://');
      const credentials = password
        ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
        : encodeURIComponent(user);
      url = `${scheme}://${credentials}@${hostAndPath}`;
    } else {
      url = base;
    }

    const rest = params.toString();
    if (rest) url += `?${rest}`;

    console.warn('[xpns] DATABASE_URL was a JDBC string; converted it to a postgresql:// URL.');
    console.warn('[xpns] Use the "Node.js" connection string from Neon to silence this.');
  }

  // Catch the remaining ways a bad value produces a confusing ECONNREFUSED.
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`\n[xpns] DATABASE_URL is not a valid URL.`);
    console.error('[xpns] Expected: postgresql://user:password@host/dbname?sslmode=require\n');
    process.exit(1);
  }

  if (!host) {
    console.error('\n[xpns] DATABASE_URL has no host — check for typos or stray quotes.\n');
    process.exit(1);
  }

  return url;
}

export const env = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: normalizeDatabaseUrl(required('DATABASE_URL')),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  nodeEnv: process.env.NODE_ENV || 'development',
};

// Log where we are connecting (never the password) so a bad deploy is obvious.
console.log(`[xpns] Database host: ${new URL(env.databaseUrl).hostname}`);
