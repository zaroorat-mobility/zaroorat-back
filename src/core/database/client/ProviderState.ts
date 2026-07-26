/**
 * Defines the explicit lifecycle states of the PrismaClientProvider.
 * Prevents accidental double-initialization or shutdown race conditions.
 */
export enum ProviderState {
  UNINITIALIZED = 'UNINITIALIZED',
  INITIALIZING = 'INITIALIZING',
  CONNECTED = 'CONNECTED',
  DISCONNECTING = 'DISCONNECTING',
  DISCONNECTED = 'DISCONNECTED',
}
