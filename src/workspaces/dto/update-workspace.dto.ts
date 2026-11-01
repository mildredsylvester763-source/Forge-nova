import { Matches, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateWorkspaceDto {
  @IsString()
  @Matches(/\S/)
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

