export type SessionSystemRecordPage<T> = Readonly<{
  records: readonly T[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

const MAX_SESSION_SYSTEM_RECORD_PAGES = 10_000;

export class SessionSystemRecordPaginationError extends Error {
  constructor(reason: 'missing-cursor' | 'cursor-cycle' | 'page-limit') {
    super(`Invalid session system-record pagination: ${reason}`);
    this.name = 'SessionSystemRecordPaginationError';
  }
}

export async function fetchAllSessionSystemRecords<T>(params: Readonly<{
  fetchPage: (cursor: string | undefined) => Promise<SessionSystemRecordPage<T>>;
}>): Promise<T[]> {
  const records: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_SESSION_SYSTEM_RECORD_PAGES; pageIndex += 1) {
    const page = await params.fetchPage(cursor);
    records.push(...page.records);
    if (!page.hasNext) return records;
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor) throw new SessionSystemRecordPaginationError('missing-cursor');
    if (seenCursors.has(nextCursor)) throw new SessionSystemRecordPaginationError('cursor-cycle');
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new SessionSystemRecordPaginationError('page-limit');
}
