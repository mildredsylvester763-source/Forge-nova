import { BadRequestException, Injectable } from '@nestjs/common';

export interface SecretFinding {
  category: string;
  line: number;
}

@Injectable()
export class SecretScannerService {
  private readonly patterns: Array<{ category: string; expression: RegExp }> = [
    { category: 'private-key', expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
    { category: 'aws-access-key', expression: /\bAKIA[0-9A-Z]{16}\b/g },
    { category: 'github-token', expression: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
    { category: 'github-fine-grained-token', expression: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
    { category: 'stripe-secret', expression: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
    { category: 'stripe-webhook-secret', expression: /\bwhsec_[A-Za-z0-9]{20,}\b/g },
    { category: 'sendgrid-token', expression: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
    { category: 'twilio-api-key', expression: /\bSK[0-9a-fA-F]{32}\b/g },
    { category: 'google-api-key', expression: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { category: 'slack-token', expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
    { category: 'jwt-token', expression: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    { category: 'openai-key', expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/g },
  ];

  scan(content: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    for (const pattern of this.patterns) {
      pattern.expression.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.expression.exec(content)) !== null) {
        findings.push({
          category: pattern.category,
          line: content.slice(0, match.index).split('\n').length,
        });
      }
    }

    const assignment = /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']([^"']{20,})["']/gi;
    let match: RegExpExecArray | null;
    while ((match = assignment.exec(content)) !== null) {
      const candidate = match[1] ?? '';
      if (/your_|replace|example|placeholder|dummy|sample|process\.env|env\(/i.test(candidate)) continue;
      findings.push({
        category: 'credential-assignment',
        line: content.slice(0, match.index).split('\n').length,
      });
    }

    const unique = new Map(findings.map((finding) => [`${finding.category}:${finding.line}`, finding]));
    return [...unique.values()].sort((a, b) => a.line - b.line);
  }

  assertNoSecrets(content: string): void {
    const findings = this.scan(content);
    if (findings.length > 0) {
      const summary = findings
        .map((finding) => `${finding.category} on line ${finding.line}`)
        .join(', ');
      throw new BadRequestException(
        `Possible secret material detected (${summary}). Store credentials in the authorized secret/integration system, not prompts or source files.`,
      );
    }
  }
}
