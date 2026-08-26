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
import {
  staffManagementRoutes,
  AdminStaffController,
  AdminStaffService,
} from './staff-management/index.js';
import {
  rbacManagementRoutes,
  AdminRbacController,
  AdminRbacService,
} from './rbac-management/index.js';
import {
  riderManagementRoutes,
  AdminRiderController,
  AdminRiderService,
} from './rider-management/index.js';

export function registerAdminModule(container: AwilixContainer): void {
  container.register({
    adminSurgeService: asClass(AdminSurgeService).singleton(),
    adminSurgeController: asClass(AdminSurgeController).singleton(),
    adminDriverManagementController: asClass(AdminDriverManagementController).singleton(),
    adminVehicleManagementController: asClass(AdminVehicleManagementController).singleton(),
    adminPaymentManagementController: asClass(AdminPaymentManagementController).singleton(),
    adminStaffService: asClass(AdminStaffService).singleton(),
    adminStaffController: asClass(AdminStaffController).singleton(),
    adminRbacService: asClass(AdminRbacService).singleton(),
    adminRbacController: asClass(AdminRbacController).singleton(),
    adminRiderService: asClass(AdminRiderService).singleton(),
    adminRiderController: asClass(AdminRiderController).singleton(),
  });
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Aggregate all admin routes under this module
  await app.register(pricingManagementRoutes);
  await app.register(driverManagementRoutes);
  await app.register(vehicleManagementRoutes);
  await app.register(paymentManagementRoutes);
  await app.register(staffManagementRoutes);
  await app.register(rbacManagementRoutes);
  await app.register(riderManagementRoutes);
}
