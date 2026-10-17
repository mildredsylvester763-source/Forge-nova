import { IsEmail, IsEnum, MaxLength } from 'class-validator';
import { MembershipRole } from '@prisma/client';

export class AddMemberDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsEnum(MembershipRole)
  role!: MembershipRole;
}
