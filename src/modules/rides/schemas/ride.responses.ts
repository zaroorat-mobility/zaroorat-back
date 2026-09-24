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

export interface ClientRideRequestView {
  id: string;
  customerId: string | null;
  status: string | null;
  vehicleTypeId: string | null;
  vehicleType: { id: string; name: string; code: string } | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropLat: number | null;
  dropLng: number | null;
  pickupAddress: string | null;
  dropAddress: string | null;
  quotedFare: number | null;
  boostAmount: number | null;
  totalOffered: number | null;
  paymentMethod: string | null;
  promoCode: string | null;
  estimatedDistanceKm: number | null;
  estimatedDurationMin: number | null;
  passengerName: string | null;
  passengerPhone: string | null;
  pickupNotes: string | null;
  stops: Array<{
    sequence: number | null;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
  }>;
  createdAt: Date | string | null;
  expiresAt: Date | string | null;
  scheduledFor: Date | string | null;
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
