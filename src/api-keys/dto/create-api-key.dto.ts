import { IsArray, IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ALL_API_KEY_SCOPES } from '../engine/api-key-policy';

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsArray()
  @IsIn(ALL_API_KEY_SCOPES, { each: true })
  scopes: string[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
