import http from 'node:http';
import crypto from 'node:crypto';
import {
  boardHome,
  ensureBoard,
  postTask,
  showTask,
  cancelTask,
  registerAgent,
  boardHome as homeOf,
} from './board.mjs';

/**
 * A2A (Agent2Agent) adapter for the board.
 *
 * The board is local; A2A is how a *remote* agent delegates work to the machine
 * that owns the board. This module implements the subset that matters for that
 * direction, with both v1.0 PascalCase methods and the 0.3 lowercase spellings
 * that most shipped clients still send:
 *
 *   GET  /.well-known/agent-card.json
 *   POST /                       JSON-RPC: message/send, message/stream,
 *                                tasks/get, tasks/cancel (and SendMessage, ...)
 *   POST /message:send           REST variant
 *   POST /message:stream         REST + SSE
 *   GET  /tasks/<id>             REST variant
 *   POST /tasks/<id>/cancel      REST variant
 *
 * Mapping: one A2A task == one board task. A2A states are derived from the
 * board state, so claim/lease/completion semantics stay in one place.
 */

export const A2A_ERROR = {
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

const STATE = {
  queued: 'TASK_STATE_SUBMITTED',
  claimed: 'TASK_STATE_WORKING',
  done: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
};

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

function partsToText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p?.kind === 'text' || p?.type === 'text') return p.text ?? '';
      if (typeof p?.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function titleOf(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? 'remote task';
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

export function toA2ATask(task) {
  const contextId = task.meta?.contextId ?? task.id;
  const messageId = task.meta?.messageId ?? `${task.id}-msg`;
  const status = {
    state: STATE[task.state] ?? 'TASK_STATE_WORKING',
    timestamp: task.updatedAt ?? task.createdAt,
  };
  if (task.claim?.by) status.message = { kind: 'message', messageId: `${task.id}-status`, role: 'agent', parts: [{ kind: 'text', text: `claimed by ${task.claim.by}` }] };
  if (task.result?.summary) status.message = { kind: 'message', messageId: `${task.id}-status`, role: 'agent', parts: [{ kind: 'text', text: String(task.result.summary) }] };

  const out = {
    kind: 'task',
    id: task.id,
    contextId,
    status,
    history: [
      {
        kind: 'message',
        messageId,
        role: 'user',
        taskId: task.id,
        contextId,
        parts: [{ kind: 'text', text: task.body ? `${task.title}\n\n${task.body}` : task.title }],
      },
    ],
    artifacts: [],
    metadata: {
      boardState: task.state,
      claimedBy: task.claim?.by ?? null,
      leaseUntil: task.claim?.leaseUntil ?? null,
      from: task.from,
      to: task.to,
      capabilities: task.capabilities,
      blockedBy: task.blockedBy,
      attempts: task.attempts,
    },
  };

  if (task.result?.status === 'done') {
    out.artifacts.push({
      artifactId: `${task.id}-result`,
      name: 'result',
      parts: [
        {
          kind: 'text',
          text: JSON.stringify(
            { summary: task.result.summary, evidence: task.result.evidence, artifacts: task.result.artifacts },
            null,
            2,
          ),
        },
      ],
    });
  }
  return out;
}

function rpcError(code, message, data) {
  return { jsonrpc: '2.0', id: null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function stateUpdate(task, final = false) {
  const a2a = toA2ATask(task);
  return {
    kind: 'status-update',
    taskId: a2a.id,
    contextId: a2a.contextId,
    status: a2a.status,
    final,
  };
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : {});
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createA2AServer({
  home = boardHome(),
  agent = 'board',
  name = 'MCP Task Board',
  description = 'A shared task board exposed over A2A. Remote agents post a task; a local worker claims it, does it, and the result comes back as an artifact.',
  host = '127.0.0.1',
  port = 0,
  publicUrl = null,
  token = null,
  blockTimeoutMs = 25_000,
  pollMs = 250,
  version = '0.2.0',
  onLog = () => {},
} = {}) {
  ensureBoard(home);
  registerAgent({ agent, capabilities: ['task-board'], description: 'A2A endpoint in front of the board', home });

  let url = publicUrl ?? `http://${host}:${port}`;
  const contextFor = (id) => showTask(id, { home })?.task?.meta?.contextId ?? null;

  const card = () => ({
    protocolVersion: '1.0',
    name,
    description,
    version,
    url,
    preferredTransport: 'JSONRPC',
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'task-status'],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    skills: [
      {
        id: 'task-board',
        name: 'Shared task board',
        description:
          'Post a task with an objective and acceptance criteria; a local agent claims it under a lease and returns a result artifact.',
        tags: ['tasks', 'queue', 'coordination', 'multi-agent'],
        examples: ['Port the CSV exporter and make tests/export_test.py pass', 'Review the draft in docs/draft.md'],
        inputModes: ['text'],
        outputModes: ['text', 'task-status'],
      },
    ],
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ],
    securitySchemes: token ? { bearer: { type: 'http', scheme: 'bearer' } } : {},
  });

  const authorized = (req) => {
    if (!token) return true;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${token}`;
  };

  async function waitTerminal(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = showTask(id, { home });
      if (!hit) return null;
      if (TERMINAL.has(hit.task.state)) return hit.task;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return showTask(id, { home })?.task ?? null;
  }

  async function createFromMessage(message, configuration = {}) {
    const text = partsToText(message);
    if (!text) {
      const err = new Error('message has no text parts');
      err.a2a = A2A_ERROR.INVALID_PARAMS;
      throw err;
    }
    const taskId = typeof message?.taskId === 'string' ? message.taskId : null;
    if (taskId) {
      const existing = showTask(taskId, { home });
      if (!existing) {
        const err = new Error(`task ${taskId} not found`);
        err.a2a = A2A_ERROR.TASK_NOT_FOUND;
        throw err;
      }
      if (TERMINAL.has(existing.task.state)) {
        const err = new Error('task already reached a terminal state; post a new task');
        err.a2a = A2A_ERROR.UNSUPPORTED_OPERATION;
        throw err;
      }
    }
    const contextId = typeof message?.contextId === 'string' && message.contextId ? message.contextId : crypto.randomUUID();
    const messageId = typeof message?.messageId === 'string' ? message.messageId : crypto.randomUUID();
    const task = postTask({
      title: titleOf(text),
      body: text,
      from: 'a2a',
      to: agent,
      meta: { contextId, messageId, channel: 'a2a' },
      home,
    });
    onLog(`a2a task ${task.id} from ${messageId} (${configuration.blocking === false ? 'async' : 'sync'})`);
    return task;
  }

  async function handleRpc(req, res) {
    const body = await readBody(req);
    const { id = null, method, params = {} } = body ?? {};
    const respond = (result) => sendJson(res, 200, { jsonrpc: '2.0', id, result });
    const fail = (code, message, data) => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

    try {
      switch (method) {
        case 'message/send':
        case 'SendMessage': {
          const task = await createFromMessage(params.message, params.configuration);
          if (params.configuration?.blocking === false || params.configuration?.returnImmediately === true) {
            return respond(toA2ATask(task));
          }
          const final = await waitTerminal(task.id, blockTimeoutMs);
          return respond(toA2ATask(final ?? task));
        }
        case 'message/stream':
        case 'SendStreamingMessage': {
          const task = await createFromMessage(params.message, params.configuration);
          return streamTask(res, task);
        }
        case 'tasks/get':
        case 'GetTask': {
          const taskId = params.id ?? params.taskId;
          const hit = taskId ? showTask(taskId, { home }) : null;
          if (!hit) return fail(A2A_ERROR.TASK_NOT_FOUND, `task ${taskId} not found`);
          return respond(toA2ATask(hit.task));
        }
        case 'tasks/cancel':
        case 'CancelTask': {
          const taskId = params.id ?? params.taskId;
          const hit = taskId ? showTask(taskId, { home }) : null;
          if (!hit) return fail(A2A_ERROR.TASK_NOT_FOUND, `task ${taskId} not found`);
          if (TERMINAL.has(hit.task.state)) return fail(A2A_ERROR.TASK_NOT_CANCELABLE, 'task already reached a terminal state');
          const cancelled = cancelTask({ id: taskId, by: 'a2a', reason: 'cancelled by remote client', home });
          return respond(toA2ATask(cancelled));
        }
        case 'tasks/resubscribe':
        case 'ResubscribeTask': {
          const taskId = params.id ?? params.taskId;
          const hit = taskId ? showTask(taskId, { home }) : null;
          if (!hit) return fail(A2A_ERROR.TASK_NOT_FOUND, `task ${taskId} not found`);
          if (TERMINAL.has(hit.task.state)) return fail(A2A_ERROR.UNSUPPORTED_OPERATION, 'task already finished');
          return streamTask(res, hit.task);
        }
        default:
          return fail(A2A_ERROR.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (e) {
      if (e?.a2a) return fail(e.a2a, e.message);
      return fail(A2A_ERROR.INTERNAL, String(e?.message ?? e));
    }
  }

  function streamTask(res, task) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    emit(toA2ATask(task));

    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const timer = setInterval(() => {
      if (closed) return clearInterval(timer);
      const hit = showTask(task.id, { home });
      if (!hit) {
        emit(rpcError(A2A_ERROR.TASK_NOT_FOUND, 'task disappeared'));
        clearInterval(timer);
        return res.end();
      }
      const final = TERMINAL.has(hit.task.state);
      emit(stateUpdate(hit.task, final));
      if (final) {
        clearInterval(timer);
        res.end();
      }
    }, pollMs);
    timer.unref?.();
  }

  async function handler(req, res) {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/.well-known/agent-card.json') return sendJson(res, 200, card());
      if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, agent, board: homeOf(home) });
      if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (req.method === 'POST' && (path === '/' || path === '/rpc' || path === '/a2a/jsonrpc')) return handleRpc(req, res);
      if (req.method === 'POST' && path === '/message:send') {
        const body = await readBody(req);
        const task = await createFromMessage(body.message, body.configuration);
        return sendJson(res, 200, toA2ATask(task));
      }
      if (req.method === 'POST' && path === '/message:stream') {
        const body = await readBody(req);
        const task = await createFromMessage(body.message, body.configuration);
        return streamTask(res, task);
      }
      const taskMatch = path.match(/^\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && taskMatch) {
        const hit = showTask(decodeURIComponent(taskMatch[1]), { home });
        if (!hit) return sendJson(res, 404, { error: 'task not found' });
        return sendJson(res, 200, toA2ATask(hit.task));
      }
      const cancelMatch = path.match(/^\/tasks\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[1]);
        const hit = showTask(id, { home });
        if (!hit) return sendJson(res, 404, { error: 'task not found' });
        if (TERMINAL.has(hit.task.state)) return sendJson(res, 409, { error: 'task is not cancelable' });
        return sendJson(res, 200, toA2ATask(cancelTask({ id, by: 'a2a', reason: 'cancelled by remote client', home })));
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: String(e?.message ?? e) });
    }
  }

  const server = http.createServer(handler);
  server.on('clientError', (_err, socket) => socket.destroy());

  return {
    server,
    card,
    get url() {
      return url;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') url = publicUrl ?? `http://${host}:${addr.port}`;
          resolve({ port: addr.port, url });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
