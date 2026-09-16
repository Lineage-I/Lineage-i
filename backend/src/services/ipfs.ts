import axios from 'axios';
import FormData from 'form-data';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

/**
 * Upload a file buffer to IPFS via Pinata.
 * Returns the CID and a public gateway URL.
 */
export async function uploadToIPFS(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ cid: string; url: string }> {
  if (!config.pinataApiKey || !config.pinataSecretKey) {
    throw new AppError(
      'Pinata credentials not configured',
      503,
      'IPFS_NOT_CONFIGURED'
    );
  }

  const form = new FormData();
  form.append('file', fileBuffer, {
    filename,
    contentType: mimeType,
    knownLength: fileBuffer.length,
  });

  // Pinata metadata
  form.append(
    'pinataMetadata',
    JSON.stringify({
      name: filename,
      keyvalues: { app: 'lineage', uploadedAt: new Date().toISOString() },
    })
  );

  form.append(
    'pinataOptions',
    JSON.stringify({ cidVersion: 1 })
  );

  try {
    const response = await axios.post<PinataResponse>(PINATA_PIN_URL, form, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: {
        ...form.getHeaders(),
        pinata_api_key: config.pinataApiKey,
        pinata_secret_api_key: config.pinataSecretKey,
      },
      timeout: 120_000,
    });

    const cid = response.data.IpfsHash;
    const url = `${PINATA_GATEWAY}/${cid}`;
    logger.info({ cid, filename, size: fileBuffer.length }, 'File pinned to IPFS');
    return { cid, url };
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? 502;
      const detail = JSON.stringify(err.response?.data ?? err.message);
      throw new AppError(`IPFS upload failed: ${detail}`, status, 'IPFS_UPLOAD_FAILED');
    }
    throw new AppError(
      `IPFS upload failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
      'IPFS_UPLOAD_FAILED'
    );
  }
}

/**
 * Compute a SHA-256 hash of a buffer.
 * Returns the raw 32-byte hash Buffer.
 */
export function hashBuffer(buffer: Buffer): Buffer {
  return crypto.createHash('sha256').update(buffer).digest();
}

/**
 * Encode a CID string to a fixed 32-byte Buffer for on-chain storage.
 * The CID is UTF-8 encoded then truncated or zero-padded to exactly 32 bytes.
 *
 * WARNING: CIDv1 strings are typically 59+ characters. If the encoded CID
 * exceeds 32 bytes it will be truncated and the stored value will NOT
 * represent the full CID. Store the full CID off-chain (DB / event) and only
 * use this function for fingerprinting, not for reconstruction.
 */
export function cidToBytes32(cid: string): Buffer {
  const encoded = Buffer.from(cid, 'utf8');
  if (encoded.length > 32) {
    // Log a warning so callers are aware of the truncation at development time.
    // In production this is expected behaviour — full CID lives in the DB/events.
    console.warn(
      `cidToBytes32: CID "${cid.slice(0, 12)}…" is ${encoded.length} bytes, ` +
      `truncating to 32. Ensure the full CID is stored off-chain.`
    );
  }
  const result = Buffer.alloc(32, 0);
  encoded.copy(result, 0, 0, Math.min(encoded.length, 32));
  return result;
}
