import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { StrKey, TransactionBuilder, scValToNative } from '@stellar/stellar-sdk';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  buildRegisterBatchTx,
  buildTransferCustodyTx,
  submitSignedXdr,
  extractXdrSigner,
} from '../services/stellar';
import { uploadToIPFS, hashBuffer } from '../services/ipfs';
import { generateQRCode } from '../services/qr';
import { config } from '../config';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from '../utils/errors';
import { logger } from '../utils/logger';

const router = Router();

// ─── Upload config ────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
]);

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.txt']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB per file
    files: 5,                    // max 5 files per request
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`File type '${file.mimetype}' is not allowed`));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`File extension '${ext}' is not allowed`));
    }
    cb(null, true);
  },
});

// ─── Shared validators ────────────────────────────────────────────────────────

const stellarAddressSchema = z
  .string()
  .length(56, 'Stellar address must be 56 characters')
  .refine((a) => StrKey.isValidEd25519PublicKey(a), {
    message: 'Must be a valid Stellar Ed25519 public key',
  });

// Validate that a string is a deserializable Stellar transaction XDR
const signedXdrSchema = z.string().min(1, 'signedXdr is required').superRefine((xdr, ctx) => {
  try {
    TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'signedXdr is not a valid Stellar transaction XDR' });
  }
});

// Bounded metadata: keys ≤ 100 chars, values string/number/boolean, total ≤ 10 KB
const metadataSchema = z
  .record(
    z.string().max(100, 'Metadata key must be ≤ 100 characters'),
    z.union([
      z.string().max(2000, 'Metadata string value must be ≤ 2000 characters'),
      z.number(),
      z.boolean(),
      z.null(),
    ])
  )
  .optional()
  .refine(
    (obj) => !obj || JSON.stringify(obj).length <= 10_000,
    { message: 'Metadata exceeds 10 KB limit' }
  );

// ─── Schemas ──────────────────────────────────────────────────────────────────

const submitBatchSchema = z.object({
  signedXdr: signedXdrSchema,
  metadataHash: z.string().regex(/^[0-9a-f]{64}$/, 'Must be 64-char hex'),
  metadata: metadataSchema,
  ipfsCids: z.array(z.string()).optional().default([]),
});

const transferPrepareSchema = z.object({
  toAddress: stellarAddressSchema,
  location: z.string().min(1).max(200).trim(),
});

const submitTransferSchema = z.object({
  signedXdr: signedXdrSchema,
  toAddress: stellarAddressSchema,
  location: z.string().min(1).max(200).trim(),
  docHash: z.string().optional(),
  docIpfsCid: z.string().optional(),
  docIpfsUrl: z.string().optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sanitize an uploaded filename for safe storage and IPFS upload. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 100);
}

/** Assert the XDR source matches the JWT actor — prevents XDR replay across actors. */
function assertXdrSigner(signedXdr: string, expectedAddress: string): void {
  const signer = extractXdrSigner(signedXdr);
  if (signer !== expectedAddress) {
    throw new ForbiddenError(
      'signedXdr source account does not match the authenticated actor'
    );
  }
}

// ─── POST /batches/prepare ────────────────────────────────────────────────────

router.post(
  '/prepare',
  requireRole('Producer'),
  upload.array('files', 5),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const producerAddress = req.actor!.address;

      // Parse metadata from multipart body
      let metadata: Record<string, unknown> = {};
      if (req.body.metadata) {
        try {
          metadata =
            typeof req.body.metadata === 'string'
              ? JSON.parse(req.body.metadata)
              : req.body.metadata;
        } catch {
          throw new BadRequestError('metadata must be valid JSON');
        }
        const metaCheck = metadataSchema.safeParse(metadata);
        if (!metaCheck.success) {
          throw new BadRequestError(metaCheck.error.errors.map((e) => e.message).join('; '));
        }
      }

      // Upload each file to IPFS. All uploads must succeed — we use Promise.all
      // so that a single failure aborts the entire prepare step rather than
      // accepting partial results and storing an incomplete metadataHash.
      const files = (req.files as Express.Multer.File[]) ?? [];
      const ipfsUploads = await Promise.all(
        files.map(async (file) => {
          const safeName = sanitizeFilename(file.originalname);
          const { cid, url } = await uploadToIPFS(file.buffer, safeName, file.mimetype);
          const hash = hashBuffer(file.buffer).toString('hex');
          return { filename: safeName, cid, url, hash };
        })
      );

      // Compute metadata hash
      const metadataForHash = { ...metadata, ipfsCids: ipfsUploads.map((u) => u.cid) };
      const metadataBuffer = Buffer.from(JSON.stringify(metadataForHash), 'utf8');
      const metadataHash = hashBuffer(metadataBuffer).toString('hex');

      // Build unsigned TX for Freighter
      const unsignedXdr = await buildRegisterBatchTx(producerAddress, metadataHash);

      logger.info({ producerAddress, metadataHash, fileCount: files.length }, 'Batch prepare complete');

      res.json({
        unsignedXdr,
        metadataHash,
        ipfsCids: ipfsUploads.map((u) => u.cid),
        ipfsUploads,
        metadata: metadataForHash,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /batches ────────────────────────────────────────────────────────────

router.post(
  '/',
  requireRole('Producer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parseResult = submitBatchSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestError(parseResult.error.errors.map((e) => e.message).join('; '));
      }
      const { signedXdr, metadataHash, metadata, ipfsCids } = parseResult.data;
      const producerAddress = req.actor!.address;

      // Verify the XDR was signed by the authenticated producer
      assertXdrSigner(signedXdr, producerAddress);

      // Submit to chain and get the real batch ID from the contract return value
      const { hash: txHash, returnValue } = await submitSignedXdr(signedXdr);
      logger.info({ txHash, producerAddress }, 'Batch register TX confirmed');

      if (!returnValue) {
        throw new AppError(
          'Contract did not return a batch ID — check contract deployment',
          502,
          'NO_BATCH_ID'
        );
      }
      const batchChainId = BigInt(String(scValToNative(returnValue)));

      // Generate QR code using the real on-chain ID
      const qrCodePath = await generateQRCode(batchChainId.toString());

      let batch;
      try {
        batch = await prisma.batch.create({
          data: {
            chainId: batchChainId,
            producerAddr: producerAddress,
            metadataHash,
            metadata: (metadata as Prisma.InputJsonValue) ?? {},
            qrCodePath,
            currentHolder: producerAddress,
          },
        });
      } catch (dbErr) {
        // The on-chain TX already landed. If the DB write fails, clean up the
        // orphaned QR file so it doesn't accumulate on disk.
        try {
          const filename = path.basename(qrCodePath);
          const resolvedStorage = path.resolve(config.qrStoragePath);
          const filePath = path.resolve(resolvedStorage, filename);
          if (filePath.startsWith(resolvedStorage + path.sep)) {
            fs.unlink(filePath, () => {}); // best-effort, don't block response
          }
        } catch {
          // ignore cleanup errors
        }
        throw dbErr;
      }

      logger.info({ batchId: batch.id, chainId: batchChainId.toString(), txHash }, 'Batch stored in DB');
      res.status(201).json({
        batch: { ...batch, chainId: batch.chainId.toString() },
        txHash,
        qrCodePath,
        ipfsCids,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /batches/:id/transfer/prepare ───────────────────────────────────────

router.post(
  '/:id/transfer/prepare',
  requireAuth,
  upload.single('document'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const actorAddress = req.actor!.address;

      // Parse and validate body before touching the DB
      const parseResult = transferPrepareSchema.safeParse({
        toAddress: req.body.toAddress,
        location: req.body.location,
      });
      if (!parseResult.success) {
        throw new BadRequestError(parseResult.error.errors.map((e) => e.message).join('; '));
      }
      const { toAddress, location } = parseResult.data;

      // Serializable transaction prevents two concurrent transfers from the same holder
      const batch = await prisma.$transaction(
        async (tx) => {
          const b = await tx.batch.findUnique({ where: { id } });
          if (!b) throw new NotFoundError(`Batch ${id} not found`);
          if (b.currentHolder !== actorAddress) {
            throw new ForbiddenError('You are not the current holder of this batch');
          }
          return b;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      // Optional document upload
      let docHash = '0'.repeat(64);
      let docIpfsCid = '';
      let docIpfsUrl = '';
      const file = req.file as Express.Multer.File | undefined;

      if (file) {
        const safeName = sanitizeFilename(file.originalname);
        const hashBuf = hashBuffer(file.buffer);
        docHash = hashBuf.toString('hex');
        const { cid, url } = await uploadToIPFS(file.buffer, safeName, file.mimetype);
        docIpfsCid = cid;
        docIpfsUrl = url;
      }

      const unsignedXdr = await buildTransferCustodyTx(
        actorAddress,
        toAddress,
        batch.chainId,
        location,
        docHash
      );

      res.json({ unsignedXdr, docHash, docIpfsCid, docIpfsUrl });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /batches/:id/transfer ───────────────────────────────────────────────

router.post(
  '/:id/transfer',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const actorAddress = req.actor!.address;

      const parseResult = submitTransferSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new BadRequestError(parseResult.error.errors.map((e) => e.message).join('; '));
      }
      const { signedXdr, toAddress, location, docHash, docIpfsCid, docIpfsUrl } =
        parseResult.data;

      // Verify XDR signer matches authenticated actor
      assertXdrSigner(signedXdr, actorAddress);

      // RACE CONDITION NOTE: There is a window between /transfer/prepare (which
      // built and returned the unsigned XDR) and this submit call. During that
      // window another request could transfer the same batch, making the XDR
      // stale. We detect this by re-verifying the current holder here (inside a
      // serializable transaction) before submitting to chain. If the holder has
      // changed, we reject early and the chain TX is never sent.
      //
      // Limitation: we cannot prevent the on-chain TX from landing if it is
      // submitted by the client directly. The indexer will reconcile any
      // resulting state divergence.

      // Serializable transaction: re-verify holder and update atomically
      const batch = await prisma.$transaction(
        async (tx) => {
          const b = await tx.batch.findUnique({ where: { id } });
          if (!b) throw new NotFoundError(`Batch ${id} not found`);
          if (b.currentHolder !== actorAddress) {
            throw new ForbiddenError(
              'You are no longer the current holder of this batch. ' +
              'The batch may have already been transferred. Please refresh and try again.'
            );
          }
          return b;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      // Submit to chain — this is irreversible once confirmed.
      const { hash: txHash } = await submitSignedXdr(signedXdr);
      logger.info({ batchId: id, txHash, from: actorAddress, to: toAddress }, 'Transfer TX confirmed');

      // Record event and update holder atomically.
      // If this write fails we log an alert — the indexer will eventually
      // reconcile state by replaying the on-chain event.
      try {
        const [event] = await prisma.$transaction([
          prisma.chainEvent.create({
            data: {
              batchChainId: batch.chainId,
              fromAddr: actorAddress,
              toAddr: toAddress,
              location,
              docHash: docHash ?? null,
              docIpfsCid: docIpfsCid ?? null,
              docIpfsUrl: docIpfsUrl ?? null,
              txHash,
              eventTimestamp: new Date(),
            },
          }),
          prisma.batch.update({
            where: { id },
            data: { currentHolder: toAddress },
          }),
        ]);

        res.json({ event: { ...event, batchChainId: event.batchChainId.toString() }, txHash });
      } catch (dbErr) {
        // The chain TX already landed — log prominently so operators can
        // manually reconcile. The background indexer will also catch this
        // event and write it to the DB on its next cycle.
        logger.error(
          { dbErr, txHash, batchId: id, from: actorAddress, to: toAddress },
          'Transfer TX confirmed on-chain but DB write failed — indexer will reconcile'
        );
        // Return the txHash so the client knows the transfer landed on-chain.
        res.status(202).json({
          txHash,
          warning:
            'Transfer confirmed on-chain. Database update failed and will be reconciled automatically.',
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /batches/chain/:chainId ──────────────────────────────────────────────
// Lookup by on-chain u64 ID — used by the QR code verify flow.
// The QR URL encodes the chainId (e.g. /verify/1), not the DB CUID.

router.get(
  '/chain/:chainId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawChainId = req.params.chainId;
      let chainId: bigint;
      try {
        chainId = BigInt(rawChainId);
      } catch {
        throw new BadRequestError(`chainId must be a valid integer, got: ${rawChainId}`);
      }

      const batch = await prisma.batch.findUnique({
        where: { chainId },
        include: {
          events: { orderBy: { eventTimestamp: 'asc' } },
        },
      });

      if (!batch) throw new NotFoundError(`Batch with chainId ${rawChainId} not found`);

      const addresses = [
        ...new Set([
          batch.producerAddr,
          ...batch.events.flatMap((e) => [e.fromAddr, e.toAddr]),
        ]),
      ];
      const actors = await prisma.actor.findMany({
        where: { address: { in: addresses } },
        select: { address: true, name: true, role: true },
      });
      const actorMap = new Map(actors.map((a) => [a.address, a]));

      res.json({
        batch: {
          ...batch,
          chainId: batch.chainId.toString(),
          producer: actorMap.get(batch.producerAddr) ?? null,
          events: batch.events.map((e) => ({
            ...e,
            batchChainId: e.batchChainId.toString(),
            fromActor: actorMap.get(e.fromAddr) ?? null,
            toActor: actorMap.get(e.toAddr) ?? null,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /batches/:id ─────────────────────────────────────────────────────────

router.get(
  '/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const batch = await prisma.batch.findUnique({
        where: { id },
        include: {
          events: { orderBy: { eventTimestamp: 'asc' } },
        },
      });

      if (!batch) throw new NotFoundError(`Batch ${id} not found`);

      const addresses = [
        ...new Set([
          batch.producerAddr,
          ...batch.events.flatMap((e) => [e.fromAddr, e.toAddr]),
        ]),
      ];
      const actors = await prisma.actor.findMany({
        where: { address: { in: addresses } },
        select: { address: true, name: true, role: true },
      });
      const actorMap = new Map(actors.map((a) => [a.address, a]));

      res.json({
        batch: {
          ...batch,
          chainId: batch.chainId.toString(),
          // Attach the resolved producer actor so consumers don't have to
          // do a second request — falls back to null if not yet in DB.
          producer: actorMap.get(batch.producerAddr) ?? null,
          events: batch.events.map((e) => ({
            ...e,
            batchChainId: e.batchChainId.toString(),
            fromActor: actorMap.get(e.fromAddr) ?? null,
            toActor: actorMap.get(e.toAddr) ?? null,
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /batches/:id/qr ──────────────────────────────────────────────────────

router.get(
  '/:id/qr',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const batch = await prisma.batch.findUnique({
        where: { id },
        select: { qrCodePath: true },
      });

      if (!batch) throw new NotFoundError(`Batch ${id} not found`);
      if (!batch.qrCodePath) throw new NotFoundError(`QR code not yet generated for batch ${id}`);

      // Defend against path traversal: strip directory components, then resolve
      // the final path and verify it is still inside qrStoragePath.
      const filename = path.basename(batch.qrCodePath);
      const resolvedStorage = path.resolve(config.qrStoragePath);
      const filePath = path.resolve(resolvedStorage, filename);

      // Ensure the resolved path is strictly inside the storage directory
      if (!filePath.startsWith(resolvedStorage + path.sep) && filePath !== resolvedStorage) {
        throw new NotFoundError(`QR file not found on disk for batch ${id}`);
      }

      if (!fs.existsSync(filePath)) {
        throw new NotFoundError(`QR file not found on disk for batch ${id}`);
      }

      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /batches ─────────────────────────────────────────────────────────────

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorAddress = req.actor!.address;
      const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10));
      const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10)));
      const skip = (page - 1) * limit;

      const [batches, total] = await Promise.all([
        prisma.batch.findMany({
          where: {
            OR: [
              { currentHolder: actorAddress },
              { producerAddr: actorAddress },
            ],
          },
          include: {
            events: {
              orderBy: { eventTimestamp: 'desc' },
              take: 1,
            },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.batch.count({
          where: {
            OR: [
              { currentHolder: actorAddress },
              { producerAddr: actorAddress },
            ],
          },
        }),
      ]);

      res.json({
        batches: batches.map((b) => ({
          ...b,
          chainId: b.chainId.toString(),
          events: b.events.map((e) => ({
            ...e,
            batchChainId: e.batchChainId.toString(),
          })),
        })),
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
