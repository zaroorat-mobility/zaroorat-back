export { default as authPlugin, type AuthorizeOptions } from './auth.plugin';
export { registerAuthRoutes } from './auth.routes';
export { AuthController } from './auth.controller';
export {
  AUTH_ERROR_STATUS,
  authErrorStatus,
  buildAuthErrorBody,
  replyAuthError,
  replyFromAuthError,
  type AuthErrorBody,
  type AuthErrorExtra,
} from './error-response';
