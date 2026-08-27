import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { generateDriverCode } from '../utils/driver-code.util.js';
import type { Driver, DriverProfile, DriverVerificationStatus } from '../types';
export class DriverRepository {
  constructor(private readonly db: DatabaseService) {}
  async lockForUpdate(id: string, tx: TransactionClient): Promise<Driver | null> {
    const locked = await tx.$queryRaw<
      {
        id: string;
      }[]
    >`
      SELECT "id" FROM "drivers" WHERE "id" = ${id}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return tx.driver.findUnique({ where: { id } });
  }
  async createDriver(userId: string, tx?: TransactionClient): Promise<Driver> {
    const client = tx ?? this.db.client;
    const driverCode = generateDriverCode();
    return client.driver.create({
      data: {
        userId,
        driverCode,
        verificationStatus: 'PENDING',
        isAvailable: false,
        isSuspended: false,
      },
    });
  }
  async findById(id: string, tx?: TransactionClient): Promise<Driver | null> {
    const client = tx ?? this.db.client;
    return client.driver.findUnique({
      where: { id },
      include: {
        profile: true,
        documents: true,
        onlineStatus: true,
      },
    });
  }
  async findByUserId(userId: string, tx?: TransactionClient): Promise<Driver | null> {
    const client = tx ?? this.db.client;
    return client.driver.findUnique({
      where: { userId },
      include: {
        profile: true,
        documents: true,
        onlineStatus: true,
      },
    });
  }
  async updateProfile(
    userId: string,
    driverId: string,
    profileData: Partial<{
      fullLegalName: string;
      dateOfBirth: Date;
      gender: string;
      addressLine: string;
      city: string;
      state: string;
      postalCode: string;
      preferredLanguage: string;
      bloodGroup: string;
      alternatePhone: string;
      drivingExperienceYears: number;
      email: string | null;
    }>,
    tx?: TransactionClient,
  ): Promise<DriverProfile> {
    const client = tx ?? this.db.client;

    // Extract email from profileData so it isn't passed to driverProfile.upsert
    const { email, ...driverProfileData } = profileData;

    if (email !== undefined) {
      await client.user.update({
        where: { id: userId },
        data: { email },
      });
    }

    return client.driverProfile.upsert({
      where: { driverId },
      create: {
        driverId,
        ...driverProfileData,
      },
      update: driverProfileData,
    });
  }
  async updateVerificationStatus(
    id: string,
    verificationStatus: DriverVerificationStatus,
    approvedBy?: string,
    rejectionReason?: string,
    tx?: TransactionClient,
  ): Promise<Driver> {
    const client = tx ?? this.db.client;
    return client.driver.update({
      where: { id },
      data: {
        verificationStatus,
        ...(verificationStatus === 'VERIFIED'
          ? {
              approvedAt: new Date(),
              ...(approvedBy !== undefined ? { approvedBy } : {}),
            }
          : {}),
        ...(rejectionReason !== undefined ? { rejectionReason } : {}),
      },
    });
  }
  /// `Driver.rating` is a stored aggregate over `RideRating`, not a value
  /// anybody sets directly. It defaulted to 5.00 and was written by nothing, so
  /// every driver's profile reported a perfect score forever, however they were
  /// actually rated.
  async setRating(id: string, rating: number, tx?: TransactionClient): Promise<Driver> {
    const client = tx ?? this.db.client;
    return client.driver.update({ where: { id }, data: { rating } });
  }

  /// The completion counters `GET /drivers/me` has always served and nothing
  /// has ever written, so a driver five hundred rides in still read
  /// `totalRides: 0`, `totalDistanceKm: 0` and `lastRideAt: null`.
  ///
  /// Incremented rather than recomputed: these are running totals over every
  /// ride a driver has ever done, and re-deriving one on each completion would
  /// cost a scan of that driver's whole history. Called from inside the
  /// completion transaction, behind the conditional claim that decides the
  /// completion, so it commits with the ride or not at all and a replayed
  /// completion cannot count twice.
  ///
  /// `totalEarnings` and the three rate columns are deliberately not touched —
  /// see the note in `LifecycleService.completeRide`.
  async recordCompletedRide(
    id: string,
    distanceKm: number,
    completedAt: Date,
    tx?: TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.db.client;
    await client.driver.update({
      where: { id },
      data: {
        totalRides: { increment: 1 },
        totalDistanceKm: { increment: distanceKm },
        lastRideAt: completedAt,
      },
    });
  }

  async setSuspended(id: string, isSuspended: boolean, tx?: TransactionClient): Promise<Driver> {
    const client = tx ?? this.db.client;
    return client.driver.update({
      where: { id },
      data: { isSuspended, ...(isSuspended ? { isAvailable: false } : {}) },
    });
  }
  async updateAvailability(
    id: string,
    isAvailable: boolean,
    tx?: TransactionClient,
  ): Promise<Driver> {
    const client = tx ?? this.db.client;
    return client.driver.update({
      where: { id },
      data: { isAvailable },
    });
  }
  async updateCurrentVehicle(
    id: string,
    vehicleId: string | null,
    tx: TransactionClient,
  ): Promise<Driver> {
    return tx.driver.update({ where: { id }, data: { currentVehicleId: vehicleId } });
  }
}
