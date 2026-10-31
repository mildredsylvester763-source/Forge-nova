import { IsNotEmpty, IsObject, IsString, MaxLength } from 'class-validator';

export class CreateConnectionDto {
  @IsString()
  @IsNotEmpty()
  connectorId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  /**
   * Credentials are accepted as a flat string map and validated
   * against the connector catalog: only NAMED fields are stored, and
   * the values are never echoed back in any response.
   */
  @IsObject()
  @IsNotEmpty()
  credentials: Record<string, string>;
}
