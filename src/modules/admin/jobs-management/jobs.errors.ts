export class JobsError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'JOBS_ERROR', statusCode = 400) {
    super(message);
    this.name = 'JobsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class QueueNotFoundError extends JobsError {
  constructor(name: string) {
    super(`Queue "${name}" was not found`, 'QUEUE_NOT_FOUND', 404);
    this.name = 'QueueNotFoundError';
  }
}

export class JobNotFoundError extends JobsError {
  constructor(queue: string, jobId: string) {
    super(`Job "${jobId}" was not found in queue "${queue}"`, 'JOB_NOT_FOUND', 404);
    this.name = 'JobNotFoundError';
  }
}
