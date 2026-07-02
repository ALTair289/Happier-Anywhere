import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceOauthAddActionModesForPlatform } from './oauth/resolveConnectedServiceOauthAddActionModesForPlatform';

describe('ConnectedServiceDetailView oauth add modes (platform)', () => {
  it('does not include embedded browser add mode on web', () => {
    expect(resolveConnectedServiceOauthAddActionModesForPlatform({
      platformOS: 'web',
      oauthAddActionModes: ['paste', 'browser'],
    })).toEqual(['paste']);
  });

  it('keeps embedded browser add mode on native platforms', () => {
    expect(resolveConnectedServiceOauthAddActionModesForPlatform({
      platformOS: 'ios',
      oauthAddActionModes: ['paste', 'browser'],
    })).toEqual(['paste', 'browser']);
  });
});
