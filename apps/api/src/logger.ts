import { pino, type Logger } from 'pino';
import type { Config } from './config';

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'LOG_PRETTY'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'locallens-api' },
    // Secrets must never reach log storage, even when a whole request body or header set is logged by mistake.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.passwordHash',
      ],
      censor: '[redacted]',
    },
    transport: config.LOG_PRETTY
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' } }
      : undefined,
  });
}
