import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * Reads the `Idempotency-Key` request header. Unlike `@Headers()`, a custom
 * param decorator accepts pipes, so the header can be validated:
 * `@IdempotencyKey(IdempotencyKeyPipe)`.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): unknown => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    return request.headers['idempotency-key'];
  },
);
