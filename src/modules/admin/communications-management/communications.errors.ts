export class CommunicationsAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'CommunicationsAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class TemplateNotFoundError extends CommunicationsAdminError {
  constructor(message = 'Notification template not found') {
    super('TEMPLATE_NOT_FOUND', message, 404);
  }
}

export class TemplateConflictError extends CommunicationsAdminError {
  constructor(message: string) {
    super('TEMPLATE_CONFLICT', message, 409);
  }
}

export class BroadcastNotFoundError extends CommunicationsAdminError {
  constructor(message = 'Push broadcast not found') {
    super('BROADCAST_NOT_FOUND', message, 404);
  }
}

export class BroadcastConflictError extends CommunicationsAdminError {
  constructor(message: string) {
    super('BROADCAST_CONFLICT', message, 409);
  }
}
