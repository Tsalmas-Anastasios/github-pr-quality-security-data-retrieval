#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Command, Option } from 'commander';
import { ZodError } from 'zod';
import { loadEnvironment } from './config/env.js';
import { GitHubClient } from './clients/github.js';
import { createJobContext } from './core/context.js';
import { getErrorMessage } from './utils/error.js';
import { runJob } from './core/runner.js';
import { exportFormats, type ExportFormat } from './exporters/file.js';
import { getJob, jobs } from './jobs/index.js';

interface CliRunOptions {
    input?: string;
    config?: string;
    format: ExportFormat;
    output?: string;
    columns?: string;
    overwrite?: boolean;
}

function parseJson(text: string, label: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(`${label} must contain valid JSON`);
    }
}

const program = new Command()
    .name('data-jobs')
    .description('Run named API data retrieval jobs and export their processed records.')
    .showHelpAfterError();

program
    .command('list')
    .description('List available jobs')
    .action(() => {
        for (const job of jobs.values()) console.log(`${job.name.padEnd(24)} ${job.description}`);
    });

program
    .command('github-check')
    .description(
        'Check GitHub API connectivity and rate limits, and optionally repository/PR access'
    )
    .option(
        '--repository <owner/repo>',
        'Also verify read access to this repository and its pull requests'
    )
    .action(async (options: { repository?: string }) => {
        loadEnvironment();
        const client = new GitHubClient(createJobContext());
        console.log(JSON.stringify(await client.checkConnection(options.repository), null, 2));
    });

program
    .command('run')
    .argument('<job>', 'Job name; use "list" to see available jobs')
    .description('Fetch, process, and export data for one job')
    .addOption(new Option('-i, --input <json>', 'Job input as a JSON object').conflicts('config'))
    .addOption(
        new Option('-c, --config <path>', 'Path to a JSON job input file').conflicts('input')
    )
    .addOption(
        new Option('-f, --format <format>', 'Export format')
            .choices([...exportFormats])
            .default('json')
    )
    .option('-o, --output <path>', 'Output path; defaults to a unique file in OUTPUT_DIR')
    .option('--columns <names>', 'Comma-separated CSV columns, in output order')
    .option('--overwrite', 'Replace an existing output file after a successful run')
    .action(async (name: string, options: CliRunOptions) => {
        const job = getJob(name);
        loadEnvironment();
        const input = options.config
            ? parseJson(await readFile(options.config, 'utf8'), 'Config file')
            : parseJson(options.input ?? '{}', '--input');
        const columns = options.columns?.split(',').map((value) => value.trim());
        if (
            columns &&
            (columns.some((value) => !value) || new Set(columns).size !== columns.length)
        ) {
            throw new Error('--columns must contain distinct, non-empty column names');
        }
        if (columns && options.format !== 'csv')
            throw new Error('--columns is only supported with --format csv');
        const controller = new AbortController();
        const cancel = (): void => controller.abort(new Error('Job interrupted'));
        process.once('SIGINT', cancel);
        process.once('SIGTERM', cancel);
        try {
            const result = await runJob(job, {
                input,
                format: options.format,
                ...(options.output ? { outputPath: options.output } : {}),
                columns,
                overwrite: options.overwrite,
                signal: controller.signal,
            });
            console.log(JSON.stringify(result, null, 2));
        } finally {
            process.removeListener('SIGINT', cancel);
            process.removeListener('SIGTERM', cancel);
        }
    });

try {
    await program.parseAsync(process.argv);
} catch (error) {
    const message =
        error instanceof ZodError
            ? error.issues
                  .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
                  .join('\n')
            : getErrorMessage(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
}
