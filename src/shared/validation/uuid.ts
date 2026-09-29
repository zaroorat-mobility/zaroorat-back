/// Shape check for a UUID string (any version).
///
/// Used before handing a caller-supplied value to a `@db.Uuid` column: PostgreSQL
/// rejects a non-UUID literal with an error rather than matching nothing, so an
/// unchecked lookup turns bad input into a 500 instead of a miss.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
