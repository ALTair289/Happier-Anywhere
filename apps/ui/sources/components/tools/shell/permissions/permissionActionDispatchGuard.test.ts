import { describe, expect, it, vi } from 'vitest';

import { createPermissionActionDispatchGuard } from './permissionActionDispatchGuard';


function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('permission action dispatch guard', () => {
    it('dispatches at most once for a request even when activated twice in the same commit', async () => {
        const pending = deferred();
        const action = vi.fn(() => pending.promise);
        const guard = createPermissionActionDispatchGuard('session-1:request-1');

        const first = guard.dispatch('session-1:request-1', action);
        const second = guard.dispatch('session-1:request-1', action);

        expect(action).toHaveBeenCalledTimes(1);
        expect(await second).toBe(false);

        pending.resolve();
        expect(await first).toBe(true);
        expect(await guard.dispatch('session-1:request-1', action)).toBe(false);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('releases the request after a retryable action failure', async () => {
        const action = vi.fn()
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValueOnce(undefined);
        const guard = createPermissionActionDispatchGuard('session-1:request-1');

        await expect(guard.dispatch('session-1:request-1', action)).rejects.toThrow('temporary transport failure');
        await expect(guard.dispatch('session-1:request-1', action)).resolves.toBe(true);
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('allows a new request identity and ignores late settlement from the prior request', async () => {
        const firstPending = deferred();
        const secondPending = deferred();
        const firstAction = vi.fn(() => firstPending.promise);
        const secondAction = vi.fn(() => secondPending.promise);
        const guard = createPermissionActionDispatchGuard('session-1:request-1');

        const first = guard.dispatch('session-1:request-1', firstAction);
        guard.setRequestKey('session-1:request-2');
        const second = guard.dispatch('session-1:request-2', secondAction);

        firstPending.resolve();
        expect(await first).toBe(true);
        expect(await guard.dispatch('session-1:request-2', secondAction)).toBe(false);

        secondPending.resolve();
        expect(await second).toBe(true);
        expect(firstAction).toHaveBeenCalledTimes(1);
        expect(secondAction).toHaveBeenCalledTimes(1);
    });

    it('shares in-flight arbitration across mounted guards and releases it after settlement', async () => {
        const oldPending = deferred();
        const oldAction = vi.fn(() => oldPending.promise);
        const oldGuard = createPermissionActionDispatchGuard('session-1:request-1');
        oldGuard.retainRequest('session-1:request-1');
        const oldDispatch = oldGuard.dispatch('session-1:request-1', oldAction);

        const reloadedAction = vi.fn().mockResolvedValue(undefined);
        const reloadedGuard = createPermissionActionDispatchGuard('session-1:request-1');
        reloadedGuard.retainRequest('session-1:request-1');
        await expect(reloadedGuard.dispatch('session-1:request-1', reloadedAction)).resolves.toBe(false);

        oldPending.resolve();
        await expect(oldDispatch).resolves.toBe(true);
        await expect(reloadedGuard.dispatch('session-1:request-1', reloadedAction)).resolves.toBe(false);

        oldGuard.releaseRequest('session-1:request-1');
        reloadedGuard.releaseRequest('session-1:request-1');

        const settledAction = vi.fn().mockResolvedValue(undefined);
        const settledGuard = createPermissionActionDispatchGuard('session-1:request-1');
        settledGuard.retainRequest('session-1:request-1');
        await expect(settledGuard.dispatch('session-1:request-1', settledAction)).resolves.toBe(true);
        settledGuard.releaseRequest('session-1:request-1');

        expect(oldAction).toHaveBeenCalledTimes(1);
        expect(reloadedAction).not.toHaveBeenCalled();
        expect(settledAction).toHaveBeenCalledTimes(1);
    });

    it('does not serialize unrelated permission requests', async () => {
        const firstPending = deferred();
        const firstAction = vi.fn(() => firstPending.promise);
        const secondAction = vi.fn().mockResolvedValue(undefined);
        const firstGuard = createPermissionActionDispatchGuard('session-1:request-1');
        const secondGuard = createPermissionActionDispatchGuard('session-1:request-2');

        const firstDispatch = firstGuard.dispatch('session-1:request-1', firstAction);
        await expect(secondGuard.dispatch('session-1:request-2', secondAction)).resolves.toBe(true);

        firstPending.resolve();
        await expect(firstDispatch).resolves.toBe(true);
        expect(firstAction).toHaveBeenCalledTimes(1);
        expect(secondAction).toHaveBeenCalledTimes(1);
    });
});
