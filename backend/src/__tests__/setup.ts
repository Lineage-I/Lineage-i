/**
 * Global test setup — runs before any test file.
 * Sets all required environment variables so config.ts passes validation
 * without a real .env file present.
 */

import { vi } from 'vitest';

// ── Environment ──────────────────────────────────────────────────────────────
// Must be set before any module that imports config.ts is loaded.
process.env['NODE_ENV']           = 'test';
process.env['DATABASE_URL']       = 'file:./test.db';
process.env['JWT_SECRET']         = 'test-secret-at-least-32-chars-long!!';
process.env['CONTRACT_ID']        = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
process.env['ADMIN_SECRET_KEY']   = 'SCZANGBA5AAAH4D2FFMDJBVTABFUHBWFLU2OVAP7PKLQYQLWXKCIQB3K';
process.env['SOROBAN_RPC_URL']    = 'https://soroban-testnet.stellar.org';
process.env['NETWORK_PASSPHRASE'] = 'Test SDF Network ; September 2015';
process.env['PORT']               = '0';      // random port — avoids conflicts
process.env['LOG_LEVEL']          = 'silent'; // suppress pino output in tests
process.env['PINATA_API_KEY']     = '';
process.env['PINATA_SECRET_KEY']  = '';

// ── Suppress indexer in tests ─────────────────────────────────────────────────
// The background indexer connects to the real Soroban RPC. Mock it out so
// tests start cleanly without network calls.
vi.mock('../workers/indexer', () => ({
  startIndexer: vi.fn().mockResolvedValue(undefined),
  stopIndexer:  vi.fn(),
}));
