/**
 * OTel is optional: the API layer only depends on @opentelemetry/api, which is
 * a no-op until an SDK is registered. The SDK and OTLP exporter are loaded
 * dynamically so the service still boots without them installed.
 */
export async function initObservability(serviceName: string): Promise<void> {
  if (process.env.OTEL_ENABLED !== 'true') return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  try {
    const sdkSpec: string = '@opentelemetry/sdk-node';
    const exporterSpec: string = '@opentelemetry/exporter-trace-otlp-http';

    const sdkModule = (await import(sdkSpec)) as {
      NodeSDK: new (config: Record<string, unknown>) => { start(): void };
    };
    const exporterModule = (await import(exporterSpec)) as {
      OTLPTraceExporter: new (config: Record<string, unknown>) => unknown;
    };

    const sdk = new sdkModule.NodeSDK({
      serviceName,
      traceExporter: new exporterModule.OTLPTraceExporter({
        url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
      }),
    });

    sdk.start();

    const shutdown = (): void => {
      void Promise.resolve((sdk as unknown as { shutdown(): Promise<void> }).shutdown()).catch(
        () => undefined,
      );
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    console.warn(
      'OTEL_ENABLED=true but the OpenTelemetry SDK is not installed; continuing without tracing.',
      error instanceof Error ? error.message : error,
    );
  }
}
