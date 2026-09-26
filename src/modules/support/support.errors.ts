export class SupportError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'SupportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class CustomerSupportTicketNotFoundError extends SupportError {
  constructor(ticketId: string) {
    super(`Support ticket '${ticketId}' was not found`, 'SUPPORT_TICKET_NOT_FOUND', 404);
    this.name = 'CustomerSupportTicketNotFoundError';
  }
}

export class SupportTicketClosedError extends SupportError {
  constructor() {
    super(
      'This conversation is closed and cannot accept new messages',
      'SUPPORT_TICKET_CLOSED',
      409,
    );
    this.name = 'SupportTicketClosedError';
  }
}
