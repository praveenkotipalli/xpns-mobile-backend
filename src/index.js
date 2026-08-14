import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { env } from './env.js';
import { query } from './db.js';
import { asyncHandler, errorHandler, ok } from './lib/http.js';
import authRoutes from './routes/auth.routes.js';
import spaceRoutes from './routes/space.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import expenseRoutes from './routes/expense.routes.js';
import categoryRoutes from './routes/category.routes.js';
import reportRoutes from './routes/report.routes.js';
import eventRoutes from './routes/event.routes.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

// Without asyncHandler a rejected query would leave the request hanging forever
// instead of returning an error — which is exactly what a bad DATABASE_URL looks like.
app.get('/health', asyncHandler(async (_req, res) => {
  try {
    const { rows } = await query('SELECT now() AS time');
    return ok(res, { status: 'up', db: 'connected', time: rows[0].time });
  } catch (err) {
    // Report the reason rather than a blank 500 — this is the first thing you
    // hit after a deploy, so it should say what is wrong.
    return res.status(503).json({
      success: false,
      message: 'Server is up but cannot reach the database',
      detail: err.message,
      hint: 'Check DATABASE_URL. It must be postgresql://user:pass@host/db?sslmode=require (not a jdbc: URL).',
    });
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/spaces', spaceRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/events', eventRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

app.listen(env.port, '0.0.0.0', () => {
  console.log(`\n  xpns server listening on http://0.0.0.0:${env.port}`);
  console.log(`  Health check: http://localhost:${env.port}/health\n`);
});

// Exported so a serverless host can use the app directly as a handler.
export default app;
