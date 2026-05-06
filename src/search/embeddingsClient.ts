export interface SemanticSearchHit {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface EmbeddingsHealth {
  status: string;
  model?: string;
  documents?: number;
  loaded?: boolean;
}

export class EmbeddingsClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<EmbeddingsHealth> {
    const response = await fetch(new URL("/health", this.baseUrl));
    if (!response.ok) {
      throw new Error(`Embeddings health-check failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as EmbeddingsHealth;
  }

  async search(query: string, limit = 5): Promise<SemanticSearchHit[]> {
    const health = await this.health();
    if (health.status !== "ok") {
      throw new Error(`Embeddings service is not healthy: ${health.status}`);
    }

    const response = await fetch(new URL("/search", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit })
    });
    if (!response.ok) {
      throw new Error(`Embeddings search failed: ${response.status} ${await response.text()}`);
    }
    const payload = (await response.json()) as { results?: SemanticSearchHit[] };
    return payload.results ?? [];
  }
}
