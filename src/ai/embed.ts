import createLogger from "../utils/logger";

const log = createLogger("Embedding");

/**
 * Sentence-transformer embedding using @xenova/transformers (runs locally).
 * Model: all-MiniLM-L6-v2 — 384 dimensions.
 */

let pipelineInstance: any = null;

async function getPipeline(): Promise<any> {
  if (!pipelineInstance) {
    log.info("Loading sentence-transformer model (first call downloads ~23MB)...");
    const start = Date.now();
    const { pipeline } = await (new Function(
      'return import("@xenova/transformers")'
    )() as Promise<typeof import("@xenova/transformers")>);
    pipelineInstance = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    log.info(`Model loaded in ${Date.now() - start}ms`);
  }
  return pipelineInstance;
}

const MAX_EMBED_CHARS = 7500;

export async function generateEmbedding(text: string): Promise<number[]> {
  const truncated = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
  const start = Date.now();

  try {
    const extractor = await getPipeline();
    const output = await extractor(truncated, { pooling: "mean", normalize: true });
    const embedding = Array.from(output.data) as number[];
    log.info(
      `Embedding generated in ${Date.now() - start}ms (${embedding.length} dims)`
    );
    return embedding;
  } catch (err: any) {
    log.warn(`Sentence-transformer failed: ${err.message} — using fallback`);
    return generateLocalEmbedding(text);
  }
}

export function generateLocalEmbedding(text: string): number[] {
  const dimensions = 384;
  const embedding = new Array(dimensions).fill(0);
  const normalized = text.toLowerCase().trim();
  const words = normalized.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    for (let j = 0; j < word.length; j++) {
      const idx = (word.charCodeAt(j) * 31 + i * 7 + j * 13) % dimensions;
      embedding[idx] += 1.0;
    }
    if (i < words.length - 1) {
      const bigram = words[i] + " " + words[i + 1];
      const idx = (hashString(bigram) % dimensions + dimensions) % dimensions;
      embedding[idx] += 0.5;
    }
  }
  const magnitude = Math.sqrt(
    embedding.reduce((sum: number, v: number) => sum + v * v, 0)
  );
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) embedding[i] /= magnitude;
  }
  return embedding;
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
