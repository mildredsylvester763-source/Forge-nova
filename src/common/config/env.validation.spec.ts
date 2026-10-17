import { validateEnvironment } from './env.validation';

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  API_PREFIX: 'api',
  API_VERSION: '1',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/genesis_test?schema=public',
  JWT_ACCESS_SECRET: 'test-only-secret-that-is-long-enough-for-validation',
};

describe('validateEnvironment', () => {
  it('accepts a valid test configuration', () => {
    const result = validateEnvironment({ ...validEnvironment });
    expect(result.NODE_ENV).toBe('test');
    expect(result.API_VERSION).toBe(1);
    expect(result.PORT).toBe(3000);
  });

  it('rejects non-PostgreSQL database URLs', () => {
    expect(() =>
      validateEnvironment({ ...validEnvironment, DATABASE_URL: 'https://example.com/database' }),
    ).toThrow(/PostgreSQL connection URL/);
  });

  it('rejects missing JWT signing secrets', () => {
    const { JWT_ACCESS_SECRET: _secret, ...withoutSecret } = validEnvironment;
    expect(() => validateEnvironment(withoutSecret)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects development placeholder secrets in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'development-secret-that-is-long-enough',
      }),
    ).toThrow(/must not contain a development placeholder/);
  });
});
