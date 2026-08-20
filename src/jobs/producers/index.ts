import type { OtpPurpose } from '@core/database/types';
import { JOB_NAMES, otpQueue } from '../queues/index.js';
export interface OtpDeliveryJobData {
  challengeId: string;
  phoneNumber: string;
  code: string;
  purpose: OtpPurpose;
}
export async function enqueueOtpDelivery(data: OtpDeliveryJobData): Promise<void> {
  await otpQueue().add(JOB_NAMES.OTP_SEND, data, { jobId: data.challengeId });
}
