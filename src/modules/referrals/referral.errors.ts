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

/// FR-023. The program pays into a wallet the beneficiary does not have.
///
/// A 500 rather than a 4xx on purpose: nothing the caller did is wrong, and the
/// condition is a misconfigured program that an operator has to fix. It aborts
/// the reward transaction so the referral stays QUALIFIED and retryable, instead
/// of being marked REWARDED over an uncredited row.
export class ReferralRewardWalletMissingError extends ReferralError {
  constructor(message = 'The beneficiary has no wallet of the type this program pays into') {
    super(message, 'REFERRAL_REWARD_WALLET_MISSING', 500);
    this.name = 'ReferralRewardWalletMissingError';
  }
}

/// FR-025 / BD-6. The referee is not eligible to be referred: they have already
/// completed a ride, or their account is older than the qualification window.
export class RefereeNotEligibleError extends ReferralError {
  constructor(message = 'Referral codes can only be applied by new users') {
    super(message, 'REFERRAL_REFEREE_NOT_ELIGIBLE', 409);
    this.name = 'RefereeNotEligibleError';
  }
}

/// FR-028. The referral matched a fraud signal. Recorded and held for review
/// rather than refused outright — a shared device is evidence, not proof.
export class ReferralUnderReviewError extends ReferralError {
  constructor(message = 'This referral has been flagged for review') {
    super(message, 'REFERRAL_UNDER_REVIEW', 202);
    this.name = 'ReferralUnderReviewError';
  }
}
