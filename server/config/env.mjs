import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url().optional(),
  JWT_TTL: z.string().default('8h'),
  COOKIE_NAME: z.string().min(1).default('wingo_session'),
  LOG_LEVEL: z.string().default('info'),
  WINGO_API_URL: z.string().url().default('https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json'),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
  CONFIDENCE_THRESHOLD: z.coerce.number().int().min(50).max(95).default(65),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
  REQUEST_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  WA_RECONNECT_MAX_BACKOFF_MS: z.coerce.number().int().min(5000).max(120000).default(30000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

export const env = parsed.data;
