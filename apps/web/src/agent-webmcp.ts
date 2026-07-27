interface ModelContext {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties: Record<string, never>;
      required: string[];
    };
    execute: () => Promise<unknown>;
  }): Promise<unknown>;
}

function registerAgentTools(modelContext: Pick<ModelContext, 'registerTool'>): void {
  void modelContext
    .registerTool({
      name: 'threads_health',
      description: 'Get Threads Downloader service health status.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const response = await fetch('/api/health');
        return response.json();
      },
    })
    .catch(() => {});
}

function isModelContext(modelContext: unknown): modelContext is Pick<ModelContext, 'registerTool'> {
  return (
    typeof modelContext === 'object' &&
    modelContext !== null &&
    typeof (modelContext as { registerTool?: unknown }).registerTool === 'function'
  );
}

((navigatorObject) => {
  const modelContext = navigatorObject.modelContext;
  if (modelContext === undefined || modelContext === null) {
    return;
  }

  if (!isModelContext(modelContext)) {
    return;
  }

  registerAgentTools(modelContext);
})(globalThis.navigator as Navigator & { modelContext?: unknown });
