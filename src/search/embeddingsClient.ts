export interface SemanticSearchHit {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

export class EmbeddingsClient {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, limit = 5): Promise<SemanticSearchHit[]> {
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
