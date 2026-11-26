/**
 * `@hivemagnus/ardent-client/openapi`: the management API's generated OpenAPI types and its
 * route manifest, for code that proxies or allowlists Ardent routes (such as Magnus's node
 * agent) instead of regenerating them. Types and data only: it imports nothing at run time.
 */
import { ARDENT_ROUTES } from './routes.js';

export type { paths, operations, components } from './generated.js';
export { ARDENT_ROUTES } from './routes.js';

/** One management API operation. */
export type ArdentRoute = (typeof ARDENT_ROUTES)[number];
/** `read` for GET, `action` for every other method. */
export type ArdentRouteKind = ArdentRoute['kind'];
export type ArdentOperationId = ArdentRoute['operationId'];

const patterns = ARDENT_ROUTES.map(route => ({ route,
  pattern: new RegExp(`^${route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}/]+\}/g, '[^/]+')}$`) }));

/**
 * The route a request matches, or undefined. `path` is the request path (no query), such as
 * `/api/v1/tasks/<id>/events`. A literal segment wins over a parameter, as the server routes.
 */
export function matchArdentRoute(method: string, path: string): ArdentRoute | undefined {
  const upper = method.toUpperCase();
  const parameters = (route: ArdentRoute) => route.path.split('{').length - 1;
  return patterns.filter(entry => entry.route.method === upper && entry.pattern.test(path)).map(entry => entry.route)
    .sort((a, b) => parameters(a) - parameters(b))[0];
}
