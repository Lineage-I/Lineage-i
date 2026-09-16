import { prisma } from '../db';
import { fetchContractEvents } from '../services/stellar';
import { logger } from '../utils/logger';

const POLL_INTERVAL_MS = 5_000;
const GENESIS_LEDGER = 0;

interface ContractEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];  // base64-encoded XDR ScVal strings
  value: string;    // base64-encoded XDR ScVal
  txHash: string;
  pagingToken: string;
}

/**
 * Determine the starting ledger from the DB checkpoint.
 * Seeds the checkpoint record if it doesn't exist yet.
 */
async function getCheckpointLedger(): Promise<number> {
  const checkpoint = await prisma.indexerCheckpoint.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, ledger: GENESIS_LEDGER },
  });
  return checkpoint.ledger;
}

async function updateCheckpoint(ledger: number): Promise<void> {
  await prisma.indexerCheckpoint.upsert({
    where: { id: 1 },
    update: { ledger },
    create: { id: 1, ledger },
  });
}

/**
 * Decode a Soroban event topic array to a list of string values.
 * Topics are returned by the RPC as raw ScVal — we convert to string best-effort.
 */
function decodeTopics(topic: unknown[]): string[] {
  return (topic ?? []).map((t) => {
    if (typeof t === 'string') return t;
    if (t && typeof t === 'object' && 'sym' in t) return String((t as { sym: unknown }).sym);
    return String(t);
  });
}

/**
 * Decode a Soroban BytesN<32> event field to a hex string.
 *
 * The Soroban RPC can return byte arrays in several forms depending on SDK
 * version and serialisation path:
 *   - A Buffer / Uint8Array (already binary)
 *   - A base64 string (from JSON-encoded XDR)
 *   - A hex string (from some SDK helpers)
 *
 * We normalise all three to a lowercase hex string.
 */
function decodeDocHash(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  // Already a Buffer or Uint8Array
  if (Buffer.isBuffer(raw)) {
    return raw.toString('hex');
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('hex');
  }

  if (typeof raw === 'string') {
    if (raw.length === 0) return null;

    // 64-char lowercase hex — already decoded
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      return raw.toLowerCase();
    }

    // Try base64 (standard or URL-safe)
    try {
      const buf = Buffer.from(raw, 'base64');
      // A valid SHA-256 base64 decodes to exactly 32 bytes
      if (buf.length === 32) {
        return buf.toString('hex');
      }
    } catch {
      // not valid base64 — fall through
    }

    // Unknown format — log and return null rather than storing garbage
    console.warn(`decodeDocHash: unrecognised format (length=${raw.length}), ignoring`);
    return null;
  }

  return null;
}

/**
 * Decode the event value payload to a plain object.
 */
function decodeValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, unknown>;
}

/**
 * Convert a BigInt-like chain value to a JavaScript bigint safely.
 */
function toBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

/**
 * Process a single custody transfer event from the contract.
 */
async function processTransferEvent(event: ContractEvent): Promise<void> {
  const rawValue = decodeValue(event.value);

  // Expected structure from the contract's custody_transfer event:
  // { batch_id: u64, from: Address, to: Address, location: String, doc_hash: Bytes, timestamp: u64 }
  const batchId = toBigInt(rawValue['batch_id'] ?? rawValue['batchId']);
  const fromAddr = String(rawValue['from'] ?? rawValue['fromAddr'] ?? '');
  const toAddr = String(rawValue['to'] ?? rawValue['toAddr'] ?? '');
  const location = String(rawValue['location'] ?? '');
  const docHash = decodeDocHash(rawValue['doc_hash'] ?? rawValue['docHash']);
  const timestampRaw = rawValue['timestamp'];
  const eventTimestamp = timestampRaw
    ? new Date(Number(timestampRaw) * 1000)
    : new Date(event.ledgerClosedAt);

  if (batchId === null) {
    logger.warn({ eventId: event.id }, 'Indexer: could not decode batchId from event');
    return;
  }

  // Upsert batch record if not yet created (indexer catches events the API may have missed)
  await prisma.batch.upsert({
    where: { chainId: batchId },
    update: { currentHolder: toAddr },
    create: {
      chainId: batchId,
      producerAddr: fromAddr,
      metadataHash: '',
      currentHolder: toAddr,
    },
  });

  // Upsert the ChainEvent by batchChainId + txHash to avoid duplicates
  const existingEvent = await prisma.chainEvent.findFirst({
    where: { batchChainId: batchId, txHash: event.txHash },
  });

  if (!existingEvent) {
    await prisma.chainEvent.create({
      data: {
        batchChainId: batchId,
        fromAddr,
        toAddr,
        location,
        docHash,
        txHash: event.txHash,
        ledger: event.ledger,
        eventTimestamp,
      },
    });
    logger.debug(
      { batchId: batchId.toString(), txHash: event.txHash, from: fromAddr, to: toAddr },
      'Indexer: chain event recorded'
    );
  }
}

/**
 * Process a batch_registered event from the contract.
 */
async function processBatchRegisteredEvent(event: ContractEvent): Promise<void> {
  const rawValue = decodeValue(event.value);

  const batchId = toBigInt(rawValue['batch_id'] ?? rawValue['batchId']);
  const producerAddr = String(rawValue['producer'] ?? rawValue['producerAddr'] ?? '');
  const metadataHashRaw = rawValue['metadata_hash'] ?? rawValue['metadataHash'];
  const metadataHash = decodeDocHash(metadataHashRaw) ?? '';

  if (batchId === null) {
    logger.warn({ eventId: event.id }, 'Indexer: could not decode batchId from register event');
    return;
  }

  await prisma.batch.upsert({
    where: { chainId: batchId },
    update: { metadataHash: metadataHash || undefined },
    create: {
      chainId: batchId,
      producerAddr,
      metadataHash,
      currentHolder: producerAddr,
    },
  });

  logger.debug(
    { batchId: batchId.toString(), producerAddr },
    'Indexer: batch registration recorded'
  );
}

/**
 * Run one indexer poll cycle.
 */
async function runCycle(): Promise<void> {
  const startLedger = await getCheckpointLedger();

  let events: unknown[];
  try {
    events = await fetchContractEvents(startLedger);
  } catch (err) {
    logger.error({ err }, 'Indexer: fetchContractEvents threw unexpectedly');
    return;
  }

  if (events.length === 0) return;

  logger.debug({ count: events.length, startLedger }, 'Indexer: processing events');

  let maxLedger = startLedger;

  for (const rawEvent of events) {
    const event = rawEvent as ContractEvent;
    try {
      const topics = decodeTopics(event.topic as unknown[]);

      // Detect event type by topic conventions.
      // Contract emits:
      //   register_batch:    (symbol_short!("batch"), symbol_short!("register"))
      //   transfer_custody:  (symbol_short!("custody"), symbol_short!("transfer"))
      const isCustodyTransfer =
        topics.includes('custody') && topics.includes('transfer');
      const isBatchRegistered =
        topics.includes('batch') && topics.includes('register');

      if (isCustodyTransfer) {
        await processTransferEvent(event);
      } else if (isBatchRegistered) {
        await processBatchRegisteredEvent(event);
      } else {
        logger.debug({ topics, eventId: event.id }, 'Indexer: unhandled event type');
      }

      if (event.ledger > maxLedger) {
        maxLedger = event.ledger;
      }
    } catch (err) {
      logger.error({ err, eventId: event.id }, 'Indexer: error processing event');
      // Continue processing remaining events rather than halting
    }
  }

  // Advance checkpoint to one past the highest ledger seen.
  // Using maxLedger + 1 means the next poll starts from the ledger AFTER
  // the last one we processed, so we never re-process events from that ledger.
  if (maxLedger > startLedger) {
    await updateCheckpoint(maxLedger + 1);
    logger.debug({ checkpoint: maxLedger + 1 }, 'Indexer: checkpoint updated');
  }
}

let indexerTimer: NodeJS.Timeout | null = null;
let indexerRunning = false; // concurrency guard — prevents double-start

/**
 * Start the background indexer.
 * Seeds the DB checkpoint on first run and polls every 5 seconds.
 * Safe to call multiple times — subsequent calls are ignored.
 */
export async function startIndexer(): Promise<void> {
  if (indexerRunning) {
    logger.warn('startIndexer called while already running — ignoring duplicate start');
    return;
  }
  indexerRunning = true;

  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Starting chain event indexer');

  // Seed checkpoint if missing
  await getCheckpointLedger();

  // Run immediately on start
  await runCycle().catch((err) =>
    logger.error({ err }, 'Indexer: initial cycle failed')
  );

  indexerTimer = setInterval(() => {
    runCycle().catch((err) =>
      logger.error({ err }, 'Indexer: cycle failed')
    );
  }, POLL_INTERVAL_MS);

  // Prevent the timer from keeping the process alive if the server stops
  if (indexerTimer.unref) indexerTimer.unref();
}

/**
 * Stop the indexer (called during graceful shutdown).
 */
export function stopIndexer(): void {
  if (indexerTimer) {
    clearInterval(indexerTimer);
    indexerTimer = null;
    indexerRunning = false;
    logger.info('Indexer stopped');
  }
}
