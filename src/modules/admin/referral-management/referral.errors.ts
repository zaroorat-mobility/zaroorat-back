export class ReferralAdminError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'REFERRAL_ADMIN_ERROR', statusCode = 400) {
    super(message);
    this.name = 'ReferralAdminError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ReferralProgramNotFoundError extends ReferralAdminError {
  constructor(message = 'Referral program was not found') {
    super(message, 'REFERRAL_PROGRAM_NOT_FOUND', 404);
    this.name = 'ReferralProgramNotFoundError';
  }
}

export class ReferralProgramConflictError extends ReferralAdminError {
  constructor(message: string) {
    super(message, 'REFERRAL_PROGRAM_CONFLICT', 409);
    this.name = 'ReferralProgramConflictError';
  }
}

export class ReferralCodeNotFoundError extends ReferralAdminError {
  constructor(message = 'Referral code was not found') {
    super(message, 'REFERRAL_CODE_NOT_FOUND', 404);
    this.name = 'ReferralCodeNotFoundError';
  }
}

export class ReferralNotFoundError extends ReferralAdminError {
  constructor(message = 'Referral was not found') {
    super(message, 'REFERRAL_NOT_FOUND', 404);
    this.name = 'ReferralNotFoundError';
  }
}

export class ReferralMilestoneNotFoundError extends ReferralAdminError {
  constructor(message = 'Referral milestone was not found') {
    super(message, 'REFERRAL_MILESTONE_NOT_FOUND', 404);
    this.name = 'ReferralMilestoneNotFoundError';
  }
}
