export interface RideRequestView {
  id: string;
  customerId: string;
  vehicleTypeId: string;
  pickupAddress: string | null;
  dropAddress: string | null;
  quotedFare: number | null;
  status: string;
  createdAt: Date;
}

export interface RideView {
  id: string;
  rideCode: string;
  customerId: string;
  driverId: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  pickupAddress: string | null;
  dropAddress: string | null;
  acceptedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  fare?: unknown;
}
