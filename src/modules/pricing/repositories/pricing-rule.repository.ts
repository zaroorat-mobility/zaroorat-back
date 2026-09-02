import type { ProviderClient } from '@core/database/index.js';
import { GeographicCoverageService } from '@modules/location';
import type { Prisma, PricingRule, RideServiceType } from '../../../generated/prisma/index.js';

/// The effective-window predicate, in one place.
///
/// It used to live in a shared `inForce()` helper. The merge at `703a76f` replaced
/// `findActiveRule` with a delegation to `findBestActiveRule`, which never had it,
/// and the follow-up commit — titled "restore missing inforce logic from merge
/// conflict" — restored it inline into `findGlobalRules` only. The helper was
/// deleted, one of the two call paths was left without a window, and three
/// committed tests have been red ever since: a future-dated rate card sorted
/// ahead of the current one under `effectiveFrom desc` and applied the moment it
/// was written, while a retired one kept pricing rides.
///
/// Exported so both callers demonstrably share it and the next merge cannot drop
/// it from one of them again.
export function inForce(now: Date): Prisma.PricingRuleWhereInput {
  return {
    isActive: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };
}

export interface FindBestActiveRuleParams {
  vehicleTypeId: string;
  cityCode?: string | undefined;
  serviceType?: RideServiceType | undefined;
  pickupLat?: number | undefined;
  pickupLng?: number | undefined;
}

export class PricingRuleRepository {
  constructor(
    private readonly db: { client: ProviderClient },
    private readonly geographicCoverageService: GeographicCoverageService,
  ) {}

  /// FR-002. The exact rule a quote was priced on, re-read at completion so the
  /// bill reproduces the quote instead of resolving a fresh card against a
  /// context the completion path never had.
  async findById(id: string): Promise<PricingRule | null> {
    return this.db.client.pricingRule.findUnique({ where: { id } });
  }

  /** @deprecated Prefer findBestActiveRule */
  async findActiveRule(vehicleTypeId: string, cityCode: string): Promise<PricingRule | null> {
    return this.findBestActiveRule({ vehicleTypeId, cityCode, serviceType: 'INSTANT' });
  }

  async findBestActiveRule(params: FindBestActiveRuleParams): Promise<PricingRule | null> {
    const serviceType = params.serviceType ?? 'INSTANT';
    const now = new Date();
    let resolvedZoneId: string | null = null;
    if (
      params.cityCode &&
      params.cityCode !== 'GLOBAL' &&
      params.pickupLat != null &&
      params.pickupLng != null
    ) {
      // FR-004. There were two resolvers with different answers. This one took
      // the oldest zone of *any* type, `RESTRICTED` included, so pricing could
      // bind a fare to a zone the coverage check had already refused for pickup.
      // `GeographicCoverageService` is now the only definition of "the zone this
      // point is in", and it filters to SERVICE/AIRPORT and honours the explicit
      // precedence FR-005 adds.
      resolvedZoneId = await this.geographicCoverageService.resolveServiceZoneIdAtPoint(
        params.cityCode,
        params.pickupLat,
        params.pickupLng,
      );
    }

    const cityCodes =
      params.cityCode && params.cityCode !== 'GLOBAL' ? [params.cityCode, 'GLOBAL'] : ['GLOBAL'];

    // One query for both city tiers rather than one per tier, and the precedence
    // ladder shared with the batched catalog lookup so the two cannot disagree.
    const candidates = await this.db.client.pricingRule.findMany({
      where: {
        vehicleTypeId: params.vehicleTypeId,
        cityCode: { in: cityCodes },
        ...inForce(now),
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    return this.pickByPrecedence(candidates, cityCodes, resolvedZoneId, serviceType);
  }

  /// FR-041. Every category's rule for one pickup point, resolved the way
  /// `findBestActiveRule` resolves a single one — but with the zone looked up
  /// once and the candidate rules fetched in one query rather than per category.
  ///
  /// The point does not change between a bike and a premium cab, so doing this
  /// per type would re-run the same PostGIS containment query once per row in the
  /// catalog. That is the shape of the defect FR-039 exists to remove from the
  /// quote loop; there is no reason to add a second instance of it here.
  async findBestActiveRulesForPoint(params: {
    vehicleTypeIds: readonly string[];
    cityCode?: string | undefined;
    serviceType?: RideServiceType | undefined;
    pickupLat: number;
    pickupLng: number;
  }): Promise<Map<string, PricingRule>> {
    if (params.vehicleTypeIds.length === 0) return new Map();
    const serviceType = params.serviceType ?? 'INSTANT';
    const now = new Date();

    let resolvedZoneId: string | null = null;
    if (params.cityCode && params.cityCode !== 'GLOBAL') {
      resolvedZoneId = await this.geographicCoverageService.resolveServiceZoneIdAtPoint(
        params.cityCode,
        params.pickupLat,
        params.pickupLng,
      );
    }

    const cityCodes =
      params.cityCode && params.cityCode !== 'GLOBAL' ? [params.cityCode, 'GLOBAL'] : ['GLOBAL'];

    const candidates = await this.db.client.pricingRule.findMany({
      where: {
        vehicleTypeId: { in: [...params.vehicleTypeIds] },
        cityCode: { in: cityCodes },
        ...inForce(now),
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    const resolved = new Map<string, PricingRule>();
    for (const vehicleTypeId of params.vehicleTypeIds) {
      const mine = candidates.filter((row) => row.vehicleTypeId === vehicleTypeId);
      const match = this.pickByPrecedence(mine, cityCodes, resolvedZoneId, serviceType);
      if (match) resolved.set(vehicleTypeId, match);
    }
    return resolved;
  }

  /// The single precedence ladder both lookups walk: city before GLOBAL, and
  /// within a city, zone+service before zone before service before neither.
  /// Shared so the batched catalog path and the per-ride path cannot drift into
  /// answering the same question differently — which is exactly how the catalog
  /// came to advertise a rate the quote did not charge.
  private pickByPrecedence(
    rules: readonly PricingRule[],
    cityCodes: readonly string[],
    resolvedZoneId: string | null,
    serviceType: RideServiceType,
  ): PricingRule | null {
    for (const cityCode of cityCodes) {
      const inCity = rules.filter((row) => row.cityCode === cityCode);
      const tries: Array<{ zoneId: string | null; svc: RideServiceType | null }> = [];
      if (resolvedZoneId) {
        tries.push({ zoneId: resolvedZoneId, svc: serviceType });
        tries.push({ zoneId: resolvedZoneId, svc: null });
      }
      tries.push({ zoneId: null, svc: serviceType });
      tries.push({ zoneId: null, svc: null });

      for (const attempt of tries) {
        const match = inCity.find(
          (row) =>
            (row.serviceZoneId ?? null) === attempt.zoneId &&
            (row.serviceType ?? null) === attempt.svc,
        );
        if (match) return match;
      }
    }
    return null;
  }

  /// Every category's fallback rule in one query, for the catalog endpoint.
  /// One call per type would be an N+1 on the first screen the customer app
  /// loads, and `findManyByIds` already exists on the vehicle side for the same
  /// reason.
  ///
  /// Newest `effectiveFrom` wins, matching `findActiveRule`: the rows arrive
  /// oldest-first so a later one overwrites its predecessor in the map.
  async findGlobalRules(
    vehicleTypeIds: readonly string[],
    cityCode: string,
  ): Promise<Map<string, PricingRule>> {
    if (vehicleTypeIds.length === 0) return new Map();
    const rules = await this.db.client.pricingRule.findMany({
      where: {
        vehicleTypeId: { in: [...vehicleTypeIds] },
        cityCode,
        ...inForce(new Date()),
      },
      orderBy: { effectiveFrom: 'asc' },
    });
    return new Map(rules.map((rule) => [rule.vehicleTypeId, rule]));
  }
}
