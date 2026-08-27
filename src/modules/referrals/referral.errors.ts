export class ReferralError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code = 'REFERRAL_ERROR', statusCode = 400) {
    super(message);
    this.name = 'ReferralError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ReferralCodeInvalidError extends ReferralError {
  constructor(message = 'Referral code is invalid or inactive') {
    super(message, 'REFERRAL_CODE_INVALID', 400);
    this.name = 'ReferralCodeInvalidError';
  }
}

export class ReferralCodeAudienceMismatchError extends ReferralError {
  constructor(message = 'Referral code is not valid for this signup type') {
    super(message, 'REFERRAL_CODE_AUDIENCE_MISMATCH', 400);
    this.name = 'ReferralCodeAudienceMismatchError';
  }
}

export class ReferralSelfReferralError extends ReferralError {
  constructor(message = 'You cannot use your own referral code') {
    super(message, 'REFERRAL_SELF_REFERRAL', 400);
    this.name = 'ReferralSelfReferralError';
  }
}

export class ReferralAlreadyAppliedError extends ReferralError {
  constructor(message = 'A referral is already recorded for this user in this program') {
    super(message, 'REFERRAL_ALREADY_APPLIED', 409);
    this.name = 'ReferralAlreadyAppliedError';
  }
}

export class ReferralProgramNotActiveError extends ReferralError {
  constructor(message = 'No active referral program is configured') {
    super(message, 'REFERRAL_PROGRAM_NOT_ACTIVE', 404);
    this.name = 'ReferralProgramNotActiveError';
  }
}
