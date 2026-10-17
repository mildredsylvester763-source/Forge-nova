import { BadRequestException } from '@nestjs/common';
import { SecretScannerService } from './secret-scanner.service';

describe('SecretScannerService', () => {
  const scanner = new SecretScannerService();

  it('does not flag ordinary source or environment placeholders', () => {
    expect(scanner.scan('const key = process.env.API_KEY;\nconst sample = "replace-with-your-key";')).toEqual([]);
  });

  it('detects high-confidence credential patterns without returning their values', () => {
    const token = 'AKIA1234567890ABCDEF';
    const findings = scanner.scan(`const first = true;\nconst key = "${token}";`);
    expect(findings).toEqual([{ category: 'aws-access-key', line: 2 }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  it('rejects private key material with a safe diagnostic', () => {
    expect(() => scanner.assertNoSecrets('-----BEGIN PRIVATE KEY-----')).toThrow(BadRequestException);
  });
});
