import { afterEach, describe, expect, it } from 'vitest';

import {
  isOpenCodeConnectedServiceTurnInFlight,
  setOpenCodeConnectedServiceInFlightTurnProvider,
} from './openCodeConnectedServiceInFlightTurnRegistry';

afterEach(() => {
  setOpenCodeConnectedServiceInFlightTurnProvider(null);
});

describe('openCodeConnectedServiceInFlightTurnRegistry', () => {
  it('reports not-in-flight when no provider is registered', () => {
    expect(isOpenCodeConnectedServiceTurnInFlight('sess_1')).toBe(false);
  });

  it('delegates to the registered provider per session id', () => {
    const inFlight = new Set(['sess_1']);
    setOpenCodeConnectedServiceInFlightTurnProvider((sessionId) => inFlight.has(sessionId));

    expect(isOpenCodeConnectedServiceTurnInFlight('sess_1')).toBe(true);
    expect(isOpenCodeConnectedServiceTurnInFlight('sess_2')).toBe(false);
  });

  it('trims the session id before querying the provider', () => {
    const seen: string[] = [];
    setOpenCodeConnectedServiceInFlightTurnProvider((sessionId) => {
      seen.push(sessionId);
      return sessionId === 'sess_1';
    });

    expect(isOpenCodeConnectedServiceTurnInFlight('  sess_1  ')).toBe(true);
    expect(seen).toEqual(['sess_1']);
  });

  it('reports not-in-flight for blank session ids without consulting the provider', () => {
    let calls = 0;
    setOpenCodeConnectedServiceInFlightTurnProvider(() => {
      calls += 1;
      return true;
    });

    expect(isOpenCodeConnectedServiceTurnInFlight('')).toBe(false);
    expect(isOpenCodeConnectedServiceTurnInFlight('   ')).toBe(false);
    expect(calls).toBe(0);
  });

  it('fails closed (not-in-flight) when the provider throws', () => {
    setOpenCodeConnectedServiceInFlightTurnProvider(() => {
      throw new Error('boom');
    });

    expect(isOpenCodeConnectedServiceTurnInFlight('sess_1')).toBe(false);
  });

  it('stops reporting in-flight after the provider is cleared', () => {
    setOpenCodeConnectedServiceInFlightTurnProvider(() => true);
    expect(isOpenCodeConnectedServiceTurnInFlight('sess_1')).toBe(true);

    setOpenCodeConnectedServiceInFlightTurnProvider(null);
    expect(isOpenCodeConnectedServiceTurnInFlight('sess_1')).toBe(false);
  });
});
