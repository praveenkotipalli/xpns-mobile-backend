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

export const env = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  nodeEnv: process.env.NODE_ENV || 'development',
};
