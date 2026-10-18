import { IsIn, IsString, MaxLength } from 'class-validator';
import { SUPPORTED_REFERENCE_KINDS } from '../engine/reference-input.engine';
import { MAX_REFERENCE_CONTENT_CHARS, MAX_REFERENCE_TITLE_CHARS } from '../engine/reference-input.engine';

export class CreateReferenceDto {
  @IsString()
  @MaxLength(MAX_REFERENCE_TITLE_CHARS)
  title!: string;

  @IsIn(SUPPORTED_REFERENCE_KINDS as unknown as string[])
  kind!: string;

  @IsString()
  @MaxLength(MAX_REFERENCE_CONTENT_CHARS)
  content!: string;
}
