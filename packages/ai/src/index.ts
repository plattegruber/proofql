// Workers AI providers: bge-m3 embeddings and the sentiment classifier, with deterministic fakes.

export {
  BGE_M3_EMBEDDING_MODEL,
  createWorkersAiEmbedder,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EmbeddingDimensionError,
  EmbeddingError,
  type EmbeddingProvider,
  FAKE_EMBEDDING_MODEL,
  FakeEmbeddingProvider,
  type FakeEmbeddingProviderOptions,
  fakeEmbed,
  type WorkersAiEmbedderOptions,
} from "./embedding.js";
export {
  BGE_RERANKER_BASE_MODEL,
  createWorkersAiReranker,
  FAKE_RERANKER_MODEL,
  FakeReranker,
  fakeRerankScore,
  RerankError,
  type Reranker,
} from "./rerank.js";
export {
  createWorkersAiSentimentClassifier,
  DEFAULT_NEUTRAL_THRESHOLD,
  DISTILBERT_SST2_MODEL,
  FAKE_SENTIMENT_MODEL,
  FakeSentimentClassifier,
  fakeSentiment,
  type Sentiment,
  type SentimentClassifier,
  type SentimentClassifierOptions,
  SentimentError,
  type SentimentResult,
  toSentimentResult,
  type WorkersAiSentimentClassifierOptions,
} from "./sentiment.js";
export { cosineSimilarity } from "./vector.js";
export {
  AiProviderError,
  AiResponseError,
  type WorkersAiBinding,
} from "./workersAi.js";
