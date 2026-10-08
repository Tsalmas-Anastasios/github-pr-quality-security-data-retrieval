import type { Logger } from '../core/logger.js';
import { sleep, withTimeout } from '../utils/time.js';
import { getBackoffDelay, getHttpRetryDecision } from '../utils/retry.js';

export class HttpError extends Error {
    constructor(
        message: string,
        public readonly status?: number
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

export interface HttpClientOptions {
    timeoutMs: number;
    retries: number;
    maxRetryDelayMs: number;
    logger: Logger;
}

export interface JsonResponse {
    data: unknown;
    headers: Headers;
    url: string;
}

export function assertSameOrigin(url: URL, origin: URL): void {
    if (url.origin !== origin.origin || url.username || url.password) {
        throw new HttpError('Refusing to send API headers to a different origin');
    }
}

export function getNextLink(link: string | null, baseUrl: string): string | undefined {
    if (!link) return undefined;
    for (const match of link.matchAll(/<([^>]+)>\s*;([^,]*)/g)) {
        const relation = /\brel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(match[2] ?? '');
        if ((relation?.[1] ?? relation?.[2])?.split(/\s+/).includes('next')) {
            return new URL(match[1]!, baseUrl).href;
        }
    }
    return undefined;
}

export class HttpClient {
    // Concurrent callers share a cooldown so a rate limit pauses queued requests too.
    private readonly rateLimitDeadlines = new Map<string, number>();

    constructor(private readonly options: HttpClientOptions) {}

    async getJson(
        value: string | URL,
        options: {
            headers?: Record<string, string>;
            timeoutMs?: number;
            signal?: AbortSignal | undefined;
        } = {}
    ): Promise<JsonResponse> {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new HttpError('Expected an HTTP(S) URL without embedded credentials');
        }
        // Query strings can contain secrets, so do not log them.
        const safeUrl = `${url.origin}${url.pathname}`;
        for (let attempt = 0; attempt <= this.options.retries; attempt++) {
            options.signal?.throwIfAborted();
            await this.waitForRateLimit(url, safeUrl, options.signal);
            let response: Response;
            let body: string;
            try {
                const result = await withTimeout(
                    async (signal) => {
                        const received = await this.requestWithRedirects(
                            url,
                            options.headers ?? {},
                            signal
                        );
                        return { response: received, body: await received.text() };
                    },
                    options.timeoutMs ?? this.options.timeoutMs,
                    options.signal
                );
                response = result.response;
                body = result.body;
            } catch (error) {
                options.signal?.throwIfAborted();
                if (error instanceof HttpError) throw error;
                if (attempt === this.options.retries) {
                    throw new HttpError(
                        `Network request failed or timed out at ${safeUrl} after ${attempt + 1} attempt(s)`
                    );
                }
                await this.waitToRetry(getBackoffDelay(attempt), safeUrl, attempt, options.signal);
                continue;
            }

            if (response.ok) {
                if (response.headers.get('x-ratelimit-remaining') === '0') {
                    const reset = Number(response.headers.get('x-ratelimit-reset'));
                    if (Number.isFinite(reset) && reset > 0) {
                        this.deferRequests(
                            url.origin,
                            Math.max(0, reset * 1000 - Date.now() + 1000)
                        );
                    }
                }
                try {
                    const data: unknown = JSON.parse(body);
                    return {
                        data,
                        headers: response.headers,
                        url: response.url || url.href,
                    };
                } catch {
                    throw new HttpError(`API returned invalid JSON at ${safeUrl}`, response.status);
                }
            }

            const retry = getHttpRetryDecision(response.status, response.headers, body, attempt);
            if (retry.rateLimited) this.deferRequests(url.origin, retry.delayMs);
            if (!retry.retryable || attempt === this.options.retries) {
                throw new HttpError(
                    `API request failed with HTTP ${response.status} at ${safeUrl}`,
                    response.status
                );
            }

            await this.waitToRetry(retry.delayMs, safeUrl, attempt, options.signal);
        }
        throw new HttpError('Retry limit exhausted');
    }

    private deferRequests(origin: string, delayMs: number): void {
        this.rateLimitDeadlines.set(
            origin,
            Math.max(this.rateLimitDeadlines.get(origin) ?? 0, Date.now() + delayMs)
        );
    }

    private async waitForRateLimit(url: URL, safeUrl: string, signal?: AbortSignal): Promise<void> {
        while (true) {
            const waitMs = (this.rateLimitDeadlines.get(url.origin) ?? 0) - Date.now();
            if (waitMs <= 0) return;
            if (waitMs > this.options.maxRetryDelayMs) {
                throw new HttpError(
                    `API rate limit at ${safeUrl} requires a ${Math.ceil(waitMs / 1000)}s wait; increase API_MAX_RETRY_DELAY_MS or run later`
                );
            }
            await sleep(waitMs, signal);
        }
    }

    private async requestWithRedirects(
        url: URL,
        headers: Record<string, string>,
        signal: AbortSignal
    ): Promise<Response> {
        let current = url;
        for (let redirects = 0; redirects <= 5; redirects++) {
            const response = await fetch(current, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'github-pr-data-retrieval',
                    ...headers,
                },
                signal,
                redirect: 'manual',
            });
            if (![301, 302, 303, 307, 308].includes(response.status)) return response;
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location)
                throw new HttpError(
                    'API redirect did not include a Location header',
                    response.status
                );
            current = new URL(location, current);
            assertSameOrigin(current, url);
        }
        throw new HttpError('API returned too many redirects');
    }

    private async waitToRetry(
        waitMs: number,
        url: string,
        attempt: number,
        signal?: AbortSignal
    ): Promise<void> {
        if (waitMs > this.options.maxRetryDelayMs) {
            throw new HttpError(
                `API requires a ${Math.ceil(waitMs / 1000)}s retry delay at ${url}; increase API_MAX_RETRY_DELAY_MS or run later`
            );
        }
        this.options.logger.warn('Retrying API request', {
            url,
            attempt: attempt + 1,
            waitMs,
        });
        await sleep(waitMs, signal);
    }
}
