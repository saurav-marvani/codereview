"use client";

import { useCallback, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Shallow URL-synced state for in-card cockpit filters (segmented toggles,
 * search boxes). The value lives in the query string so the view is
 * shareable, but changing it only updates the URL via
 * `history.replaceState` — no server round-trip, since these filters act
 * on already-loaded data.
 *
 * The URL is the source of truth on first render; the param is dropped
 * from the URL when it equals the default, keeping shared links clean.
 *
 * `allowed` guards against a hand-edited/stale param selecting an invalid
 * option — it falls back to the default instead.
 */
export function useShallowParam<T extends string>(
    key: string,
    defaultValue: T,
    allowed?: readonly T[],
): [T, (next: T) => void] {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [value, setValue] = useState<T>(() => {
        const raw = searchParams.get(key) as T | null;
        if (!raw) return defaultValue;
        if (allowed && !allowed.includes(raw)) return defaultValue;
        return raw;
    });

    const set = useCallback(
        (next: T) => {
            setValue(next);

            const params = new URLSearchParams(searchParams.toString());
            if (next === defaultValue) params.delete(key);
            else params.set(key, next);

            const qs = params.toString();
            window.history.replaceState(
                null,
                "",
                qs ? `${pathname}?${qs}` : pathname,
            );
        },
        [key, defaultValue, pathname, searchParams],
    );

    return [value, set];
}
