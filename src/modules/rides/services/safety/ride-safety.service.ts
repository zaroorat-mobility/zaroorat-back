import { randomBytes } from 'node:crypto';
import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import { GeoService } from '@modules/location';
import { rideConfig } from '@config';
import { RideRepository } from '../../repositories/ride.repository.js';
import {
  RideNotFoundError,
  RideCustomerMismatchError,
  RideNotShareableError,
  ShareLinkNotFoundError,
  SosNotAllowedError,
} from '../../errors/ride.errors.js';
import { rideEvent, RIDE_EVENT_CATALOG } from '../../events/catalog.js';
import { LIVE_RIDE_STATUSES } from '../../constants/ride.constants.js';
import { rideParty, ridePartyIds } from '../../types/ride-party.js';
import { toClientRideView } from '../../presenters/ride-client.presenter.js';
import type { Ride } from '../../types';

const OPEN_INCIDENT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'] as const;

export interface SosInput {
  latitude?: number;
  longitude?: number;
  locationAddress?: string;
  description?: string;
}

function isLive(status: string): boolean {
  return (LIVE_RIDE_STATUSES as readonly string[]).includes(status);
}

export class RideSafetyService {
  constructor(
    private readonly rideRepo: RideRepository,
    private readonly txManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly geoService: GeoService,
  ) {}

  /// Either party may raise it. A second press while an incident is still open
  /// returns that incident instead of opening another, so a panicked rider
  /// hammering the button does not flood the ops queue.
  async triggerSos(rideId: string, userId: string, input: SosInput) {
    const ride = await this.rideRepo.findById(rideId);
    if (!ride) throw new RideNotFoundError(rideId);
    const party = rideParty(userId, ride);
    if (!party) throw new RideCustomerMismatchError(rideId);
    if (!isLive(ride.status)) throw new SosNotAllowedError(ride.status);
    const { customerId, driverUserId } = ridePartyIds(ride);
    const subjectUserId = party === 'CUSTOMER' ? driverUserId : customerId;

    return this.txManager.execute(async (tx) => {
      const existing = await tx.safetyIncident.findFirst({
        where: {
          rideId,
          reporterUserId: userId,
          type: 'SOS',
          status: { in: [...OPEN_INCIDENT_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        return {
          incidentId: existing.id,
          incidentNumber: existing.incidentNumber,
          status: existing.status,
          rideId,
          createdAt: existing.createdAt.toISOString(),
          alreadyOpen: true,
        };
      }
      const incident = await tx.safetyIncident.create({
        data: {
          incidentNumber: `SOS-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`,
          type: 'SOS',
          severity: 'CRITICAL',
          status: 'OPEN',
          rideId,
          reporterUserId: userId,
          subjectUserId,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          locationAddress: input.locationAddress ?? null,
          description: input.description ?? null,
        },
      });
      await tx.safetyIncidentEvent.create({
        data: {
          incidentId: incident.id,
          eventType: 'TRIGGERED',
          actorId: userId,
          notes: `SOS raised by ${party.toLowerCase()} during ride`,
          metadata: {
            rideStatus: ride.status,
            reporterRole: party,
            latitude: incident.latitude,
            longitude: incident.longitude,
          },
        },
      });
      await this.eventPublisher.publish(
        rideEvent(RIDE_EVENT_CATALOG.SOS_TRIGGERED, rideId, {
          rideId,
          incidentId: incident.id,
          incidentNumber: incident.incidentNumber,
          reporterUserId: userId,
          reporterRole: party,
          subjectUserId,
          latitude: incident.latitude,
          longitude: incident.longitude,
        }),
        tx,
      );
      return {
        incidentId: incident.id,
        incidentNumber: incident.incidentNumber,
        status: incident.status,
        rideId,
        createdAt: incident.createdAt.toISOString(),
        alreadyOpen: false,
      };
    });
  }

  /// Reuses the rider's still-valid link for this ride rather than minting a
  /// new one on every tap of "share".
  async createShareLink(rideId: string, customerId: string) {
    const ride = await this.rideRepo.findById(rideId);
    if (!ride) throw new RideNotFoundError(rideId);
    if (ride.customerId !== customerId) throw new RideCustomerMismatchError(rideId);
    if (!isLive(ride.status)) throw new RideNotShareableError(ride.status);

    return this.txManager.execute(async (tx) => {
      const now = new Date();
      const existing = await tx.rideShareToken.findFirst({
        where: { rideId, createdBy: customerId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { expiresAt: 'desc' },
      });
      const row =
        existing ??
        (await tx.rideShareToken.create({
          data: {
            token: randomBytes(24).toString('base64url'),
            rideId,
            createdBy: customerId,
            expiresAt: new Date(now.getTime() + rideConfig.shareTokenTtlHours * 60 * 60 * 1000),
          },
        }));
      return {
        token: row.token,
        url: `${rideConfig.shareBaseUrl}/${row.token}`,
        expiresAt: row.expiresAt.toISOString(),
      };
    });
  }

  /// Unauthenticated. Deliberately narrow: no phone numbers, no rider identity,
  /// no fare — only what someone tracking the trip needs to see.
  async getSharedRide(token: string) {
    const row = await this.txManager.execute((tx) =>
      tx.rideShareToken.findUnique({ where: { token } }),
    );
    if (!row || row.revokedAt || row.expiresAt <= new Date()) {
      throw new ShareLinkNotFoundError();
    }
    const ride = await this.rideRepo.findById(row.rideId);
    if (!ride) throw new ShareLinkNotFoundError();
    return this.toSharedView(ride, row.expiresAt);
  }

  private async toSharedView(ride: Ride, expiresAt: Date) {
    const view = toClientRideView(ride) as {
      status: string;
      pickupAddress: string | null;
      dropAddress: string | null;
      pickupLat: number | null;
      pickupLng: number | null;
      dropLat: number | null;
      dropLng: number | null;
      startedAt: Date | null;
      completedAt: Date | null;
      driver: { rating: number | null; profile: { firstName: string | null } } | null;
      vehicle: {
        registrationNumber: string | null;
        color: string | null;
        make: string | null;
        model: string | null;
      } | null;
      vehicleType: { name: string } | null;
    };
    const live = isLive(ride.status);
    const position = live ? await this.geoService.liveDriverPosition(ride.driverId) : null;
    return {
      status: view.status,
      isLive: live,
      pickup: { address: view.pickupAddress, latitude: view.pickupLat, longitude: view.pickupLng },
      drop: { address: view.dropAddress, latitude: view.dropLat, longitude: view.dropLng },
      startedAt: view.startedAt,
      completedAt: view.completedAt,
      driver: view.driver
        ? { firstName: view.driver.profile.firstName, rating: view.driver.rating }
        : null,
      vehicle: view.vehicle
        ? {
            registrationNumber: view.vehicle.registrationNumber,
            color: view.vehicle.color,
            make: view.vehicle.make,
            model: view.vehicle.model,
            type: view.vehicleType?.name ?? null,
          }
        : null,
      driverLocation: position
        ? {
            latitude: position.latitude,
            longitude: position.longitude,
            recordedAt: position.updatedAt ?? null,
          }
        : null,
      linkExpiresAt: expiresAt.toISOString(),
    };
  }
}
