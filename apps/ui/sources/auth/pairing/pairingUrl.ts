import { resolveAppUrlScheme } from '@/utils/url/appScheme';
import { parseHappierCustomSchemeUrl } from '@/utils/url/parseHappierCustomSchemeUrl';
import { PairingClaimIdV1Schema, normalizePairingClaimOriginV1 } from '@happier-dev/protocol';

type LegacyPairingDeepLinkPayload = {
    pairId: string;
    secret: string;
    serverUrl: string | null;
};

type ClaimPairingDeepLinkPayload = {
    claimId: string;
    origin: string;
};

export type PairingDeepLinkPayload = LegacyPairingDeepLinkPayload | ClaimPairingDeepLinkPayload;

function isValidPairingLinkTarget(hostname: string, pathname: string): boolean {
    const normalizedPathname = pathname === 'pair' ? '/pair' : pathname;

    if (normalizedPathname === '/pair') return true;
    if (hostname === 'pair' && (normalizedPathname === '' || normalizedPathname === '/')) return true;

    return false;
}

function normalizeServerUrl(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;

    const pathname = url.pathname === '/' ? '' : url.pathname;
    const search = url.search ?? '';
    return `${url.origin}${pathname}${search}`;
}

function parseStrictPairingClaimDeepLink(rawLink: string): ClaimPairingDeepLinkPayload | null {
    const prefix = `${resolveAppUrlScheme()}:///pair?`;
    if (!rawLink.startsWith(prefix) || rawLink.includes('#')) return null;

    const query = rawLink.slice(prefix.length);
    const fields = query.split('&');
    const expectedKeys = ['v', 'claimId', 'origin'] as const;
    if (fields.length !== expectedKeys.length) return null;

    for (let index = 0; index < expectedKeys.length; index += 1) {
        const field = fields[index];
        const separatorIndex = field.indexOf('=');
        if (
            separatorIndex <= 0
            || field.indexOf('=', separatorIndex + 1) !== -1
            || field.slice(0, separatorIndex) !== expectedKeys[index]
        ) {
            return null;
        }
    }

    const searchParams = new URLSearchParams(query);
    if (searchParams.get('v') !== 'claim-v1') return null;

    const claimId = searchParams.get('claimId');
    const originRaw = searchParams.get('origin');
    const origin = originRaw ? normalizePairingClaimOriginV1(originRaw) : null;
    if (
        !claimId
        || !PairingClaimIdV1Schema.safeParse(claimId).success
        || !origin
        || originRaw !== origin
    ) {
        return null;
    }

    return { claimId, origin };
}

export function parsePairingDeepLink(rawLink: string): PairingDeepLinkPayload | null {
    const parsed = parseHappierCustomSchemeUrl(rawLink);
    if (!parsed) return null;
    if (!isValidPairingLinkTarget(parsed.hostname, parsed.pathname)) return null;

    const version = parsed.searchParams.get('v');
    if (version === 'claim-v1') {
        return parseStrictPairingClaimDeepLink(rawLink);
    }

    if (version != null && version !== '1') return null;

    const pairId = parsed.searchParams.get('pairId');
    const secret = parsed.searchParams.get('secret');
    if (!pairId || !secret) return null;

    const server = parsed.searchParams.get('server');
    const serverUrl = server ? normalizeServerUrl(server) : null;

    return { pairId, secret, serverUrl };
}

export function buildPairingDeepLink(input: { pairId: string; secret: string; serverUrl?: string | null }): string {
    const pairId = encodeURIComponent(input.pairId);
    const secret = encodeURIComponent(input.secret);

    const serverSegment =
        input.serverUrl != null && input.serverUrl.length > 0
            ? `&server=${encodeURIComponent(input.serverUrl)}`
            : '';

    return `${resolveAppUrlScheme()}:///pair?v=1&pairId=${pairId}&secret=${secret}${serverSegment}`;
}

export function buildPairingClaimDeepLink(input: { claimId: string; origin: string }): string {
    const parsedClaimId = PairingClaimIdV1Schema.safeParse(input.claimId);
    const origin = normalizePairingClaimOriginV1(input.origin);
    if (!parsedClaimId.success || !origin) {
        throw new Error('Invalid claim-v1 pairing link input');
    }

    return `${resolveAppUrlScheme()}:///pair?v=claim-v1&claimId=${encodeURIComponent(parsedClaimId.data)}&origin=${encodeURIComponent(origin)}`;
}
