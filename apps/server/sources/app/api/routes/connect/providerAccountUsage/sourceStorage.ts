import { createHash } from "node:crypto";

import { ConnectedServiceUsageSourceV1Schema, type ConnectedServiceUsageSourceV1 } from "@happier-dev/protocol";
import { AGENTS_CORE } from "@happier-dev/agents";

import { db } from "@/storage/db";
import type { TransactionClient } from "@/storage/prisma";
import { UpsertConnectedServiceUsageSourceSchema } from "./schemas";
import type {
    StoredConnectedServiceUsageSource,
    UpsertConnectedServiceUsageSourceParams,
} from "./types";
import {
    ConnectedServiceUsageSourceBindingError,
    ConnectedServiceUsageSourceOwnershipError,
} from "./types";

type ConnectedServiceUsageSourceClient = Pick<
    typeof db,
    "providerAccountUsageRecord" | "serviceAccountToken" | "connectedServiceAuthGroupMember" | "connectedServiceUsageSource"
> | Pick<
    TransactionClient,
    "providerAccountUsageRecord" | "serviceAccountToken" | "connectedServiceAuthGroupMember" | "connectedServiceUsageSource"
>;

type AgentConnectedServiceSupport = Readonly<{
    connectedServices?: Readonly<{
        supportedServiceIds: ReadonlyArray<string>;
    }> | null;
}>;

type ConnectedServiceBindingIdentity = Readonly<{
    providerAccountId: string | null;
}>;
type ProviderAccountUsageRecordIdentity = Readonly<{
    providerId: string;
    accountSubjectId: string;
    subjectKind: string;
}>;

const AGENTS_BY_PROVIDER_ID: Readonly<Record<string, AgentConnectedServiceSupport>> = AGENTS_CORE;

function readRecord(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readCredentialBindingIdentity(metadata: unknown): ConnectedServiceBindingIdentity {
    const record = readRecord(metadata);
    return {
        providerAccountId: readString(record?.providerAccountId),
    };
}

function buildConnectedServiceUsageSourceKey(params: Readonly<{
    bindingKind: "profile" | "group_member";
    serviceId: string;
    profileId: string;
    groupId?: string;
    groupGeneration?: number;
}>): string {
    const tuple = params.bindingKind === "group_member"
        ? ["group", params.serviceId, params.profileId, params.groupId ?? "", params.groupGeneration ?? "current"]
        : ["profile", params.serviceId, params.profileId];
    const digest = createHash("sha256").update(JSON.stringify(tuple)).digest("base64url");
    return `csus_v1_${digest}`;
}

function mapStoredConnectedServiceUsageSource(row: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    sourceKey: string;
    providerAccountUsageRecordId: string;
    bindingKind: string;
    groupId: string | null;
    groupGeneration: number | null;
}>): StoredConnectedServiceUsageSource {
    if (row.bindingKind !== "profile" && row.bindingKind !== "group_member") {
        throw new ConnectedServiceUsageSourceBindingError(`Unsupported connected service usage source binding kind: ${row.bindingKind}`);
    }
    return {
        accountId: row.accountId,
        serviceId: row.serviceId,
        profileId: row.profileId,
        sourceKey: row.sourceKey,
        providerAccountUsageRecordId: row.providerAccountUsageRecordId as StoredConnectedServiceUsageSource["providerAccountUsageRecordId"],
        bindingKind: row.bindingKind,
        ...(row.groupId ? { groupId: row.groupId } : {}),
        ...(typeof row.groupGeneration === "number" ? { groupGeneration: row.groupGeneration } : {}),
    };
}

export function toConnectedServiceUsageSourceV1(
    source: StoredConnectedServiceUsageSource,
): ConnectedServiceUsageSourceV1 {
    return ConnectedServiceUsageSourceV1Schema.parse({
        serviceId: source.serviceId,
        profileId: source.profileId,
        bindingKind: source.bindingKind,
        ...(source.groupId ? { groupId: source.groupId } : {}),
        ...(source.groupGeneration !== undefined ? { groupGeneration: source.groupGeneration } : {}),
    });
}

function isProviderUsageRecordCompatibleWithConnectedService(params: Readonly<{
    providerId: string;
    serviceId: string;
}>): boolean {
    const providerId = params.providerId.trim();
    const serviceId = params.serviceId.trim();
    if (!providerId || !serviceId) return false;
    if (providerId === serviceId) return true;
    const provider = AGENTS_BY_PROVIDER_ID[providerId];
    return provider?.connectedServices?.supportedServiceIds.includes(serviceId) === true;
}

export function assertProviderUsageRecordCompatibleWithConnectedServiceSource(params: Readonly<{
    providerId: string;
    serviceId: string;
}>): void {
    if (!isProviderUsageRecordCompatibleWithConnectedService(params)) {
        throw new ConnectedServiceUsageSourceOwnershipError("Provider account usage record is not compatible with the connected-service source");
    }
}

async function isStoredConnectedServiceUsageSourceActive(
    source: StoredConnectedServiceUsageSource,
    client: ConnectedServiceUsageSourceClient,
): Promise<boolean> {
    try {
        const record = await resolveLinkedProviderUsageRecordIdentity(source, client);
        assertProviderUsageRecordCompatibleWithConnectedServiceSource({
            providerId: record.providerId,
            serviceId: source.serviceId,
        });
        let bindingIdentity: ConnectedServiceBindingIdentity;
        if (source.bindingKind === "profile") {
            bindingIdentity = await resolveProfileBinding(source, client);
        } else {
            bindingIdentity = (await resolveGroupBinding({
                accountId: source.accountId,
                serviceId: source.serviceId,
                profileId: source.profileId,
                groupId: source.groupId,
                groupGeneration: source.groupGeneration,
                requireGenerationMatch: false,
            }, client)).identity;
        }
        assertConnectedServiceBindingIdentityMatchesProviderUsageRecord({
            providerAccountSubjectId: record.accountSubjectId,
            providerAccountSubjectKind: record.subjectKind,
            bindingIdentity,
        });
        return true;
    } catch (error) {
        if (
            error instanceof ConnectedServiceUsageSourceBindingError
            || error instanceof ConnectedServiceUsageSourceOwnershipError
        ) return false;
        throw error;
    }
}

async function resolveLinkedProviderUsageRecordIdentity(
    source: StoredConnectedServiceUsageSource,
    client: ConnectedServiceUsageSourceClient,
): Promise<ProviderAccountUsageRecordIdentity> {
    const record = await client.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: source.accountId,
                recordId: source.providerAccountUsageRecordId,
            },
        },
        select: { providerId: true, accountSubjectId: true, subjectKind: true },
    });
    if (!record) {
        throw new ConnectedServiceUsageSourceOwnershipError("Provider account usage record does not belong to the source account");
    }
    return record;
}

async function resolveProfileBinding(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient): Promise<ConnectedServiceBindingIdentity> {
    const binding = await client.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { metadata: true },
    });
    if (!binding) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service profile binding does not exist", "unavailable");
    }
    return readCredentialBindingIdentity(binding.metadata);
}

async function resolveGroupBinding(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    groupId?: string;
    groupGeneration?: number;
    requireGenerationMatch?: boolean;
}>, client: ConnectedServiceUsageSourceClient): Promise<Readonly<{
    groupGeneration: number;
    identity: ConnectedServiceBindingIdentity;
}>> {
    if (!params.groupId) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service group-member sources require groupId");
    }
    const member = await client.connectedServiceAuthGroupMember.findUnique({
        where: {
            accountId_vendor_groupId_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
                profileId: params.profileId,
            },
        },
        select: {
            enabled: true,
            group: { select: { generation: true } },
            credential: { select: { metadata: true } },
        },
    });
    if (!member || !member.enabled) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service group-member binding is missing or disabled", "unavailable");
    }
    if (params.requireGenerationMatch !== false && params.groupGeneration !== undefined && member.group.generation !== params.groupGeneration) {
        throw new ConnectedServiceUsageSourceBindingError("Connected-service group-member generation does not match the active group generation", "unavailable");
    }
    return {
        groupGeneration: params.groupGeneration ?? member.group.generation,
        identity: readCredentialBindingIdentity(member.credential.metadata),
    };
}

function assertConnectedServiceBindingIdentityMatchesProviderUsageRecord(params: Readonly<{
    providerAccountSubjectId: string;
    providerAccountSubjectKind: string;
    bindingIdentity: ConnectedServiceBindingIdentity;
}>): void {
    if (!params.bindingIdentity.providerAccountId) {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Connected-service credential does not expose provider account identity",
            "unproven",
        );
    }
    if (params.providerAccountSubjectKind !== "account") {
        throw new ConnectedServiceUsageSourceOwnershipError(
            "Provider account usage record does not expose a verifiable account subject",
            "unproven",
        );
    }
    if (params.bindingIdentity.providerAccountId !== params.providerAccountSubjectId) {
        throw new ConnectedServiceUsageSourceOwnershipError("Connected-service credential identity does not match provider account usage record");
    }
}

export async function upsertConnectedServiceUsageSource(
    raw: UpsertConnectedServiceUsageSourceParams,
    client: ConnectedServiceUsageSourceClient = db,
): Promise<StoredConnectedServiceUsageSource> {
    const parsed = UpsertConnectedServiceUsageSourceSchema.parse(raw);
    const record = await client.providerAccountUsageRecord.findUnique({
        where: {
            accountId_recordId: {
                accountId: parsed.accountId,
                recordId: parsed.providerAccountUsageRecordId,
            },
        },
        select: { recordId: true, providerId: true, accountSubjectId: true, subjectKind: true },
    });
    if (!record) {
        throw new ConnectedServiceUsageSourceOwnershipError("Provider account usage record does not belong to the source account");
    }
    assertProviderUsageRecordCompatibleWithConnectedServiceSource({
        providerId: record.providerId,
        serviceId: parsed.serviceId,
    });

    let groupGeneration = parsed.groupGeneration;
    let bindingIdentity: ConnectedServiceBindingIdentity;
    if (parsed.bindingKind === "profile") {
        bindingIdentity = await resolveProfileBinding(parsed, client);
    } else {
        const groupBinding = await resolveGroupBinding(parsed, client);
        groupGeneration = groupBinding.groupGeneration;
        bindingIdentity = groupBinding.identity;
    }
    assertConnectedServiceBindingIdentityMatchesProviderUsageRecord({
        providerAccountSubjectId: record.accountSubjectId,
        providerAccountSubjectKind: record.subjectKind,
        bindingIdentity,
    });

    const sourceKey = buildConnectedServiceUsageSourceKey({
        bindingKind: parsed.bindingKind,
        serviceId: parsed.serviceId,
        profileId: parsed.profileId,
        groupId: parsed.groupId,
        groupGeneration,
    });

    // Source identity is the full sourceKey (serviceId + profileId + group identity),
    // NOT the profile tuple: one profile can belong to multiple auth groups, and each
    // group's link owns a distinct sourceKey. Keying the upsert by sourceKey lets those
    // per-group links coexist instead of the second silently overwriting the first.
    const row = await client.connectedServiceUsageSource.upsert({
        where: {
            accountId_sourceKey: {
                accountId: parsed.accountId,
                sourceKey,
            },
        },
        create: {
            accountId: parsed.accountId,
            serviceId: parsed.serviceId,
            profileId: parsed.profileId,
            sourceKey,
            providerAccountUsageRecordId: parsed.providerAccountUsageRecordId,
            bindingKind: parsed.bindingKind,
            ...(parsed.groupId ? { groupId: parsed.groupId } : {}),
            ...(groupGeneration !== undefined ? { groupGeneration } : {}),
        },
        update: {
            providerAccountUsageRecordId: parsed.providerAccountUsageRecordId,
            bindingKind: parsed.bindingKind,
            groupId: parsed.groupId ?? null,
            groupGeneration: groupGeneration ?? null,
        },
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    return mapStoredConnectedServiceUsageSource(row);
}

export async function readConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<StoredConnectedServiceUsageSource | null> {
    // A profile can now hold several coexisting links (one per group it belongs to,
    // plus an optional profile-level link). They are identity-bound to the same
    // credential, so any active one resolves to the same provider usage record; return
    // the first active match under a deterministic order.
    const rows = await client.connectedServiceUsageSource.findMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
        },
        orderBy: [
            { bindingKind: "asc" },
            { sourceKey: "asc" },
        ],
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    for (const row of rows) {
        const source = mapStoredConnectedServiceUsageSource(row);
        if (await isStoredConnectedServiceUsageSourceActive(source, client)) {
            return source;
        }
    }
    return null;
}

export async function listConnectedServiceUsageSourcesForProviderAccountUsageRecord(params: Readonly<{
    accountId: string;
    providerAccountUsageRecordId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<StoredConnectedServiceUsageSource[]> {
    const rows = await client.connectedServiceUsageSource.findMany({
        where: {
            accountId: params.accountId,
            providerAccountUsageRecordId: params.providerAccountUsageRecordId,
        },
        orderBy: [
            { serviceId: "asc" },
            { profileId: "asc" },
        ],
        select: {
            accountId: true,
            serviceId: true,
            profileId: true,
            sourceKey: true,
            providerAccountUsageRecordId: true,
            bindingKind: true,
            groupId: true,
            groupGeneration: true,
        },
    });
    const activeSources: StoredConnectedServiceUsageSource[] = [];
    for (const row of rows) {
        const source = mapStoredConnectedServiceUsageSource(row);
        if (await isStoredConnectedServiceUsageSourceActive(source, client)) {
            activeSources.push(source);
        }
    }
    return activeSources;
}

export async function unlinkConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<"removed" | "not_found"> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
        },
    });
    return deleted.count > 0 ? "removed" : "not_found";
}

export async function deleteConnectedServiceUsageSourcesForProfile(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<number> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: {
            accountId: params.accountId,
            serviceId: params.serviceId,
            profileId: params.profileId,
        },
    });
    return deleted.count;
}

export async function deleteConnectedServiceUsageSourcesForAccount(params: Readonly<{
    accountId: string;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<number> {
    const deleted = await client.connectedServiceUsageSource.deleteMany({
        where: { accountId: params.accountId },
    });
    return deleted.count;
}

export async function linkConnectedServiceUsageSource(params: Readonly<{
    accountId: string;
    providerAccountUsageRecordId: string;
    source: ConnectedServiceUsageSourceV1;
}>, client: ConnectedServiceUsageSourceClient = db): Promise<StoredConnectedServiceUsageSource> {
    return await upsertConnectedServiceUsageSource({
        accountId: params.accountId,
        serviceId: params.source.serviceId,
        profileId: params.source.profileId,
        providerAccountUsageRecordId: params.providerAccountUsageRecordId as StoredConnectedServiceUsageSource["providerAccountUsageRecordId"],
        bindingKind: params.source.bindingKind,
        groupId: params.source.groupId,
        groupGeneration: params.source.groupGeneration,
    }, client);
}
