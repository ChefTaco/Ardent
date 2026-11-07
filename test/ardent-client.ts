import createClient from 'openapi-fetch';
import type { paths } from './generated/ardent-openapi.js';

/** Typed management client generated from Ardent's checked OpenAPI document. */
export function createArdentManagementClient(options: {
  baseUrl: string;
  bearerToken?: string;
  fetch?: typeof globalThis.fetch;
}) {
  return createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.bearerToken ? { headers: { Authorization: `Bearer ${options.bearerToken}` } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
