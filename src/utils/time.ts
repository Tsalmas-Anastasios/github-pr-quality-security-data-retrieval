import { setTimeout as delay } from 'node:timers/promises';

const maximumTimerMs = 2_147_483_647;

function validateDuration(milliseconds: number, minimum: number): void {
    if (
        !Number.isInteger(milliseconds) ||
        milliseconds < minimum ||
        milliseconds > maximumTimerMs
    ) {
        throw new RangeError(
            `Duration must be an integer from ${minimum} to ${maximumTimerMs} milliseconds`
        );
    }
}

export class TimeoutError extends Error {
    readonly code = 'ETIMEDOUT';

    constructor(public readonly timeoutMs: number) {
        super(`Operation timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}

/** Pause between requests; cancellation preserves the caller's abort reason. */
export async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    validateDuration(milliseconds, 0);
    signal?.throwIfAborted();
    try {
        await delay(milliseconds, undefined, { signal });
    } catch (error) {
        signal?.throwIfAborted();
        throw error;
    }
}

/** Apply a deadline, pass cancellation to the operation, and release timers/listeners. */
export async function withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    parentSignal?: AbortSignal
): Promise<T> {
    validateDuration(timeoutMs, 1);
    parentSignal?.throwIfAborted();
    const controller = new AbortController();
    let rejectDeadline!: (reason: unknown) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
    });
    const abort = (reason: unknown): void => {
        controller.abort(reason);
        rejectDeadline(reason);
    };
    const cancel = (): void => abort(parentSignal!.reason);
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort(new TimeoutError(timeoutMs)), timeoutMs);
    try {
        const task = Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return operation(controller.signal);
        });
        return await Promise.race([task, deadline]);
    } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', cancel);
    }
}
