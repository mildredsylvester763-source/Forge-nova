import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class WriteFileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  path!: string;

  @IsString()
  @MaxLength(1000000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  language?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
