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
