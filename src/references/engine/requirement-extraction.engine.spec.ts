import { parseExtractionResult } from './requirement-extraction.engine';

const validPayload = JSON.stringify({
  summary: 'A landing page with fast load and a signup form.',
  requirements: [
    { title: 'Fast load', detail: 'The page must load in under two seconds on a 4G connection.', priority: 'MUST' },
    { title: 'Signup form', detail: 'The page must include an email signup form.', priority: 'SHOULD' },
  ],
  openQuestions: ['Which analytics provider should be used?'],
});

describe('parseExtractionResult', () => {
  it('parses a valid extraction payload', () => {
    const result = parseExtractionResult(validPayload);
    expect(result.summary).toBe('A landing page with fast load and a signup form.');
    expect(result.requirements.length).toBe(2);
    expect(result.requirements[0].priority).toBe('MUST');
    expect(result.openQuestions).toEqual(['Which analytics provider should be used?']);
  });

  it('tolerates markdown-fenced output exactly once', () => {
    const fenced = '```json\n' + validPayload + '\n```';
    expect(parseExtractionResult(fenced).requirements.length).toBe(2);
  });

  it('refuses non-JSON output by name', () => {
    expect(() => parseExtractionResult('here are the requirements:')).toThrow(/extraction-not-json/);
  });

  it('refuses a non-object root by name', () => {
    expect(() => parseExtractionResult('[]')).toThrow(/extraction-wrong-shape/);
  });

  it('refuses a missing summary by name', () => {
    const payload = JSON.stringify({ requirements: [{ title: 't', detail: 'd', priority: 'MUST' }] });
    expect(() => parseExtractionResult(payload)).toThrow(/extraction-missing-summary/);
  });

  it('refuses zero requirements by name', () => {
    const payload = JSON.stringify({ summary: 's', requirements: [] });
    expect(() => parseExtractionResult(payload)).toThrow(/extraction-empty-requirements/);
  });

  it('refuses an invalid priority by name', () => {
    const payload = JSON.stringify({
      summary: 's',
      requirements: [{ title: 't', detail: 'd', priority: 'NICE' }],
    });
    expect(() => parseExtractionResult(payload)).toThrow(/extraction-invalid-priority/);
  });

  it('refuses non-string open questions by name', () => {
    const payload = JSON.stringify({
      summary: 's',
      requirements: [{ title: 't', detail: 'd', priority: 'MUST' }],
      openQuestions: [42],
    });
    expect(() => parseExtractionResult(payload)).toThrow(/extraction-invalid-open-questions/);
  });
});
