type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function readAggregateCount(record: UnknownRecord): number | null {
    const totalMatches = record.totalMatches;
    if (typeof totalMatches === 'number' && Number.isSafeInteger(totalMatches) && totalMatches >= 0) {
        return totalMatches;
    }
    const totalFiles = record.totalFiles;
    if (typeof totalFiles === 'number' && Number.isSafeInteger(totalFiles) && totalFiles >= 0) {
        return totalFiles;
    }
    return null;
}

function hasSearchError(record: UnknownRecord): boolean {
    const error = record.error;
    return record.isError === true
        || error === true
        || (typeof error === 'string' && error.trim().length > 0)
        || (error !== null && typeof error === 'object')
        || record.status === 'error'
        || record.status === 'failed';
}

function withCanonicalSearchDetailAvailability(record: UnknownRecord, matches: unknown[]): UnknownRecord {
    const normalized: UnknownRecord = { ...record, matches };
    delete normalized.detailsUnavailable;
    const count = readAggregateCount(record);
    if (matches.length === 0 && count !== null && count > 0) {
        normalized.detailsUnavailable = true;
    }
    return normalized;
}

function parseGrepLine(line: string): { filePath: string; line?: number; excerpt?: string } | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    const match = trimmed.match(/^(.+?):(\d+):\s?(.*)$/);
    if (!match) return null;
    const n = Number(match[2]);
    return {
        filePath: match[1],
        line: Number.isFinite(n) ? n : undefined,
        excerpt: match[3],
    };
}

function parseOpenCodeSearch(text: string): { matches: Array<{ filePath: string; line?: number; excerpt?: string }> } | null {
    if (!text.includes('matches')) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const matches: Array<{ filePath: string; line?: number; excerpt?: string }> = [];
    let currentFile: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        // "/path/file:" header
        if (!line.startsWith(' ') && trimmed.endsWith(':') && trimmed.includes('/')) {
            currentFile = trimmed.slice(0, -1);
            continue;
        }

        // "Line 2: beta"
        const m = trimmed.match(/^Line\s+(\d+):\s?(.*)$/i);
        if (m && currentFile) {
            const n = Number(m[1]);
            matches.push({
                filePath: currentFile,
                line: Number.isFinite(n) ? n : undefined,
                excerpt: m[2],
            });
            continue;
        }

        // Fallback: grep-ish "path:line: text"
        const grep = parseGrepLine(line);
        if (grep) matches.push(grep);
    }

    if (matches.length === 0) return null;
    return { matches };
}

function coerceTextFromContentBlocks(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as UnknownRecord;
        if (typeof rec.text === 'string') {
            parts.push(rec.text);
            continue;
        }
        const nested = rec.content;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const nestedRec = nested as UnknownRecord;
            if (typeof nestedRec.text === 'string') parts.push(nestedRec.text);
        }
    }
    return parts.length > 0 ? parts.join('\n') : null;
}

export function normalizeGlobInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.pattern !== 'string' && typeof out.glob === 'string' && out.glob.trim().length > 0) {
        out.pattern = out.glob.trim();
    }
    if (typeof out.path !== 'string' && typeof out.cwd === 'string' && out.cwd.trim().length > 0) {
        out.path = out.cwd.trim();
    }

    return out;
}

export function normalizeGlobResult(rawOutput: unknown): UnknownRecord {
    if (Array.isArray(rawOutput) && rawOutput.every((v) => typeof v === 'string')) {
        return { matches: rawOutput };
    }

    if (Array.isArray(rawOutput)) {
        const text = coerceTextFromContentBlocks(rawOutput);
        if (text) {
            const lines = text
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            return { matches: lines.length > 0 ? lines : [text] };
        }
    }

    if (typeof rawOutput === 'string') {
        const lines = rawOutput
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length > 0) return { matches: lines };
        return {};
    }

    const record = asRecord(rawOutput);
    if (record) {
        const contentText = coerceTextFromContentBlocks(record.content);
        if (contentText) {
            const lines = contentText
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            return { ...record, matches: lines.length > 0 ? lines : [contentText] };
        }
    }
    if (record && Array.isArray(record.matches)) {
        return { matches: record.matches };
    }

    return { value: rawOutput };
}

export function normalizeCodeSearchInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    const query =
        typeof out.query === 'string' && out.query.trim().length > 0
            ? out.query.trim()
            : typeof out.q === 'string' && out.q.trim().length > 0
                ? out.q.trim()
                : typeof out.pattern === 'string' && out.pattern.trim().length > 0
                    ? out.pattern.trim()
                    : typeof out.information_request === 'string' && out.information_request.trim().length > 0
                        ? out.information_request.trim()
                        : typeof out.informationRequest === 'string' && out.informationRequest.trim().length > 0
                            ? out.informationRequest.trim()
                    : null;

    if (query && typeof out.query !== 'string') out.query = query;

    return out;
}

export function normalizeCodeSearchResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const parsed = parseOpenCodeSearch(rawOutput);
        if (parsed) return parsed;

        const lines = rawOutput
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length > 0) return { matches: lines.map((l) => ({ excerpt: l })) };
        return {};
    }

    if (Array.isArray(rawOutput)) {
        const text = coerceTextFromContentBlocks(rawOutput);
        if (text) return { matches: [{ excerpt: text }] };
    }

    const record = asRecord(rawOutput);
    if (!record) return { value: rawOutput };

    // Error state is authoritative even when a provider also emits an explicit
    // empty matches array and aggregate counters. Preserve those diagnostics,
    // but never turn them into a successful aggregate-only result.
    if (hasSearchError(record)) {
        const normalized = { ...record };
        delete normalized.detailsUnavailable;
        return normalized;
    }

    if (Array.isArray(record.matches)) {
        return withCanonicalSearchDetailAvailability(record, record.matches);
    }

    const metadata = asRecord(record.metadata);
    const textCandidate =
        typeof record.output === 'string'
            ? record.output
            : typeof metadata?.output === 'string'
                ? metadata.output
                : typeof record.aggregated_output === 'string'
                    ? record.aggregated_output
                    : typeof record.formatted_output === 'string'
                        ? record.formatted_output
                        : typeof record.stdout === 'string'
                            ? record.stdout
                            : typeof record.text === 'string'
                                ? record.text
                                : typeof record.value === 'string'
                                    ? record.value
                                    : null;

    if (typeof textCandidate === 'string' && textCandidate.trim().length > 0) {
        const parsed = parseOpenCodeSearch(textCandidate);
        if (parsed) return parsed;
        const lines = textCandidate
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length > 0) return { ...record, matches: lines.map((l) => ({ excerpt: l })) };
    }

    if (readAggregateCount(record) !== null) {
        return withCanonicalSearchDetailAvailability(record, []);
    }

    // Error-only and malformed records must not be turned into a false zero-result assertion.
    const normalized = { ...record };
    delete normalized.detailsUnavailable;
    return normalized;
}

export function normalizeGrepInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.pattern !== 'string' && typeof out.query === 'string' && out.query.trim().length > 0) {
        out.pattern = out.query.trim();
    }

    return out;
}

export function normalizeGrepResult(rawOutput: unknown): UnknownRecord {
    if (typeof rawOutput === 'string') {
        const lines = rawOutput.replace(/\r\n/g, '\n').split('\n');
        const matches: Array<{ filePath: string; line?: number; excerpt?: string }> = [];
        for (const line of lines) {
            const parsed = parseGrepLine(line);
            if (parsed) matches.push(parsed);
        }
        if (matches.length > 0) return { matches };
        const trimmed = rawOutput.trim();
        if (trimmed.length > 0) return { matches: [{ excerpt: trimmed }] };
        return {};
    }

    const record = asRecord(rawOutput);
    if (record) {
        const contentText = coerceTextFromContentBlocks(record.content);
        if (contentText && contentText.trim().length > 0) {
            const lines = contentText.replace(/\r\n/g, '\n').split('\n');
            const matches: Array<{ filePath: string; line?: number; excerpt?: string }> = [];
            for (const line of lines) {
                const parsed = parseGrepLine(line);
                if (parsed) matches.push(parsed);
            }
            if (matches.length > 0) return { ...record, matches };
            return { ...record, matches: [{ excerpt: contentText.trim() }] };
        }
    }
    if (record && Array.isArray(record.matches)) return { matches: record.matches };
    if (record) return { ...record };
    return { value: rawOutput };
}

export function normalizeLsInput(rawInput: unknown): UnknownRecord {
    const record = asRecord(rawInput) ?? {};
    const out: UnknownRecord = { ...record };

    if (typeof out.path !== 'string' && typeof out.dir === 'string' && out.dir.trim().length > 0) {
        out.path = out.dir.trim();
    }

    return out;
}

export function normalizeLsResult(rawOutput: unknown): UnknownRecord {
    if (Array.isArray(rawOutput)) {
        return { entries: rawOutput };
    }

    const record = asRecord(rawOutput);
    if (record) {
        const contentText = coerceTextFromContentBlocks(record.content);
        if (contentText) {
            const lines = contentText
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            return { ...record, entries: lines };
        }
    }
    if (record && Array.isArray(record.entries)) return { entries: record.entries };
    if (record && Array.isArray(record.files)) return { entries: record.files };
    if (record) return { ...record };
    return { value: rawOutput };
}
