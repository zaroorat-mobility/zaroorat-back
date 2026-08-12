import { RideRequestController } from './ride-request.controller.js';
import { RideStateController } from './ride-state.controller.js';
import { RideQueryController } from './ride-query.controller.js';

export class RideController {
  constructor(
    public readonly request: RideRequestController,
    public readonly state: RideStateController,
    public readonly query: RideQueryController,
  ) {}
}
