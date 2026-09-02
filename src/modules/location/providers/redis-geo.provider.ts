import type { Redis } from 'ioredis';
import { RedisService } from '@core/cache';
import { geoConfig } from '@config/geo';
import { GeoRedisKeys } from '../constants/geo.constants.js';
import type { DriverPosition, H3Cell } from '../types/geo.types.js';
interface StoredPosition {
  lat: number;
  lng: number;
  h3: string;
  at: number;
}
const WRITE_POSITION = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local prev = cjson.decode(existing)
  if tonumber(prev.at) >= tonumber(ARGV[4]) then
    return 0
  end
  if prev.h3 ~= ARGV[3] then
    redis.call('SREM', 'geo:cell:' .. prev.h3, ARGV[6])
  end
end
redis.call('SET', KEYS[1], cjson.encode({
  lat = tonumber(ARGV[1]), lng = tonumber(ARGV[2]), h3 = ARGV[3], at = tonumber(ARGV[4])
}), 'EX', tonumber(ARGV[5]))
redis.call('SADD', KEYS[2], ARGV[6])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return 1
`;
export class RedisGeoProvider {
  private readonly client: Redis;
  constructor(redisService: RedisService) {
    this.client = redisService.provider.client;
  }
  async setPosition(position: DriverPosition): Promise<boolean> {
    const written = await this.client.eval(
      WRITE_POSITION,
      2,
      GeoRedisKeys.driverPosition(position.driverId),
      GeoRedisKeys.cellMembers(position.h3Cell),
      String(position.latitude),
      String(position.longitude),
      position.h3Cell,
      String(position.updatedAt.getTime()),
      String(geoConfig.liveLocationTtlSeconds),
      position.driverId,
    );
    return written === 1;
  }
  async getPosition(driverId: string): Promise<DriverPosition | null> {
    const raw = await this.client.get(GeoRedisKeys.driverPosition(driverId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredPosition;
    return {
      driverId,
      latitude: stored.lat,
      longitude: stored.lng,
      h3Cell: stored.h3,
      updatedAt: new Date(stored.at),
    };
  }
  async removePosition(driverId: string): Promise<void> {
    const existing = await this.getPosition(driverId);
    const pipeline = this.client.pipeline();
    pipeline.del(GeoRedisKeys.driverPosition(driverId));
    if (existing) pipeline.srem(GeoRedisKeys.cellMembers(existing.h3Cell), driverId);
    await pipeline.exec();
  }
  async driversInCells(cells: readonly H3Cell[]): Promise<string[]> {
    if (cells.length === 0) return [];
    const members = await this.client.sunion(...cells.map(GeoRedisKeys.cellMembers));
    return [...new Set(members)];
  }
  async positionsOf(driverIds: readonly string[]): Promise<DriverPosition[]> {
    if (driverIds.length === 0) return [];
    const raws = await this.client.mget(...driverIds.map(GeoRedisKeys.driverPosition));
    const positions: DriverPosition[] = [];
    raws.forEach((raw, index) => {
      if (!raw) return;
      const stored = JSON.parse(raw) as StoredPosition;
      positions.push({
        driverId: driverIds[index] as string,
        latitude: stored.lat,
        longitude: stored.lng,
        h3Cell: stored.h3,
        updatedAt: new Date(stored.at),
      });
    });
    return positions;
  }
}
