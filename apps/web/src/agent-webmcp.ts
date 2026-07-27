interface ModelContext {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties: Record<string, never>;
      required: string[];
    };
    execute: () => Promise<unknown> | unknown;
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

((navigatorObject) => {
  const modelContext = navigatorObject.modelContext;
  if (modelContext === undefined || modelContext === null) {
    return;
  }

  const maybeModelContext = modelContext as Partial<ModelContext> & {
    registerTool: unknown;
  };

  if (typeof maybeModelContext.registerTool !== 'function') {
    return;
  }

  registerAgentTools(maybeModelContext as ModelContext);
})(globalThis.navigator as Navigator & { modelContext?: unknown });
