import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceProfileIdSchema,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
} from './connectedServiceBindings.js';

/**
 * Agent-friendly connected-services selection normalizer — the ONE boundary that turns the simple
 * forms an agent naturally reaches for into a canonical {@link ConnectedServiceBindingsV1}.
 *
 * Accepted input (any of):
 *  - `undefined` / `null` → no explicit selection; the run/session uses the account default.
 *  - a string token, or an array of string tokens, each one of:
 *      - `"<serviceId>"`                     → account default for that service (contributes no
 *                                              explicit binding; the caller's defaulting applies).
 *      - `"<serviceId>:<profileId>"`         → pin the run to that connected profile.
 *      - `"<serviceId>:profile:<profileId>"` → pin the run to that connected profile (explicit).
 *      - `"<serviceId>:group:<groupId>"`     → bind to that account pool/group (auto-rotates when the
 *                                              pool has autoSwitch enabled).
 *      - `"<serviceId>:native"`              → opt out; use the runner's inherited account.
 *  - a full `{ v: 1, bindingsByServiceId: { ... } }` object (the canonical power form).
 *
 * Malformed input is rejected with a typed error naming the valid forms — never silently dropped.
 * A result of `{ ok: true, bindings: undefined }` means "no explicit binding; defer to the account
 * default", which for runs/sessions prefers the account's autoSwitch pool when one is configured.
 */

export type NormalizeConnectedServiceSelectionResult =
    | Readonly<{ ok: true; bindings: ConnectedServiceBindingsV1 | undefined }>
    | Readonly<{ ok: false; error: string }>;

const VALID_FORMS_MESSAGE =
    'Valid forms: "<serviceId>" (account default), "<serviceId>:<profileId>", '
    + '"<serviceId>:profile:<profileId>", "<serviceId>:group:<groupId>", "<serviceId>:native", '
    + 'an array of those, or a full { v: 1, bindingsByServiceId: {...} } object. '
    + 'serviceId is e.g. "openai-codex".';

function invalid(reason: string): Readonly<{ ok: false; error: string }> {
    return { ok: false, error: `${reason} ${VALID_FORMS_MESSAGE}` };
}

type TokenParse =
    | Readonly<{ ok: true; serviceId: string; binding: ConnectedServiceBindingSelectionV1 | undefined }>
    | Readonly<{ ok: false; error: string }>;

function parseSelectionToken(rawToken: string): TokenParse {
    const token = rawToken.trim();
    if (!token) return invalid('Empty connected-services selection.');

    const parts = token.split(':').map((part) => part.trim());
    const serviceIdRaw = parts[0] ?? '';
    const serviceParsed = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!serviceParsed.success) {
        return invalid(`Unknown connected service id "${serviceIdRaw}".`);
    }
    const serviceId = serviceParsed.data;

    // "<serviceId>" → account default for that service (no explicit binding).
    if (parts.length === 1) {
        return { ok: true, serviceId, binding: undefined };
    }

    if (parts.length === 2) {
        const second = parts[1] ?? '';
        if (second === 'native') {
            return { ok: true, serviceId, binding: { source: 'native' } };
        }
        if (second === 'group') {
            return invalid(`"${serviceId}:group" is missing a group id.`);
        }
        if (second === 'profile') {
            return invalid(`"${serviceId}:profile" is missing a profile id.`);
        }
        // "<serviceId>:<profileId>"
        const profileParsed = ConnectedServiceProfileIdSchema.safeParse(second);
        if (!profileParsed.success) return invalid(`Invalid profile id "${second}".`);
        return { ok: true, serviceId, binding: { source: 'connected', selection: 'profile', profileId: profileParsed.data } };
    }

    if (parts.length === 3) {
        const kind = parts[1] ?? '';
        const value = parts[2] ?? '';
        if (kind === 'profile') {
            const profileParsed = ConnectedServiceProfileIdSchema.safeParse(value);
            if (!profileParsed.success) return invalid(`Invalid profile id "${value}".`);
            return { ok: true, serviceId, binding: { source: 'connected', selection: 'profile', profileId: profileParsed.data } };
        }
        if (kind === 'group') {
            const groupParsed = ConnectedServiceAuthGroupIdSchema.safeParse(value);
            if (!groupParsed.success) return invalid(`Invalid group id "${value}".`);
            return { ok: true, serviceId, binding: { source: 'connected', selection: 'group', groupId: groupParsed.data } };
        }
        return invalid(`Unknown selection kind "${kind}".`);
    }

    return invalid(`Could not parse connected-services selection "${token}".`);
}

function normalizeTokens(tokens: readonly string[]): NormalizeConnectedServiceSelectionResult {
    const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
    for (const rawToken of tokens) {
        const parsed = parseSelectionToken(rawToken);
        if (!parsed.ok) return parsed;
        if (parsed.binding === undefined) continue; // bare serviceId → account default.
        if (bindingsByServiceId[parsed.serviceId] !== undefined) {
            return invalid(`Duplicate selection for service "${parsed.serviceId}".`);
        }
        bindingsByServiceId[parsed.serviceId] = parsed.binding;
    }

    if (Object.keys(bindingsByServiceId).length === 0) {
        return { ok: true, bindings: undefined };
    }
    const parsed = ConnectedServiceBindingsV1Schema.safeParse({ v: 1, bindingsByServiceId });
    if (!parsed.success) return invalid('Invalid connected-services selection.');
    return { ok: true, bindings: parsed.data };
}

export function normalizeConnectedServiceSelectionInput(
    input: unknown,
): NormalizeConnectedServiceSelectionResult {
    if (input === undefined || input === null) {
        return { ok: true, bindings: undefined };
    }

    if (typeof input === 'string') {
        return normalizeTokens([input]);
    }

    if (Array.isArray(input)) {
        if (input.some((entry) => typeof entry !== 'string')) {
            return invalid('Connected-services array entries must be strings.');
        }
        return normalizeTokens(input as string[]);
    }

    if (typeof input === 'object') {
        // Canonical power form: a full bindings object.
        const parsed = ConnectedServiceBindingsV1Schema.safeParse(input);
        if (parsed.success) {
            const hasBinding = Object.keys(parsed.data.bindingsByServiceId).length > 0;
            return { ok: true, bindings: hasBinding ? parsed.data : undefined };
        }
        return invalid('Invalid connected-services object.');
    }

    return invalid('Unsupported connected-services selection type.');
}
