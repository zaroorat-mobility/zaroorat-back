import { OnboardingService } from './onboarding/onboarding.service.js';
import { DocumentsService } from './documents/documents.service.js';
import { StatusService } from './status/status.service.js';
import { LocationService } from './location/location.service.js';
import { DriverWalletViewService } from './wallet/wallet.service.js';
import { ShiftService } from './shift/shift.service.js';
export class DriverService {
  constructor(
    public readonly onboarding: OnboardingService,
    public readonly documents: DocumentsService,
    public readonly status: StatusService,
    public readonly location: LocationService,
    public readonly wallet: DriverWalletViewService,
    public readonly shift: ShiftService,
  ) {}
}
