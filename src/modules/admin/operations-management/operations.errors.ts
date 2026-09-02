export class OperationsAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'OPERATIONS_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'OperationsAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class RideNotFoundError extends OperationsAdminError {
  constructor(message = 'Ride was not found') {
    super(message, 'RIDE_NOT_FOUND', 404);
    this.name = 'RideNotFoundError';
  }
}

export class RideRequestNotFoundError extends OperationsAdminError {
  constructor(message = 'Ride request was not found') {
    super(message, 'RIDE_REQUEST_NOT_FOUND', 404);
    this.name = 'RideRequestNotFoundError';
  }
}

export class SupportTicketNotFoundError extends OperationsAdminError {
  constructor(message = 'Support ticket was not found') {
    super(message, 'TICKET_NOT_FOUND', 404);
    this.name = 'SupportTicketNotFoundError';
  }
}

export class SupportAgentNotFoundError extends OperationsAdminError {
  constructor(message = 'Support agent was not found') {
    super(message, 'SUPPORT_AGENT_NOT_FOUND', 404);
    this.name = 'SupportAgentNotFoundError';
  }
}

export class SupportCategoryNotFoundError extends OperationsAdminError {
  constructor(message = 'Support category was not found') {
    super(message, 'SUPPORT_CATEGORY_NOT_FOUND', 404);
    this.name = 'SupportCategoryNotFoundError';
  }
}

export class SafetyIncidentNotFoundError extends OperationsAdminError {
  constructor(message = 'Safety incident was not found') {
    super(message, 'SAFETY_INCIDENT_NOT_FOUND', 404);
    this.name = 'SafetyIncidentNotFoundError';
  }
}

export class OperationsConflictError extends OperationsAdminError {
  constructor(message: string) {
    super(message, 'OPERATIONS_CONFLICT', 409);
    this.name = 'OperationsConflictError';
  }
}

export class OperationsValidationError extends OperationsAdminError {
  constructor(message: string) {
    super(message, 'OPERATIONS_VALIDATION', 400);
    this.name = 'OperationsValidationError';
  }
}
