import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('api'),
  API_VERSION: z.coerce.number().int().positive().default(1),
  DATABASE_URL: z.string().url().refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'must be a valid PostgreSQL connection URL',
  ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default(''),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_DEFAULT_MODEL: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_DEFAULT_MODEL: z.string().min(1).optional(),
  GOOGLE_AI_API_KEY: z.string().min(1).optional(),
  GOOGLE_AI_DEFAULT_MODEL: z.string().min(1).optional(),
  MISTRAL_API_KEY: z.string().min(1).optional(),
  MISTRAL_DEFAULT_MODEL: z.string().min(1).optional(),
  AI_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(60000),
  AI_PROVIDER_PRIORITY: z.string().default('openai,anthropic,google,mistral'),
  EXECUTION_WORKER_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true').default('true'),
  EXECUTION_WORKER_POLL_MS: z.coerce.number().int().min(250).max(10000).default(1000),
  EXECUTION_WORKER_LEASE_MS: z.coerce.number().int().min(10000).max(300000).default(60000),
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

  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.JWT_ACCESS_SECRET.toLowerCase().includes('development')
  ) {
    throw new Error('JWT_ACCESS_SECRET must not contain a development placeholder in production.');
  }

  return parsed.data;
}
