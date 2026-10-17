import { parseGeneratedSource } from './generated-source.parser';

describe('parseGeneratedSource', () => {
  it('accepts a valid multi-file output and normalizes paths', () => {
    const parsed = parseGeneratedSource(JSON.stringify({
      summary: 'Created a minimal application skeleton.',
      files: [
        { path: 'src/app.ts', language: 'typescript', content: 'export const app = true;' },
        { path: 'README.md', language: 'markdown', content: '# Application' },
      ],
    }));
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]?.path).toBe('src/app.ts');
  });

  it('rejects unsafe paths before persistence', () => {
    expect(() => parseGeneratedSource(JSON.stringify({
      summary: 'Unsafe output',
      files: [{ path: '../secrets.txt', content: 'no' }],
    }))).toThrow();
  });

  it('rejects duplicate paths', () => {
    expect(() => parseGeneratedSource(JSON.stringify({
      summary: 'Duplicate output',
      files: [
        { path: 'src/app.ts', content: 'one' },
        { path: 'src/app.ts', content: 'two' },
      ],
    }))).toThrow(/duplicate file paths/);
  });

  it('rejects invalid JSON instead of accepting partial output', () => {
    expect(() => parseGeneratedSource('not json')).toThrow(/valid JSON/);
  });
});
