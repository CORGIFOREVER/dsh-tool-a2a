// DSH A2A bridge server — exposes an LLM-backed agent over the A2A (Agent2Agent) protocol.
// A2A = Google Agent2Agent (JSON-RPC over HTTP). AgentCard at /.well-known/agent-card.json.
//
// Portable by design: no hardcoded endpoints or absolute paths.
// All deployment specifics come from the environment:
//   A2A_PORT            listen port              (default 4123)
//   A2A_HOST            bind host                (default 127.0.0.1; 0.0.0.0 for cross-network)
//   DEEPSEEK_BASE       OpenAI-compatible API base URL (required)
//   DEEPSEEK_MODEL      model id                 (default deepseek-chat)
//   DEEPSEEK_API_KEY    API key (env) — or A2A_CREDENTIALS_FILE, or ${DSH_HOME:-~/.dsh}/.credentials.yaml
import express from 'express';
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, TaskState } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, AgentEvent } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.A2A_PORT || 4123);
const HOST = process.env.A2A_HOST || '127.0.0.1';
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

if (!DEEPSEEK_BASE) {
  console.error('DEEPSEEK_BASE is required (OpenAI-compatible API base URL). Set it in the environment.');
  process.exit(1);
}

function deepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const credFile =
    process.env.A2A_CREDENTIALS_FILE ||
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml');
  const yaml = readFileSync(credFile, 'utf8');
  const m = /^DEEPSEEK_API_KEY:\s*(.+)$/m.exec(yaml);
  if (!m) throw new Error(`DEEPSEEK_API_KEY not found in ${credFile}`);
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}
const apiKey = deepSeekKey();

async function callDeepSeek(messages) {
  const res = await fetch(DEEPSEEK_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, stream: false, max_tokens: 8192 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return (msg?.content ?? '').trim() || (msg?.reasoning_content ?? '').trim() || '';
}

const agentCard = {
  name: 'DSH A2A Bridge',
  description: 'A2A server bridging to an LLM backend (OpenAI-compatible). Ask it anything.',
  supportedInterfaces: [
    { url: `http://${HOST}:${PORT}/`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION },
  ],
  provider: { organization: 'dsh', url: '' },
  version: '1.0.0',
  capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'llm_assistant',
      name: 'LLM Assistant',
      description: 'General question answering via the configured LLM backend.',
      tags: ['llm'],
      examples: ['hello', 'explain something'],
      inputModes: ['text'],
      outputModes: ['text'],
      securityRequirements: [],
    },
  ],
  documentationUrl: '',
  signatures: [],
};

const textPart = (value) => ({ content: { $case: 'text', value }, mediaType: 'text/plain', filename: '', metadata: {} });
const makeMessage = (role, parts, taskId, contextId) => ({
  messageId: crypto.randomUUID(),
  contextId,
  taskId,
  role,
  parts,
  metadata: {},
  extensions: [],
});

const executor = {
  async execute(requestContext, eventBus) {
    const { taskId, contextId } = requestContext;
    const userMsg = requestContext.userMessage;
    const history = requestContext.task?.history || [];
    const text = (userMsg.parts || [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('\n')
      .trim();
    const messages = history.map((m) => ({
      role: m.role === 1 ? 'user' : 'assistant',
      content: (m.parts || []).map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join(' '),
    }));
    if (!messages.length || messages[messages.length - 1].content !== text) {
      messages.push({ role: 'user', content: text });
    }

    eventBus.publish(AgentEvent.statusUpdate({
      taskId, contextId,
      status: { state: TaskState.TASK_STATE_WORKING, message: null, timestamp: new Date().toISOString() },
      metadata: {},
    }));

    let reply;
    try {
      reply = await callDeepSeek(messages);
    } catch (err) {
      eventBus.publish(AgentEvent.task({
        id: taskId, contextId,
        status: { state: TaskState.TASK_STATE_FAILED, message: makeMessage(2, [textPart('Error: ' + err.message)], taskId, contextId), timestamp: new Date().toISOString() },
        artifacts: [], history: history.concat([userMsg]), metadata: {}, extensions: [],
      }));
      return;
    }

    const agentMsg = makeMessage(2, [textPart(reply)], taskId, contextId);
    eventBus.publish(AgentEvent.message(agentMsg));
    eventBus.publish(AgentEvent.artifactUpdate({
      taskId, contextId,
      artifact: { name: 'response', description: 'LLM reply', parts: [textPart(reply)], metadata: {} },
      append: false, lastChunk: true, metadata: {},
    }));
    eventBus.publish(AgentEvent.task({
      id: taskId, contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED, message: agentMsg, timestamp: new Date().toISOString() },
      artifacts: [{ name: 'response', description: 'LLM reply', parts: [textPart(reply)], metadata: {} }],
      history: history.concat([userMsg, agentMsg]), metadata: {}, extensions: [],
    }));
  },
  async cancelTask(taskId, eventBus) {
    eventBus.publish(AgentEvent.statusUpdate({
      taskId, contextId: '',
      status: { state: TaskState.TASK_STATE_CANCELED, message: null, timestamp: new Date().toISOString() },
      metadata: {},
    }));
  },
};

const taskStore = new InMemoryTaskStore();
const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);
const app = express();
app.use(express.json());
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
app.listen(PORT, HOST, () => {
  console.log(`[a2a-bridge] listening on http://${HOST}:${PORT}`);
  console.log(`[a2a-bridge] agent card: http://${HOST}:${PORT}/${AGENT_CARD_PATH}`);
});
