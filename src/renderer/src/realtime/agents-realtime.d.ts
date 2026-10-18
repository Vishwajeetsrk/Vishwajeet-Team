// Ambient types for @openai/agents-realtime.
//
// The published package.json declares `types: dist/index.d.ts`, but that file
// is not shipped (only dist/clientMessages.d.ts is). Until upstream publishes
// real entry types, this declaration covers the exact surface the renderer
// uses: tool(), RealtimeAgent, RealtimeSession, OpenAIRealtimeWebRTC.
//
// Shapes are derived from call sites in session.ts / tools.ts / actions.ts.

declare module '@openai/agents-realtime' {
  /** A function-tool definition passed to RealtimeAgent. */
  export interface ToolDefinition {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    execute?: (input: unknown) => unknown | Promise<unknown>;
  }

  export function tool(config: ToolDefinition): ToolDefinition;

  export class RealtimeAgent {
    constructor(config: { name: string; instructions?: string; tools?: ToolDefinition[] });
    name: string;
  }

  /** The WebRTC transport handed to RealtimeSession. */
  export class OpenAIRealtimeWebRTC {
    constructor(options: { mediaStream?: MediaStream; audioElement?: HTMLAudioElement; [key: string]: unknown });
    sendEvent(event: Record<string, unknown>): void;
    close?(): void;
  }

  export interface RealtimeSessionOptions {
    transport: OpenAIRealtimeWebRTC;
    model?: string;
    config?: Record<string, unknown>;
  }

  export class RealtimeSession {
    constructor(agent: RealtimeAgent, options: RealtimeSessionOptions);
    /** Raw transport — used for silent conversation.item.create injection. */
    transport: OpenAIRealtimeWebRTC;
    connect(options?: { apiKey?: string; model?: string }): Promise<void>;
    mute(muted: boolean): void;
    sendMessage(message: string): void;
    close(): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
  }
}
