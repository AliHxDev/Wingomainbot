import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(50),
  password: z.string().min(8).max(128),
});

export const pairingSchema = z.object({
  phoneNumber: z.string().trim().regex(/^\d{8,15}$/, 'Use the full international phone number without + or punctuation.'),
});

export const channelSchema = z.object({
  recipients: z.array(z.string().trim().min(5).max(100)).max(30),
});

export const settingsSchema = z.object({
  confidenceThreshold: z.coerce.number().int().min(50).max(95),
  pollIntervalSeconds: z.coerce.number().int().min(30).max(300),
});

export const signalLimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
