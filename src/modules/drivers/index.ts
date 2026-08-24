import { asClass, aliasTo, AwilixContainer } from 'awilix';
import { registerFileReference } from '@modules/files';
import { DriverMetrics } from './metrics/driver.metrics.js';
import {
  DriverRepository,
  DriverDocumentRepository,
  DriverBankRepository,
  DriverWalletRepository,
  DriverStatusRepository,
  DriverLocationRepository,
  DriverShiftRepository,
} from './repositories/index.js';
import {
  OnboardingService,
  DocumentsService,
  StatusService,
  LocationService,
  DriverWalletViewService,
  ShiftService,
  DriverService,
  DriverEligibilityService,
} from './services/index.js';
import {
  DriverOnboardingController,
  DriverDocumentsController,
  DriverStatusController,
  DriverLocationController,
  DriverWalletController,
  DriverController,
} from './controllers/index.js';
import { HeartbeatTimeoutJob, DocExpirationJob } from './jobs/index.js';
export * from './controllers/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './jobs/index.js';
export * from './metrics/index.js';
export * from './plugins/index.js';
export * from './events/index.js';
export * from './errors/index.js';
export * from './constants/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export function registerDriversModule(container: AwilixContainer): void {
  container.register({
    driverMetrics: asClass(DriverMetrics).singleton(),
    driverRepository: asClass(DriverRepository).singleton(),
    driverDocumentRepository: asClass(DriverDocumentRepository).singleton(),
    driverBankRepository: asClass(DriverBankRepository).singleton(),
    driverWalletRepository: asClass(DriverWalletRepository).singleton(),
    driverStatusRepository: asClass(DriverStatusRepository).singleton(),
    driverLocationRepository: asClass(DriverLocationRepository).singleton(),
    driverShiftRepository: asClass(DriverShiftRepository).singleton(),
    onboardingService: asClass(OnboardingService).singleton(),
    documentsService: asClass(DocumentsService).singleton(),
    statusService: asClass(StatusService).singleton(),
    locationService: asClass(LocationService).singleton(),
    driverEligibilityService: asClass(DriverEligibilityService).singleton(),
    eligibilityService: aliasTo('driverEligibilityService'),
    driverWalletViewService: asClass(DriverWalletViewService).singleton(),
    shiftService: asClass(ShiftService).singleton(),
    driverService: asClass(DriverService)
      .singleton()
      .inject((c) => ({
        onboarding: c.resolve('onboardingService'),
        documents: c.resolve('documentsService'),
        status: c.resolve('statusService'),
        location: c.resolve('locationService'),
        wallet: c.resolve('driverWalletViewService'),
        shift: c.resolve('shiftService'),
      })),
    driverOnboardingController: asClass(DriverOnboardingController).singleton(),
    driverDocumentsController: asClass(DriverDocumentsController).singleton(),
    driverStatusController: asClass(DriverStatusController).singleton(),
    driverLocationController: asClass(DriverLocationController).singleton(),
    driverWalletController: asClass(DriverWalletController).singleton(),
    driverController: asClass(DriverController)
      .singleton()
      .inject((c) => ({
        onboarding: c.resolve('driverOnboardingController'),
        documents: c.resolve('driverDocumentsController'),
        status: c.resolve('driverStatusController'),
        location: c.resolve('driverLocationController'),
        wallet: c.resolve('driverWalletController'),
      })),
    heartbeatTimeoutJob: asClass(HeartbeatTimeoutJob).singleton(),
    driverRepo: aliasTo('driverRepository'),
    docRepo: aliasTo('driverDocumentRepository'),
    locationRepo: aliasTo('driverLocationRepository'),
    shiftRepo: aliasTo('driverShiftRepository'),
    statusRepo: aliasTo('driverStatusRepository'),
    txManager: aliasTo('transactionManager'),
    docExpirationJob: asClass(DocExpirationJob).singleton(),
  });
  registerFileReference('DRIVER_DOCUMENT', {
    module: 'drivers',
    isReferenced: (fileId, tx) =>
      container
        .resolve<DriverDocumentRepository>('driverDocumentRepository')
        .isDocumentFile(fileId, tx),
  });
}
