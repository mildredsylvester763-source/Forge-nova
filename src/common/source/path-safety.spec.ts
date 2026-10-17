import { BadRequestException } from '@nestjs/common';
import { normalizeApplicationPath } from './path-safety';

describe('normalizeApplicationPath', () => {\n  const backslashPath = 'src' + String.fromCharCode(92) + 'app.ts';
  it('accepts safe nested source paths', () => {
    expect(normalizeApplicationPath('src/modules/app.service.ts')).toBe('src/modules/app.service.ts');
    expect(normalizeApplicationPath('.env.example')).toBe('.env.example');
  });

  it.each(['../secrets.txt', '/etc/passwd', 'C:/secrets.txt', backslashPath, 'src//app.ts', '.git/config', 'node_modules/pkg/index.js', '.env', '.env.production'])(
    'rejects unsafe path %s',
    (path) => {
      expect(() => normalizeApplicationPath(path)).toThrow(BadRequestException);
    },
  );
});
