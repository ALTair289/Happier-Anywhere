import React from 'react';

const SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS = 60_000;

export function useSessionListRelativeTimeClock(enabled = true): number {
    const [nowMs, setNowMs] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!enabled) return undefined;
        setNowMs(Date.now());
        const intervalId = setInterval(() => {
            setNowMs(Date.now());
        }, SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS);
        return () => clearInterval(intervalId);
    }, [enabled]);

    return nowMs;
}
