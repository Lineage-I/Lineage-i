/**
 * Integration tests — /batches endpoints
 *
 * GET  /batches/chain/:chainId   — public batch lookup by on-chain ID
 * GET  /batches/:id              — batch lookup by DB CUID
 * GET  /batches                  — authenticated actor's batch list
 * POST /batches/prepare          — Producer: upload docs, get unsigned XDR
 * POST /batches                  — Producer: submit signed XDR, persist batch
 * POST /batches/:id/transfer/prepare  — Actor: get unsigned transfer XDR
 * POST /batches/:id/transfer          — Actor: submit signed transfer
 *
 * Stellar RPC, IPFS, and QR code generation are all mocked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../index';
import { ADDRESSES, authHeader, clearDatabase, createTestPrisma } from './helpers';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../services/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stellar')>();
  return {
    ...actual,
    buildRegisterBatchTx: vi.fn().mockResolvedValue('UNSIGNED_XDR_REGISTER'),
    buildTransferCustodyTx: vi.fn().mockResolvedValue('UNSIGNED_XDR_TRANSFER'),
    submitSignedXdr: vi.fn().mockResolvedValue({
      hash: 'mocktxhash_submitted',
      returnValue: {
        // scValToNative will be called on this — return a BigInt-compatible value
        _type: 'scvU64',
        u64: BigInt(1),
      },
    }),
    extractXdrSigner: vi.fn().mockImplementation((xdr: string) => {
      // Return the producer address by default; tests can override
      return xdr.startsWith('TRANSFER_')
        ? xdr.replace('TRANSFER_', '')
        : ADDRESSES.producer;
    }),
    clearAdminKeypair: vi.fn(),
  };
});

vi.mock('../services/ipfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ipfs')>();
  return {
    ...actual,
    uploadToIPFS: vi.fn().mockResolvedValue({
      cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      url: 'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    }),
  };
});

vi.mock('../services/qr', () => ({
  generateQRCode: vi.fn().mockResolvedValue('./storage/qr/1.png'),
}));

// scValToNative needs to work for the mocked returnValue
vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    scValToNative: vi.fn().mockReturnValue(BigInt(1)),
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
  // Seed required actors
  await prisma.actor.createMany({
    data: [
      { address: ADDRESSES.admin,       role: 'Admin',       name: 'Admin',   active: true },
      { address: ADDRESSES.producer,    role: 'Producer',    name: 'FarmCo',  active: true },
      { address: ADDRESSES.processor,   role: 'Processor',   name: 'MillCo',  active: true },
      { address: ADDRESSES.distributor, role: 'Distributor', name: 'LogiCo',  active: true },
    ],
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function seedBatch(opts: {
  chainId?: bigint;
  producerAddr?: string;
  currentHolder?: string;
} = {}): Promise<{ id: string; chainId: bigint }> {
  const batch = await prisma.batch.create({
    data: {
      chainId:      opts.chainId      ?? BigInt(1),
      producerAddr: opts.producerAddr ?? ADDRESSES.producer,
      metadataHash: 'a'.repeat(64),
      metadata:     JSON.stringify({ productName: 'Arabica Coffee' }),
      currentHolder: opts.currentHolder ?? opts.producerAddr ?? ADDRESSES.producer,
      qrCodePath:   './storage/qr/1.png',
    },
  });
  return { id: batch.id, chainId: batch.chainId };
}

// ─── GET /batches/chain/:chainId ──────────────────────────────────────────────

describe('GET /batches/chain/:chainId', () => {
  it('returns a batch by its on-chain ID', async () => {
    await seedBatch({ chainId: BigInt(42) });

    const res = await request(app).get('/batches/chain/42').expect(200);
    expect(res.body.batch.chainId).toBe('42');
  });

  it('returns 404 for an unknown chainId', async () => {
    const res = await request(app).get('/batches/chain/9999').expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 400 for a non-integer chainId', async () => {
    const res = await request(app).get('/batches/chain/notanumber').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('includes resolved producer actor info', async () => {
    await seedBatch({ chainId: BigInt(1) });

    const res = await request(app).get('/batches/chain/1').expect(200);
    expect(res.body.batch.producer).not.toBeNull();
    expect(res.body.batch.producer.address).toBe(ADDRESSES.producer);
  });

  it('serialises chainId as a string (not a number) to avoid JS BigInt truncation', async () => {
    await seedBatch({ chainId: BigInt(999999999999999) });

    const res = await request(app).get('/batches/chain/999999999999999').expect(200);
    expect(typeof res.body.batch.chainId).toBe('string');
    expect(res.body.batch.chainId).toBe('999999999999999');
  });
});

// ─── GET /batches/:id ─────────────────────────────────────────────────────────

describe('GET /batches/:id', () => {
  it('returns a batch by DB CUID', async () => {
    const { id } = await seedBatch();

    const res = await request(app).get(`/batches/${id}`).expect(200);
    expect(res.body.batch.id).toBe(id);
  });

  it('returns 404 for an unknown CUID', async () => {
    const res = await request(app).get('/batches/cnonexistentid').expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ─── GET /batches (authenticated) ────────────────────────────────────────────

describe('GET /batches', () => {
  it('returns batches where actor is producer or currentHolder', async () => {
    await seedBatch({ chainId: BigInt(1), producerAddr: ADDRESSES.producer, currentHolder: ADDRESSES.producer });
    await seedBatch({ chainId: BigInt(2), producerAddr: ADDRESSES.producer, currentHolder: ADDRESSES.processor });
    await seedBatch({ chainId: BigInt(3), producerAddr: ADDRESSES.processor, currentHolder: ADDRESSES.processor });

    const res = await request(app)
      .get('/batches')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .expect(200);

    // Producer created batches 1 and 2; should see both
    const chainIds = res.body.batches.map((b: { chainId: string }) => b.chainId);
    expect(chainIds).toContain('1');
    expect(chainIds).toContain('2');
    expect(chainIds).not.toContain('3');
  });

  it('returns 401 without a token', async () => {
    await request(app).get('/batches').expect(401);
  });

  it('returns paginated response with pagination metadata', async () => {
    const res = await request(app)
      .get('/batches?page=1&limit=10')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .expect(200);

    expect(res.body).toHaveProperty('pagination');
    expect(res.body.pagination).toHaveProperty('total');
    expect(res.body.pagination).toHaveProperty('page', 1);
    expect(res.body.pagination).toHaveProperty('limit', 10);
  });

  it('returns 401 for a deactivated actor', async () => {
    await prisma.actor.update({
      where: { address: ADDRESSES.producer },
      data: { active: false },
    });

    await request(app)
      .get('/batches')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .expect(401);
  });
});

// ─── POST /batches/prepare ────────────────────────────────────────────────────

describe('POST /batches/prepare', () => {
  it('returns unsignedXdr and metadataHash for a Producer', async () => {
    const res = await request(app)
      .post('/batches/prepare')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .field('metadata', JSON.stringify({ productName: 'Arabica Coffee', origin: 'Ethiopia' }))
      .expect(200);

    expect(res.body).toHaveProperty('unsignedXdr', 'UNSIGNED_XDR_REGISTER');
    expect(res.body).toHaveProperty('metadataHash');
    expect(res.body.metadataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns 403 for a non-Producer actor', async () => {
    await request(app)
      .post('/batches/prepare')
      .set(authHeader(ADDRESSES.processor, 'Processor'))
      .field('metadata', JSON.stringify({ productName: 'Test' }))
      .expect(403);
  });

  it('returns 401 with no token', async () => {
    await request(app)
      .post('/batches/prepare')
      .field('metadata', JSON.stringify({ productName: 'Test' }))
      .expect(401);
  });

  it('returns 400 for invalid metadata JSON', async () => {
    const res = await request(app)
      .post('/batches/prepare')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .field('metadata', 'not json {{{')
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

// ─── POST /batches ────────────────────────────────────────────────────────────

describe('POST /batches (submit)', () => {
  const validPayload = {
    signedXdr: 'SIGNED_XDR',
    metadataHash: 'a'.repeat(64),
    metadata: { productName: 'Arabica Coffee', origin: 'Ethiopia' },
    ipfsCids: [],
  };

  it('creates and returns a batch with a chainId', async () => {
    const res = await request(app)
      .post('/batches')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .send(validPayload)
      .expect(201);

    expect(res.body.batch).toHaveProperty('chainId');
    expect(res.body).toHaveProperty('txHash', 'mocktxhash_submitted');
  });

  it('returns 403 for a non-Producer', async () => {
    await request(app)
      .post('/batches')
      .set(authHeader(ADDRESSES.processor, 'Processor'))
      .send(validPayload)
      .expect(403);
  });

  it('returns 400 when metadataHash is not 64-char hex', async () => {
    const res = await request(app)
      .post('/batches')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .send({ ...validPayload, metadataHash: 'tooshort' })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

// ─── POST /batches/:id/transfer/prepare ───────────────────────────────────────

describe('POST /batches/:id/transfer/prepare', () => {
  it('returns unsignedXdr for the current holder', async () => {
    const { id } = await seedBatch({ currentHolder: ADDRESSES.producer });

    const res = await request(app)
      .post(`/batches/${id}/transfer/prepare`)
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .field('toAddress', ADDRESSES.processor)
      .field('location', 'Farm Gate, Kenya')
      .expect(200);

    expect(res.body).toHaveProperty('unsignedXdr', 'UNSIGNED_XDR_TRANSFER');
    expect(res.body).toHaveProperty('docHash');
  });

  it('returns 403 when caller is not the current holder', async () => {
    const { id } = await seedBatch({ currentHolder: ADDRESSES.processor });

    const res = await request(app)
      .post(`/batches/${id}/transfer/prepare`)
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .field('toAddress', ADDRESSES.distributor)
      .field('location', 'Farm Gate')
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 404 for a non-existent batch', async () => {
    const res = await request(app)
      .post('/batches/nonexistentid/transfer/prepare')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .field('toAddress', ADDRESSES.processor)
      .field('location', 'Farm Gate')
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 400 when location is missing', async () => {
    const { id } = await seedBatch({ currentHolder: ADDRESSES.producer });

    const res = await request(app)
      .post(`/batches/${id}/transfer/prepare`)
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .field('toAddress', ADDRESSES.processor)
      // no location
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

// ─── POST /batches/:id/transfer ───────────────────────────────────────────────

describe('POST /batches/:id/transfer (submit)', () => {
  it('records the transfer and updates currentHolder', async () => {
    const { id } = await seedBatch({ currentHolder: ADDRESSES.producer });

    const res = await request(app)
      .post(`/batches/${id}/transfer`)
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .send({
        signedXdr: ADDRESSES.producer, // extractXdrSigner mock keyed on this
        toAddress: ADDRESSES.processor,
        location: 'Farm Gate, Kenya',
        docHash: 'b'.repeat(64),
      })
      .expect(200);

    expect(res.body).toHaveProperty('txHash', 'mocktxhash_submitted');
    expect(res.body.event.toAddr).toBe(ADDRESSES.processor);

    // Verify DB — currentHolder should be updated
    const batch = await prisma.batch.findUnique({ where: { id } });
    expect(batch?.currentHolder).toBe(ADDRESSES.processor);
  });

  it('returns 403 when caller is not the current holder', async () => {
    const { id } = await seedBatch({ currentHolder: ADDRESSES.processor });

    const res = await request(app)
      .post(`/batches/${id}/transfer`)
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .send({
        signedXdr: ADDRESSES.producer,
        toAddress: ADDRESSES.distributor,
        location: 'Farm Gate',
      })
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 404 for a non-existent batch', async () => {
    const res = await request(app)
      .post('/batches/nonexistentid/transfer')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .send({
        signedXdr: ADDRESSES.producer,
        toAddress: ADDRESSES.processor,
        location: 'Farm Gate',
      })
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });
});
