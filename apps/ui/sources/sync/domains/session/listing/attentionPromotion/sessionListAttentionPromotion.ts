import {
    normalizeSessionListAttentionPromotionMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPromotionMode,
    type SessionListAttentionPromotionReason,
    type SessionListWorkingPlacementMode,
} from './sessionListAttentionPromotionTypes';

export const ATTENTION_PROMOTION_GROUP_KEY_V1 = 'attention-promotion-v1';

export type SessionListAttentionPromotionOptions = Readonly<{
    mode: SessionListAttentionPromotionMode;
    activeSessionKey?: string | null;
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
}>;

export type SessionListWorkingPlacementOptions = Readonly<{
    mode: SessionListWorkingPlacementMode;
}>;

export {
    normalizeSessionListAttentionPromotionMode,
    normalizeSessionListWorkingPlacementMode,
};
export type {
    SessionListAttentionPromotionMode,
    SessionListAttentionPromotionReason,
    SessionListWorkingPlacementMode,
};
