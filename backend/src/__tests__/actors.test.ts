/**
 * Integration tests — /actors endpoints
 *
 * POST   /actors            (Admin only — register actor on-chain + DB)
 * GET    /actors            (Public — list active actors, optional role filter)
 * GET    /actors/:address   (Public — single actor by Stellar address)
 * PATCH  /actors/:address/deactivate  (Admin only)
 *
 * The Stellar on-chain calls (registerActor, deactivateActor) are mocked so
 * tests never hit the Soroban RPC.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import app from '../index';
import { ADDRESSES, authHeader, clearDatabase, createTestPrisma } from './helpers';

// ─── Mock Stellar on-chain calls ─────────────────────────────────────────────

vi.mock('../services/stellar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/stellar')>();
  return {
    ...actual,
    registerActor: vi.fn().mockResolvedValue('mocktxhash_register_actor'),
    deactivateActor: vi.fn().mockResolvedValue('mocktxhash_deactivate_actor'),
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
  // Seed the admin actor so requireAuth DB check passes for admin requests
  await prisma.actor.create({
    data: { address: ADDRESSES.admin, role: 'Admin', name: 'Admin', active: true },
  });
});

// ─── POST /actors ─────────────────────────────────────────────────────────────

describe('POST /actors', () => {
  it('registers a new actor and returns 201', async () => {
    const res = await request(app)
      .post('/actors')
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .send({
        address: ADDRESSES.producer,
        role: 'Producer',
        name: 'FarmCo',
        contactInfo: 'farm@example.com',
      })
      .expect(201);

    expect(res.body.actor.address).toBe(ADDRESSES.producer);
    expect(res.body.actor.role).toBe('Producer');
    expect(res.body.actor.name).toBe('FarmCo');
    expect(res.body.actor.active).toBe(true);
    expect(res.body.txHash).toBe('mocktxhash_register_actor');
  });

  it('returns 409 when actor already exists', async () => {
    await prisma.actor.create({
      data: { address: ADDRESSES.producer, role: 'Producer', name: 'FarmCo', active: true },
    });

    const res = await request(app)
      .post('/actors')
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .send({ address: ADDRESSES.producer, role: 'Producer', name: 'FarmCo' })
      .expect(409);

    expect(res.body.code).toBe('CONFLICT');
  });

  it('returns 400 for an invalid role', async () => {
    const res = await request(app)
      .post('/actors')
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .send({ address: ADDRESSES.producer, role: 'Hacker', name: 'BadActor' })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when Admin role is submitted (not allowed via API)', async () => {
    const res = await request(app)
      .post('/actors')
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .send({ address: ADDRESSES.producer, role: 'Admin', name: 'AnotherAdmin' })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 403 when called by a non-admin actor', async () => {
    await prisma.actor.create({
      data: { address: ADDRESSES.producer, role: 'Producer', name: 'FarmCo', active: true },
    });

    const res = await request(app)
      .post('/actors')
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .send({ address: ADDRESSES.processor, role: 'Processor', name: 'MillCo' })
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 401 with no auth token', async () => {
    await request(app)
      .post('/actors')
      .send({ address: ADDRESSES.producer, role: 'Producer', name: 'FarmCo' })
      .expect(401);
  });
});

// ─── GET /actors ──────────────────────────────────────────────────────────────

describe('GET /actors', () => {
  beforeEach(async () => {
    await prisma.actor.createMany({
      data: [
        { address: ADDRESSES.producer,    role: 'Producer',    name: 'FarmCo',   active: true },
        { address: ADDRESSES.processor,   role: 'Processor',   name: 'MillCo',   active: true },
        { address: ADDRESSES.distributor, role: 'Distributor', name: 'LogiCo',   active: false },
      ],
    });
  });

  it('lists only active actors', async () => {
    const res = await request(app).get('/actors').expect(200);
    // admin + producer + processor (distributor is inactive)
    const addresses = res.body.actors.map((a: { address: string }) => a.address);
    expect(addresses).toContain(ADDRESSES.producer);
    expect(addresses).toContain(ADDRESSES.processor);
    expect(addresses).not.toContain(ADDRESSES.distributor);
  });

  it('filters by role', async () => {
    const res = await request(app).get('/actors?role=Producer').expect(200);
    expect(res.body.actors).toHaveLength(1);
    expect(res.body.actors[0].address).toBe(ADDRESSES.producer);
  });

  it('returns 400 for an invalid role filter', async () => {
    const res = await request(app).get('/actors?role=Hacker').expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns total count matching actors array length', async () => {
    const res = await request(app).get('/actors').expect(200);
    expect(res.body.total).toBe(res.body.actors.length);
  });
});

// ─── GET /actors/:address ─────────────────────────────────────────────────────

describe('GET /actors/:address', () => {
  beforeEach(async () => {
    await prisma.actor.create({
      data: { address: ADDRESSES.producer, role: 'Producer', name: 'FarmCo', active: true },
    });
  });

  it('returns the actor for a known address', async () => {
    const res = await request(app)
      .get(`/actors/${ADDRESSES.producer}`)
      .expect(200);

    expect(res.body.actor.address).toBe(ADDRESSES.producer);
    expect(res.body.actor.role).toBe('Producer');
  });

  it('returns 404 for an unknown address', async () => {
    const res = await request(app)
      .get(`/actors/${ADDRESSES.stranger}`)
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ─── PATCH /actors/:address/deactivate ────────────────────────────────────────

describe('PATCH /actors/:address/deactivate', () => {
  beforeEach(async () => {
    await prisma.actor.create({
      data: { address: ADDRESSES.producer, role: 'Producer', name: 'FarmCo', active: true },
    });
  });

  it('deactivates an active actor', async () => {
    const res = await request(app)
      .patch(`/actors/${ADDRESSES.producer}/deactivate`)
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .expect(200);

    expect(res.body.actor.active).toBe(false);
    expect(res.body.txHash).toBe('mocktxhash_deactivate_actor');

    // Verify DB state
    const dbActor = await prisma.actor.findUnique({ where: { address: ADDRESSES.producer } });
    expect(dbActor?.active).toBe(false);
  });

  it('returns 409 when actor is already deactivated', async () => {
    await prisma.actor.update({
      where: { address: ADDRESSES.producer },
      data: { active: false },
    });

    const res = await request(app)
      .patch(`/actors/${ADDRESSES.producer}/deactivate`)
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .expect(409);

    expect(res.body.code).toBe('CONFLICT');
  });

  it('returns 404 for a non-existent actor', async () => {
    const res = await request(app)
      .patch(`/actors/${ADDRESSES.stranger}/deactivate`)
      .set(authHeader(ADDRESSES.admin, 'Admin'))
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 403 for a non-admin caller', async () => {
    const res = await request(app)
      .patch(`/actors/${ADDRESSES.producer}/deactivate`)
      .set(authHeader(ADDRESSES.producer, 'Producer'))
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });
});
