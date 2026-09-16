import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import path from 'path';

import { config } from './config';
import { logger } from './utils/logger';
import { prisma } from './db';
import { errorHandler } from './middleware/errorHandler';
import { startIndexer, stopIndexer } from './workers/indexer';
import { clearAdminKeypair } from './services/stellar';

import authRoutes from './routes/auth';
import actorsRoutes from './routes/actors';
import batchesRoutes from './routes/batches';

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express();

// ─── Security & transport middleware ─────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: config.isProd,
    crossOriginEmbedderPolicy: config.isProd,
  })
);

app.use(
  cors({
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  })
);

app.use(compression());

// ─── Request logging ──────────────────────────────────────────────────────────

app.use(
  pinoHttp({
    logger,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    customSuccessMessage: (req, res) =>
      `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} ${res.statusCode} — ${err.message}`,
  })
);

// ─── Body parsing ─────────────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Trust proxy (for rate limiting behind load balancer/nginx) ───────────────

app.set('trust proxy', 1);

// ─── Rate limiting ────────────────────────────────────────────────────────────

// General: 200 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.', code: 'RATE_LIMITED' },
  skip: (req) => req.path === '/health',
});

// Auth routes: stricter — 20 requests per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.', code: 'AUTH_RATE_LIMITED' },
});

// Public batch verification (GET /batches/:id, GET /batches/:id/qr):
// 30 requests per minute per IP — prevents sequential enumeration scraping
const publicBatchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification requests, please slow down.', code: 'RATE_LIMITED' },
});

app.use(generalLimiter);
app.use('/auth', authLimiter);
app.use('/batches/:id', publicBatchLimiter);
// Also rate-limit the chainId lookup used by the QR verify flow
app.use('/batches/chain', publicBatchLimiter);
// Rate-limit the static QR image directory to match /batches/:id/qr.
// Without this, sequential enumeration of QR filenames bypasses the batch limiter.
app.use('/qr', publicBatchLimiter);

// ─── Static QR image serving ──────────────────────────────────────────────────

app.use('/qr', express.static(config.qrStoragePath, {
  maxAge: '1d',
  immutable: false,
  index: false,
}));

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.use('/auth', authRoutes);
app.use('/actors', actorsRoutes);
app.use('/batches', batchesRoutes);

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' });
});

// ─── Error handler (must be last) ────────────────────────────────────────────

app.use(errorHandler);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Graceful shutdown initiated');

  stopIndexer();

  // Clear the in-memory admin keypair so the secret does not linger
  // in process memory during the shutdown sequence.
  clearAdminKeypair();

  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      if (!server) return resolve();
      server.close(async () => {
        logger.info('HTTP server closed');
        resolve();
      });
    });

  await closeServer();

  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error({ err }, 'Error disconnecting from database');
  }
  process.exit(0);

  // Force exit after 30s if graceful shutdown hangs
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

// ─── Start server ─────────────────────────────────────────────────────────────
// Guard: in test mode supertest binds its own ephemeral port — do not start
// a persistent listener, which would hold the process open and conflict with
// the test runner's port management.

let server: ReturnType<typeof app.listen> | null = null;

if (process.env['NODE_ENV'] !== 'test') {
  server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, contractId: config.contractId },
      'Lineage backend started'
    );

    // Boot the chain event indexer
    startIndexer().catch((err) =>
      logger.error({ err }, 'Failed to start indexer')
    );
  });

  // Keep connections alive under load
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

export default app;
