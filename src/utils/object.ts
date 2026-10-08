/** Read JSON fields using dotted paths, including numeric array indices. */
export function getPath(value: unknown, path: string): unknown {
    if (!path) return value;
    let current = value;
    for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key))
            return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}
