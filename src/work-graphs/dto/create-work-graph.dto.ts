import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWorkGraphDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  sourcePrompt!: string;
}
