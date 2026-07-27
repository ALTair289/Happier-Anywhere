import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    TranscriptSameSessionHandoffProvider,
    type TranscriptExitEntrySnapshot,
    type TranscriptExperience,
    type TranscriptSameSessionHandoffRoute,
    useTranscriptSameSessionHandoffRoute,
} from './transcriptSameSessionHandoff';

const neverSettles = new Promise<never>(() => undefined);

function anchored(messageId: string, itemOffsetPx: number, capturedAtMs: number): TranscriptExitEntrySnapshot {
    return {
        anchor: {
            kind: 'message',
            messageId,
            itemId: messageId,
            itemOffsetPx,
            capturedAtMs,
        },
        capturedAtMs,
        isPinned: false,
        offsetY: 500,
        shouldRestoreViewport: true,
    };
}

function tail(capturedAtMs: number): TranscriptExitEntrySnapshot {
    return {
        anchor: null,
        capturedAtMs,
        isPinned: true,
        offsetY: 0,
        shouldRestoreViewport: false,
    };
}

type RouteRef = { current: TranscriptSameSessionHandoffRoute | null };

function RouteProbe(props: Readonly<{ routeRef: RouteRef }>) {
    const route = useTranscriptSameSessionHandoffRoute();
    React.useLayoutEffect(() => {
        props.routeRef.current = route;
        return () => {
            props.routeRef.current = null;
        };
    }, [props.routeRef, route]);
    return null;
}

function TranscriptProducer(props: Readonly<{
    capture: () => { source: 'physical-exit'; viewport: TranscriptExitEntrySnapshot } | null;
    experience: TranscriptExperience;
    mountToken: object;
    sessionId: string;
}>) {
    const route = useTranscriptSameSessionHandoffRoute();
    React.useLayoutEffect(() => {
        const unregister = route.registerProducer({
            captureForHandoff: props.capture,
            experience: props.experience,
            mountToken: props.mountToken,
            sessionId: props.sessionId,
        });
        return () => {
            route.refreshForDeletion({
                producerMountToken: props.mountToken,
                selection: props.capture(),
                sessionId: props.sessionId,
            });
            unregister();
        };
    }, [props.capture, props.experience, props.mountToken, props.sessionId, route]);
    return null;
}

function TranscriptConsumer(props: Readonly<{
    experience: TranscriptExperience;
    fallbackSnapshot: TranscriptExitEntrySnapshot;
    layoutSnapshots: TranscriptExitEntrySnapshot[];
    mountToken: object;
    renderSnapshots: TranscriptExitEntrySnapshot[];
    sessionId: string;
}>) {
    const route = useTranscriptSameSessionHandoffRoute();
    const claimedRef = React.useRef<TranscriptExitEntrySnapshot | null>(null);
    const peeked = route.peekForRender({
        incomingMountToken: props.mountToken,
        sessionId: props.sessionId,
        toExperience: props.experience,
    });
    props.renderSnapshots.push(peeked?.viewport ?? props.fallbackSnapshot);
    React.useInsertionEffect(() => {
        claimedRef.current ??= route.claimAfterCommit({
            incomingMountToken: props.mountToken,
            sessionId: props.sessionId,
            toExperience: props.experience,
        })?.viewport ?? null;
    }, [props.experience, props.mountToken, props.sessionId, route]);
    React.useLayoutEffect(() => {
        props.layoutSnapshots.push(claimedRef.current ?? props.fallbackSnapshot);
    }, [props.fallbackSnapshot, props.layoutSnapshots]);
    return null;
}

function AbandonedTranscriptConsumer(props: Readonly<{
    mountToken: object;
    sessionId: string;
}>): React.ReactElement {
    const route = useTranscriptSameSessionHandoffRoute();
    route.peekForRender({
        incomingMountToken: props.mountToken,
        sessionId: props.sessionId,
        toExperience: 'cockpit',
    });
    throw neverSettles;
}

function ReplacementHarness(props: Readonly<{
    capture: () => { source: 'physical-exit'; viewport: TranscriptExitEntrySnapshot } | null;
    experience: TranscriptExperience | 'abandoned';
    fallbackSnapshot?: TranscriptExitEntrySnapshot;
    layoutSnapshots: TranscriptExitEntrySnapshot[];
    mountToken: object;
    renderSnapshots: TranscriptExitEntrySnapshot[];
    routeRef: RouteRef;
    sessionId?: string;
}>) {
    const sessionId = props.sessionId ?? 'session-a';
    const producerMountTokenRef = React.useRef(props.mountToken);
    return (
        <TranscriptSameSessionHandoffProvider
            desiredExperience={props.experience === 'classic' ? 'classic' : 'cockpit'}
            sessionId={sessionId}
        >
            {(experience) => (
                <>
                    <RouteProbe routeRef={props.routeRef} />
                    {experience === 'classic' ? (
                        <TranscriptProducer
                            capture={props.capture}
                            experience="classic"
                            mountToken={producerMountTokenRef.current}
                            sessionId={sessionId}
                        />
                    ) : props.experience === 'cockpit' ? (
                        <TranscriptConsumer
                            experience="cockpit"
                            fallbackSnapshot={props.fallbackSnapshot ?? tail(0)}
                            layoutSnapshots={props.layoutSnapshots}
                            mountToken={props.mountToken}
                            renderSnapshots={props.renderSnapshots}
                            sessionId={sessionId}
                        />
                    ) : (
                        <React.Suspense fallback={null}>
                            <AbandonedTranscriptConsumer
                                mountToken={props.mountToken}
                                sessionId={sessionId}
                            />
                        </React.Suspense>
                    )}
                </>
            )}
        </TranscriptSameSessionHandoffProvider>
    );
}

describe('transcriptSameSessionHandoff', () => {
    it('stages a raw desired-experience change so the outgoing producer prepares before incoming render', async () => {
        const routeRef: RouteRef = { current: null };
        const renderSnapshots: TranscriptExitEntrySnapshot[] = [];
        const layoutSnapshots: TranscriptExitEntrySnapshot[] = [];
        const outgoingToken = {};
        const incomingToken = {};
        const current = anchored('m2', 55, 20);
        const capture = () => ({ source: 'physical-exit' as const, viewport: current });
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ReplacementHarness
                    capture={capture}
                    experience="classic"
                    fallbackSnapshot={tail(1)}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={outgoingToken}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                />,
            );
        });

        await act(async () => {
            tree.update(
                <ReplacementHarness
                    capture={capture}
                    experience="cockpit"
                    fallbackSnapshot={tail(1)}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={incomingToken}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                />,
            );
        });

        expect(renderSnapshots).toEqual([current]);
        expect(layoutSnapshots).toEqual([current]);
    });

    it('peeks pinned-to-anchored intent before render, refreshes deletion before insertion claim, and claims once', async () => {
        const routeRef: RouteRef = { current: null };
        const renderSnapshots: TranscriptExitEntrySnapshot[] = [];
        const layoutSnapshots: TranscriptExitEntrySnapshot[] = [];
        const outgoingToken = {};
        const incomingToken = {};
        const preparedViewport = anchored('m2', 40, 10);
        const deletionViewport = anchored('m2', 55, 20);
        let captureCount = 0;
        const capture = vi.fn(() => ({
            source: 'physical-exit' as const,
            viewport: captureCount++ === 0 ? preparedViewport : deletionViewport,
        }));
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ReplacementHarness
                    capture={capture}
                    experience="classic"
                    fallbackSnapshot={tail(1)}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={outgoingToken}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                />,
            );
        });

        await act(async () => {
            tree.update(
                <ReplacementHarness
                    capture={capture}
                    experience="cockpit"
                    fallbackSnapshot={tail(1)}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={incomingToken}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                />,
            );
        });

        expect(renderSnapshots).toEqual([preparedViewport]);
        expect(layoutSnapshots).toEqual([deletionViewport]);
        expect(routeRef.current?.claimAfterCommit({
            incomingMountToken: incomingToken,
            sessionId: 'session-a',
            toExperience: 'cockpit',
        })).toBeNull();
    });

    it('transports anchored-to-tail render intent instead of retaining the prior anchored kind', async () => {
        const routeRef: RouteRef = { current: null };
        const renderSnapshots: TranscriptExitEntrySnapshot[] = [];
        const layoutSnapshots: TranscriptExitEntrySnapshot[] = [];
        const current = tail(30);
        const capture = () => ({ source: 'physical-exit' as const, viewport: current });
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ReplacementHarness
                    capture={capture}
                    experience="classic"
                    fallbackSnapshot={anchored('m1', 40, 1)}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={{}}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                />,
            );
        });
        await act(async () => {
            tree.update(
                <ReplacementHarness
                    capture={capture}
                    experience="cockpit"
                    fallbackSnapshot={anchored('m1', 40, 1)}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={{}}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                />,
            );
        });
        expect(renderSnapshots).toEqual([tail(30)]);
        expect(layoutSnapshots).toEqual([tail(30)]);
    });

    it('resets the staged slot when the route changes session identity', async () => {
        const routeRef: RouteRef = { current: null };
        const renderSnapshots: TranscriptExitEntrySnapshot[] = [];
        const layoutSnapshots: TranscriptExitEntrySnapshot[] = [];
        const fallback = tail(1);
        const capture = () => ({
            source: 'physical-exit' as const,
            viewport: anchored('m2', 55, 20),
        });
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ReplacementHarness
                    capture={capture}
                    experience="classic"
                    layoutSnapshots={layoutSnapshots}
                    mountToken={{}}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                    sessionId="session-a"
                />,
            );
        });
        await act(async () => {
            tree.update(
                <ReplacementHarness
                    capture={capture}
                    experience="cockpit"
                    fallbackSnapshot={fallback}
                    layoutSnapshots={layoutSnapshots}
                    mountToken={{}}
                    renderSnapshots={renderSnapshots}
                    routeRef={routeRef}
                    sessionId="session-b"
                />,
            );
        });

        expect(renderSnapshots).toEqual([fallback]);
        expect(layoutSnapshots).toEqual([fallback]);
    });

    it('keeps render non-destructive, rejects session mismatch, and offers nothing on pure unmount', async () => {
        const routeRef: RouteRef = { current: null };
        const capture = vi.fn(() => ({
            source: 'physical-exit' as const,
            viewport: anchored('m2', 55, 20),
        }));
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <TranscriptSameSessionHandoffProvider
                    desiredExperience="classic"
                    sessionId="session-a"
                >
                    {() => (
                        <>
                            <RouteProbe routeRef={routeRef} />
                            <TranscriptProducer
                                capture={capture}
                                experience="classic"
                                mountToken={{}}
                                sessionId="session-a"
                            />
                        </>
                    )}
                </TranscriptSameSessionHandoffProvider>,
            );
        });
        const prepared = routeRef.current?.prepareReplacement({
            fromExperience: 'classic',
            sessionId: 'session-a',
            toExperience: 'cockpit',
        });
        const incomingToken = {};
        expect(routeRef.current?.peekForRender({
            incomingMountToken: incomingToken,
            sessionId: 'session-a',
            toExperience: 'cockpit',
        })).toBe(prepared);
        expect(routeRef.current?.peekForRender({
            incomingMountToken: incomingToken,
            sessionId: 'session-a',
            toExperience: 'cockpit',
        })).toBe(prepared);
        expect(routeRef.current?.peekForRender({
            incomingMountToken: incomingToken,
            sessionId: 'session-b',
            toExperience: 'cockpit',
        })).toBeNull();

        await act(async () => {
            tree.unmount();
        });
        expect(routeRef.current).toBeNull();
    });

    it('does not let a StrictMode probe or abandoned render consume the prepared handoff', async () => {
        const routeRef: RouteRef = { current: null };
        const incomingToken = {};
        const capture = () => ({
            source: 'physical-exit' as const,
            viewport: anchored('m2', 55, 20),
        });
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <React.StrictMode>
                    <ReplacementHarness
                        capture={capture}
                        experience="classic"
                        layoutSnapshots={[]}
                        mountToken={{}}
                        renderSnapshots={[]}
                        routeRef={routeRef}
                    />
                </React.StrictMode>,
            );
        });
        await act(async () => {
            tree.update(
                <React.StrictMode>
                    <ReplacementHarness
                        capture={capture}
                        experience="abandoned"
                        fallbackSnapshot={tail(1)}
                        layoutSnapshots={[]}
                        mountToken={incomingToken}
                        renderSnapshots={[]}
                        routeRef={routeRef}
                    />
                </React.StrictMode>,
            );
        });
        expect(routeRef.current?.claimAfterCommit({
            incomingMountToken: incomingToken,
            sessionId: 'session-a',
            toExperience: 'cockpit',
        })?.viewport).toEqual(anchored('m2', 55, 20));
    });
});
