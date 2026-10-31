import { ArrayNotEmpty, IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateWebhookEndpointDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url: string;

  /**
   * Each entry must be a known event name, an entity wildcard
   * (e.g. deployment.*), or the literal all.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  eventSubscriptions: string[];
}
