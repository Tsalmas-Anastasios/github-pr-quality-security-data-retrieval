export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export function createLogger(minimumLevel: LogLevel = 'info'): Logger {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const write = (level: LogLevel, message: string, fields?: LogFields): void => {
        if (levels.indexOf(level) < levels.indexOf(minimumLevel)) return;
        process.stderr.write(
            `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`
        );
    };
    return {
        debug: (message, fields) => write('debug', message, fields),
        info: (message, fields) => write('info', message, fields),
        warn: (message, fields) => write('warn', message, fields),
        error: (message, fields) => write('error', message, fields),
    };
}
