import { DriverOnboardingController } from './driver-onboarding.controller.js';
import { DriverStatusController } from './driver-status.controller.js';
import { DriverLocationController } from './driver-location.controller.js';
import { DriverWalletController } from './driver-wallet.controller.js';
export class DriverController {
  constructor(
    public readonly onboarding: DriverOnboardingController,
    public readonly status: DriverStatusController,
    public readonly location: DriverLocationController,
    public readonly wallet: DriverWalletController,
  ) {}
}
