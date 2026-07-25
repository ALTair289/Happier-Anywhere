import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ExactSessionTurnEndMutationV1Schema,
  type ExactSessionTurnEndMutationV1,
  ExactSessionTurnMutationPositiveReceiptV1Schema,
  isExactSessionTurnEndMutationV1,
  isExactSessionTurnMutationPositiveReceiptV1,
  SessionTurnMutationV1Schema,
} from './sessionTurnMutationV1.js';
import * as ProtocolRoot from '../../index.js';
import * as SessionControlContract from '../../sessionControl/contract.js';

const mutation = {
  v: 1,
  sessionId: 'session-1',
  mutationId: 'mutation-1',
  action: 'end_session',
  turnId: 'turn-1',
  observedAt: 200,
} as const;

describe('exact session turn end mutation', () => {
  it('exports the exact contract through canonical public barrels', () => {
    expect(ProtocolRoot.ExactSessionTurnEndMutationV1Schema).toBe(ExactSessionTurnEndMutationV1Schema);
    expect(ProtocolRoot.ExactSessionTurnMutationPositiveReceiptV1Schema).toBe(
      ExactSessionTurnMutationPositiveReceiptV1Schema,
    );
    expect(ProtocolRoot.isExactSessionTurnEndMutationV1).toBe(isExactSessionTurnEndMutationV1);
    expect(SessionControlContract.isExactSessionTurnEndMutationV1).toBe(isExactSessionTurnEndMutationV1);
    expect(SessionControlContract.isExactSessionTurnMutationPositiveReceiptV1).toBe(
      isExactSessionTurnMutationPositiveReceiptV1,
    );
  });

  it('accepts only a provider-free explicit end and preserves broad no-turn compatibility', () => {
    expect(ExactSessionTurnEndMutationV1Schema.parse(mutation)).toEqual(mutation);
    expect(isExactSessionTurnEndMutationV1(mutation)).toBe(true);
    expectTypeOf<ExactSessionTurnEndMutationV1>().not.toHaveProperty('provider');
    expectTypeOf<ExactSessionTurnEndMutationV1>().not.toHaveProperty('providerTurnId');
    expect(SessionTurnMutationV1Schema.safeParse(mutation).success).toBe(true);

    for (const candidate of [
      { ...mutation, provider: 'codex' },
      { ...mutation, providerTurnId: 'provider-turn-1' },
    ]) {
      expect(ExactSessionTurnEndMutationV1Schema.safeParse(candidate).success).toBe(false);
      expect(isExactSessionTurnEndMutationV1(candidate)).toBe(false);
      expect(SessionTurnMutationV1Schema.safeParse(candidate).success).toBe(false);
    }

    expect(SessionTurnMutationV1Schema.safeParse({
      ...mutation,
      turnId: undefined,
      provider: 'codex',
      providerTurnId: 'provider-turn-1',
    }).success).toBe(true);
  });

  it('recognizes only full-identity positive exact receipts', () => {
    const receipt = {
      ...mutation,
      decision: 'applied',
      appliedAt: 250,
    } as const;

    expect(ExactSessionTurnMutationPositiveReceiptV1Schema.safeParse(receipt).success).toBe(true);
    expect(isExactSessionTurnMutationPositiveReceiptV1(mutation, receipt)).toBe(true);
    expect(isExactSessionTurnMutationPositiveReceiptV1(mutation, {
      ...receipt,
      decision: 'duplicate-terminal',
    })).toBe(true);
    expect(isExactSessionTurnMutationPositiveReceiptV1({
      ...mutation,
      provider: 'codex',
    }, receipt)).toBe(false);
    expect(isExactSessionTurnMutationPositiveReceiptV1({
      ...mutation,
      providerTurnId: 'provider-turn-1',
    }, receipt)).toBe(false);

    for (const candidate of [
      { ...receipt, v: 2 },
      { ...receipt, sessionId: 'other-session' },
      { ...receipt, mutationId: 'other-mutation' },
      { ...receipt, action: 'cancel' },
      { ...receipt, turnId: 'other-turn' },
      { ...receipt, observedAt: 201 },
      { ...receipt, decision: 'missing-turn' },
      { ...receipt, decision: 'stale-terminal' },
      { ...receipt, decision: 'stale-in-progress' },
      { ...receipt, decision: 'duplicate-mutation' },
    ]) {
      expect(isExactSessionTurnMutationPositiveReceiptV1(mutation, candidate)).toBe(false);
    }
  });
});
