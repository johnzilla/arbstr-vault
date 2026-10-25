import { ulid } from 'ulidx';
import { createHash, randomBytes } from 'crypto';

// Branded type aliases with prefixes
export type AgentId = `ag_${string}`;
export type TransactionId = `tx_${string}`;
export type PolicyId = `pl_${string}`;
export type TokenId = `vtk_${string}`;

// ID generator functions
export function generateAgentId(): AgentId {
  return `ag_${ulid()}`;
}

export function generateTransactionId(): TransactionId {
  return `tx_${ulid()}`;
}

export function generatePolicyId(): PolicyId {
  return `pl_${ulid()}`;
}

// 256 random bits. Tokens are looked up by their SHA-256 hash, so tokens issued
// in the earlier vtk_<ULID> format (80 random bits) keep working.
export function generateAgentToken(): TokenId {
  return `vtk_${randomBytes(32).toString('base64url')}`;
}

// Hash a raw token for secure storage
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
