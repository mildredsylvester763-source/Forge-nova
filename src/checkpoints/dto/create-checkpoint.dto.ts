import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateCheckpointDto {
  @IsString()
  @Matches(/\S/)
  @MinLength(1)
  @MaxLength(160)
  label!: string;
}
