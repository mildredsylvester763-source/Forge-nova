import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { WorkNodeType } from '@prisma/client';

export class CreateWorkNodeDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
  key!: string;

  @IsEnum(WorkNodeType)
  type!: WorkNodeType;

  @IsString()
  @Matches(/\\S/)
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  dependsOnNodeIds?: string[];
}
