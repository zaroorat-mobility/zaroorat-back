import { RideRequestController } from './ride-request.controller.js';
import { RideStateController } from './ride-state.controller.js';
import { RideQueryController } from './ride-query.controller.js';
import {
  RideCallController,
  RideChatController,
  RideScheduledController,
} from './ride-comms.controller.js';

export class RideController {
  constructor(
    public readonly request: RideRequestController,
    public readonly state: RideStateController,
    public readonly query: RideQueryController,
    public readonly chat: RideChatController,
    public readonly call: RideCallController,
    public readonly scheduled: RideScheduledController,
  ) {}
}
