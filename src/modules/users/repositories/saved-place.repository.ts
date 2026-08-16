import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { SavedPlace } from '../types';
export interface Coordinates {
  latitude: number;
  longitude: number;
}
export interface CreateSavedPlaceInput {
  userId: string;
  label: string;
  address?: string | null;
  buildingName?: string | null;
  landmark?: string | null;
  floor?: string | null;
  instructions?: string | null;
  coordinates?: Coordinates | null;
}
export interface UpdateSavedPlaceInput {
  label?: string;
  address?: string | null;
  buildingName?: string | null;
  landmark?: string | null;
  floor?: string | null;
  instructions?: string | null;
  coordinates?: Coordinates | null;
}
type PlaceColumns = Omit<UpdateSavedPlaceInput, 'coordinates'> & {
  latitude?: number | null;
  longitude?: number | null;
};
function toColumns(input: UpdateSavedPlaceInput): PlaceColumns {
  const data: PlaceColumns = {};
  if ('label' in input) data.label = input.label;
  if ('address' in input) data.address = input.address;
  if ('buildingName' in input) data.buildingName = input.buildingName;
  if ('landmark' in input) data.landmark = input.landmark;
  if ('floor' in input) data.floor = input.floor;
  if ('instructions' in input) data.instructions = input.instructions;
  if ('coordinates' in input) {
    data.latitude = input.coordinates?.latitude ?? null;
    data.longitude = input.coordinates?.longitude ?? null;
  }
  return data;
}
export class SavedPlaceRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findAllByUser(userId: string): Promise<SavedPlace[]> {
    const places = await this.client.savedPlace.findMany({ where: { userId } });
    return places.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
  }
  async findOwned(userId: string, id: string, tx?: TransactionClient): Promise<SavedPlace | null> {
    return (tx ?? this.client).savedPlace.findFirst({ where: { id, userId } });
  }
  async countByUser(userId: string, tx?: TransactionClient): Promise<number> {
    return (tx ?? this.client).savedPlace.count({ where: { userId } });
  }
  async create(input: CreateSavedPlaceInput, tx?: TransactionClient): Promise<SavedPlace> {
    const client = tx ?? this.client;
    const place = await client.savedPlace.create({
      data: {
        userId: input.userId,
        label: input.label,
        ...(input.address != null ? { address: input.address } : {}),
        ...(input.buildingName != null ? { buildingName: input.buildingName } : {}),
        ...(input.landmark != null ? { landmark: input.landmark } : {}),
        ...(input.floor != null ? { floor: input.floor } : {}),
        ...(input.instructions != null ? { instructions: input.instructions } : {}),
        ...(input.coordinates
          ? { latitude: input.coordinates.latitude, longitude: input.coordinates.longitude }
          : {}),
      },
    });
    if (input.coordinates) {
      await this.writeLocation(input.userId, place.id, input.coordinates, client);
    }
    return place;
  }
  async updateOwned(
    userId: string,
    id: string,
    input: UpdateSavedPlaceInput,
    tx?: TransactionClient,
  ): Promise<SavedPlace | null> {
    const client = tx ?? this.client;
    const { count } = await client.savedPlace.updateMany({
      where: { id, userId },
      data: toColumns(input),
    });
    if (count === 0) return null;
    if ('coordinates' in input) {
      await this.writeLocation(userId, id, input.coordinates ?? null, client);
    }
    return client.savedPlace.findFirst({ where: { id, userId } });
  }
  async deleteOwned(userId: string, id: string, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).savedPlace.deleteMany({ where: { id, userId } });
    return count === 1;
  }
  async deleteAllForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).savedPlace.deleteMany({ where: { userId } });
    return count;
  }
  private async writeLocation(
    userId: string,
    id: string,
    coordinates: Coordinates | null,
    client: TransactionClient | typeof this.client,
  ): Promise<void> {
    if (!coordinates) {
      await client.$executeRaw`
        UPDATE saved_places SET location = NULL
         WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`;
      return;
    }
    await client.$executeRaw`
      UPDATE saved_places
         SET location = ST_SetSRID(
               ST_MakePoint(
                 ${coordinates.longitude}::double precision,
                 ${coordinates.latitude}::double precision
               ),
               4326
             )::geography
        WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`;
  }
}
