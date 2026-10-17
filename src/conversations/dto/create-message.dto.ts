import { Matches, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateMessageDto {
  @IsString()
  @Matches(/\S/)
  @MinLength(1)
  @MaxLength(50000)
  content!: string;
}
