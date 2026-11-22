import { SCOPE_GLOBAL_CITY, SCOPE_NIL_UUID } from '../constants.js';

export type ConfigScopeLevel =
  | 'GLOBAL'
  | 'GLOBAL_VEHICLE'
  | 'CITY'
  | 'CITY_VEHICLE'
  | 'ZONE'
  | 'ZONE_VEHICLE';

export interface ScopeTupleInput {
  cityCode?: string | null | undefined;
  serviceZoneId?: string | null | undefined;
  vehicleTypeId?: string | null | undefined;
}

export interface NormalizedScopeTuple {
  scopeLevel: ConfigScopeLevel;
  cityCode: string;
  serviceZoneId: string;
  vehicleTypeId: string;
}

const SCOPE_PRIORITY: Record<ConfigScopeLevel, number> = {
  ZONE_VEHICLE: 6,
  ZONE: 5,
  CITY_VEHICLE: 4,
  CITY: 3,
  GLOBAL_VEHICLE: 2,
  GLOBAL: 1,
};

/// Normalizes optional (cityCode, serviceZoneId, vehicleTypeId) into the strict
/// 6-tier sentinel representation enforced by M-03/M-04a/M-04b CHECK constraints.
export function normalizeScopeTuple(input: ScopeTupleInput): NormalizedScopeTuple {
  const rawCity = input.cityCode?.trim();
  const hasCity = Boolean(rawCity && rawCity !== 'GLOBAL' && rawCity !== SCOPE_GLOBAL_CITY);
  const hasZone = Boolean(input.serviceZoneId && input.serviceZoneId !== SCOPE_NIL_UUID);
  const hasVehicle = Boolean(input.vehicleTypeId && input.vehicleTypeId !== SCOPE_NIL_UUID);

  if (hasZone && !hasCity) {
    throw new Error('A zone-scoped configuration requires a non-global cityCode');
  }

  const cityCode = hasCity ? rawCity! : SCOPE_GLOBAL_CITY;
  const serviceZoneId = hasZone ? input.serviceZoneId! : SCOPE_NIL_UUID;
  const vehicleTypeId = hasVehicle ? input.vehicleTypeId! : SCOPE_NIL_UUID;

  let scopeLevel: ConfigScopeLevel;
  if (hasZone && hasVehicle) scopeLevel = 'ZONE_VEHICLE';
  else if (hasZone) scopeLevel = 'ZONE';
  else if (hasCity && hasVehicle) scopeLevel = 'CITY_VEHICLE';
  else if (hasCity) scopeLevel = 'CITY';
  else if (hasVehicle) scopeLevel = 'GLOBAL_VEHICLE';
  else scopeLevel = 'GLOBAL';

  return { scopeLevel, cityCode, serviceZoneId, vehicleTypeId };
}

export function scopeLevelPriority(level: string): number {
  return SCOPE_PRIORITY[level as ConfigScopeLevel] ?? 0;
}

export function scopeTupleKey(tuple: {
  cityCode: string;
  serviceZoneId: string;
  vehicleTypeId: string;
}): string {
  return `${tuple.cityCode}|${tuple.serviceZoneId}|${tuple.vehicleTypeId}`;
}

/// Builds the 6-tier candidate OR filter for Prisma scope lookups at runtime.
export function buildScopeLookupCandidates(ctx: {
  cityCode?: string | null;
  serviceZoneId?: string | null;
  vehicleTypeId?: string | null;
}): Array<{ cityCode: string; serviceZoneId: string; vehicleTypeId: string }> {
  const city =
    ctx.cityCode && ctx.cityCode !== 'GLOBAL' && ctx.cityCode !== SCOPE_GLOBAL_CITY
      ? ctx.cityCode
      : null;
  const zone = ctx.serviceZoneId && ctx.serviceZoneId !== SCOPE_NIL_UUID ? ctx.serviceZoneId : null;
  const veh = ctx.vehicleTypeId && ctx.vehicleTypeId !== SCOPE_NIL_UUID ? ctx.vehicleTypeId : null;

  const tuples: Array<{ cityCode: string; serviceZoneId: string; vehicleTypeId: string }> = [
    { cityCode: SCOPE_GLOBAL_CITY, serviceZoneId: SCOPE_NIL_UUID, vehicleTypeId: SCOPE_NIL_UUID },
  ];

  if (veh) {
    tuples.push({
      cityCode: SCOPE_GLOBAL_CITY,
      serviceZoneId: SCOPE_NIL_UUID,
      vehicleTypeId: veh,
    });
  }
  if (city) {
    tuples.push({ cityCode: city, serviceZoneId: SCOPE_NIL_UUID, vehicleTypeId: SCOPE_NIL_UUID });
    if (veh) {
      tuples.push({ cityCode: city, serviceZoneId: SCOPE_NIL_UUID, vehicleTypeId: veh });
    }
    if (zone) {
      tuples.push({ cityCode: city, serviceZoneId: zone, vehicleTypeId: SCOPE_NIL_UUID });
      if (veh) {
        tuples.push({ cityCode: city, serviceZoneId: zone, vehicleTypeId: veh });
      }
    }
  }

  return tuples;
}

/// Deterministic 6-tier winner selection: highest scope specificity, then latest effectiveFrom, then id.
export function pickWinningScope<
  T extends { id: string; scopeLevel: string; effectiveFrom: Date },
>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    const prioDiff = scopeLevelPriority(b.scopeLevel) - scopeLevelPriority(a.scopeLevel);
    if (prioDiff !== 0) return prioDiff;
    const effDiff = b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
    if (effDiff !== 0) return effDiff;
    return b.id.localeCompare(a.id);
  });
  return sorted[0]!;
}
