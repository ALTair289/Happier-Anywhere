export type ConnectedServiceProfileActionRoute =
    | Readonly<{
        pathname: '/settings/connected-services/oauth' | '/settings/connected-services/profile';
        params: Readonly<{
            serviceId: string;
            profileId: string;
        }>;
    }>
    | Readonly<{
        pathname: '/settings/connected-services';
    }>;

function readRouteString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function isProfileAuthKind(kind: string): boolean {
    return kind === 'token'
        || kind === 'apiKey'
        || kind === 'api_key'
        || kind === 'manual';
}

export function readConnectedServiceProfileKindFromServices(params: Readonly<{
    connectedServicesV2: unknown;
    serviceId: string;
    profileId: string;
}>): string | null {
    if (!Array.isArray(params.connectedServicesV2)) return null;

    for (const service of params.connectedServicesV2) {
        if (!service || typeof service !== 'object' || Array.isArray(service)) continue;
        const rawService = service as Record<string, unknown>;
        if (rawService.serviceId !== params.serviceId) continue;
        const profiles = rawService.profiles;
        if (!Array.isArray(profiles)) return null;
        for (const profile of profiles) {
            if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
            const rawProfile = profile as Record<string, unknown>;
            const profileId = typeof rawProfile.profileId === 'string' ? rawProfile.profileId.trim() : '';
            if (profileId !== params.profileId) continue;
            return typeof rawProfile.kind === 'string' ? rawProfile.kind.trim() : null;
        }
    }

    return null;
}

export function resolveConnectedServiceProfileActionRoute(params: Readonly<{
    serviceId?: unknown;
    profileId?: unknown;
    profileKind?: unknown;
}>): ConnectedServiceProfileActionRoute {
    const serviceId = readRouteString(params.serviceId);
    const profileId = readRouteString(params.profileId);
    const profileKind = readRouteString(params.profileKind);

    if (!serviceId || !profileId) {
        return { pathname: '/settings/connected-services' };
    }

    if (profileKind === 'oauth') {
        return {
            pathname: '/settings/connected-services/oauth',
            params: { serviceId, profileId },
        };
    }

    if (isProfileAuthKind(profileKind)) {
        return {
            pathname: '/settings/connected-services/profile',
            params: { serviceId, profileId },
        };
    }

    return { pathname: '/settings/connected-services' };
}
