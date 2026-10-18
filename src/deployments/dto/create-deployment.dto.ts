import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export type DeploymentEnvironment = 'PREVIEW' | 'STAGING' | 'PRODUCTION';

export const DEPLOYMENT_ENVIRONMENTS: DeploymentEnvironment[] = [
  'PREVIEW',
  'STAGING',
  'PRODUCTION',
];

export class CreateDeploymentDto {
  @IsIn(DEPLOYMENT_ENVIRONMENTS)
  environment: DeploymentEnvironment;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  target?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
