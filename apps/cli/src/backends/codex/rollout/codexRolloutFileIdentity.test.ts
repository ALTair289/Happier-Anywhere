import { describe, expect, it } from 'vitest';

import {
    createCodexRolloutEffectLocalId,
    createCodexRolloutFileIdentity,
} from './codexRolloutFileIdentity';

describe('createCodexRolloutFileIdentity', () => {
    it('preserves the v1 file identity vector shared by live and direct rollout readers', () => {
        expect(createCodexRolloutFileIdentity({ dev: 123, ino: 456 })).toBe(
            '0d8511bde1b89ad8cbcb5ab7e9043f194ef495b9321d249d483cd9b131037ed3',
        );
    });

    it('derives one stable identity per effect occurrence within a rollout source line', () => {
        const fileIdentity = createCodexRolloutFileIdentity({ dev: 123, ino: 456 });

        expect(createCodexRolloutEffectLocalId({
            fileIdentity,
            lineStartOffsetBytes: 789,
            effectIndex: 2,
        })).toBe('f1c5d247099bf1f26ee7b91cfd129af0f3f8187dbf947c6a295686151a45b432');
        expect(createCodexRolloutEffectLocalId({
            fileIdentity,
            lineStartOffsetBytes: 789,
            effectIndex: 3,
        })).not.toBe(createCodexRolloutEffectLocalId({
            fileIdentity,
            lineStartOffsetBytes: 789,
            effectIndex: 2,
        }));
    });
});
