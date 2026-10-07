# Atlas Vector Search index for `questions`

Mongoose cannot create Atlas Search indexes, so create this one in the Atlas UI
(Database → Atlas Search → Create Index → JSON editor) or with the Atlas CLI, on the
`questions` collection, named `questions_embedding` (see `QUESTION_VECTOR_INDEX` in
`src/modules/questions/repository.ts`).

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
    { "type": "filter", "path": "isActive" },
    { "type": "filter", "path": "category" },
    { "type": "filter", "path": "difficulty" },
    { "type": "filter", "path": "seniority" }
  ]
}
```

`numDimensions` must match the embedding model chosen for `embed()` in the AI gateway; update
it (and re-embed the bank) if the model changes. Every field used in the `$vectorSearch`
`filter` must be declared as a `filter` field above.
