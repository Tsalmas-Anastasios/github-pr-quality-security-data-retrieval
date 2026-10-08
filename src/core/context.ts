import { HttpClient } from '../clients/http.js';
import { loadConfig } from '../config/env.js';
import type { JobContext } from './job.js';
import { createLogger } from './logger.js';

export function createJobContext(overrides: Partial<JobContext> = {}): JobContext {
    const config = overrides.config ?? loadConfig();
    const logger = overrides.logger ?? createLogger(config.LOG_LEVEL);
    const http =
        overrides.http ??
        new HttpClient({
            timeoutMs: config.API_TIMEOUT_MS,
            retries: config.API_RETRIES,
            maxRetryDelayMs: config.API_MAX_RETRY_DELAY_MS,
            logger,
        });
    return { config, logger, http, signal: overrides.signal };
}
