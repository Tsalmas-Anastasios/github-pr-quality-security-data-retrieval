import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { exportFormats, exportRows, type ExportOptions } from '../exporters/file.js';
import { createJobContext } from './context.js';
import type { Job, JobContext } from './job.js';
import { getErrorMessage } from '../utils/error.js';

export type RunOptions = Omit<ExportOptions, 'outputPath'> & {
    input?: unknown;
    outputPath?: string;
};

export interface RunResult {
    job: string;
    format: ExportOptions['format'];
    outputPath: string;
    rowCount: number;
    durationMs: number;
}

export async function runJob(
    job: Job,
    options: RunOptions,
    dependencies: Partial<JobContext> = {}
): Promise<RunResult> {
    if (!exportFormats.includes(options.format))
        throw new Error(`Unsupported export format: ${options.format}`);
    const input = options.input === undefined ? {} : options.input;
    const execute = job.prepare(input);
    const signal = dependencies.signal ?? options.signal;
    const context = createJobContext({ ...dependencies, signal });
    const { config, logger } = context;
    signal?.throwIfAborted();
    const started = Date.now();
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const filename = `${job.name.replace(/[^a-z\d_-]/gi, '-')}-${timestamp}-${randomUUID().slice(0, 8)}.${options.format}`;
    const outputPath = resolve(
        options.outputPath ?? job.outputPath?.(input) ?? resolve(config.OUTPUT_DIR, filename)
    );
    logger.info('Job started', { job: job.name, format: options.format });
    try {
        const exportOptions: ExportOptions = {
            ...job.csvOptions,
            ...options,
            columns: options.columns ?? job.columns,
            outputPath,
            signal,
        };
        const rowCount = job.export
            ? await job.export(input, context, exportOptions)
            : await exportRows(execute(context), exportOptions);
        const result = {
            job: job.name,
            format: options.format,
            outputPath,
            rowCount,
            durationMs: Date.now() - started,
        };
        logger.info('Job completed', result);
        return result;
    } catch (error) {
        logger.error('Job failed', {
            job: job.name,
            message: getErrorMessage(error),
        });
        throw error;
    }
}
