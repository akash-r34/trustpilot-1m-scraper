import fs from 'fs';
import pino from 'pino';
import { config } from '../config.js';

let _logger: pino.Logger | null = null;

function createLogger(): pino.Logger {
  const targets: pino.TransportTargetOptions[] = [];

  if (process.stdout.isTTY) {
    targets.push({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      level: config.logLevel,
    });
  } else {
    targets.push({ target: 'pino/file', options: { destination: 1 }, level: config.logLevel });
  }

  // Add rotating file log in non-test environments (daily rollover, 50 MB cap, 7-file retention)
  if (process.env['NODE_ENV'] !== 'test') {
    try {
      fs.mkdirSync('logs', { recursive: true });
      targets.push({
        target: 'pino-roll',
        options: { file: 'logs/scraper.log', frequency: 'daily', size: '50m', limit: { count: 7 } },
        level: 'debug',
      });
    } catch {/* skip if directory creation or transport init fails */}
  }

  const transport = pino.transport({ targets });
  return pino({ level: config.logLevel }, transport);
}

// Lazy proxy: logger is created on first use so CLI flags (--verbose etc.)
// are applied before the pino instance reads config.logLevel.
export const logger = new Proxy({} as pino.Logger, {
  get(_t, prop: string | symbol) {
    if (!_logger) _logger = createLogger();
    return (_logger as unknown as Record<string | symbol, unknown>)[prop];
  },
});
