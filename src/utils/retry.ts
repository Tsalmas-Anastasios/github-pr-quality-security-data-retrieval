export interface HttpRetryDecision {
    retryable: boolean;
    rateLimited: boolean;
    delayMs: number;
}

export function getBackoffDelay(attempt: number, baseMs = 1000): number {
    return baseMs * 2 ** attempt;
}

function retryAfterDelay(value: string | null, now: number): number | undefined {
    if (value === null || !value.trim()) return undefined;
    const numeric = /^\d+(?:\.\d+)?$/.test(value.trim());
    const milliseconds = numeric ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

/** Calculate a wait without shortening Retry-After or a GitHub reset deadline. */
export function getHttpRetryDecision(
    status: number,
    headers: Headers,
    body: string,
    attempt: number,
    now = Date.now()
): HttpRetryDecision {
    const rateLimited =
        status === 429 ||
        (status === 403 &&
            (headers.get('x-ratelimit-remaining') === '0' ||
                headers.has('retry-after') ||
                /rate limit/i.test(body)));
    const retryable = rateLimited || status === 408 || status >= 500;
    if (!retryable) return { retryable, rateLimited, delayMs: 0 };
    const minimumDelay = getBackoffDelay(attempt);
    const retryAfter = retryAfterDelay(headers.get('retry-after'), now);
    const reset =
        headers.get('x-ratelimit-remaining') === '0' ? Number(headers.get('x-ratelimit-reset')) : 0;
    const resetDelay =
        Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now + 1000) : undefined;
    const explicitDelay = retryAfter !== undefined || resetDelay !== undefined;
    const delayMs = explicitDelay
        ? Math.max(minimumDelay, retryAfter ?? 0, resetDelay ?? 0)
        : getBackoffDelay(attempt, rateLimited ? 60_000 : 1000);
    return { retryable, rateLimited, delayMs: Math.ceil(delayMs) };
}
