import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { SavedPlace } from '../types';

/** A coordinate pair. Both halves travel together or not at all (doc 02 §2.6). */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Fields required to add a saved place (doc 02 §2.6). */
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

/**
 * A partial place edit. Only the keys **present** are written; an absent key
 * leaves its column unchanged, an explicit `null` clears it (R-USER-5).
 *
 * `coordinates` is a single key on purpose: latitude and longitude are only ever
 * meaningful together, and `location` has to be re-derived whenever either moves.
 */
export interface UpdateSavedPlaceInput {
  label?: string;
  address?: string | null;
  buildingName?: string | null;
  landmark?: string | null;
  floor?: string | null;
  instructions?: string | null;
  coordinates?: Coordinates | null;
}

/** The columns Prisma can write directly (everything but `location`). */
type PlaceColumns = Omit<UpdateSavedPlaceInput, 'coordinates'> & {
  latitude?: number | null;
  longitude?: number | null;
};

/** Split a partial edit into plain columns and the coordinate change, if any. */
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

/**
 * Data access for `saved_places` (user doc 03 §3.3). Prisma-only, no business
 * rules; every method is scoped by `userId` in its `WHERE` clause (doc 02 §3).
 *
 * Two things here are not ordinary Prisma. The `location` geography is
 * `Unsupported`, so Prisma can neither read nor write it — it is derived from the
 * decimals by raw SQL inside the caller's transaction (§4.4). And the list is
 * ordered case-insensitively, which a functional sort key cannot express through
 * the query builder.
 */
export class SavedPlaceRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * List a user's places, ordered by label, case-insensitively (doc 02 §2.6).
   *
   * Sorted here rather than in SQL because `ORDER BY lower(label)` is not
   * expressible through Prisma's query builder, and the alternative — a raw query
   * — would give up the generated row type for a list the cap holds at a couple of
   * dozen rows. `uq_saved_places_user_label` makes `lower(label)` unique per user,
   * so this is a total order with no tie-break needed.
   * @param userId Owner's user UUID.
   * @returns Places, label ascending.
   */
  async findAllByUser(userId: string): Promise<SavedPlace[]> {
    const places = await this.client.savedPlace.findMany({ where: { userId } });
    return places.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
  }

  /**
   * Fetch one place, scoped to its owner.
   * @param userId Owner's user UUID.
   * @param id Place UUID.
   * @param tx Transaction client to join (omit for a standalone read).
   * @returns The place, or `null` if it does not exist **or is not owned**.
   */
  async findOwned(userId: string, id: string, tx?: TransactionClient): Promise<SavedPlace | null> {
    return (tx ?? this.client).savedPlace.findFirst({ where: { id, userId } });
  }

  /**
   * Count a user's places, for the cap check.
   * @param userId Owner's user UUID.
   * @param tx The transaction holding the owner-row lock (USER-INV-7).
   */
  async countByUser(userId: string, tx?: TransactionClient): Promise<number> {
    return (tx ?? this.client).savedPlace.count({ where: { userId } });
  }

  /**
   * Insert a place and derive its geography.
   * @param input Owner, label, optional address parts, and optional coordinates.
   * @param tx Transaction client to join, so the row, its geography, and its
   *           outbox event commit together (R-USER-28).
   * @returns The created place.
   * @throws Propagates a unique violation when the label is already taken for
   *         this user (`uq_saved_places_user_label`) — the index is the
   *         enforcement (doc 03 §5).
   */
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

  /**
   * Apply a partial edit, scoped to the owner, re-deriving the geography when the
   * coordinates move.
   *
   * `updateMany` keeps ownership in the `WHERE` clause; `update` addresses by
   * primary key alone and would edit another user's row if the scope check were
   * ever dropped upstream.
   * @param userId Owner's user UUID.
   * @param id Place UUID.
   * @param input The keys to write.
   * @param tx Transaction client to join.
   * @returns The updated place, or `null` if no owned row matched.
   * @throws Propagates a unique violation on a taken label.
   */
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

  /**
   * Delete a place, scoped to the owner.
   * @param userId Owner's user UUID.
   * @param id Place UUID.
   * @param tx Transaction client to join.
   * @returns `true` if an owned row was deleted; `false` if none matched.
   */
  async deleteOwned(userId: string, id: string, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).savedPlace.deleteMany({ where: { id, userId } });
    return count === 1;
  }

  /**
   * Delete every place an account holds (account erasure, R-USER-18/19).
   *
   * A hard delete. Home and work addresses are among the most sensitive rows the
   * platform holds (doc 03 §6), and retaining them under a `deleted_at` would
   * retain exactly what the request asked to be rid of.
   *
   * @param userId Owner's user UUID.
   * @param tx Transaction client to join.
   * @returns Count removed — reported in the erasure audit event.
   */
  async deleteAllForUser(userId: string, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).savedPlace.deleteMany({ where: { userId } });
    return count;
  }

  /**
   * Set (or clear) the PostGIS geography derived from a coordinate pair
   * (doc 03 §4.4).
   *
   * **`ST_MakePoint` takes longitude first.** Swapping the arguments is the most
   * common PostGIS mistake and it fails silently — the point lands in the wrong
   * hemisphere rather than raising. The round-trip is asserted in the integration
   * suite for exactly that reason (doc 06 §8).
   */
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
