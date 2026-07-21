import pino from "pino";
import { config } from "@config";
import { transport } from "./transport.js";

export const logger = pino({
  level:
    config.app.environment === "local"
      ? "debug"
      : "info",
  transport,
});
