/**
 * Integration tests — GET /auth/challenge  &  POST /auth/verify
 *
 * Stellar signature verification and the Freighter wallet are mocked so tests
 * never require a real keypair or network connection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../index';
import { ADDRESSES, clearDatabase, createTestPrisma } from './helpers';

// ─── Mock external Stellar calls ─────────────────────────────────────────────
// We mock tweetnacl so signature verification always passes in tests, and mock
// TransactionBuilder.fromXDR so the XDR parsing path succeeds with a fake tx.

vi.mock('tweetnacl', () => ({
  default: {
    sign: {
      detached: {
        verify: vi.fn().mockReturnValue(true),
      },
    },
  },
}));

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: vi.fn().mockReturnValue({
        source: ADDRESSES.producer,
        memo: { type: 'text', value: 'aabbccddee0011223344556677' },
        signatures: [{ signature: () => Buffer.alloc(64) }],
        hash: () => Buffer.alloc(32),
      }),
    },
  };
});

// ─── Setup ───────────────────────────────────────────────────────────────────

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createTestPrisma();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearDatabase(prisma);
});

// ─── GET /auth/challenge ──────────────────────────────────────────────────────

describe('GET /auth/challenge', () => {
  it('returns a 64-char hex challenge for a valid Stellar address', async () => {
    const res = await request(app)
      .get(`/auth/challenge?address=${ADDRESSES.producer}`)
      .expect(200);

    expect(res.body).toHaveProperty('challenge');
    expect(res.body.challenge).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns 400 for a missing address', async () => {
    const res = await request(app)
      .get('/auth/challenge')
      .expect(400);

    expect(res.body).toHaveProperty('code', 'BAD_REQUEST');
  });

  it('returns 400 for an invalid (non-Stellar) address', async () => {
    const res = await request(app)
      .get('/auth/challenge?address=notastellaraddress')
      .expect(400);

    expect(res.body).toHaveProperty('code', 'BAD_REQUEST');
  });

  it('returns 429 when more than 3 active challenges exist for the same address', async () => {
    // Seed 3 active challenges for the address
    const future = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.authChallenge.createMany({
      data: [
        { address: ADDRESSES.producer, challenge: 'a'.repeat(64), expiresAt: future },
        { address: ADDRESSES.producer, challenge: 'b'.repeat(64), expiresAt: future },
        { address: ADDRESSES.producer, challenge: 'c'.repeat(64), expiresAt: future },
      ],
    });

    const res = await request(app)
      .get(`/auth/challenge?address=${ADDRESSES.producer}`)
      .expect(429);

    expect(res.body.code).toBe('TOO_MANY_CHALLENGES');
  });

  it('cleans up expired challenges before issuing a new one', async () => {
    // Seed 3 expired challenges — should be cleaned up so a new one is issued
    const past = new Date(Date.now() - 1000);
    await prisma.authChallenge.createMany({
      data: [
        { address: ADDRESSES.producer, challenge: 'a'.repeat(64), expiresAt: past },
        { address: ADDRESSES.producer, challenge: 'b'.repeat(64), expiresAt: past },
        { address: ADDRESSES.producer, challenge: 'c'.repeat(64), expiresAt: past },
      ],
    });

    const res = await request(app)
      .get(`/auth/challenge?address=${ADDRESSES.producer}`)
      .expect(200);

    expect(res.body.challenge).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── POST /auth/verify ────────────────────────────────────────────────────────

describe('POST /auth/verify', () => {
  const validChallenge = 'aabbccddee00112233445566778899aabbccddee00112233445566778899aabb';

  async function seedChallenge(
    address = ADDRESSES.producer,
    challenge = validChallenge,
    expiresAt = new Date(Date.now() + 5 * 60 * 1000)
  ) {
    return prisma.authChallenge.create({ data: { address, challenge, expiresAt } });
  }

  async function seedActor(address = ADDRESSES.producer, role = 'Producer', active = true) {
    return prisma.actor.create({
      data: { address, role, name: 'Test Producer', active },
    });
  }

  it('issues a JWT token for a registered, active actor with a valid challenge', async () => {
    await seedChallenge();
    await seedActor();

    const res = await request(app)
      .post('/auth/verify')
      .send({
        address: ADDRESSES.producer,
        challenge: validChallenge,
        signedXdr: 'AAAAAQAAAA==',  // mocked — nacl.verify always returns true
      })
      .expect(200);

    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('actor');
    expect(res.body.actor.address).toBe(ADDRESSES.producer);
    expect(res.body.actor.role).toBe('Producer');
  });

  it('consumes the challenge (single-use)', async () => {
    await seedChallenge();
    await seedActor();

    // First verify succeeds
    await request(app)
      .post('/auth/verify')
      .send({ address: ADDRESSES.producer, challenge: validChallenge, signedXdr: 'AAAAAQAAAA==' })
      .expect(200);

    // Same challenge a second time must fail
    const res = await request(app)
      .post('/auth/verify')
      .send({ address: ADDRESSES.producer, challenge: validChallenge, signedXdr: 'AAAAAQAAAA==' })
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an unknown challenge', async () => {
    await seedActor();

    const res = await request(app)
      .post('/auth/verify')
      .send({
        address: ADDRESSES.producer,
        challenge: 'f'.repeat(64),
        signedXdr: 'AAAAAQAAAA==',
      })
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an expired challenge', async () => {
    await seedChallenge(ADDRESSES.producer, validChallenge, new Date(Date.now() - 1000));
    await seedActor();

    const res = await request(app)
      .post('/auth/verify')
      .send({
        address: ADDRESSES.producer,
        challenge: validChallenge,
        signedXdr: 'AAAAAQAAAA==',
      })
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 when actor is not registered', async () => {
    await seedChallenge();
    // No actor seeded

    const res = await request(app)
      .post('/auth/verify')
      .send({
        address: ADDRESSES.producer,
        challenge: validChallenge,
        signedXdr: 'AAAAAQAAAA==',
      })
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 401 when actor is deactivated', async () => {
    await seedChallenge();
    await seedActor(ADDRESSES.producer, 'Producer', false);

    const res = await request(app)
      .post('/auth/verify')
      .send({
        address: ADDRESSES.producer,
        challenge: validChallenge,
        signedXdr: 'AAAAAQAAAA==',
      })
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 for a missing signedXdr field', async () => {
    const res = await request(app)
      .post('/auth/verify')
      .send({ address: ADDRESSES.producer, challenge: validChallenge })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });
});
