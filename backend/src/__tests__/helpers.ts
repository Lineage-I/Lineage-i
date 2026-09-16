/**
 * Test helpers — shared setup/teardown and factory functions used across all
 * test suites. Uses a real SQLite database (in-memory via file:./test.db) so
 * every test run starts from a clean slate with actual Prisma queries.
 *
 * External services (Stellar RPC, IPFS/Pinata) are mocked at the module level
 * so tests never make real network calls.
 */

import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

export const TEST_JWT_SECRET = 'test-secret-at-least-32-chars-long!!';
export const TEST_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
export const TEST_ADMIN_SECRET = 'SCZANGBA5AAAH4D2FFMDJBVTABFUHBWFLU2OVAP7PKLQYQLWXKCIQB3K';
export const TEST_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

// Valid 56-char Stellar G... addresses for use in tests
export const ADDRESSES = {
  admin:       'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZV6AWNTPRUQATWCW4M0J',
  producer:    'GBVNKYJZ4PKXFBIPXJHEXKKCWCWQUPFOMFZ3BWLHVQNXJYWRPAVH2G7U',
  processor:   'GDMTVHLWJTHSUDMZVVMXXH6VJHA2ZV3HNG5LYNAZ6RTWB7GISM6YOXKZ',
  distributor: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RIGPZPD554755ZZTWUQ5',
  retailer:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN4',
  stranger:    'GCLWGQPMKXQSPF776IU33AH4PZNOOWNAWGGKVTBQMIC5IMKUNP3E6NVU',
};

/** Issue a real JWT the way the backend does — used in test auth headers. */
export function makeToken(address: string, role: string): string {
  return jwt.sign({ address, role }, TEST_JWT_SECRET, {
    expiresIn: '1h',
    issuer: 'lineage-backend',
    audience: 'lineage-frontend',
  });
}

/** Bearer header for supertest requests. */
export function authHeader(address: string, role: string): { Authorization: string } {
  return { Authorization: `Bearer ${makeToken(address, role)}` };
}

/**
 * Create a fresh PrismaClient pointing at the test SQLite database.
 * Each test file gets its own client + db file to avoid cross-suite pollution.
 */
export function createTestPrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: process.env['DATABASE_URL'] ?? 'file:./test.db' } },
    log: [],
  });
}

/** Wipe all tables between tests. Order matters for FK constraints. */
export async function clearDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.chainEvent.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.authChallenge.deleteMany();
  await prisma.actor.deleteMany();
  await prisma.indexerCheckpoint.deleteMany();
}
