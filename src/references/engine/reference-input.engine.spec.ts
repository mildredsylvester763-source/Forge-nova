import {
  MAX_REFERENCE_CONTENT_CHARS,
  MAX_REFERENCE_TITLE_CHARS,
  validateReferenceInput,
} from './reference-input.engine';

describe('validateReferenceInput', () => {
  it('accepts and trims a valid reference', () => {
    const result = validateReferenceInput({
      title: '  Landing page spec  ',
      kind: 'SPEC',
      content: '  The page must load in under two seconds.  ',
    });
    expect(result.title).toBe('Landing page spec');
    expect(result.kind).toBe('SPEC');
    expect(result.content).toBe('The page must load in under two seconds.');
  });

  it('refuses an empty or missing title by name', () => {
    expect(() => validateReferenceInput({ kind: 'SPEC', content: 'body' })).toThrow(/reference-title-required/);
    expect(() => validateReferenceInput({ title: '   ', kind: 'SPEC', content: 'body' })).toThrow(
      /reference-title-required/,
    );
  });

  it('refuses an oversized title by name', () => {
    expect(() =>
      validateReferenceInput({ title: 'x'.repeat(MAX_REFERENCE_TITLE_CHARS + 1), kind: 'NOTES', content: 'body' }),
    ).toThrow(/reference-title-too-long/);
  });

  it('refuses unsupported kinds by name, including image and figma', () => {
    expect(() => validateReferenceInput({ title: 't', kind: 'IMAGE', content: 'body' })).toThrow(
      /reference-kind-unsupported/,
    );
    expect(() => validateReferenceInput({ title: 't', kind: 'FIGMA', content: 'body' })).toThrow(
      /reference-kind-unsupported/,
    );
  });

  it('refuses empty content by name', () => {
    expect(() => validateReferenceInput({ title: 't', kind: 'NOTES', content: '' })).toThrow(
      /reference-content-required/,
    );
  });

  it('refuses oversized content by name with the actual size', () => {
    expect(() =>
      validateReferenceInput({ title: 't', kind: 'SPEC', content: 'x'.repeat(MAX_REFERENCE_CONTENT_CHARS + 1) }),
    ).toThrow(new RegExp(`reference-content-too-large: content is ${MAX_REFERENCE_CONTENT_CHARS + 1} characters`));
  });
});
