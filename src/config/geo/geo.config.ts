export interface GeoConfig {
  h3Resolution: number;
  searchRadiusMeters: number;
  maxSearchRadiusMeters: number;
  liveLocationTtlSeconds: number;
  candidateStalenessSeconds: number;
  maxCandidates: number;
}
export const geoConfig: GeoConfig = Object.freeze({
  h3Resolution: Number(process.env.GEO_H3_RESOLUTION ?? 8),
  searchRadiusMeters: Number(process.env.GEO_SEARCH_RADIUS_M ?? 3000),
  maxSearchRadiusMeters: Number(process.env.GEO_MAX_SEARCH_RADIUS_M ?? 15000),
  liveLocationTtlSeconds: Number(process.env.GEO_LIVE_LOCATION_TTL_SEC ?? 300),
  candidateStalenessSeconds: Number(process.env.GEO_CANDIDATE_STALENESS_SEC ?? 120),
  maxCandidates: Number(process.env.GEO_MAX_CANDIDATES ?? 50),
});
