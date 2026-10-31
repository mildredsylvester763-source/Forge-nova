import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DispatchEventDto {
  @IsString()
  @IsNotEmpty()
  eventName: string;

  /** Free-form JSON payload delivered alongside the event name. */
  payload: Record<string, unknown>;
}
