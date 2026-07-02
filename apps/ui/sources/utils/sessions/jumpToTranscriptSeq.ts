export async function jumpToTranscriptSeq(params: Readonly<{
    targetSeq: number;
    getIndex: () => number | null;
    scrollToIndex: (index: number) => boolean | void | Promise<boolean | void>;
}>): Promise<Readonly<{ status: 'scrolled' | 'not_found' }>> {
    const targetSeq = Math.max(0, Math.trunc(params.targetSeq));
    if (!Number.isFinite(targetSeq)) return { status: 'not_found' };

    const immediateIndex = params.getIndex();
    if (typeof immediateIndex === 'number' && Number.isFinite(immediateIndex) && immediateIndex >= 0) {
        const applied = await params.scrollToIndex(Math.trunc(immediateIndex));
        if (applied !== false) return { status: 'scrolled' };
    }

    return { status: 'not_found' };
}
