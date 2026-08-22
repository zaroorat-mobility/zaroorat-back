import { asClass, aliasTo, AwilixContainer } from 'awilix';
import { registerFileReference } from '@modules/files';
import {
  VehicleRepository,
  VehicleAssignmentRepository,
  VehicleTypeRepository,
  VehicleDocumentRepository,
} from './repositories/index.js';
import {
  VehicleAssignmentService,
  VehicleTypeService,
  VehicleDocumentService,
  VehicleVerificationService,
  VehicleEligibilityService,
} from './services/index.js';
import {
  VehicleController,
  VehicleTypeController,
  VehicleDocumentController,
  VehicleVerificationController,
} from './controllers/index.js';
export * from './controllers/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './errors/index.js';
export * from './types/index.js';
export function registerVehiclesModule(container: AwilixContainer): void {
  container.register({
    vehicleRepository: asClass(VehicleRepository).singleton(),
    vehicleAssignmentRepository: asClass(VehicleAssignmentRepository).singleton(),
    vehicleTypeRepository: asClass(VehicleTypeRepository).singleton(),
    vehicleDocumentRepository: asClass(VehicleDocumentRepository).singleton(),
    vehicleTypeService: asClass(VehicleTypeService).singleton(),
    vehicleAssignmentService: asClass(VehicleAssignmentService).singleton(),
    vehicleDocumentService: asClass(VehicleDocumentService).singleton(),
    vehicleVerificationService: asClass(VehicleVerificationService).singleton(),
    vehicleEligibilityService: asClass(VehicleEligibilityService).singleton(),
    vehicleController: asClass(VehicleController).singleton(),
    vehicleTypeController: asClass(VehicleTypeController).singleton(),
    vehicleDocumentController: asClass(VehicleDocumentController).singleton(),
    vehicleVerificationController: asClass(VehicleVerificationController).singleton(),
    vehicleRepo: aliasTo('vehicleRepository'),
    assignmentRepo: aliasTo('vehicleAssignmentRepository'),
    txManager: aliasTo('transactionManager'),
  });

  // Mirrors the drivers module's registration: a file a live vehicle document
  // still points at must not be soft-deletable out from under it.
  registerFileReference('VEHICLE_DOCUMENT', {
    module: 'vehicles',
    isReferenced: (fileId, tx) =>
      container
        .resolve<VehicleDocumentRepository>('vehicleDocumentRepository')
        .isDocumentFile(fileId, tx),
  });
}
