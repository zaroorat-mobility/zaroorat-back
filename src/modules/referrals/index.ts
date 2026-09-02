import type { AwilixContainer } from 'awilix';
import { asClass } from 'awilix';
import { ReferralApplyService } from './referral-apply.service.js';
import { ReferralCodeService } from './referral-code.service.js';
import { ReferralRuntimeService } from './referral-runtime.service.js';
import { ReferralController } from './referral.controller.js';
import {
  ReferralRideCompletedConsumer,
  ReferralDriverVerifiedConsumer,
} from './consumers/index.js';
import { ReferralMetrics } from './referral.metrics.js';
import { ReferralPendingRewardSweepJob } from './jobs/pending-reward-sweep.job.js';

export function registerReferralsModule(container: AwilixContainer): void {
  container.register({
    referralMetrics: asClass(ReferralMetrics).singleton(),
    referralPendingRewardSweepJob: asClass(ReferralPendingRewardSweepJob).singleton(),
    referralRuntimeService: asClass(ReferralRuntimeService).singleton(),
    referralCodeService: asClass(ReferralCodeService).singleton(),
    referralApplyService: asClass(ReferralApplyService).singleton(),
    referralController: asClass(ReferralController).singleton(),
    referralRideCompletedConsumer: asClass(ReferralRideCompletedConsumer).singleton(),
    referralDriverVerifiedConsumer: asClass(ReferralDriverVerifiedConsumer).singleton(),
  });
}

export { ReferralMetrics } from './referral.metrics.js';
export {
  ReferralPendingRewardSweepJob,
  type PendingRewardSweepReport,
} from './jobs/pending-reward-sweep.job.js';
export { ReferralApplyService } from './referral-apply.service.js';
export { ReferralCodeService } from './referral-code.service.js';
export { ReferralRuntimeService } from './referral-runtime.service.js';
export {
  ReferralError,
  ReferralCodeInvalidError,
  ReferralCodeAudienceMismatchError,
  ReferralSelfReferralError,
  ReferralAlreadyAppliedError,
  ReferralProgramNotActiveError,
} from './referral.errors.js';
