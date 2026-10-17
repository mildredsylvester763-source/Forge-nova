import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

type RequestWithId = Request & { requestId?: string };

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();
    const incoming = request.headers['x-request-id'];
    const candidate = typeof incoming === 'string' ? incoming : '';
    const requestId = /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate)
      ? candidate
      : randomUUID();

    request.requestId = requestId;
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-Id', requestId);
    return next.handle();
  }
}
