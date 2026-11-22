export interface DriverView {
  id: string;
  userId: string;
  driverCode: string;
  verificationStatus: string;
  rating: number;
  totalRides: number;
  isAvailable: boolean;
  isSuspended: boolean;
  createdAt: Date;
  profile?: unknown;
  onlineStatus?: unknown;
}
export interface DriverShiftView {
  id: string;
  driverId: string;
  shiftStart: Date;
  shiftEnd: Date | null;
  totalOnlineMinutes: number;
}
