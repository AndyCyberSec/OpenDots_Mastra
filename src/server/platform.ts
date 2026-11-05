import './telemetry-env.js';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import type { BaseEvent, Message } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import type { Memory } from '@mastra/memory';
import { createAgentMemory } from './agent-memory.js';
import { SqliteAgentRunner } from './agent-runner.js';
import type { AiSettings } from './ai.js';
import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { DotAgent, currentTurnText } from './dot-agent.js';
import { PageService } from './page-service.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { SkillLibrary } from './skills.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';

/**
 * Self-hosted platform wiring.
 *
 * Agent execution is Mastra; the AG-UI transport and thread endpoints are the
 * MIT-licensed CopilotKit runtime in its local SSE mode (no Intelligence
 * client, no hosted orchestration). Conversations, tool calls, and approval
 * receipts are stored in the local SQLite database.
 */
export class Platform {
  readonly setupTelemetry = new SetupTelemetry();
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  readonly runner: SqliteAgentRunner;
  readonly skills: SkillLibrary;
  readonly ai?: AiSettings;
  readonly memory?: Memory;
  readonly handler?: CopilotHonoApp;

  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
  ) {
    this.ai = config.ai;
    this.skills = new SkillLibrary();
    this.runner = new SqliteAgentRunner(config.databasePath, workspace.ownerId);
    this.memory = createAgentMemory({ databasePath: config.databasePath });
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(workspace.connections);
    this.pages = new PageService(workspace, () => this.runner);
    if (!this.ai) return;
    const runtime = new CopilotRuntime({
      runner: this.runner,
      agents: async () =>
        Object.fromEntries(
          workspace.dots().map((dot) => [dot.id, this.agent(dot.id)]),
        ),
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }

  /** Build a Dot agent bound to the current workspace configuration. */
  agent(dotId: string) {
    if (!this.ai) throw new Error('Model configuration is required.');
    return new DotAgent(
      {
        store: this.store,
        workspace: this.workspace,
        config: this.config,
        ai: this.ai,
        memory: this.memory,
        skills: this.skills,
        setupTelemetry: this.setupTelemetry,
      },
      dotId,
    );
  }

  setup() {
    return setupStatus(this.config);
  }

  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}. Configure a model provider to start conversations.`,
      );
  }

  start() {
    this.setupTelemetry.start();
  }

  async stop() {
    await this.setupTelemetry.stop();
    this.runner.close();
  }

  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    const conversation = this.workspace.bindThread(id, dotId, title);
    this.runner.registerThread(id, dotId, title);
    return conversation;
  }

  /** Recent conversation history as plain text, for voice and summaries. */
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const messages = this.runner.getThreadMessages(threadId);
    return messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }

  async handle(request: Request): Promise<Response> {
    if (!this.handler)
      return Response.json(
        {
          error:
            'Setup required: configure AI_BASE_URL, AI_API_KEY, and AI_MODEL (or the OPENAI_* equivalents).',
        },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }

  /**
   * Run one turn outside the web chat (voice compute, scheduled tasks) and
   * return the assistant text. The turn goes through the same durable runner, so
   * it is part of the conversation transcript and survives restarts.
   */
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    signal.throwIfAborted();
    const thread = this.workspace.requireThread(threadId);
    const agent = this.agent(thread.dotId);
    const history = this.runner.getThreadMessages(threadId);
    const prefix =
      metadata?.opendotsSource === 'voice_receipt'
        ? voiceReceiptMessagePrefix
        : metadata?.opendotsSource === 'scheduled_task'
          ? scheduledTaskMessagePrefix
          : '';
    const userMessage: Message = {
      id: `${prefix}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    };
    const messages = [...history, userMessage];
    agent.setMessages(messages);
    let runError: Error | undefined;
    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      const subscription = this.runner
        .run({
          threadId,
          agent,
          input: {
            threadId,
            runId: randomUUID(),
            messages,
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          },
        })
        .subscribe({
          next: (event) => {
            events.push(event);
            if (event.type === 'RUN_ERROR')
              runError = new Error(
                (event as { message?: string }).message ?? 'Run failed.',
              );
          },
          error: (error: unknown) =>
            reject(error instanceof Error ? error : new Error(String(error))),
          complete: () => resolve(),
        });
      signal.addEventListener(
        'abort',
        () => {
          void this.runner.stop({ threadId });
          subscription.unsubscribe();
          reject(new Error('Run was stopped.'));
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    return currentTurnText(agent.messages, runError);
  }
}
