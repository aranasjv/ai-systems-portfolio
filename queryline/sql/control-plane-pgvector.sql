-- Optional: semantic retrieval over verified question/SQL examples.
-- Requires the pgvector extension (the docker-compose image includes it).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS example_embeddings (
  example_id bigint PRIMARY KEY REFERENCES few_shot_examples(id) ON DELETE CASCADE,
  embedding  vector(1024) NOT NULL
);

CREATE INDEX IF NOT EXISTS example_embeddings_hnsw_idx
  ON example_embeddings USING hnsw (embedding vector_cosine_ops);
