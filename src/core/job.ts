import type { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import type { HttpClient } from '../clients/http.js';
import type { Logger } from './logger.js';
import type { ExportOptions } from '../exporters/file.js';

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
    csvOptions?: Pick<ExportOptions, 'utf8Bom' | 'csvEscapeFormulas'>;
    run(input: Input, context: JobContext): AsyncIterable<ExportRow>;
    outputPath?(input: Input): string | undefined;
    export?(input: Input, context: JobContext, options: ExportOptions): Promise<number>;
}

export interface Job {
    name: string;
    description: string;
    columns?: readonly string[] | undefined;
    csvOptions?: Pick<ExportOptions, 'utf8Bom' | 'csvEscapeFormulas'> | undefined;
    prepare(input: unknown): (context: JobContext) => AsyncIterable<ExportRow>;
    outputPath?(input: unknown): string | undefined;
    export?(input: unknown, context: JobContext, options: ExportOptions): Promise<number>;
}

/** Preserve typed inputs inside each job while exposing a uniform registry interface. */
export function defineJob<Input>(definition: JobDefinition<Input>): Job {
    const resolveOutputPath = definition.outputPath;
    const exportJob = definition.export;
    return {
        name: definition.name,
        description: definition.description,
        columns: definition.columns,
        csvOptions: definition.csvOptions,
        ...(resolveOutputPath
            ? {
                  outputPath: (input: unknown) =>
                      resolveOutputPath(definition.inputSchema.parse(input)),
              }
            : {}),
        ...(exportJob
            ? {
                  export: (input: unknown, context: JobContext, options: ExportOptions) =>
                      exportJob(definition.inputSchema.parse(input), context, options),
              }
            : {}),
        prepare(input) {
            const parsed = definition.inputSchema.parse(input);
            return (context) => definition.run(parsed, context);
        },
    };
}
