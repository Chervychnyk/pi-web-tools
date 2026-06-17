import { SEARCH_USER_AGENT, parseJsonResponse } from './shared.ts'
import type {
  ConcreteSearchProviderName,
  SearchProvider,
  SearchResultItem,
} from './types.ts'

export type JsonSearchProviderConfig = {
  name: ConcreteSearchProviderName
  errorLabel: string
  buildRequest: (
    query: string,
    limit: number,
  ) => { url: string; headers?: Record<string, string> }
  parseResponse: (json: unknown, limit: number) => SearchResultItem[]
}

export function createJsonSearchProvider(
  config: JsonSearchProviderConfig,
): SearchProvider {
  return {
    name: config.name,
    async search(query, limit, signal) {
      const { url, headers } = config.buildRequest(query, limit)
      const response = await fetch(url, {
        signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': SEARCH_USER_AGENT,
          ...headers,
        },
      })

      if (!response.ok) {
        throw new Error(
          `${config.errorLabel} search failed: ${response.status} ${response.statusText}`,
        )
      }

      return config.parseResponse(await parseJsonResponse(response), limit)
    },
  }
}
