/**
 * The request context — re-exported from `@quynhonsemiconductor/observability`.
 *
 * There must be exactly ONE `AsyncLocalStorage` instance in the process. `observability` owns it
 * because its logger mixin reads it and `withJobContext` writes to it. This package used to carry a
 * second, private copy of the same class, so a context seeded through one could not be read through
 * the other, and a product that seeded this package's copy got none of `correlationId`, `userId` and
 * `workspaceId` on its log lines (the mixin reads the other store). Nothing fails when that happens;
 * the fields are just absent. `enableCorrelationId` seeds the context, so it must write to the store
 * everything else reads.
 *
 * Kept as a re-export rather than deleted so every existing import of these names stays valid, and
 * so `RequestContextService` stays one class: two copies of an `@Injectable()` are two DI tokens.
 */
export {
  RequestContextService,
  requestContextStorage,
  type RequestContext,
} from '@quynhonsemiconductor/observability';
