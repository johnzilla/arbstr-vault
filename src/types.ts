import { ulid } from 'ulidx';
import { createHash } from 'crypto';

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

export function generateAgentToken(): TokenId {
  return `vtk_${ulid()}`;
}

// Hash a raw token for secure storage
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
