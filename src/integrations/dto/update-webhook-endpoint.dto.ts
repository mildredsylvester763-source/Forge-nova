import { ArrayNotEmpty, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Partial endpoint update, grounded in the GitHub webhook update and
 * the Stripe webhook endpoint update: only the fields sent change and
 * everything else stays untouched. The signing secret is deliberately
 * not updatable - it was revealed exactly once at creation and stays
 * bound to the endpoint for its whole life.
 */
export class UpdateWebhookEndpointDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  eventSubscriptions?: string[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
