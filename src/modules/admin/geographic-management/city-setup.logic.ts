import type { CityCoverageMode } from '../../../generated/prisma/index.js';

export type FareLevel = 'CITY' | 'GLOBAL' | 'NONE';

export interface CitySetupFacts {
  cityId: string;
  cityCode: string;
  hasBoundary: boolean;
  coverageMode: CityCoverageMode;
  activeCoverageZones: number;
  restrictedBlockingNothing: Array<{ id: string; code: string }>;
  zonesOutsideArea: string[];
  fares: Array<{ code: string; name: string; level: FareLevel }>;
}

export interface SetupIssue {
  code:
    | 'NO_BOUNDARY'
    | 'ZONES_ONLY_NO_ZONES'
    | 'RESTRICTED_BLOCKS_NOTHING'
    | 'NO_FARE'
    | 'GLOBAL_FARE_ONLY'
    | 'ZONE_OUTSIDE_AREA';
  /// RED stops a city being turned on. AMBER is worth a look but does not.
  severity: 'RED' | 'AMBER';
  message: string;
  /// The admin screen that fixes it.
  href: string;
}

/// What is wrong with a city's setup, worst first.
export function citySetupIssues(facts: CitySetupFacts): SetupIssue[] {
  const cityHref = `/geographic-management/cities/${facts.cityId}`;
  const fareHref = `/pricing-management/fare-rules/new?cityCode=${facts.cityCode}`;
  const names = (level: FareLevel) =>
    facts.fares.filter((fare) => fare.level === level).map((fare) => fare.name);
  const issues: SetupIssue[] = [];

  if (!facts.hasBoundary) {
    issues.push({
      code: 'NO_BOUNDARY',
      severity: 'RED',
      message: 'This city has no Operating Area.',
      href: cityHref,
    });
  }
  if (facts.coverageMode === 'ZONES_ONLY' && facts.activeCoverageZones === 0) {
    issues.push({
      code: 'ZONES_ONLY_NO_ZONES',
      severity: 'RED',
      message: 'Rides can only start inside zones here, but this city has no active zone.',
      href: cityHref,
    });
  }
  const [firstRestricted] = facts.restrictedBlockingNothing;
  if (firstRestricted) {
    const codes = facts.restrictedBlockingNothing.map((zone) => zone.code).join(', ');
    issues.push({
      code: 'RESTRICTED_BLOCKS_NOTHING',
      severity: 'RED',
      message: `These restricted zones block nothing: ${codes}.`,
      href: `/geographic-management/service-zones/${firstRestricted.id}`,
    });
  }
  const noFare = names('NONE');
  if (noFare.length > 0) {
    issues.push({
      code: 'NO_FARE',
      severity: 'RED',
      message: `No fare for: ${noFare.join(', ')}.`,
      href: fareHref,
    });
  }
  const globalFare = names('GLOBAL');
  if (globalFare.length > 0) {
    issues.push({
      code: 'GLOBAL_FARE_ONLY',
      severity: 'AMBER',
      message: `Using the global fare, not one set for this city: ${globalFare.join(', ')}.`,
      href: fareHref,
    });
  }
  if (facts.zonesOutsideArea.length > 0) {
    issues.push({
      code: 'ZONE_OUTSIDE_AREA',
      severity: 'AMBER',
      message: `These zones are outside the Operating Area, so they never apply: ${facts.zonesOutsideArea.join(', ')}.`,
      href: cityHref,
    });
  }
  return issues;
}
