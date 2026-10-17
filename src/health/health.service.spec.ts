import { HealthService } from './health.service';
import { PrismaService } from '../database/prisma.service';

describe('HealthService', () => {
  const prisma = {
    isDatabaseReady: jest.fn(),
  } as unknown as PrismaService;

  let service: HealthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new HealthService(prisma);
  });

  it('returns liveness without depending on database availability', () => {
    const result = service.live();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('genesis-api');
    expect(result.timestamp).toBeTruthy();
    expect(prisma.isDatabaseReady).not.toHaveBeenCalled();
  });

  it('reports ready when the database check succeeds', async () => {
    jest.mocked(prisma.isDatabaseReady).mockResolvedValue(true);
    const result = await service.ready();
    expect(result.status).toBe('ok');
    expect(result.checks.database).toBe('ok');
  });

  it('reports degraded when the database check fails', async () => {
    jest.mocked(prisma.isDatabaseReady).mockResolvedValue(false);
    const result = await service.ready();
    expect(result.status).toBe('degraded');
    expect(result.checks.database).toBe('unavailable');
  });
});
