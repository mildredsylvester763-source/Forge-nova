import { Matches, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsString()
  @Matches(/\S/)
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}
