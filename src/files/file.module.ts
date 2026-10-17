import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { ApplicationSourceService } from './application-source.service';

@Module({
  imports: [SecurityModule],
  controllers: [FileController],
  providers: [FileService, ApplicationSourceService],
  exports: [FileService, ApplicationSourceService],
})
export class FileModule {}
