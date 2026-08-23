import type { FastifyInstance } from 'fastify';
import { asClass, AwilixContainer } from 'awilix';

import {
  pricingManagementRoutes,
  AdminSurgeController,
  AdminSurgeService,
} from './pricing-management/index.js';
import {
  driverManagementRoutes,
  AdminDriverManagementController,
} from './driver-management/index.js';
import {
  vehicleManagementRoutes,
  AdminVehicleManagementController,
} from './vehicle-management/index.js';
import {
  paymentManagementRoutes,
  AdminPaymentManagementController,
} from './payment-management/index.js';

export function registerAdminModule(container: AwilixContainer): void {
  container.register({
    adminSurgeService: asClass(AdminSurgeService).singleton(),
    adminSurgeController: asClass(AdminSurgeController).singleton(),
    adminDriverManagementController: asClass(AdminDriverManagementController).singleton(),
    adminVehicleManagementController: asClass(AdminVehicleManagementController).singleton(),
    adminPaymentManagementController: asClass(AdminPaymentManagementController).singleton(),
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Aggregate all admin routes under this module
  await app.register(pricingManagementRoutes);
  await app.register(driverManagementRoutes);
  await app.register(vehicleManagementRoutes);
  await app.register(paymentManagementRoutes);
}
