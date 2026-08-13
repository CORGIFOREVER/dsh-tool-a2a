// End-to-end A2A client test. Usage:  A2A_URL=http://<host>:<port> node test-client.mjs
// sendMessage resolves to the final agent Message (role=2) — not a Task wrapper.
import { ClientFactory } from '@a2a-js/sdk/client';

const url = process.env.A2A_URL;
if (!url) {
  console.error('A2A_URL is required (e.g. A2A_URL=http://<host>:<port> node test-client.mjs)');
  process.exit(1);
}

const factory = new ClientFactory();
const client = await factory.createFromUrl(url);
console.log('client created from', url);

const reply = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: process.env.A2A_PROMPT || 'Reply with the word PONG.' }],
  },
});

console.log('taskId:', reply.taskId);
console.log('role:', reply.role, '(2 = agent)');
const text = (reply.parts || [])
  .map((p) => (p.content?.$case === 'text' ? p.content.value : JSON.stringify(p)))
  .join('\n');
console.log('reply:', text);
process.exit(0);
