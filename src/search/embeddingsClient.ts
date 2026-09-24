export interface SemanticSearchHit {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface EmbeddingsDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingsHealth {
  status: string;
  model?: string;
  documents?: number;
  loaded?: boolean;
}

export interface EmbeddingsIndexResult {
  indexed: number;
}

const HEALTH_TIMEOUT_MS = 5_000;
const SEARCH_TIMEOUT_MS = 30_000;
const INDEX_TIMEOUT_MS = 30 * 60_000;

/** Client for the optional Python embeddings service (embeddings/service.py). Every request has a timeout. */
export class EmbeddingsClient {
  constructor(private readonly baseUrl: string, private readonly token = process.env.BITRIX_MCP_EMBEDDINGS_TOKEN ?? "") {}

  private async request<T>(pathname: string, timeoutMs: number, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await fetch(new URL(pathname, this.baseUrl), {
        method: body === undefined && pathname === "/health" ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (error as Error).message;
      throw new Error(`Embeddings service at ${this.baseUrl} is unreachable (${pathname}): ${reason}`);
    }
    if (!response.ok) {
      throw new Error(`Embeddings ${pathname} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  health(): Promise<EmbeddingsHealth> {
    return this.request("/health", HEALTH_TIMEOUT_MS);
  }

  index(documents: EmbeddingsDocument[]): Promise<EmbeddingsIndexResult> {
    return this.request("/index", INDEX_TIMEOUT_MS, { documents });
  }

  reload(): Promise<EmbeddingsHealth> {
    return this.request("/reload", HEALTH_TIMEOUT_MS, {});
  }

  async search(query: string, limit = 5): Promise<SemanticSearchHit[]> {
    const payload = await this.request<{ results?: SemanticSearchHit[] }>("/search", SEARCH_TIMEOUT_MS, { query, limit });
    return payload.results ?? [];
  }
}
