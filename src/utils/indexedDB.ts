/**
 * IndexedDB compatibility facade.
 *
 * Keep this module path and its public exports stable for existing callers.
 * The implementation lives under src/persistence and is split behind explicit
 * database, transaction, repository, migration, recovery, and adapter edges.
 */
export * from "../persistence/facade/indexedDbPersistence";
export { default } from "../persistence/facade/indexedDbPersistence";
