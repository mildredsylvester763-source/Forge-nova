export const EXTRACTION_REQUIREMENT_PRIORITIES = ['MUST', 'SHOULD', 'COULD'] as const;
export type ExtractionPriority = (typeof EXTRACTION_REQUIREMENT_PRIORITIES)[number];

export const MAX_EXTRACTED_REQUIREMENTS = 30;
export const MAX_EXTRACTED_OPEN_QUESTIONS = 20;

export interface ExtractedRequirement {
  title: string;
  detail: string;
  priority: ExtractionPriority;
}

export interface ExtractedRequirements {
  summary: string;
  requirements: ExtractedRequirement[];
  openQuestions: string[];
}

export function buildExtractionSystemPrompt(): string {
  return [
    'You are GENESIS Reference Ingestion, part of a full-stack software factory.',
    'You read a project reference document and extract concrete software requirements.',
    'Return only one JSON object with this exact shape: {"summary":"one-paragraph summary","requirements":[{"title":"short requirement name","detail":"specific, testable statement","priority":"MUST|SHOULD|COULD"}],"openQuestions":["question needing human clarification"]}.',
    'Do not use markdown fences, commentary, or additional top-level fields.',
    'Extract 1-30 requirements. Derive them from the document; do not invent capabilities the document does not describe.',
    'Every requirement must be specific and testable. Reject vague restatements.',
    'Use MUST only for hard constraints, SHOULD for important but negotiable needs, COULD for optional enhancements.',
    'List up to 20 open questions for ambiguities that genuinely need human decisions.',
    'Never claim the reference was built, tested, or deployed. This is analysis only.',
  ].join('\n');
}

export function buildExtractionUserPrompt(title: string, kind: string, content: string): string {
  return ['Reference document:', JSON.stringify({ title, kind }), '', 'Document contents:', content].join('\n');
}

/**
 * Parses and strictly validates an AI extraction response. Fence-wrapped
 * output is tolerated once, but malformed shapes are refused with named
 * reasons; nothing is guessed or padded.
 */
export function parseExtractionResult(text: string): ExtractedRequirements {
  const stripped = stripFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error('extraction-not-json: the extraction response is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extraction-wrong-shape: the extraction response must be a JSON object.');
  }
  const root = parsed as Record<string, unknown>;

  if (typeof root.summary !== 'string' || root.summary.trim().length === 0) {
    throw new Error('extraction-missing-summary: summary must be a non-empty string.');
  }
  const summary = root.summary.trim().slice(0, 2000);

  if (!Array.isArray(root.requirements) || root.requirements.length === 0) {
    throw new Error(
      'extraction-empty-requirements: at least one requirement must be extracted, or the document is not a usable reference.',
    );
  }
  if (root.requirements.length > MAX_EXTRACTED_REQUIREMENTS) {
    throw new Error(
      `extraction-too-many-requirements: ${root.requirements.length} requirements exceed the maximum of ${MAX_EXTRACTED_REQUIREMENTS}.`,
    );
  }

  const requirements: ExtractedRequirement[] = [];
  for (const [index, entry] of root.requirements.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`extraction-invalid-requirement: requirement ${index + 1} is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.title !== 'string' || record.title.trim().length === 0) {
      throw new Error(`extraction-invalid-requirement: requirement ${index + 1} has no non-empty title.`);
    }
    if (typeof record.detail !== 'string' || record.detail.trim().length === 0) {
      throw new Error(`extraction-invalid-requirement: requirement ${index + 1} has no non-empty detail.`);
    }
    if (
      typeof record.priority !== 'string' ||
      !(EXTRACTION_REQUIREMENT_PRIORITIES as readonly string[]).includes(record.priority)
    ) {
      throw new Error(
        `extraction-invalid-priority: requirement ${index + 1} priority must be MUST, SHOULD, or COULD.`,
      );
    }
    requirements.push({
      title: record.title.trim().slice(0, 200),
      detail: record.detail.trim().slice(0, 4000),
      priority: record.priority as ExtractionPriority,
    });
  }

  const openQuestions: string[] = [];
  if (root.openQuestions !== undefined && root.openQuestions !== null) {
    if (!Array.isArray(root.openQuestions)) {
      throw new Error('extraction-invalid-open-questions: openQuestions must be an array of strings.');
    }
    if (root.openQuestions.length > MAX_EXTRACTED_OPEN_QUESTIONS) {
      throw new Error(
        `extraction-too-many-open-questions: ${root.openQuestions.length} open questions exceed the maximum of ${MAX_EXTRACTED_OPEN_QUESTIONS}.`,
      );
    }
    for (const [index, question] of root.openQuestions.entries()) {
      if (typeof question !== 'string' || question.trim().length === 0) {
        throw new Error(`extraction-invalid-open-questions: open question ${index + 1} is not a non-empty string.`);
      }
      openQuestions.push(question.trim().slice(0, 300));
    }
  }

  return { summary, requirements, openQuestions };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  const withoutOpening = trimmed.slice(trimmed.indexOf('\n') + 1);
  const closingIndex = withoutOpening.lastIndexOf('```');
  return (closingIndex === -1 ? withoutOpening : withoutOpening.slice(0, closingIndex)).trim();
}
