import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class GenerateSourceDto {
  @IsString()
  @Matches(/\S/)
  @MinLength(1)
  @MaxLength(20000)
  prompt!: string;

  @IsString()
  @Matches(/^[a-zA-Z0-9._:-]{8,128}$/)
  idempotencyKey!: string;
}
