import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { Decimal, type DriverLocation } from '../types';
export interface UpdateDriverLocationInput {
  driverId: string;
  latitude: number;
  longitude: number;
  heading?: number;
  bearing?: number;
  speedKmh?: number;
  accuracyMeters?: number;
  isMockLocation?: boolean;
  rideId?: string;
}
export class DriverLocationRepository {
  constructor(private readonly db: DatabaseService) {}

  /// Runs `fn` in a transaction holding a per-driver advisory lock, so the
  /// fixes one driver sends concurrently (REST, socket, retries) are checked
  /// against the last fix and written one at a time — including the very
  /// first fix, when there is no row yet to lock. Released at commit/rollback.
  async withDriverLock<T>(driverId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.db.client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`driver_location:${driverId}`}, 0))`;
      return fn(tx);
    });
  }

  /// `recordedAt` is server time (defaulting to now). The upsert never
  /// replaces a row stamped later than this fix, so an older fix that loses a
  /// race cannot overwrite a newer one; the stored row is returned either way.
  async updateLocation(
    input: UpdateDriverLocationInput,
    tx?: TransactionClient,
    recordedAt: Date = new Date(),
  ): Promise<DriverLocation> {
    const client = tx ?? this.db.client;
    await client.$executeRaw`
      INSERT INTO "driver_locations" (
        "driver_id", "latitude", "longitude", "location", "heading", "bearing",
        "speed_kmh", "accuracy_meters", "is_mock_location", "ride_id", "recorded_at"
      ) VALUES (
        ${input.driverId}::uuid,
        ${new Decimal(input.latitude)}, ${new Decimal(input.longitude)},
        ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography,
        ${input.heading != null ? new Decimal(input.heading) : null},
        ${input.bearing != null ? new Decimal(input.bearing) : null},
        ${input.speedKmh != null ? new Decimal(input.speedKmh) : null},
        ${input.accuracyMeters != null ? new Decimal(input.accuracyMeters) : null},
        ${input.isMockLocation ?? false},
        ${input.rideId ?? null}::uuid,
        ${recordedAt}
      )
      ON CONFLICT ("driver_id") DO UPDATE SET
        "latitude" = EXCLUDED."latitude",
        "longitude" = EXCLUDED."longitude",
        "location" = EXCLUDED."location",
        "heading" = EXCLUDED."heading",
        "bearing" = EXCLUDED."bearing",
        "speed_kmh" = EXCLUDED."speed_kmh",
        "accuracy_meters" = EXCLUDED."accuracy_meters",
        "is_mock_location" = EXCLUDED."is_mock_location",
        "ride_id" = EXCLUDED."ride_id",
        "recorded_at" = EXCLUDED."recorded_at"
      WHERE "driver_locations"."recorded_at" <= EXCLUDED."recorded_at"
    `;
    return client.driverLocation.findUniqueOrThrow({ where: { driverId: input.driverId } });
  }
  async getLocation(driverId: string, tx?: TransactionClient): Promise<DriverLocation | null> {
    const client = tx ?? this.db.client;
    return client.driverLocation.findUnique({
      where: { driverId },
    });
  }
}
