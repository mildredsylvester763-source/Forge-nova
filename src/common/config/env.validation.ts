import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('api'),
  API_VERSION: z.coerce.number().int().positive().default(1),
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgresql://')).or(z.string().startsWith('postgres://')),
  DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(120).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default(''),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: NodeJS.ProcessEnv): AppEnvironment {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return parsed.data;
}
