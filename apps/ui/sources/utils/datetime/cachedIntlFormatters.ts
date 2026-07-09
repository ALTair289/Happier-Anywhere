import { LruMap } from '@/utils/cache/lruMap';

const DATETIME_FORMATTER_CACHE_CAP = 48;

const dateTimeFormatterCache = new LruMap<string, Intl.DateTimeFormat>({
    maxEntries: DATETIME_FORMATTER_CACHE_CAP,
});

function buildLocaleKey(locale: Intl.LocalesArgument): string {
    if (Array.isArray(locale)) return locale.join('\u0001');
    return locale == null ? 'default' : String(locale);
}

function buildDateTimeFormatOptionsKey(options: Intl.DateTimeFormatOptions | undefined): string {
    if (!options) return 'default';
    const entries = Object.entries(options)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify(entries);
}

function buildDateTimeFormatterCacheKey(
    locale: Intl.LocalesArgument,
    options: Intl.DateTimeFormatOptions | undefined,
): string {
    return `${buildLocaleKey(locale)}::${buildDateTimeFormatOptionsKey(options)}`;
}

export function getCachedIntlDateTimeFormat(
    locale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
    const cacheKey = buildDateTimeFormatterCacheKey(locale, options);
    const cached = dateTimeFormatterCache.get(cacheKey);
    if (cached) return cached;

    const formatter = new Intl.DateTimeFormat(locale, options);
    dateTimeFormatterCache.set(cacheKey, formatter);
    return formatter;
}
