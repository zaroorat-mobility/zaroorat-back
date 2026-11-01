import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { errorEnvelope, isCodedError } from '@core/errors/envelope.js';
import { FileError } from '@modules/files';
import { replyFromFileError } from '@modules/files/schemas';
import { VehicleError } from '../errors/index.js';

export function handleVehicleError(
  err: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Document submission surfaces the Files module's ownership/state errors (404/409); they
  // used to fall through to a 500. Same branch as the drivers module's handler.
  if (err instanceof FileError) {
    replyFromFileError(request, reply, err);
    return;
  }
  const errRecord = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  if (
    err instanceof ZodError ||
    (errRecord !== null && (errRecord.name === 'ZodError' || Array.isArray(errRecord.issues)))
  ) {
    const issues = Array.isArray(errRecord?.issues) ? errRecord.issues : [];
    reply.status(400).send(
      errorEnvelope('VALIDATION', 'Request validation failed', request.id, {
        details: issues,
      }),
    );
    return;
  }
  if (isCodedError(err) && err.statusCode < 500) {
    reply.status(err.statusCode).send(errorEnvelope(err.code, err.message, request.id));
    return;
  }
  if (errRecord?.code === 'P2002') {
    const meta = errRecord.meta as { target?: string[] | string } | undefined;
    const target = meta?.target;
    const targetStr = Array.isArray(target) ? target.join(', ') : (target ?? 'field');
    reply.status(409).send(
      errorEnvelope(
        'CONFLICT',
        `A vehicle service with this ${targetStr} already exists. Please choose a different name or edit the existing service.`,
        request.id,
      ),
    );
    return;
  }
  request.log.error({ err }, '[vehicles] unhandled error');
  const message =
    process.env.NODE_ENV === 'production'
      ? 'An unexpected vehicles error occurred'
      : typeof errRecord?.message === 'string'
        ? errRecord.message
        : 'An unexpected vehicles error occurred';
  reply
    .status(500)
    .send(errorEnvelope('INTERNAL', message, request.id));
}
export { VehicleError };
