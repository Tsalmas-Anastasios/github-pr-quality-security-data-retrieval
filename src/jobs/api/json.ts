import { z } from 'zod';
import { assertSameOrigin, getNextLink } from '../../clients/http.js';
import { httpUrlSchema } from '../../config/env.js';
import { defineJob, type ExportRow } from '../../core/job.js';
import { getPath } from '../../utils/object.js';

export const jsonApiInputSchema = z
    .strictObject({
        url: httpUrlSchema,
        recordsPath: z.string().default(''),
        fields: z.record(z.string().min(1), z.string().min(1)).optional(),
        headers: z.record(z.string().min(1), z.string()).default({}),
        // Header name -> environment variable name. Keep secrets out of config files.
        headerEnv: z.record(z.string().min(1), z.string().min(1)).default({}),
        pagination: z.enum(['none', 'link']).default('none'),
        maxPages: z.number().int().positive().default(1000),
        maxItems: z.number().int().positive().nullable().default(100),
    })
    .refine((input) => !input.fields || Object.keys(input.fields).length > 0, {
        message: 'fields must select at least one output field',
        path: ['fields'],
    });

export type JsonApiInput = z.infer<typeof jsonApiInputSchema>;

export const jsonApiJob = defineJob({
    name: 'api:json',
    description:
        'Fetch a JSON API, select records and fields, and optionally follow Link pagination.',
    inputSchema: jsonApiInputSchema,
    async *run(input, context) {
        const origin = new URL(input.url);
        const headers = { ...input.headers };
        for (const [header, variable] of Object.entries(input.headerEnv)) {
            const value = process.env[variable];
            if (!value)
                throw new Error(
                    `Missing environment variable required for API header: ${variable}`
                );
            Object.defineProperty(headers, header, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
        let next: string | undefined = input.url;
        let count = 0;
        const visited = new Set<string>();
        while (next) {
            context.signal?.throwIfAborted();
            assertSameOrigin(new URL(next), origin);
            if (visited.has(next)) throw new Error('API returned a pagination loop');
            if (visited.size >= input.maxPages)
                throw new Error(
                    'API exceeded maxPages; raise the limit to export the full dataset'
                );
            visited.add(next);
            const response = await context.http.getJson(next, {
                headers,
                signal: context.signal,
            });
            const selected = getPath(response.data, input.recordsPath);
            const records = Array.isArray(selected) ? selected : [selected];
            for (const record of records) {
                if (!record || typeof record !== 'object' || Array.isArray(record)) {
                    throw new Error('Expected JSON objects; check the API URL and recordsPath');
                }
                const row: ExportRow = input.fields
                    ? Object.fromEntries(
                          Object.entries(input.fields).map(([field, path]) => [
                              field,
                              getPath(record, path) ?? null,
                          ])
                      )
                    : (record as ExportRow);
                yield row;
                count++;
                if (input.maxItems !== null && count >= input.maxItems) return;
            }
            next =
                input.pagination === 'link'
                    ? getNextLink(response.headers.get('link'), response.url)
                    : undefined;
        }
    },
});
