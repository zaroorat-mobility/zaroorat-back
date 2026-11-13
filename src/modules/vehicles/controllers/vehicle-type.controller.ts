import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PricingRateCard } from '@config';
import { PricingService } from '@modules/pricing';
import { GeographicCoverageService } from '@modules/location';
import { VehicleTypeService } from '../services/vehicle-type.service.js';
import type { VehicleType } from '../types/index.js';

export interface VehicleTypeView {
  id: string;
  code: string;
  name: string;
  category: string;
  hasAc: boolean;
  badge: string | null;
  description: string | null;
  imageUrl: string | null;
  imageFileId: string | null;
  icon: string | null;
  displayOrder: number;
  passengerCapacity: number | null;
  luggageCapacity: number | null;
  baseFare: number | null;
  perKmRate: number | null;
  perMinuteRate: number | null;
  minimumFare: number | null;
  isActive: boolean;
}

/// Decimal columns are serialized as numbers rather than Prisma Decimal
/// instances, which stringify as objects through the JSON schema.
///
/// `rateCard` is optional only because the two callers get it differently — the
/// catalog batches one lookup for every category, the quote already holds the
/// card it priced with. Omitting it leaves the four fare fields null, which the
/// published response schema allows.
export function toVehicleTypeView(
  vehicleType: VehicleType & {
    category?: string;
    hasAc?: boolean;
    badge?: string | null;
    description?: string | null;
    imageUrl?: string | null;
    imageFileId?: string | null;
  },
  rateCard?: PricingRateCard,
): VehicleTypeView {
  const fileId = vehicleType.imageFileId ?? null;
  const directUrl = vehicleType.imageUrl ?? null;
  let resolvedFileId = fileId;
  if (!resolvedFileId && directUrl && typeof directUrl === 'string') {
    const match = directUrl.match(/vehicles\/([0-9a-fA-F-]{36})/);
    if (match) {
      resolvedFileId = match[1];
    }
  }

  // If directUrl is already a direct https:// S3/CDN URL, preserve it so clients download directly.
  // Otherwise use the public backend proxy endpoint if a fileId exists.
  const isDirectRemote = directUrl && /^https?:\/\//i.test(directUrl);
  const resolvedImageUrl = isDirectRemote
    ? directUrl
    : (resolvedFileId ? `/api/v1/vehicle-types/images/${resolvedFileId}` : directUrl || null);

  let resolvedIcon = vehicleType.icon ?? null;
  if (resolvedIcon && typeof resolvedIcon === 'string') {
    // If the icon contains a file UUID (either in an S3 presigned URL or relative path),
    // always resolve to the permanent public proxy endpoint to prevent S3 expiration.
    const iconMatch = resolvedIcon.match(/([0-9a-fA-F-]{36})/);
    if (iconMatch && !resolvedIcon.startsWith('/api/v1/vehicle-types/images/')) {
      resolvedIcon = `/api/v1/vehicle-types/images/${iconMatch[1]}`;
    }
  }

  return {
    id: vehicleType.id,
    code: vehicleType.code,
    name: vehicleType.name,
    category: vehicleType.category ?? 'car',
    hasAc: vehicleType.hasAc ?? false,
    badge: vehicleType.badge ?? null,
    description: vehicleType.description ?? null,
    imageUrl: resolvedImageUrl,
    imageFileId: fileId,
    icon: resolvedIcon,
    displayOrder: vehicleType.displayOrder,
    passengerCapacity: vehicleType.passengerCapacity,
    luggageCapacity: vehicleType.luggageCapacity,
    baseFare: rateCard?.baseFare ?? null,
    perKmRate: rateCard?.perKm ?? null,
    perMinuteRate: rateCard?.perMinute ?? null,
    minimumFare: rateCard?.minimumFare ?? null,
    isActive: vehicleType.isActive,
  };
}

export class VehicleTypeController {
  constructor(
    private readonly vehicleTypeService: VehicleTypeService,
    private readonly pricingService: PricingService,
    private readonly geographicCoverageService: GeographicCoverageService,
  ) {}

  /// The catalog the customer app renders its category picker from, and the
  /// only sanctioned way any client obtains a `vehicleTypeId`.
  ///
  /// The fare fields have been in this endpoint's published response schema all
  /// along and were never populated: pricing moved from `VehicleType` onto
  /// `PricingRule` and the view was not moved with it, so `/docs` advertised a
  /// `perKmRate` that every response omitted.
  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { cityId, lat, lng } = (req.query ?? {}) as {
      cityId?: string;
      lat?: number;
      lng?: number;
    };
    const types = await this.vehicleTypeService.listActive(cityId !== undefined ? { cityId } : {});

    // FR-041 / BD-9. With a pickup point the catalog resolves exactly what the
    // quote will: the city that owns the point, then that city's zone rules.
    // Without one it can only reach the GLOBAL card, which is what advertised a
    // price the quote did not charge — so it publishes no rate figure instead.
    if (lat === undefined || lng === undefined) {
      reply.send({ data: types.map((type) => toVehicleTypeView(type)) });
      return;
    }

    const city = await this.geographicCoverageService.resolveCityAtPoint(lat, lng);
    const rateCards = await this.pricingService.rateCardsForPoint({
      vehicleTypeIds: types.map((type) => type.id),
      ...(city?.code !== undefined ? { cityCode: city.code } : {}),
      pickupLat: lat,
      pickupLng: lng,
    });
    reply.send({ data: types.map((type) => toVehicleTypeView(type, rateCards.get(type.id))) });
  }

  /// Public permanent asset streaming / redirect endpoint for mobile apps and browsers.
  /// Bypasses authorization requirements, sets 7-day browser/device caching headers,
  /// proxies image bytes directly with HTTP 200 (avoiding Android OkHttp redirect blocks),
  /// and falls back to a fresh S3 redirect.
  async serveVehicleImage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { fileId } = (req.params ?? {}) as { fileId?: string };
    if (!fileId) {
      reply.status(400).send({ message: 'Missing fileId parameter' });
      return;
    }

    const downloadUrl = await this.vehicleTypeService.getImageReadUrl(fileId);
    if (!downloadUrl) {
      reply.status(404).send({ message: 'Vehicle image not found' });
      return;
    }

    // High performance device caching: cached for 7 days with stale-while-revalidate
    reply.header('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Access-Control-Allow-Origin', '*');

    // Attempt to stream image buffer directly to guarantee HTTP 200 without cross-protocol redirect issues
    try {
      const response = await fetch(downloadUrl);
      if (response.ok) {
        const contentType = response.headers.get('content-type') || 'image/png';
        const arrayBuffer = await response.arrayBuffer();
        reply.header('Content-Type', contentType);
        reply.send(Buffer.from(arrayBuffer));
        return;
      }
    } catch {
      // Fallback to redirect if proxy fetch fails
    }

    reply.redirect(downloadUrl);
  }
}
