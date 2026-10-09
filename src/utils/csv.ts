import { createReadStream } from 'node:fs';

/** Streaming RFC 4180 reader, including quoted newlines and an optional UTF-8 BOM. */
export async function* readCsv(path: string, signal?: AbortSignal): AsyncIterable<string[]> {
    const stream = createReadStream(path, { encoding: 'utf8', signal });
    let fields: string[] = [];
    let field = '';
    let state: 'start' | 'text' | 'quoted' | 'closed' = 'start';
    let first = true;
    let skipLf = false;
    let record = 1;
    try {
        for await (const chunk of stream) {
            if (typeof chunk !== 'string') throw new Error('Expected UTF-8 CSV text');
            signal?.throwIfAborted();
            for (const character of chunk) {
                if (first) {
                    first = false;
                    if (character === '\uFEFF') continue;
                }
                if (skipLf) {
                    skipLf = false;
                    if (character === '\n') continue;
                }
                if (state === 'quoted') {
                    if (character === '"') state = 'closed';
                    else field += character;
                    continue;
                }
                if (state === 'closed' && character === '"') {
                    field += '"';
                    state = 'quoted';
                    continue;
                }
                if (character === ',' || character === '\r' || character === '\n') {
                    fields.push(field);
                    field = '';
                    state = 'start';
                    if (character !== ',') {
                        if (fields.length !== 1 || fields[0] !== '') yield fields;
                        fields = [];
                        skipLf = character === '\r';
                        record++;
                    }
                    continue;
                }
                if (state === 'closed')
                    throw new Error(
                        `Unexpected text after a closing CSV quote at record ${record}`
                    );
                if (character === '"') {
                    if (state !== 'start')
                        throw new Error(`Unexpected CSV quote at record ${record}`);
                    state = 'quoted';
                } else {
                    field += character;
                    state = 'text';
                }
            }
        }
        if (state === 'quoted') throw new Error(`Unclosed CSV quote at record ${record}`);
        if (fields.length || field || state !== 'start') yield [...fields, field];
    } finally {
        stream.destroy();
    }
}
