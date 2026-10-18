export const SUPPORTED_REFERENCE_KINDS = ['SPEC', 'TRANSCRIPT', 'NOTES', 'OTHER'] as const;
export type SupportedReferenceKind = (typeof SUPPORTED_REFERENCE_KINDS)[number];

export const MAX_REFERENCE_TITLE_CHARS = 200;
export const MAX_REFERENCE_CONTENT_CHARS = 50_000;

export interface ValidatedReferenceInput {
  title: string;
  kind: SupportedReferenceKind;
  content: string;
}

/**
 * Validates reference-document input with named refusals. Binary, image,
 * Figma, and URL references are deliberately unsupported here: no ingestion
 * infrastructure exists for them, so accepting them would imply storage and
 * processing that never happens.
 */
export function validateReferenceInput(raw: {
  title?: unknown;
  kind?: unknown;
  content?: unknown;
}): ValidatedReferenceInput {
  if (typeof raw.title !== 'string' || raw.title.trim().length === 0) {
    throw new Error('reference-title-required: title must be a non-empty string.');
  }
  const title = raw.title.trim();
  if (title.length > MAX_REFERENCE_TITLE_CHARS) {
    throw new Error(
      `reference-title-too-long: title is ${title.length} characters; the maximum is ${MAX_REFERENCE_TITLE_CHARS}.`,
    );
  }

  if (typeof raw.kind !== 'string' || !(SUPPORTED_REFERENCE_KINDS as readonly string[]).includes(raw.kind)) {
    throw new Error(
      `reference-kind-unsupported: kind must be one of ${SUPPORTED_REFERENCE_KINDS.join(', ')}; image, Figma, and URL references are not supported yet.`,
    );
  }
  const kind = raw.kind as SupportedReferenceKind;

  if (typeof raw.content !== 'string' || raw.content.trim().length === 0) {
    throw new Error('reference-content-required: content must be a non-empty text document.');
  }
  const content = raw.content.trim();
  if (content.length > MAX_REFERENCE_CONTENT_CHARS) {
    throw new Error(
      `reference-content-too-large: content is ${content.length} characters; the maximum is ${MAX_REFERENCE_CONTENT_CHARS}. Split the reference or implement chunked ingestion first.`,
    );
  }

  return { title, kind, content };
}
