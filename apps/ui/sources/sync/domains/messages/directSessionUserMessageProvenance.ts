import type { MessageMeta } from './messageMetaTypes';

const DIRECT_SESSION_USER_MESSAGE = Symbol('happier.direct-session-user-message');

type DirectSessionUserMessageMeta = MessageMeta & {
    [DIRECT_SESSION_USER_MESSAGE]?: true;
};

export function markDirectSessionUserMessageMeta(meta: MessageMeta | undefined): MessageMeta {
    return {
        ...(meta ?? {}),
        [DIRECT_SESSION_USER_MESSAGE]: true,
    } as DirectSessionUserMessageMeta;
}

export function isDirectSessionUserMessageMeta(meta: MessageMeta | undefined): boolean {
    return (meta as DirectSessionUserMessageMeta | undefined)?.[DIRECT_SESSION_USER_MESSAGE] === true;
}
