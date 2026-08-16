import { OtpHasher } from '@modules/auth/services/otp';
import { RideOtpRepository } from '../../repositories/ride-otp.repository.js';
import { generateRideOtp } from '../../utils/otp.util.js';
import { OtpVerificationError } from '../../errors/ride.errors.js';
import { RIDE_OTP_MAX_ATTEMPTS, RIDE_OTP_TTL_MINUTES } from '../../constants/ride.constants.js';
import type { RideOtp } from '../../types';
import type { TransactionClient } from '@core/database/TransactionManager';
export class RideOtpService {
  constructor(
    private readonly otpRepo: RideOtpRepository,
    private readonly otpHasher: OtpHasher,
  ) {}
  async generateStartOtp(
    rideId: string,
    tx?: TransactionClient,
  ): Promise<{
    otpRecord: RideOtp;
    plaintextOtp: string;
  }> {
    const plaintextOtp = generateRideOtp();
    const expiresAt = new Date(Date.now() + RIDE_OTP_TTL_MINUTES * 60 * 1000);
    const otpRecord = await this.otpRepo.create(
      {
        rideId,
        otpHash: this.otpHasher.hash(plaintextOtp),
        purpose: 'START',
        expiresAt,
      },
      tx,
    );
    return { otpRecord, plaintextOtp };
  }
  async verifyStartOtp(
    rideId: string,
    plaintextOtp: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const latestOtp = await this.otpRepo.findLatestByRideId(rideId, tx);
    if (!latestOtp) {
      throw new OtpVerificationError('No active OTP record found for this ride');
    }
    if (latestOtp.expiresAt.getTime() <= Date.now()) {
      throw new OtpVerificationError('OTP has expired');
    }
    if (!(await this.otpRepo.claimAttempt(latestOtp.id, RIDE_OTP_MAX_ATTEMPTS, tx))) {
      throw new OtpVerificationError('Maximum OTP verification attempts exceeded');
    }
    if (this.otpHasher.hash(plaintextOtp) !== latestOtp.otpHash) {
      throw new OtpVerificationError('Invalid start OTP code');
    }
    if (!(await this.otpRepo.claimVerification(latestOtp.id, tx))) {
      throw new OtpVerificationError('This OTP has already been used');
    }
    return true;
  }
}
