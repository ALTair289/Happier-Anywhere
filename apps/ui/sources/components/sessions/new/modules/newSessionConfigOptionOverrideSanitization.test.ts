import { describe, expect, it } from 'vitest';

import { sanitizeNewSessionConfigOverridesForModelSelection } from './newSessionConfigOptionOverrideSanitization';

describe('sanitizeNewSessionConfigOverridesForModelSelection', () => {
    it('preserves exact nonblank config identifiers and selected values', () => {
        expect(sanitizeNewSessionConfigOverridesForModelSelection({
            providerId: 'cursor',
            configOptions: [{
                id: ' effort ',
                name: 'Effort',
                type: 'select',
                currentValue: ' medium ',
                options: [
                    { value: ' medium ', name: 'Medium' },
                    { value: ' high ', name: 'High' },
                ],
            }],
            modelOptions: [],
            selectedModelId: ' model ',
            selectedConfigOverrides: { ' effort ': ' high ' },
        })).toEqual({ ' effort ': ' high ' });
    });
});
