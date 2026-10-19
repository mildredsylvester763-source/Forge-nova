import { IsString, MaxLength } from 'class-validator';

export class TransferOwnershipDto {
  @IsString()
  @MaxLength(64)
  memberId: string;
}
