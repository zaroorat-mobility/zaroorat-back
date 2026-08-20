import { DriverShiftRepository } from '../../repositories/driver-shift.repository.js';
import type { DriverShiftLog } from '../../types';
export class ShiftService {
  constructor(private readonly shiftRepo: DriverShiftRepository) {}
  async getActiveShift(driverId: string): Promise<DriverShiftLog | null> {
    return this.shiftRepo.findActiveShift(driverId);
  }
}
