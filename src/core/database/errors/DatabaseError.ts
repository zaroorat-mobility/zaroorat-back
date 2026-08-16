export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}
export class ConnectionError extends DatabaseError {
  constructor(message: string = 'Database connection failed', originalError?: unknown) {
    super(message, originalError);
  }
}
export class RecordNotFoundError extends DatabaseError {
  constructor(model: string, originalError?: unknown) {
    super(`Record not found for model: ${model}`, originalError);
  }
}
export class UniqueConstraintError extends DatabaseError {
  constructor(target: string, originalError?: unknown) {
    super(`Unique constraint failed on: ${target}`, originalError);
  }
}
