import type { TransactionClient } from '@core/database/TransactionManager';
import { vehicleConfig } from '@config';
import { VehicleRepository } from '../repositories/vehicle.repository.js';
import { VehicleAssignmentRepository } from '../repositories/vehicle-assignment.repository.js';
import { VehicleDocumentRepository } from '../repositories/vehicle-document.repository.js';
import {
  NoActiveVehicleError,
  VehicleDocumentsIncompleteError,
  VehicleInactiveError,
  VehicleNotVerifiedError,
} from '../errors/vehicle.errors.js';
import type {
  Vehicle,
  VehicleDocumentEligibilityResult,
  VehicleEligibility,
} from '../types/index.js';

/// The vehicle half of "may this driver operate right now", deliberately shaped
/// like `DriverEligibilityService` so `StatusService.setOnline` reads the two
/// checks the same way. This is also the single implementation the ride-accept
/// path reuses — `LifecycleService.assertVehicleEligible` used to carry its own
/// partial copy of these rules.
export class VehicleEligibilityService {
  constructor(
    private readonly vehicleRepository: VehicleRepository,
    private readonly vehicleAssignmentRepository: VehicleAssignmentRepository,
    private readonly vehicleDocumentRepository: VehicleDocumentRepository,
  ) {}

  async checkRequiredDocuments(
    vehicleId: string,
    tx?: TransactionClient,
  ): Promise<VehicleDocumentEligibilityResult> {
    if (!vehicleConfig.requireApprovedDocuments) {
      return { eligible: true, missing: [], pending: [], rejected: [], expired: [] };
    }
    const documents = await this.vehicleDocumentRepository.findByVehicleId(vehicleId, tx);
    const byType = new Map(documents.map((document) => [document.documentType, document]));
    const now = new Date();
    const missing: string[] = [];
    const pending: string[] = [];
    const rejected: string[] = [];
    const expired: string[] = [];

    for (const type of vehicleConfig.requiredDocumentTypes) {
      const document = byType.get(type);
      if (!document) {
        missing.push(type);
        continue;
      }
      if (document.verificationStatus === 'PENDING') {
        pending.push(type);
        continue;
      }
      if (document.verificationStatus === 'REJECTED') {
        rejected.push(type);
        continue;
      }
      if (document.expiresAt && document.expiresAt <= now) {
        expired.push(type);
      }
    }

    const eligible = !missing.length && !pending.length && !rejected.length && !expired.length;
    return { eligible, missing, pending, rejected, expired };
  }

  /// Non-throwing form: reports *which* gate failed so callers can surface a
  /// distinct error rather than one catch-all.
  async check(driverId: string, tx?: TransactionClient): Promise<VehicleEligibility> {
    const assignment = await this.vehicleAssignmentRepository.findActiveForDriver(driverId, tx);
    if (!assignment) return { eligible: false, reason: 'VEHICLE_MISSING' };

    const vehicle = await this.vehicleRepository.findById(assignment.vehicleId, tx);
    if (!vehicle) return { eligible: false, reason: 'VEHICLE_MISSING' };

    return this.checkVehicle(vehicle, tx);
  }

  async checkVehicle(vehicle: Vehicle, tx?: TransactionClient): Promise<VehicleEligibility> {
    if (!vehicle.isActive) return { eligible: false, reason: 'VEHICLE_INACTIVE' };

    if (vehicleConfig.requireVerifiedVehicle && vehicle.verificationStatus !== 'VERIFIED') {
      return {
        eligible: false,
        reason: 'VEHICLE_NOT_VERIFIED',
        verificationStatus: vehicle.verificationStatus,
      };
    }

    const documents = await this.checkRequiredDocuments(vehicle.id, tx);
    if (!documents.eligible) {
      return { eligible: false, reason: 'VEHICLE_DOCUMENTS_INCOMPLETE', documents };
    }

    return { eligible: true, vehicle };
  }

  /// Throwing form, for the go-online gate. Each reason maps to its own error
  /// code so a driver app can tell "you have no vehicle" from "your vehicle is
  /// awaiting review" from "your vehicle's papers are incomplete".
  async assertOperable(driverId: string, tx?: TransactionClient): Promise<Vehicle> {
    return this.assertEligibility(await this.check(driverId, tx));
  }

  assertEligibility(result: VehicleEligibility): Vehicle {
    if (result.eligible) return result.vehicle;
    switch (result.reason) {
      case 'VEHICLE_MISSING':
        throw new NoActiveVehicleError(
          'You have no vehicle assigned. Claim a vehicle before going online.',
        );
      case 'VEHICLE_INACTIVE':
        throw new VehicleInactiveError();
      case 'VEHICLE_NOT_VERIFIED':
        throw new VehicleNotVerifiedError(
          `Your vehicle's verification status is '${result.verificationStatus}', required: 'VERIFIED'`,
          { verificationStatus: result.verificationStatus },
        );
      case 'VEHICLE_DOCUMENTS_INCOMPLETE':
        throw new VehicleDocumentsIncompleteError(
          'Your vehicle does not hold every required document',
          result.documents,
        );
    }
  }
}
