import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { ExportRow } from '../core/job.js';

export const exportFormats = ['csv', 'json', 'jsonl'] as const;
export type ExportFormat = (typeof exportFormats)[number];

export interface ExportOptions {
    format: ExportFormat;
    outputPath: string;
    columns?: readonly string[] | undefined;
    overwrite?: boolean | undefined;
    signal?: AbortSignal | undefined;
}

export function csvCell(value: unknown): string {
    if (value === undefined || value === null) return '';
    let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // Preserve numeric negatives; neutralize spreadsheet formula strings.
    if (typeof value === 'string' && (/^\s*[=+\-@]/.test(text) || /^[\t\r]/.test(text)))
        text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Write incrementally and only publish a complete file after every row succeeds. */
export async function exportRows(
    rows: AsyncIterable<ExportRow>,
    options: ExportOptions
): Promise<number> {
    if (!exportFormats.includes(options.format))
        throw new Error(`Unsupported export format: ${options.format}`);
    options.signal?.throwIfAborted();
    const output = resolve(options.outputPath);
    const conflictMessage = `Output file already exists: ${output}. Choose another path or use --overwrite.`;
    if (!options.overwrite) {
        const exists = await lstat(output).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        );
        if (exists) throw new Error(conflictMessage);
    }
    await mkdir(dirname(output), { recursive: true });
    const temporary = resolve(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx');
    let count = 0;
    let columns = options.columns ? [...options.columns] : undefined;
    let headerWritten = false;
    try {
        if (options.format === 'json') await file.writeFile('[\n');
        for await (const row of rows) {
            options.signal?.throwIfAborted();
            if (!row || typeof row !== 'object' || Array.isArray(row))
                throw new Error('Jobs must yield objects');
            if (options.format === 'csv') {
                columns ??= Object.keys(row);
                if (columns.length === 0)
                    throw new Error(
                        'CSV exports need at least one column; supply --columns or job columns'
                    );
                // Inferred columns must not silently discard fields from subsequent records.
                if (!options.columns && Object.keys(row).some((key) => !columns!.includes(key))) {
                    throw new Error(
                        'CSV fields changed between rows; supply --columns or use JSON/JSONL'
                    );
                }
                if (!headerWritten) {
                    await file.writeFile(`${columns.map(csvCell).join(',')}\r\n`);
                    headerWritten = true;
                }
                await file.writeFile(`${columns.map((key) => csvCell(row[key])).join(',')}\r\n`);
            } else {
                const serialized = JSON.stringify(row);
                await file.writeFile(
                    options.format === 'json'
                        ? `${count ? ',\n' : ''}  ${serialized}`
                        : `${serialized}\n`
                );
            }
            count++;
        }
        options.signal?.throwIfAborted();
        if (options.format === 'csv' && !headerWritten) {
            if (!columns?.length)
                throw new Error('An empty CSV export needs --columns or predefined job columns');
            await file.writeFile(`${columns.map(csvCell).join(',')}\r\n`);
        }
        if (options.format === 'json') await file.writeFile(`${count ? '\n' : ''}]\n`);
        await file.close();
        if (options.overwrite) {
            await rename(temporary, output);
        } else {
            // link is atomic and fails if the destination already exists, avoiding a race.
            await link(temporary, output);
        }
        return count;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            throw new Error(conflictMessage);
        }
        throw error;
    } finally {
        await file.close();
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
}
