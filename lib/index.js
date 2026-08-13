// @deepseek-ai/dsh-tool-a2a — A2A (Agent2Agent) client tools for DSH agents.
// Registers a2a_discover / a2a_send / a2a_get / a2a_cancel over HTTP JSON-RPC (A2A v1.0).
// Self-contained: uses global fetch; no SDK dependency. Protocol verified against @a2a-js/sdk.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-a2a";

/** Services required by the A2A tool suite. */
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  // No hardcoded URL: supplied by deployment config or the A2A_BASE_URL environment variable.
  baseUrl: z.string().default(""),
  timeoutMs: z.number().default(120000),
  maxReplyChars: z.number().default(16000)
});

// ── A2A v1.0 wire helpers ───────────────────────────────────────────────────

async function a2aRpc(baseUrl, method, params, timeoutMs) {
  const res = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`A2A HTTP ${res.status} from ${baseUrl}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.error) throw new Error(`A2A error ${data.error.code} (${data.error.message})`);
  return data.result;
}

async function fetchAgentCard(baseUrl, timeoutMs) {
  const res = await fetch(`${baseUrl}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`agent card HTTP ${res.status} from ${baseUrl}`);
  return await res.json();
}

function textFromMessage(message) {
  return (message?.parts || [])
    .map((p) => (typeof p?.text === "string" ? p.text : typeof p?.content?.value === "string" ? p.content.value : JSON.stringify(p)))
    .join("\n");
}

function summarizeTask(task) {
  const state = task?.status?.state ?? "UNKNOWN";
  const reply = textFromMessage(task?.status?.message);
  return { taskId: task?.id, contextId: task?.contextId, state, reply };
}

// ── plugin apply ────────────────────────────────────────────────────────────

function apply(ctx, config) {
  if (!config.baseUrl) {
    throw new Error("tool-a2a: baseUrl is required — set it in the plugin config or via the A2A_BASE_URL environment variable.");
  }
  ctx.systemPrompt.section({
    name: "tool:a2a",
    order: 115,
    text: `Use a2a_discover before calling an unknown A2A agent. Use a2a_send to send a message to an A2A agent and get its reply; a2a_get polls and a2a_cancel cancels long-running tasks. The local DSH A2A bridge (DeepSeek) is at ${config.baseUrl}.`
  });

  ctx.tools.register(defineTool({
    name: "a2a_discover",
    description: "Fetch an A2A (Agent2Agent) agent card — name, description, skills, supported interfaces. Always call this before messaging an unknown A2A agent.",
    parameters: {
      baseUrl: { type: "string", description: `A2A server base URL (default ${config.baseUrl}).` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", required: true },
          description: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          interfaces: { type: "array", items: { type: "string" } }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `A2A agent: ${value.name}\n${value.description || ""}\nSkills: ${value.skills?.join(", ") || "none"}\nInterfaces: ${value.interfaces?.join(", ") || "none"}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const base = args.baseUrl || config.baseUrl;
      const card = await fetchAgentCard(base, config.timeoutMs);
      return {
        name: card.name,
        description: card.description || "",
        skills: (card.skills || []).map((s) => `${s.name}: ${s.description || ""}`),
        interfaces: (card.supportedInterfaces || []).map((i) => `${i.protocolBinding} v${i.protocolVersion}`)
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "a2a_send",
    description: "Send a message to an A2A agent and return its reply (blocking). Pass taskId/contextId to continue an existing conversation.",
    parameters: {
      text: { type: "string", required: true, description: "The message text to send." },
      baseUrl: { type: "string", description: `A2A server base URL (default ${config.baseUrl}).` },
      taskId: { type: "string", description: "Existing task id to continue (optional)." },
      contextId: { type: "string", description: "Context id of the conversation (optional)." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          contextId: { type: "string" },
          state: { type: "string", required: true },
          reply: { type: "string", required: true }
        }
      },
      render: (args, value) => [{
        type: "text",
        text: `[A2A ${value.state}] ${value.reply || "(no reply)"}\n${value.taskId ? `task: ${value.taskId}` : ""}`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = args.baseUrl || config.baseUrl;
      const message = {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ text: args.text }]
      };
      if (args.taskId) message.taskId = args.taskId;
      if (args.contextId) message.contextId = args.contextId;
      const result = await a2aRpc(base, "SendMessage", { message }, config.timeoutMs);
      if (exec.signal.aborted) throw new Error("a2a_send aborted");
      if (result.message) {
        return {
          taskId: result.message.taskId,
          contextId: result.message.contextId,
          state: "TASK_STATE_COMPLETED",
          reply: textFromMessage(result.message).slice(0, config.maxReplyChars)
        };
      }
      const task = summarizeTask(result.task);
      return {
        taskId: task.taskId,
        contextId: task.contextId,
        state: task.state,
        reply: (task.reply || "").slice(0, config.maxReplyChars)
      };
    }
  }));

  ctx.tools.register(defineTool({
    name: "a2a_get",
    description: "Poll the status of an A2A task by id (state, reply, artifacts).",
    parameters: {
      taskId: { type: "string", required: true, description: "Task id returned by a2a_send." },
      contextId: { type: "string", description: "Context id of the conversation." },
      baseUrl: { type: "string", description: `A2A server base URL (default ${config.baseUrl}).` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          contextId: { type: "string" },
          state: { type: "string", required: true },
          reply: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `[A2A ${value.state}] ${value.reply || "(no reply)"}` }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = args.baseUrl || config.baseUrl;
      const result = await a2aRpc(base, "GetTask", { taskId: args.taskId, contextId: args.contextId }, config.timeoutMs);
      if (exec.signal.aborted) throw new Error("a2a_get aborted");
      const task = summarizeTask(result.task);
      return { taskId: task.taskId, contextId: task.contextId, state: task.state, reply: (task.reply || "").slice(0, config.maxReplyChars) };
    }
  }));

  ctx.tools.register(defineTool({
    name: "a2a_cancel",
    description: "Cancel a running A2A task by id.",
    parameters: {
      taskId: { type: "string", required: true, description: "Task id returned by a2a_send." },
      contextId: { type: "string", description: "Context id of the conversation." },
      baseUrl: { type: "string", description: `A2A server base URL (default ${config.baseUrl}).` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          state: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `[A2A ${value.state}] task ${value.taskId || ""}` }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const base = args.baseUrl || config.baseUrl;
      const result = await a2aRpc(base, "CancelTask", { taskId: args.taskId, contextId: args.contextId }, config.timeoutMs);
      if (exec.signal.aborted) throw new Error("a2a_cancel aborted");
      const state = result.task?.status?.state ?? "TASK_STATE_CANCELED";
      return { taskId: result.task?.id ?? args.taskId, state };
    }
  }));
}

export { Config, apply, inject, name };
