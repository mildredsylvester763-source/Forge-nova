import { Matches, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApplicationDto {
  @IsString()
  @Matches(/\S/)
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  framework?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  runtime?: string;
}
