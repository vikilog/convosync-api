import type { Contact } from '@prisma/client';
import type { ConditionNodeData, ConditionOperator } from '../types/journey.types.js';
import { resolveContactField } from './message-renderer.service.js';

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function compareValues(
  left: unknown,
  operator: ConditionOperator,
  right: string | number
): boolean {
  const leftStr = left == null ? '' : String(left);
  const rightStr = String(right);

  switch (operator) {
    case '=':
      return leftStr === rightStr;
    case '!=':
      return leftStr !== rightStr;
    case 'contains':
      return leftStr.toLowerCase().includes(rightStr.toLowerCase());
    case '>':
    case '<': {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (ln == null || rn == null) return false;
      return operator === '>' ? ln > rn : ln < rn;
    }
    default:
      return false;
  }
}

export function evaluateCondition(contact: Contact, config: ConditionNodeData): boolean {
  const left = resolveContactField(contact, config.field);
  return compareValues(left, config.operator, config.value);
}

export function pickBranchEdge<T extends { conditionValue: string | null }>(
  edges: T[],
  result: boolean
): T | undefined {
  const branch = result ? 'yes' : 'no';
  return (
    edges.find((e) => e.conditionValue === branch) ??
    edges.find((e) => e.conditionValue === 'default' || e.conditionValue == null)
  );
}
