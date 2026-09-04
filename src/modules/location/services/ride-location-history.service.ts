import { DatabaseService } from '@core/database';
import { geoConfig } from '@config';

export interface RideLocationPointInput {
  rideId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  heading?: number | null;
  speedKmh?: number | null;
  accuracyMeters?: number | null;
  fixId: string;
  sequence?: number | null;
  recordedAt: Date;
}

export class RideLocationHistoryService {
  constructor(private readonly db: DatabaseService) {}

  async recordPoint(input: RideLocationPointInput): Promise<boolean> {
    const existing = await this.db.client.rideLocationPoint.findFirst({
      where: { rideId: input.rideId, fixId: input.fixId },
      select: { id: true },
    });
    if (existing) return false;

    await this.db.client.$executeRaw`
      INSERT INTO "ride_location_points" (
        "id", "ride_id", "driver_id", "latitude", "longitude", "location",
        "heading", "speed_kmh", "accuracy_meters", "fix_id", "sequence",
        "recorded_at", "received_at"
      ) VALUES (
        gen_random_uuid(), ${input.rideId}::uuid, ${input.driverId}::uuid,
        ${input.latitude}, ${input.longitude},
        ST_SetSRID(ST_MakePoint(${input.longitude}, ${input.latitude}), 4326)::geography,
        ${input.heading ?? null}, ${input.speedKmh ?? null}, ${input.accuracyMeters ?? null},
        ${input.fixId}, ${input.sequence ?? null},
        ${input.recordedAt}, now()
      )
    `;
    return true;
  }

  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - geoConfig.rideLocationRetentionDays * 86_400_000);
    const result = await this.db.client.rideLocationPoint.deleteMany({
      where: { recordedAt: { lt: cutoff } },
    });
    return result.count;
  }
}
