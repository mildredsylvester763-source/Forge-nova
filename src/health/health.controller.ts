import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live() {
    return this.health.live();
  }

  @Get('ready')
  async ready() {
    const result = await this.health.ready();
    if (result.status !== 'ok') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
