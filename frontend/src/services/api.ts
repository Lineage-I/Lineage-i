import type { Actor, Batch, PrepareResponse, TransferPrepareResponse } from '../types';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function getAuthHeadersNoContentType(): Record<string, string> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP error ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
      else if (data?.message) message = data.message;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function getBatch(id: string): Promise<Batch> {
  // The QR code encodes the on-chain chainId (a u64 integer), not the DB CUID.
  // We route through /batches/chain/:chainId so that scanned QR codes resolve
  // correctly. The DB CUID lookup (GET /batches/:id) remains for internal use.
  const res = await fetch(`${BASE_URL}/batches/chain/${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  // Backend returns { batch: Batch }
  const data = await handleResponse<{ batch: Batch }>(res);
  return data.batch;
}

export async function getActors(role?: string): Promise<Actor[]> {
  const url = role
    ? `${BASE_URL}/actors?role=${encodeURIComponent(role)}`
    : `${BASE_URL}/actors`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  // Backend returns { actors: Actor[], total: number }
  const data = await handleResponse<{ actors: Actor[]; total: number }>(res);
  return data.actors;
}

export async function getMyBatches(): Promise<Batch[]> {
  // Backend route is GET /batches (with auth), not /batches/mine
  const res = await fetch(`${BASE_URL}/batches`, {
    headers: getAuthHeaders(),
  });
  // Backend returns { batches: Batch[], pagination: {...} }
  const data = await handleResponse<{ batches: Batch[]; pagination: unknown }>(res);
  return data.batches;
}

export async function registerActor(data: {
  address: string;
  role: string;
  name: string;
  contactInfo?: string;
}): Promise<Actor> {
  const res = await fetch(`${BASE_URL}/actors`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  return handleResponse<Actor>(res);
}

export async function prepareBatch(formData: FormData): Promise<PrepareResponse> {
  const res = await fetch(`${BASE_URL}/batches/prepare`, {
    method: 'POST',
    headers: getAuthHeadersNoContentType(),
    body: formData,
  });
  return handleResponse<PrepareResponse>(res);
}

export async function submitBatch(data: {
  signedXdr: string;
  metadataHash: string;
  metadata: object;
  ipfsCids: string[];
}): Promise<Batch> {
  // Backend route is POST /batches, not /batches/submit
  const res = await fetch(`${BASE_URL}/batches`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  // Backend returns { batch: Batch, txHash, qrCodePath, ipfsCids }
  const result = await handleResponse<{ batch: Batch }>(res);
  return result.batch;
}

export async function prepareTransfer(
  batchId: string,
  formData: FormData
): Promise<TransferPrepareResponse> {
  const res = await fetch(`${BASE_URL}/batches/${batchId}/transfer/prepare`, {
    method: 'POST',
    headers: getAuthHeadersNoContentType(),
    body: formData,
  });
  return handleResponse<TransferPrepareResponse>(res);
}

export async function submitTransfer(
  batchId: string,
  data: {
    signedXdr: string;
    toAddress: string;
    location: string;
    docHash?: string;
    docIpfsCid?: string;
  }
): Promise<void> {
  // Backend route is POST /batches/:id/transfer, not /:id/transfer/submit
  const res = await fetch(`${BASE_URL}/batches/${batchId}/transfer`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  await handleResponse<void>(res);
}

export async function getChallenge(address: string): Promise<{ challenge: string }> {
  const res = await fetch(
    `${BASE_URL}/auth/challenge?address=${encodeURIComponent(address)}`,
    { headers: { 'Content-Type': 'application/json' } }
  );
  return handleResponse<{ challenge: string }>(res);
}

export async function verifySignature(
  address: string,
  challenge: string,
  signedXdr: string
): Promise<{ token: string; actor: Actor }> {
  const res = await fetch(`${BASE_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, challenge, signedXdr }),
  });
  return handleResponse<{ token: string; actor: Actor }>(res);
}
