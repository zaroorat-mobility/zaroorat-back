import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocationStreamService } from '../../src/modules/realtime/location-stream.service.js';
import { RideEtaService } from '../../src/modules/location/services/ride-eta.service.js';
import { toClientRideView } from '../../src/modules/rides/presenters/ride-client.presenter.js';
import type { SocketPrincipal } from '../../src/modules/realtime/socket-auth.service.js';
import type { Coordinate } from '../../src/modules/location/types/geo.types.js';

const DRIVER: SocketPrincipal = {
  userId: 'user_drv',
  sid: 's',
  epoch: 1,
  roles: ['driver'],
  driverId: 'drv_1',
};

const PICKUP = { lat: 12.9716, lng: 77.5946 };
const DROP = { lat: 13.0827, lng: 80.2707 };

describe('Customer route geometry & dynamic ETA streaming', () => {
  it('calculates ETA to pickup before trip start and emits destinationType: PICKUP', async () => {
    let capturedDestination: Coordinate | null = null;
    let capturedType: string | null = null;

    const mockEtaService = {
      async refreshEta(input: {
        destination: Coordinate;
        destinationType?: 'PICKUP' | 'DROP';
        rideId: string;
      }) {
        capturedDestination = input.destination;
        capturedType = input.destinationType ?? null;
        return {
          rideId: input.rideId,
          destinationType: input.destinationType ?? 'PICKUP',
          remainingDistanceMeters: 1200,
          remainingDurationSeconds: 240,
          providerName: 'mock_maps',
          stale: false,
          computedAt: new Date().toISOString(),
        };
      },
      forget: () => {},
    };

    const mockRideRepo = {
      async findActiveByDriver(_driverId: string) {
        return {
          id: 'ride-123',
          status: 'DRIVER_ARRIVING',
          request: {
            pickupLat: PICKUP.lat,
            pickupLng: PICKUP.lng,
            dropLat: DROP.lat,
            dropLng: DROP.lng,
          },
        };
      },
    };

    const service = new LocationStreamService(
      { updateLocation: async () => {} } as never,
      mockRideRepo as never,
      { recordPoint: async () => false } as never,
      mockEtaService as never,
    );

    const result = await service.accept(DRIVER, { latitude: 12.97, longitude: 77.59 });

    assert.ok(result.etaEnvelope, 'Must produce an ETA envelope');
    assert.equal(capturedType, 'PICKUP', 'Before start, ETA destination must be PICKUP');
    const pickupDest = capturedDestination as Coordinate | null;
    assert.ok(pickupDest);
    assert.equal(pickupDest.latitude, PICKUP.lat);
    assert.equal(pickupDest.longitude, PICKUP.lng);
    assert.equal(result.etaEnvelope?.type, 'ride.eta.updated');
    assert.equal(result.etaEnvelope?.data.destinationType, 'PICKUP');
    assert.equal(result.etaEnvelope?.data.remainingDistanceMeters, 1200);
    assert.equal(result.etaEnvelope?.data.remainingDurationSeconds, 240);
  });

  it('calculates ETA to drop after trip start and emits destinationType: DROP', async () => {
    let capturedDestination: Coordinate | null = null;
    let capturedType: string | null = null;

    const mockEtaService = {
      async refreshEta(input: {
        destination: Coordinate;
        destinationType?: 'PICKUP' | 'DROP';
        rideId: string;
      }) {
        capturedDestination = input.destination;
        capturedType = input.destinationType ?? null;
        return {
          rideId: input.rideId,
          destinationType: input.destinationType ?? 'DROP',
          remainingDistanceMeters: 5400,
          remainingDurationSeconds: 780,
          providerName: 'mock_maps',
          stale: false,
          computedAt: new Date().toISOString(),
        };
      },
      forget: () => {},
    };

    const mockRideRepo = {
      async findActiveByDriver(_driverId: string) {
        return {
          id: 'ride-123',
          status: 'IN_PROGRESS',
          request: {
            pickupLat: PICKUP.lat,
            pickupLng: PICKUP.lng,
            dropLat: DROP.lat,
            dropLng: DROP.lng,
          },
        };
      },
    };

    const service = new LocationStreamService(
      { updateLocation: async () => {} } as never,
      mockRideRepo as never,
      { recordPoint: async () => false } as never,
      mockEtaService as never,
    );

    const result = await service.accept(DRIVER, { latitude: 12.975, longitude: 77.6 });

    assert.ok(result.etaEnvelope, 'Must produce an ETA envelope');
    assert.equal(capturedType, 'DROP', 'After trip start, ETA destination must be DROP');
    const dropDest = capturedDestination as Coordinate | null;
    assert.ok(dropDest);
    assert.equal(dropDest.latitude, DROP.lat);
    assert.equal(dropDest.longitude, DROP.lng);
    assert.equal(result.etaEnvelope?.data.destinationType, 'DROP');
    assert.equal(result.etaEnvelope?.data.remainingDistanceMeters, 5400);
  });

  it('RideEtaService refreshes when destinationType transitions from PICKUP to DROP', async () => {
    let directionsCalls = 0;
    const mockMapProviderService = {
      async getDirections(_origin: Coordinate, _destination: Coordinate) {
        directionsCalls++;
        return {
          distanceMeters: 2500,
          durationSeconds: 300,
          providerName: 'test-map',
        };
      },
    };

    const etaService = new RideEtaService(mockMapProviderService as never);

    // Call 1: PICKUP
    const first = await etaService.refreshEta({
      rideId: 'ride-456',
      driverPosition: { latitude: 12.97, longitude: 77.59 },
      destination: { latitude: PICKUP.lat, longitude: PICKUP.lng },
      destinationType: 'PICKUP',
    });
    assert.equal(first?.destinationType, 'PICKUP');
    assert.equal(directionsCalls, 1);

    // Call 2: DROP with same driver position immediately.
    // Must NOT return cached PICKUP snapshot — must recompute for DROP!
    const second = await etaService.refreshEta({
      rideId: 'ride-456',
      driverPosition: { latitude: 12.97, longitude: 77.59 },
      destination: { latitude: DROP.lat, longitude: DROP.lng },
      destinationType: 'DROP',
    });
    assert.equal(second?.destinationType, 'DROP');
    assert.equal(directionsCalls, 2, 'Transition to DROP must bypass stale PICKUP cache');
  });

  it('normalizes client ride view with decoded route path and ETA snapshot', () => {
    const samplePolyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const ride = {
      id: 'ride-789',
      rideCode: 'ZR-1234',
      status: 'IN_PROGRESS',
      routePlan: {
        encodedPolyline: samplePolyline,
      },
      request: {
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 13.0827,
        dropLng: 80.2707,
        quotedFare: 250,
        boostAmount: 50,
      },
      fare: {
        totalFare: 300,
      },
    };

    const etaSnapshot = {
      rideId: 'ride-789',
      destinationType: 'DROP' as const,
      remainingDistanceMeters: 3200,
      remainingDurationSeconds: 420,
      providerName: 'google',
      stale: false,
      computedAt: '2026-10-15T12:00:00.000Z',
    };

    const clientView = toClientRideView(ride as never, etaSnapshot);
    assert.ok(clientView);
    assert.equal(clientView.routeAvailable, true);
    assert.ok(Array.isArray(clientView.routePath));
    const path = clientView.routePath as Array<{ latitude: number; longitude: number }>;
    assert.ok(path.length > 1);
    assert.equal(typeof path![0]!.latitude, 'number');
    assert.equal(clientView.encodedPolyline, samplePolyline);

    assert.deepEqual(clientView.eta, {
      destinationType: 'DROP',
      remainingDistanceMeters: 3200,
      remainingDurationSeconds: 420,
      providerName: 'google',
      stale: false,
      computedAt: '2026-10-15T12:00:00.000Z',
    });
  });

  it('handles missing routePlan gracefully without fabricating straight routes', () => {
    const ride = {
      id: 'ride-no-route',
      rideCode: 'ZR-9999',
      status: 'ACCEPTED',
      routePlan: null,
      request: {
        pickupLat: 12.9716,
        pickupLng: 77.5946,
        dropLat: 13.0827,
        dropLng: 80.2707,
        quotedFare: 150,
      },
    };

    const clientView = toClientRideView(ride as never, null);
    assert.ok(clientView);
    assert.equal(clientView.routeAvailable, false);
    assert.equal(clientView.routePath, null, 'Must NOT fabricate a straight-line route');
    assert.equal(clientView.encodedPolyline, null);
    assert.equal(clientView.eta, null);
  });
});
