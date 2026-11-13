import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from '../exceptions/domain.exception';

@Catch(DomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // Retryable domain errors (e.g. STORAGE_UNAVAILABLE) carry a delay.
    const retryAfter = (exception as { retryAfterSeconds?: unknown })
      .retryAfterSeconds;
    if (typeof retryAfter === 'number') {
      response.setHeader('Retry-After', String(retryAfter));
    }

    response.status(exception.httpStatus).json({
      statusCode: exception.httpStatus,
      error: exception.errorCode,
      message: exception.message,
    });
  }
}
