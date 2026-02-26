import { timingSafeEqual, createHash } from 'crypto';
import { generateAgentToken, hashToken as hashTokenUtil } from '../../types.js';
import type { TokenId } from '../../types.js';

/**
 * Generate a new raw vtk_ agent token
 */
export function generateToken(): TokenId {
  return generateAgentToken();
}

/**
 * Hash a raw token using SHA-256
 */
export function hashToken(raw: string): string {
  return hashTokenUtil(raw);
}

/**
 * Verify a provided token against a stored hash using constant-time comparison.
 * Returns false on any mismatch or length difference (never throws).
 */
export function verifyTokenConstantTime(provided: string, stored_hash: string): boolean {
  try {
    const providedHash = createHash('sha256').update(provided).digest('hex');
    const providedBuf = Buffer.from(providedHash, 'utf8');
    const storedBuf = Buffer.from(stored_hash, 'utf8');

    if (providedBuf.length !== storedBuf.length) {
      return false;
    }

    return timingSafeEqual(providedBuf, storedBuf);
  } catch {
    return false;
  }
}
