import { Matches, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWorkGraphDto {
  @IsString()
  @Matches(/\\S/)
  @MinLength(1)
  @MaxLength(160)
  title!: string;

  @IsString()
  @Matches(/\\S/)
  @MinLength(1)
  @MaxLength(20000)
  sourcePrompt!: string;
}
