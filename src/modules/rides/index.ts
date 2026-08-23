import { asClass, aliasTo, AwilixContainer } from 'awilix';
import { RideMetrics } from './metrics/ride.metrics.js';
import {
  RideRequestRepository,
  RideDispatchRepository,
  RideRepository,
  RideFareRepository,
  RideCancellationRepository,
  RideOtpRepository,
  RideStatusEventRepository,
  RideReceiptRepository,
  RideRatingRepository,
} from './repositories/index.js';
import {
  RideRequestService,
  RideOtpService,
  CancellationService,
  DispatchService,
  MatchingService,
  LifecycleService,
  ReceiptService,
  RatingService,
  RideService,
} from './services/index.js';
import {
  RideRequestController,
  RideStateController,
  RideQueryController,
  RideController,
} from './controllers/index.js';
import { DispatchTimeoutJob, RequestExpiryJob } from './jobs/index.js';
import {
  RideRequestedConsumer,
  RideNotificationConsumer,
  RideRealtimeConsumer,
} from './consumers/index.js';
export * from './controllers/index.js';
export * from './routes/index.js';
export * from './schemas/index.js';
export * from './services/index.js';
export * from './repositories/index.js';
export * from './jobs/index.js';
export * from './consumers/index.js';
export * from './metrics/index.js';
export * from './plugins/index.js';
export * from './events/index.js';
export * from './errors/index.js';
export * from './constants/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export function registerRidesModule(container: AwilixContainer): void {
  container.register({
    rideMetrics: asClass(RideMetrics).singleton(),
    rideRequestRepository: asClass(RideRequestRepository).singleton(),
    rideDispatchRepository: asClass(RideDispatchRepository).singleton(),
    rideRepository: asClass(RideRepository).singleton(),
    rideFareRepository: asClass(RideFareRepository).singleton(),
    rideCancellationRepository: asClass(RideCancellationRepository).singleton(),
    rideOtpRepository: asClass(RideOtpRepository).singleton(),
    rideStatusEventRepository: asClass(RideStatusEventRepository).singleton(),
    rideReceiptRepository: asClass(RideReceiptRepository).singleton(),
    rideRatingRepository: asClass(RideRatingRepository).singleton(),
    rideRequestService: asClass(RideRequestService).singleton(),

    rideOtpService: asClass(RideOtpService).singleton(),
    cancellationService: asClass(CancellationService).singleton(),
    dispatchService: asClass(DispatchService).singleton(),
    matchingService: asClass(MatchingService).singleton(),
    lifecycleService: asClass(LifecycleService).singleton(),
    receiptService: asClass(ReceiptService).singleton(),
    ratingService: asClass(RatingService).singleton(),
    rideService: asClass(RideService)
      .singleton()
      .inject((c) => ({
        request: c.resolve('rideRequestService'),
        lifecycle: c.resolve('lifecycleService'),
        pricing: c.resolve('pricingService'),
        otp: c.resolve('rideOtpService'),
        cancellation: c.resolve('cancellationService'),
        dispatch: c.resolve('dispatchService'),
        receipt: c.resolve('receiptService'),
      })),
    rideRequestController: asClass(RideRequestController).singleton(),
    rideStateController: asClass(RideStateController).singleton(),
    rideQueryController: asClass(RideQueryController).singleton(),
    rideController: asClass(RideController)
      .singleton()
      .inject((c) => ({
        request: c.resolve('rideRequestController'),
        state: c.resolve('rideStateController'),
        query: c.resolve('rideQueryController'),
      })),
    dispatchTimeoutJob: asClass(DispatchTimeoutJob).singleton(),
    requestExpiryJob: asClass(RequestExpiryJob).singleton(),
    rideRequestedConsumer: asClass(RideRequestedConsumer).singleton(),
    rideNotificationConsumer: asClass(RideNotificationConsumer).singleton(),
    rideRealtimeConsumer: asClass(RideRealtimeConsumer).singleton(),
    rideRepo: aliasTo('rideRepository'),
    requestRepo: aliasTo('rideRequestRepository'),
    statusEventRepo: aliasTo('rideStatusEventRepository'),
    fareRepo: aliasTo('rideFareRepository'),
    otpRepo: aliasTo('rideOtpRepository'),
    dispatchRepo: aliasTo('rideDispatchRepository'),
    cancellationRepo: aliasTo('rideCancellationRepository'),
    receiptRepo: aliasTo('rideReceiptRepository'),
    ratingRepo: aliasTo('rideRatingRepository'),
    txManager: aliasTo('transactionManager'),
  });
}
