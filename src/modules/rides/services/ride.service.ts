import { RideRequestService } from './request/ride-request.service.js';
import { LifecycleService } from './lifecycle/lifecycle.service.js';
import { PricingService } from '@modules/pricing';
import { CancellationService } from './cancellation/cancellation.service.js';
import { DispatchService } from './dispatch/dispatch.service.js';
import { ReceiptService } from './receipt/receipt.service.js';
export class RideService {
  constructor(
    public readonly request: RideRequestService,
    public readonly lifecycle: LifecycleService,
    public readonly pricing: PricingService,
    public readonly cancellation: CancellationService,
    public readonly dispatch: DispatchService,
    public readonly receipt: ReceiptService,
  ) {}
}
