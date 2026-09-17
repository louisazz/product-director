/**
 * Local Chinese embedding via Transformers.js + BGE-small-zh-v1.5.
 * Lazy-loads the ONNX model on first use (~4s cold start, cached afterwards).
 * Uses hf-mirror.com for access from mainland China.
 */
import * as path from "node:path";
import { pipeline, env } from "@xenova/transformers";

// Route through HF mirror (hf-mirror.com) for China access
env.remoteHost = "https://hf-mirror.com";
env.remotePathTemplate = "{model}/resolve/{revision}/";

const MODEL = "Xenova/bge-small-zh-v1.5";

/** Set the exact project-controlled cache directory (survives npm reinstalls). */
export function setCacheDir(dir: string) {
  env.cacheDir = path.resolve(dir);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;
let ready = false;

async function getExtractor() {
  if (extractor) return extractor;
  extractor = await pipeline("feature-extraction", MODEL, { quantized: true });
  ready = true;
  return extractor;
}

/** Convert texts to 512-dim normalized embedding vectors */
export async function embed(texts: string[]): Promise<number[][]> {
  const pipe = await getExtractor();
  const output = await pipe(texts, { pooling: "mean", normalize: true });
  const results: number[][] = [];
  const dim = output.dims[1] as number;
  for (let i = 0; i < output.dims[0]; i++) {
    const row = Array.from(output.data.slice(i * dim, (i + 1) * dim) as Float32Array);
    results.push(row as unknown as number[]);
  }
  return results;
}

/** Whether the model has been loaded */
export function isEmbeddingReady(): boolean {
  return ready;
}
