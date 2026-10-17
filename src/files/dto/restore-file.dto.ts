import { IsInt, Min } from 'class-validator';

export class RestoreFileDto {
  @IsInt()
  @Min(1)
  expectedCurrentRevision!: number;
}
