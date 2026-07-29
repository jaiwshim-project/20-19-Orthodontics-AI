# Azure OpenAI Setup

This project can use Azure OpenAI before falling back to Gemini.

Set these values in `.env.local` for local development and in Vercel Environment Variables for deployment:

```env
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=https://<resource-name>.openai.azure.com
AZURE_OPENAI_CHAT_DEPLOYMENT=<chat-model-deployment-name>
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=<embedding-model-deployment-name>
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_EMBEDDING_DIMENSIONS=768
```

Important:

- `AZURE_OPENAI_CHAT_DEPLOYMENT` is the Azure deployment name, not just the model name.
- `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` should point to an embedding deployment. If using `text-embedding-3-*`, keep `AZURE_OPENAI_EMBEDDING_DIMENSIONS=768` to match the current `pgvector vector(768)` schema.
- Image analysis requires a chat deployment that supports vision input.
- Do not commit real API keys. `.env.local` is intentionally ignored by Git.
