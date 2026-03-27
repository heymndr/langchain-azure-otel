# Changelog

## 0.1.0 (2026-03-27)

Initial release.

- `AzureOtelTracer` callback handler for LangChain/LangGraph JS
- Emits spans following OpenTelemetry GenAI semantic conventions
- `invoke_agent`, `chat`, and `execute_tool` span types
- Parent-child span hierarchy via `runId`/`parentRunId` context propagation
- Configurable content recording with truncation limits
- `flush()` for safe cleanup on stream cancellation
- Works with any OTEL exporter (Azure Monitor, Jaeger, OTLP, etc.)
- Dual ESM + CJS build
- Zero runtime dependencies
