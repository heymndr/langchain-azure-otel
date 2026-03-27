# Contributing to @mndr/langchain-azure-otel

Thanks for your interest in contributing! This package provides OpenTelemetry GenAI tracing for LangChain/LangGraph JS, and we welcome contributions from the community.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/heymndr/langchain-azure-otel.git
cd langchain-azure-otel

# Install dependencies
npm install

# Build (ESM + CJS)
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test -- --watch
```

## Project Structure

```
src/
  index.ts        # Public exports
  tracer.ts       # AzureOtelTracer callback handler
  attributes.ts   # GenAI semantic convention constants
tests/
  tracer.test.ts  # Unit tests (vitest + in-memory OTEL exporter)
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Run `npm run build && npm test` to verify
5. Open a pull request

## Guidelines

- **TypeScript** — all source code is TypeScript with strict mode
- **Tests** — add tests for new functionality using vitest
- **Semantic conventions** — follow [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- **No runtime dependencies** — keep `@langchain/core` and `@opentelemetry/api` as peer deps only
- **Backward compatibility** — avoid breaking changes to the public API

## Commit Messages

Use clear, descriptive commit messages. Examples:

- `Add support for retriever span tracing`
- `Fix token usage extraction for Anthropic models`
- `Update GenAI attribute constants to latest spec`

## Reporting Issues

- Use the [bug report template](https://github.com/heymndr/langchain-azure-otel/issues/new?template=bug_report.yml) for bugs
- Use the [feature request template](https://github.com/heymndr/langchain-azure-otel/issues/new?template=feature_request.yml) for ideas

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
