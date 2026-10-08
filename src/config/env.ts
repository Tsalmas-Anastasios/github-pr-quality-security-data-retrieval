import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

export const httpUrlSchema = z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Expected an HTTP(S) URL without embedded credentials');

const optionalSecret = z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    z.string().trim().optional()
);

const environmentSchema = z.object({
    GITHUB_TOKEN: optionalSecret,
    GITHUB_API_URL: httpUrlSchema
        .refine((value) => {
            const url = new URL(value);
            return !url.search && !url.hash;
        }, 'GitHub API base URL must not contain a query or fragment')
        .default('https://api.github.com'),
    GITHUB_API_VERSION: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .default('2026-03-10'),
    OUTPUT_DIR: z.string().min(1).default('data/exports'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    API_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(30_000),
    GITHUB_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(30_000),
    API_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    API_MAX_RETRY_DELAY_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(120_000),
});

export type AppConfig = z.infer<typeof environmentSchema>;

/** Load .env only for CLI entry points; importing the library has no side effects. */
export function loadEnvironment(path = '.env'): void {
    if (existsSync(path)) loadEnvFile(path);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
    return environmentSchema.parse({
        ...environment,
        GITHUB_TOKEN: environment.GITHUB_TOKEN?.trim() || environment.GITHUB_API__TOKEN,
        GITHUB_API_URL: environment.GITHUB_API_URL?.trim() || environment.GITHUB_API__URL,
        GITHUB_TIMEOUT_MS:
            environment.GITHUB_TIMEOUT_MS ??
            environment.GITHUB_API__TIMEOUT ??
            environment.API_TIMEOUT_MS,
    });
}
