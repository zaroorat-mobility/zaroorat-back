import { asClass, aliasTo, AwilixContainer } from 'awilix';
import { VehicleRepository, VehicleAssignmentRepository } from './repositories/index.js';
import { VehicleAssignmentService } from './services/index.js';
import { VehicleController } from './controllers/index.js';
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
    vehicleAssignmentService: asClass(VehicleAssignmentService).singleton(),
    vehicleController: asClass(VehicleController).singleton(),
    vehicleRepo: aliasTo('vehicleRepository'),
    assignmentRepo: aliasTo('vehicleAssignmentRepository'),
    txManager: aliasTo('transactionManager'),
  });
}
