import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestIdInterceptor } from './request-id.interceptor';
import { SecretScannerService } from './secret-scanner.service';

@Global()
@Module({
  providers: [
    SecretScannerService,
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
  ],
  exports: [SecretScannerService],
})
export class SecurityModule {}
