import pino from 'pino';
import { env } from '../config/env.mjs';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.jwt'],
    censor: '[REDACTED]',
  },
});
