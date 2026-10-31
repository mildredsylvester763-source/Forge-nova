import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class DispatchEventDto {
  @IsString()
  @IsNotEmpty()
  eventName: string;

  /** Free-form JSON payload delivered alongside the event name. */
  @IsObject()
  payload: Record<string, unknown>;
}
