import type { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import type { HttpClient } from '../clients/http.js';
import type { Logger } from './logger.js';

export type ExportRow = Record<string, unknown>;

export interface JobContext {
    config: AppConfig;
    http: HttpClient;
    logger: Logger;
    signal?: AbortSignal | undefined;
}

export interface JobDefinition<Input> {
    name: string;
    description: string;
    inputSchema: z.ZodType<Input>;
    columns?: readonly string[];
    run(input: Input, context: JobContext): AsyncIterable<ExportRow>;
}

export interface Job {
    name: string;
    description: string;
    columns?: readonly string[] | undefined;
    prepare(input: unknown): (context: JobContext) => AsyncIterable<ExportRow>;
}

/** Preserve typed inputs inside each job while exposing a uniform registry interface. */
export function defineJob<Input>(definition: JobDefinition<Input>): Job {
    return {
        name: definition.name,
        description: definition.description,
        columns: definition.columns,
        prepare(input) {
            const parsed = definition.inputSchema.parse(input);
            return (context) => definition.run(parsed, context);
        },
    };
}
