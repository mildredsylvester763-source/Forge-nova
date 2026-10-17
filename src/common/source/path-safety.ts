import { BadRequestException } from '@nestjs/common';

const MAX_PATH_LENGTH = 512;
const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules']);

export function normalizeApplicationPath(input: string): string {
  const value = input.trim();
  if (!value || value.length > MAX_PATH_LENGTH) {
    throw new BadRequestException('File path must contain 1 to 512 characters.');
  }
  if (
    value.startsWith('/') ||
    value.startsWith(String.fromCharCode(92)) ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes(String.fromCharCode(92)) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BadRequestException('Absolute paths, backslashes, and control characters are not allowed.');
  }

  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new BadRequestException('File path contains an invalid path segment.');
  }
  for (const segment of segments) {
    const normalized = segment.toLowerCase();
    if (BLOCKED_SEGMENTS.has(normalized)) {
      throw new BadRequestException('Generated source cannot write to protected dependency or VCS directories.');
    }
    if (normalized === '.env' || (normalized.startsWith('.env.') && !['.env.example', '.env.sample'].includes(normalized))) {
      throw new BadRequestException('Secret-bearing environment files cannot be stored as source files.');
    }
  }

  return segments.join('/');
}
