import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';

@Module({
  imports: [SecurityModule],
  controllers: [FileController],
  providers: [FileService],
})
export class FileModule {}
