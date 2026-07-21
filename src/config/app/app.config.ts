import { validatedEnv } from "../env/validated-env.js";

export const appConfig = Object.freeze({
  name: validatedEnv.APP_NAME,
  environment: validatedEnv.APP_ENV,
  nodeEnv: validatedEnv.NODE_ENV,
});
