import { BadRequestException } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';

describe('job queue status filter law (shared by the JWT and genapi listings)', () => {
  const known = [
    'QUEUED',
    'RESERVED',
    'RUNNING',
    'WAITING_FOR_APPROVAL',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'PAUSED',
  ];

  it('treats an absent filter as no filter', () => {
    expect(JobQueueService.resolveStatusFilter(undefined)).toBeUndefined();
  });

  it('treats an empty filter as no filter', () => {
    expect(JobQueueService.resolveStatusFilter('')).toBeUndefined();
  });

  it('accepts every known job status unchanged', () => {
    for (const status of known) {
      expect(JobQueueService.resolveStatusFilter(status)).toBe(status);
    }
  });

  it('refuses an unknown status with a named 400', () => {
    expect(() => JobQueueService.resolveStatusFilter('BOGUS')).toThrow(BadRequestException);
    expect(() => JobQueueService.resolveStatusFilter('BOGUS')).toThrow(
      'Job status filter must be one of the known job statuses.',
    );
  });

  it('refuses case-mangled, padded, and multi-value filters identically', () => {
    expect(() => JobQueueService.resolveStatusFilter('queued')).toThrow(BadRequestException);
    expect(() => JobQueueService.resolveStatusFilter('CANCELLED ')).toThrow(BadRequestException);
    expect(() => JobQueueService.resolveStatusFilter('CANCELLED,FAILED')).toThrow(BadRequestException);
    expect(() => JobQueueService.resolveStatusFilter('null')).toThrow(BadRequestException);
  });
});