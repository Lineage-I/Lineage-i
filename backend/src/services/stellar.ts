import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Keypair,
  Contract,
  nativeToScVal,
  xdr,
  Address,
  scValToNative,
  BASE_FEE,
  StrKey,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

// ─── Singletons ──────────────────────────────────────────────────────────────

function getRpcServer(): SorobanRpc.Server {
  return new SorobanRpc.Server(config.sorobanRpcUrl, { allowHttp: false });
}

// Lazy singleton — secret is decoded once and held in a single Keypair instance.
// SECURITY NOTE: The secret lives in memory for the lifetime of the process.
// In production, use a secrets manager (AWS Secrets Manager, HashiCorp Vault)
// and consider re-fetching the secret per-operation rather than caching it.
let _adminKeypair: Keypair | null = null;
function getAdminKeypair(): Keypair {
  if (!_adminKeypair) {
    _adminKeypair = Keypair.fromSecret(config.adminSecretKey);
  }
  return _adminKeypair;
}

/**
 * Clear the in-memory admin keypair. Call this during graceful shutdown so the
 * secret does not linger in memory after the process begins its shutdown sequence.
 */
export function clearAdminKeypair(): void {
  _adminKeypair = null;
}

function getContract(): Contract {
  return new Contract(config.contractId);
}

// ─── Role encoding ───────────────────────────────────────────────────────────

/**
 * Encodes a role string as the Soroban enum variant used by the contract.
 * The contract expects a Vec with one Symbol element.
 */
const roleToScVal = (role: string): xdr.ScVal => {
  const validRoles = ['Producer', 'Processor', 'Distributor', 'Retailer', 'Auditor', 'Admin'];
  if (!validRoles.includes(role)) {
    throw new AppError(`Invalid role: ${role}`, 400, 'INVALID_ROLE');
  }
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(role)]);
};

// ─── Internal helper ─────────────────────────────────────────────────────────

/**
 * Builds, prepares, signs (admin), submits and polls a transaction.
 * Returns the transaction hash on SUCCESS.
 */
async function buildAndSubmitAdminTx(
  operation: xdr.Operation
): Promise<string> {
  const server = getRpcServer();
  const admin = getAdminKeypair();

  const account = await server.getAccount(admin.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();

  let preparedTx: Parameters<typeof server.sendTransaction>[0];
  try {
    preparedTx = await server.prepareTransaction(tx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to prepare admin transaction');
    throw new AppError(`Transaction preparation failed: ${msg}`, 502, 'TX_PREPARE_FAILED');
  }

  (preparedTx as ReturnType<typeof TransactionBuilder.prototype.build>).sign(admin);

  const sendResponse = await server.sendTransaction(preparedTx);
  if (sendResponse.status === 'ERROR') {
    const detail = JSON.stringify(sendResponse.errorResult ?? 'unknown');
    throw new AppError(`Transaction submission failed: ${detail}`, 502, 'TX_SUBMIT_FAILED');
  }

  const result = await pollTransactionResult(sendResponse.hash);
  if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    const detail = JSON.stringify((result as SorobanRpc.Api.FailedTransaction).resultXdr ?? 'unknown');
    throw new AppError(`Transaction failed on-chain: ${detail}`, 502, 'TX_FAILED');
  }

  logger.info({ hash: sendResponse.hash }, 'Admin transaction confirmed');
  return sendResponse.hash;
}

// ─── Simulation helper ────────────────────────────────────────────────────────

async function simulateCall(operation: xdr.Operation): Promise<xdr.ScVal> {
  const server = getRpcServer();
  const admin = getAdminKeypair();

  const account = await server.getAccount(admin.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new AppError(
      `Simulation error: ${simResult.error}`,
      502,
      'SIMULATION_ERROR'
    );
  }

  const successResult = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  const retval = successResult.result?.retval;
  if (!retval) {
    throw new AppError('Simulation returned no value', 502, 'SIMULATION_NO_RETVAL');
  }
  return retval;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register an actor on-chain. Admin-signed.
 */
export async function registerActor(
  actorAddress: string,
  role: string,
  name: string
): Promise<string> {
  const admin = getAdminKeypair();
  const contract = getContract();
  // Contract signature: register_actor(env, admin, actor_addr, role, name)
  const operation = contract.call(
    'register_actor',
    new Address(admin.publicKey()).toScVal(),
    new Address(actorAddress).toScVal(),
    roleToScVal(role),
    nativeToScVal(name, { type: 'string' })
  );
  return buildAndSubmitAdminTx(operation);
}

/**
 * Deactivate an actor on-chain. Admin-signed.
 */
export async function deactivateActor(actorAddress: string): Promise<string> {
  const admin = getAdminKeypair();
  const contract = getContract();
  // Contract signature: deactivate_actor(env, admin, actor_addr)
  const operation = contract.call(
    'deactivate_actor',
    new Address(admin.publicKey()).toScVal(),
    new Address(actorAddress).toScVal()
  );
  return buildAndSubmitAdminTx(operation);
}

/**
 * Read-only: get batch data from chain.
 */
export async function getBatchOnChain(batchId: bigint): Promise<unknown> {
  const contract = getContract();
  const operation = contract.call(
    'get_batch',
    nativeToScVal(batchId, { type: 'u64' })
  );
  const retval = await simulateCall(operation);
  return scValToNative(retval);
}

/**
 * Read-only: get full transfer history for a batch.
 */
export async function getHistoryOnChain(batchId: bigint): Promise<unknown[]> {
  const contract = getContract();
  const operation = contract.call(
    'get_history',
    nativeToScVal(batchId, { type: 'u64' })
  );
  const retval = await simulateCall(operation);
  const native = scValToNative(retval);
  return Array.isArray(native) ? native : [];
}

/**
 * Read-only: get actor data from chain.
 */
export async function getActorOnChain(address: string): Promise<unknown> {
  const contract = getContract();
  const operation = contract.call(
    'get_actor',
    new Address(address).toScVal()
  );
  const retval = await simulateCall(operation);
  return scValToNative(retval);
}

/**
 * Extract the source account (signer) from a signed XDR without submitting.
 * Used to verify the XDR was built by the authenticated actor.
 */
export function extractXdrSigner(signedXdr: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
    return tx.source;
  } catch {
    throw new AppError('signedXdr is not a valid Stellar transaction', 400, 'INVALID_XDR');
  }
}

/**
 * Submit a pre-signed XDR (from Freighter wallet).
 * Returns the tx hash and the contract return value so callers can read
 * outputs like the new batch ID from register_batch.
 */
export async function submitSignedXdr(
  signedXdr: string
): Promise<{ hash: string; returnValue: xdr.ScVal | null }> {
  const server = getRpcServer();

  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
  } catch {
    throw new AppError('signedXdr is not a valid Stellar transaction', 400, 'INVALID_XDR');
  }

  const sendResponse = await server.sendTransaction(tx);
  if (sendResponse.status === 'ERROR') {
    const detail = JSON.stringify(sendResponse.errorResult ?? 'unknown');
    throw new AppError(`XDR submission failed: ${detail}`, 502, 'XDR_SUBMIT_FAILED');
  }

  const result = await pollTransactionResult(sendResponse.hash);
  if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    const detail = JSON.stringify(
      (result as SorobanRpc.Api.FailedTransaction).resultXdr ?? 'unknown'
    );
    throw new AppError(`Signed XDR transaction failed: ${detail}`, 502, 'XDR_TX_FAILED');
  }

  const successResult = result as SorobanRpc.Api.SuccessfulTransaction;
  logger.info({ hash: sendResponse.hash }, 'Signed XDR transaction confirmed');
  return {
    hash: sendResponse.hash,
    returnValue: successResult.returnValue ?? null,
  };
}

/**
 * Build an unsigned register_batch transaction XDR for Freighter signing.
 */
export async function buildRegisterBatchTx(
  producerAddress: string,
  metadataHashHex: string
): Promise<string> {
  const server = getRpcServer();
  const contract = getContract();

  const metadataHashBytes = Buffer.from(metadataHashHex, 'hex');
  if (metadataHashBytes.length !== 32) {
    throw new AppError('metadataHashHex must be a 64-character hex string (32 bytes)', 400, 'INVALID_HASH');
  }

  const operation = contract.call(
    'register_batch',
    new Address(producerAddress).toScVal(),
    nativeToScVal(metadataHashBytes, { type: 'bytes' })
  );

  const account = await server.getAccount(producerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  return preparedTx.toXDR();
}

/**
 * Build an unsigned transfer_custody transaction XDR for Freighter signing.
 */
export async function buildTransferCustodyTx(
  fromAddress: string,
  toAddress: string,
  batchId: bigint,
  location: string,
  docHashHex: string
): Promise<string> {
  const server = getRpcServer();
  const contract = getContract();

  // Validate docHashHex before converting — Buffer.from with 'hex' encoding
  // silently ignores non-hex characters and produces wrong-length output for
  // odd-length strings. We enforce exactly 64 hex chars (32 bytes) here.
  if (!/^[0-9a-fA-F]{64}$/.test(docHashHex)) {
    throw new AppError(
      `docHashHex must be exactly 64 hex characters (32 bytes), got length ${docHashHex.length}`,
      400,
      'INVALID_DOC_HASH'
    );
  }

  const docHashBytes = Buffer.from(docHashHex, 'hex');

  const operation = contract.call(
    'transfer_custody',
    new Address(fromAddress).toScVal(),
    new Address(toAddress).toScVal(),
    nativeToScVal(batchId, { type: 'u64' }),
    nativeToScVal(location, { type: 'string' }),
    nativeToScVal(docHashBytes, { type: 'bytes' })
  );

  const account = await server.getAccount(fromAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  return preparedTx.toXDR();
}

/**
 * Poll for contract events starting from a given ledger.
 */
export async function fetchContractEvents(startLedger: number): Promise<unknown[]> {
  const server = getRpcServer();

  try {
    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [config.contractId],
        },
      ],
      limit: 200,
    });
    return response.events ?? [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, startLedger }, `fetchContractEvents failed: ${msg}`);
    return [];
  }
}

/**
 * Poll until a transaction reaches a terminal state (SUCCESS or FAILED).
 * Uses exponential backoff starting at 1 s, doubling each attempt, capped at 8 s.
 * Total worst-case wait: ~2 min across 30 attempts.
 */
export async function pollTransactionResult(
  hash: string,
  maxAttempts = 30
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  const server = getRpcServer();
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const BASE_DELAY_MS = 1_000;
  const MAX_DELAY_MS = 8_000;

  let attempt = 0;
  while (attempt < maxAttempts) {
    const result = await server.getTransaction(hash);
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      return result;
    }
    // Exponential backoff: 1 s, 2 s, 4 s, 8 s, 8 s, 8 s, …
    const backoff = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
    await delay(backoff);
    attempt++;
  }

  throw new AppError(
    `Transaction ${hash} not confirmed after ${maxAttempts} attempts`,
    504,
    'TX_TIMEOUT'
  );
}

// Re-export StrKey for use in auth routes
export { StrKey };
