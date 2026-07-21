import { validatedEnv } from "../env/validated-env.js";

export const serverConfig = Object.freeze({
  host: validatedEnv.HOST,
  port: validatedEnv.PORT,
});
