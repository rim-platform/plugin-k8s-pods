#!/usr/bin/env node

// node_modules/@rim-platform/plugin-sdk/dist/node.js
import { Console } from "node:console";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// node_modules/@rim-platform/plugin-sdk/dist/manifest.js
function parseManifestInfo(text2, source) {
  const raw = JSON.parse(text2);
  if (typeof raw !== "object" || raw === null || typeof raw.plugin_id !== "string") {
    throw new Error(`${source} is not a plugin manifest: plugin_id is missing`);
  }
  const manifest = raw;
  const commands = /* @__PURE__ */ new Map();
  for (const entry of arrayOf(manifest.commands)) {
    if (typeof entry.id === "string")
      commands.set(entry.id, entry.dangerous === true);
  }
  const panelIds = /* @__PURE__ */ new Set();
  for (const entry of arrayOf(manifest.panels)) {
    if (typeof entry.id === "string")
      panelIds.add(entry.id);
  }
  return { pluginId: manifest.plugin_id, commands, panelIds };
}
function arrayOf(value) {
  if (!Array.isArray(value))
    return [];
  return value.filter((entry) => typeof entry === "object" && entry !== null);
}

// node_modules/@rim-platform/plugin-sdk/dist/generated/protocol.js
var PROTOCOL_VERSION = 1;
var MAX_FRAME_BYTES = 4194304;
var ErrorCode = {
  /** the frame is not valid JSON. */
  PARSE_ERROR: -32700,
  /** the JSON is not a valid JSON-RPC 2.0 message. */
  INVALID_REQUEST: -32600,
  /** the receiver does not implement the method. */
  METHOD_NOT_FOUND: -32601,
  /** params are missing or have the wrong shape, including an unknown commandId. */
  INVALID_PARAMS: -32602,
  /** the receiver failed while handling a valid request. */
  INTERNAL_ERROR: -32603,
  /** the user has not approved the capability the method needs. */
  CAPABILITY_DENIED: -32e3,
  /** the plugin called a capability more often than its per-minute limit. */
  RATE_LIMITED: -32001,
  /** the plugin ran the command and it failed; message says why. */
  PLUGIN_ERROR: -32002
};
var Method = {
  handshake: "rim.handshake",
  heartbeat: "rim.heartbeat",
  shutdown: "rim.shutdown",
  principalChanged: "rim.principal.changed",
  principalsRemapped: "rim.principals.remapped",
  commandExecute: "rim.command.execute",
  log: "rim.log"
};

// node_modules/@rim-platform/plugin-sdk/dist/framing.js
var HEADER_BYTES = 4;
var FrameTooLargeError = class extends Error {
  /** Length the frame claimed or would have had, in bytes. */
  length;
  constructor(length) {
    super(`frame of ${length} bytes is over the ${MAX_FRAME_BYTES}-byte limit`);
    this.name = "FrameTooLargeError";
    this.length = length;
  }
};
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
function encodeText(text2) {
  const body = encoder.encode(text2);
  if (body.length > MAX_FRAME_BYTES)
    throw new FrameTooLargeError(body.length);
  const frame = new Uint8Array(HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, HEADER_BYTES);
  return frame;
}
var FrameDecoder = class {
  chunks = [];
  buffered = 0;
  /**
   * Add bytes from the stream and return every frame they complete, in order.
   * A frame whose body is not UTF-8 JSON comes back with `ok: false`; the
   * protocol says to log and drop it, and the stream stays usable.
   *
   * @throws FrameTooLargeError when a length prefix is over {@link MAX_FRAME_BYTES}.
   */
  push(chunk) {
    return this.pushBodies(chunk).map(parse);
  }
  /**
   * Add bytes from the stream and return the text of every frame they complete,
   * in order, or `null` for a frame whose body is not UTF-8.
   *
   * @throws FrameTooLargeError when a length prefix is over {@link MAX_FRAME_BYTES}.
   */
  pushText(chunk) {
    return this.pushBodies(chunk).map((body) => {
      try {
        return decoder.decode(body);
      } catch {
        return null;
      }
    });
  }
  pushBodies(chunk) {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames = [];
    while (this.buffered >= HEADER_BYTES) {
      const header = this.peek(HEADER_BYTES);
      const length = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(0, true);
      if (length > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(length);
      if (this.buffered < HEADER_BYTES + length)
        break;
      frames.push(this.take(HEADER_BYTES + length).subarray(HEADER_BYTES));
    }
    return frames;
  }
  /** Bytes received that do not make up a whole frame yet. */
  get pendingBytes() {
    return this.buffered;
  }
  peek(count) {
    if (this.chunks[0].length < count)
      this.chunks = [concat(this.chunks, this.buffered)];
    return this.chunks[0].subarray(0, count);
  }
  take(count) {
    const all = this.chunks.length === 1 ? this.chunks[0] : concat(this.chunks, this.buffered);
    this.chunks = all.length > count ? [all.subarray(count)] : [];
    this.buffered -= count;
    return all.subarray(0, count);
  }
};
function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function parse(body) {
  try {
    return { ok: true, value: JSON.parse(decoder.decode(body)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// node_modules/@rim-platform/plugin-sdk/dist/transport.js
var encoder2 = new TextEncoder();
function streamTransport(input, output) {
  return {
    messages: (async function* () {
      const decoder2 = new FrameDecoder();
      for await (const chunk of input) {
        for (const frame of decoder2.pushText(typeof chunk === "string" ? encoder2.encode(chunk) : chunk)) {
          yield frame ?? "";
        }
      }
    })(),
    send(text2) {
      output.write(encodeText(text2));
    },
    /** Resolves once everything written before it has been handed to the stream. */
    flush() {
      return new Promise((done) => output.write(new Uint8Array(0), () => done()));
    },
    close() {
    }
  };
}
function portTransport(port) {
  const queue = [];
  let wake = null;
  let closed = false;
  let failure = null;
  port.onmessage = (event) => {
    if (closed)
      return;
    const data = typeof event.data === "string" ? event.data : "";
    const bytes = data.length > MAX_FRAME_BYTES ? data.length : encoder2.encode(data).length;
    if (bytes > MAX_FRAME_BYTES) {
      failure = new FrameTooLargeError(bytes);
      closed = true;
    } else {
      queue.push(data);
    }
    wake?.();
  };
  const events = port;
  events.addEventListener?.("close", () => {
    closed = true;
    wake?.();
  });
  return {
    messages: (async function* () {
      for (; ; ) {
        while (queue.length > 0)
          yield queue.shift();
        if (failure)
          throw failure;
        if (closed)
          return;
        await new Promise((resolve2) => {
          wake = resolve2;
        });
        wake = null;
      }
    })(),
    send(text2) {
      const bytes = encoder2.encode(text2).length;
      if (bytes > MAX_FRAME_BYTES)
        throw new FrameTooLargeError(bytes);
      port.postMessage(text2);
    },
    close() {
      closed = true;
      port.onmessage = null;
      port.close();
      wake?.();
    }
  };
}

// node_modules/@rim-platform/plugin-sdk/dist/node.js
function readManifest(path) {
  const fullPath = resolve(path);
  let text2;
  try {
    text2 = readFileSync(fullPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return void 0;
    throw error;
  }
  return parseManifestInfo(text2, fullPath);
}
var nodePlatform = {
  streams: () => ({ input: process.stdin, output: process.stdout }),
  claimStdio() {
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
    return (code) => process.exit(code);
  },
  readManifest,
  stderr: (line) => process.stderr.write(`${line}
`)
};

// node_modules/@rim-platform/plugin-sdk/dist/errors.js
var PluginError = class extends Error {
  /** JSON-RPC error code, one of {@link ErrorCode} or a code the plugin documents. */
  code;
  /** Optional machine-readable details, sent as `error.data`. Must be JSON. */
  data;
  constructor(message, options = {}) {
    super(message);
    this.name = "PluginError";
    this.code = options.code ?? ErrorCode.PLUGIN_ERROR;
    this.data = options.data;
  }
};
var HostRequestError = class extends Error {
  /** The method the plugin called. */
  method;
  /** JSON-RPC error code the host sent, such as `CAPABILITY_DENIED`. */
  code;
  /** `error.data` from the host, if any. */
  data;
  constructor(method, error) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = "HostRequestError";
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
};
function toWireError(error, fallbackCode) {
  if (error instanceof PluginError) {
    const wireError = { code: error.code, message: error.message };
    if (error.data !== void 0)
      wireError.data = error.data;
    return wireError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message: message || "unknown error" };
}

// node_modules/@rim-platform/plugin-sdk/dist/principal.js
var MalformedPrincipalError = class extends Error {
  constructor(value) {
    super(`malformed principal: ${JSON.stringify(value)}`);
    this.name = "MalformedPrincipalError";
  }
};
function readPrincipal(value) {
  if (value === null)
    return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new MalformedPrincipalError(value);
  const { principalId, displayName } = value;
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new MalformedPrincipalError(value);
  }
  if (typeof displayName !== "string")
    throw new MalformedPrincipalError(value);
  return Object.freeze({ principalId, displayName });
}
var MalformedMappingError = class extends Error {
  constructor(value) {
    super(`malformed principal mapping: ${JSON.stringify(value)}`);
    this.name = "MalformedMappingError";
  }
};
function readPrincipalMappings(value) {
  if (!Array.isArray(value))
    throw new MalformedMappingError(value);
  return Object.freeze(value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new MalformedMappingError(item);
    }
    const { from, to } = item;
    if (typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0) {
      throw new MalformedMappingError(item);
    }
    return Object.freeze({ from, to });
  }));
}
function samePrincipal(a, b) {
  if (a === null || b === null)
    return a === b;
  return a.principalId === b.principalId && a.displayName === b.displayName;
}

// node_modules/@rim-platform/plugin-sdk/dist/plugin.js
var SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
var DEFAULT_REQUEST_TIMEOUT_MS = 3e4;
var UPDATE_PANEL_METHOD = "rim.ui.update_panel";
var STORAGE_GET_METHOD = "rim.storage.get";
var STORAGE_SET_METHOD = "rim.storage.set";
var CHAT_LIST_MESSAGES_METHOD = "rim.chat.list_messages";
var CHAT_GET_MESSAGE_METHOD = "rim.chat.get_message";
var CHAT_SEARCH_MESSAGES_METHOD = "rim.chat.search_messages";
var CHAT_POST_MESSAGE_METHOD = "rim.chat.post_message";
function createDefinePlugin(platform) {
  return (definition) => definePluginOn(platform, definition);
}
function definePluginOn(platform, definition) {
  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new TypeError("definePlugin: id must be the plugin_id from rim-plugin.json");
  }
  const commands = /* @__PURE__ */ new Map();
  for (const [id, command] of Object.entries(definition.commands ?? {})) {
    if (typeof command?.run !== "function") {
      throw new TypeError(`definePlugin: command ${id} needs a run function`);
    }
    commands.set(id, command);
  }
  return Object.freeze({
    id: definition.id,
    run: (options = {}) => runPlugin(platform, definition, commands, options)
  });
}
async function runPlugin(platform, definition, commands, options) {
  const port = globalThis.rimPluginPort;
  const onStreams = options.input === void 0 && options.output === void 0;
  let transport;
  let exit = options.exit;
  if (options.transport) {
    transport = options.transport;
  } else if (port && onStreams) {
    transport = portTransport(port);
  } else {
    const streams = options.input === void 0 || options.output === void 0 ? platform.streams() : void 0;
    transport = streamTransport(options.input ?? streams.input, options.output ?? streams.output);
    if (onStreams)
      exit ??= platform.claimStdio();
  }
  const session = new Session(definition, commands, (text2) => transport.send(text2), loadManifest(platform, options.manifestPath), options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, platform);
  let code = 0;
  try {
    for await (const text2 of transport.messages) {
      session.receiveText(text2);
      if (session.stopping)
        break;
    }
  } catch (error) {
    session.log("error", `connection failed: ${error instanceof Error ? error.message : error}`);
    code = error instanceof FrameTooLargeError ? 1 : 2;
  }
  await session.close();
  await transport.flush?.();
  transport.close();
  exit?.(code);
}
function loadManifest(platform, path) {
  if (path === false)
    return {};
  const text2 = globalThis.rimPluginManifest;
  const source = path ?? (typeof text2 === "string" ? "rimPluginManifest" : "rim-plugin.json");
  try {
    if (path === void 0 && typeof text2 === "string") {
      return { manifest: parseManifestInfo(text2, source) };
    }
    return { manifest: platform.readManifest(source) };
  } catch (error) {
    return {
      problem: `cannot read ${source}: ${error instanceof Error ? error.message : error}`
    };
  }
}
var Session = class {
  stopping = false;
  host;
  definition;
  commands;
  send;
  platform;
  manifest;
  manifestProblem;
  requestTimeoutMs;
  pending = /* @__PURE__ */ new Map();
  nextRequestId = 1;
  ready = false;
  closed = false;
  hostVersion = "";
  protocolVersion = PROTOCOL_VERSION;
  grantedCapabilities = Object.freeze([]);
  principal = null;
  constructor(definition, commands, send, loaded, requestTimeoutMs, platform) {
    this.definition = definition;
    this.commands = commands;
    this.send = send;
    this.platform = platform;
    this.manifest = loaded.manifest;
    this.requestTimeoutMs = requestTimeoutMs;
    this.manifestProblem = loaded.problem ?? (loaded.manifest && loaded.manifest.pluginId !== definition.id ? `rim-plugin.json declares ${loaded.manifest.pluginId}, but the code defines ${definition.id}` : void 0);
    this.host = this.createHost();
    if (this.manifestProblem)
      this.log("error", this.manifestProblem);
    for (const id of this.manifest?.commands.keys() ?? []) {
      if (!commands.has(id))
        this.log("warn", `rim-plugin.json declares command ${id}, which has no handler`);
    }
    for (const id of commands.keys()) {
      if (this.manifest && !this.manifest.commands.has(id)) {
        this.log("warn", `command ${id} is not in rim-plugin.json, so the host never runs it`);
      }
    }
  }
  /** Handle the JSON text of one message from the host. */
  receiveText(text2) {
    let frame;
    try {
      frame = JSON.parse(text2);
    } catch {
      this.log("warn", "dropped a message that is not JSON");
      return;
    }
    this.receive(frame);
  }
  /** Handle one parsed message from the host. */
  receive(frame) {
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") {
      this.log("warn", "dropped a frame that is not JSON-RPC 2.0");
      return;
    }
    const { method, id } = frame;
    if (typeof method === "string") {
      if (id === void 0 || id === null)
        this.onNotification(method, frame.params);
      else if (isId(id))
        void this.onRequest(method, frame.params, id);
      else
        this.log("warn", `dropped ${method}: its id is neither a number nor a string`);
      return;
    }
    if (isId(id) && ("result" in frame || "error" in frame)) {
      this.onResponse(id, frame);
      return;
    }
    this.log("warn", "dropped a frame that is neither a request, a notification nor a response");
  }
  /** Write a line to the host log, or to stderr once the connection is closed. */
  log(level, message) {
    const frame = {
      jsonrpc: "2.0",
      method: Method.log,
      params: { level, message }
    };
    if (!this.closed) {
      try {
        this.write(frame);
        return;
      } catch {
      }
    }
    this.platform.stderr(`[${level}] ${message}`);
  }
  /** Run `onShutdown` and fail every request still waiting for the host. */
  async close() {
    if (this.closed)
      return;
    this.stopping = true;
    await this.callHook("onShutdown", () => this.definition.onShutdown?.());
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new HostRequestError(entry.method, {
        code: ErrorCode.INTERNAL_ERROR,
        message: "the connection to the host closed"
      }));
      this.pending.delete(id);
    }
  }
  async onRequest(method, params, id) {
    try {
      switch (method) {
        case Method.handshake: {
          const result = this.handshake(params);
          const response = { jsonrpc: "2.0", id, result };
          this.write(response);
          if (result.accepted) {
            await this.callHook("onReady", () => this.definition.onReady?.(this.host));
          }
          return;
        }
        case Method.heartbeat: {
          const response = { jsonrpc: "2.0", id, result: { pong: true } };
          this.write(response);
          return;
        }
        case Method.commandExecute: {
          let response;
          try {
            response = { jsonrpc: "2.0", id, result: await this.execute(params) };
          } catch (error) {
            response = { jsonrpc: "2.0", id, error: toWireError(error, ErrorCode.PLUGIN_ERROR) };
          }
          this.writeAnswer(response);
          return;
        }
        default:
          this.writeError(id, ErrorCode.METHOD_NOT_FOUND, `method not found: ${method}`);
      }
    } catch (error) {
      this.writeError(id, ErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }
  onNotification(method, params) {
    if (method === Method.shutdown) {
      this.stopping = true;
    } else if (method === Method.principalChanged) {
      this.onPrincipalChanged(params);
    } else if (method === Method.principalsRemapped) {
      this.onPrincipalsRemapped(params);
    }
  }
  onResponse(id, frame) {
    const entry = typeof id === "number" ? this.pending.get(id) : void 0;
    if (!entry)
      return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.error !== void 0)
      entry.reject(new HostRequestError(entry.method, readWireError(frame.error)));
    else
      entry.resolve(frame.result);
  }
  handshake(params) {
    const p = isRecord(params) ? params : {};
    const refuse = (error) => {
      this.log("error", `refused the handshake: ${error}`);
      return {
        accepted: false,
        protocolVersion: SUPPORTED_VERSIONS[0],
        pluginId: this.definition.id,
        error
      };
    };
    if (this.manifestProblem)
      return refuse(this.manifestProblem);
    if (p.pluginId !== this.definition.id) {
      return refuse(`this plugin is ${this.definition.id}, but the host started it as ${String(p.pluginId)}`);
    }
    const hostVersions = Array.isArray(p.supportedVersions) ? p.supportedVersions.filter(isVersion) : isVersion(p.protocolVersion) ? [p.protocolVersion] : [];
    const version = SUPPORTED_VERSIONS.find((v) => hostVersions.includes(v));
    if (version === void 0) {
      return refuse(`the host speaks protocol ${hostVersions.join(", ") || "(none)"}, this plugin speaks ${SUPPORTED_VERSIONS.join(", ")}`);
    }
    let principal = null;
    try {
      principal = readPrincipal(p.principal ?? null);
    } catch (error) {
      this.log("warn", `ignored the handshake principal: ${error.message}`);
    }
    this.principal = principal;
    this.protocolVersion = version;
    this.hostVersion = typeof p.hostVersion === "string" ? p.hostVersion : "";
    this.grantedCapabilities = Object.freeze(Array.isArray(p.grantedCapabilities) ? p.grantedCapabilities.filter((c) => typeof c === "string") : []);
    this.ready = true;
    return { accepted: true, protocolVersion: version, pluginId: this.definition.id };
  }
  async execute(params) {
    if (!this.ready) {
      throw new PluginError("rim.command.execute arrived before the handshake", {
        code: ErrorCode.INVALID_REQUEST
      });
    }
    const p = readExecuteParams(params);
    const command = this.commands.get(p.commandId);
    if (!command) {
      throw new PluginError(`unknown command: ${p.commandId}`, { code: ErrorCode.INVALID_PARAMS });
    }
    const dangerous = command.dangerous === true || this.manifest?.commands.get(p.commandId) === true;
    if (dangerous && !(p.confirmed === true && p.initiator === "user")) {
      throw new PluginError(`${p.commandId} is dangerous and runs only after the user confirms it`, {
        code: ErrorCode.PLUGIN_ERROR,
        data: { reason: "confirmation_required" }
      });
    }
    const context = Object.freeze({ ...p, host: this.host });
    return toCommandResult(p.commandId, await command.run(context));
  }
  onPrincipalChanged(params) {
    let principal;
    try {
      principal = readPrincipal(isRecord(params) ? params.principal : void 0);
    } catch (error) {
      this.log("warn", `ignored rim.principal.changed: ${error.message}`);
      return;
    }
    if (samePrincipal(principal, this.principal))
      return;
    this.principal = principal;
    void this.callHook("onPrincipalChanged", () => this.definition.onPrincipalChanged?.(principal, this.host));
  }
  onPrincipalsRemapped(params) {
    let mappings;
    try {
      mappings = readPrincipalMappings(isRecord(params) ? params.mappings : void 0);
    } catch (error) {
      this.log("warn", `ignored rim.principals.remapped: ${error.message}`);
      return;
    }
    if (mappings.length === 0)
      return;
    void this.callHook("onPrincipalsRemapped", () => this.definition.onPrincipalsRemapped?.(mappings, this.host));
  }
  request(method, params) {
    if (this.closed || this.stopping || !this.ready) {
      const message = this.ready ? "the connection to the host is closing" : "the handshake has not finished";
      return Promise.reject(new HostRequestError(method, { code: ErrorCode.INTERNAL_ERROR, message }));
    }
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostRequestError(method, {
          code: ErrorCode.INTERNAL_ERROR,
          message: `the host did not answer within ${this.requestTimeoutMs} ms`
        }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async updatePanel(panelId, state, patch) {
    if (this.manifest && !this.manifest.panelIds.has(panelId)) {
      throw new PluginError(`panel ${panelId} is not declared in rim-plugin.json`, {
        code: ErrorCode.INVALID_PARAMS
      });
    }
    await this.request(UPDATE_PANEL_METHOD, { panel_id: panelId, state, patch });
  }
  createHost() {
    const session = this;
    return Object.freeze({
      pluginId: this.definition.id,
      get hostVersion() {
        return session.hostVersion;
      },
      get protocolVersion() {
        return session.protocolVersion;
      },
      get grantedCapabilities() {
        return session.grantedCapabilities;
      },
      get principal() {
        return session.principal;
      },
      log: Object.freeze({
        debug: (message) => session.log("debug", message),
        info: (message) => session.log("info", message),
        warn: (message) => session.log("warn", message),
        error: (message) => session.log("error", message)
      }),
      storage: Object.freeze({
        get: async (key) => {
          const result = await session.request(STORAGE_GET_METHOD, { key });
          return isRecord(result) && "value" in result ? result.value : null;
        },
        set: async (key, value) => {
          await session.request(STORAGE_SET_METHOD, { key, value });
        }
      }),
      chat: Object.freeze({
        listMessages: async (conversationId, options = {}) => await session.request(CHAT_LIST_MESSAGES_METHOD, {
          conversationId,
          ...options
        }),
        getMessage: async (messageId) => {
          const result = await session.request(CHAT_GET_MESSAGE_METHOD, { messageId });
          return isRecord(result) && isRecord(result.message) ? result.message : null;
        },
        searchMessages: async (query, options = {}) => {
          const result = await session.request(CHAT_SEARCH_MESSAGES_METHOD, {
            query,
            ...options
          });
          return isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
        },
        postMessage: async (conversationId, body, options = {}) => await session.request(CHAT_POST_MESSAGE_METHOD, {
          conversationId,
          body,
          ...options
        })
      }),
      panels: Object.freeze({
        set: (panelId, state) => session.updatePanel(panelId, state, false),
        patch: (panelId, patch) => {
          if (!isRecord(patch)) {
            return Promise.reject(new TypeError("panels.patch: patch must be an object"));
          }
          return session.updatePanel(panelId, patch, true);
        }
      })
    });
  }
  async callHook(name, hook) {
    try {
      await hook();
    } catch (error) {
      this.log("error", `${name} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  write(frame) {
    const text2 = JSON.stringify(frame);
    const bytes = new TextEncoder().encode(text2).length;
    if (bytes > MAX_FRAME_BYTES)
      throw new FrameTooLargeError(bytes);
    this.send(text2);
  }
  /** Write a response, or an error saying why it could not be sent. */
  writeAnswer(response) {
    try {
      this.write(response);
    } catch (error) {
      this.writeError(response.id, ErrorCode.INTERNAL_ERROR, `could not send the result: ${error.message}`);
    }
  }
  writeError(id, code, message) {
    const response = { jsonrpc: "2.0", id, error: { code, message } };
    this.write(response);
  }
};
function readExecuteParams(params) {
  const invalid2 = (why) => new PluginError(`invalid rim.command.execute params: ${why}`, {
    code: ErrorCode.INVALID_PARAMS
  });
  if (!isRecord(params))
    throw invalid2("params must be an object");
  const { commandId, args, invoker, initiator, confirmed } = params;
  if (typeof commandId !== "string" || commandId.length === 0)
    throw invalid2("commandId must be a string");
  if (args !== void 0 && !isRecord(args))
    throw invalid2("args must be an object");
  if (initiator !== "user" && initiator !== "agent")
    throw invalid2("initiator must be user or agent");
  if (typeof confirmed !== "boolean")
    throw invalid2("confirmed must be a boolean");
  let principal;
  try {
    principal = readPrincipal(invoker ?? null);
  } catch (error) {
    throw invalid2(error.message);
  }
  return {
    commandId,
    args: Object.freeze({ ...args ?? {} }),
    invoker: principal,
    initiator,
    confirmed
  };
}
function toCommandResult(commandId, output) {
  if (output === void 0 || output === null)
    return {};
  if (typeof output !== "object" || Array.isArray(output)) {
    throw new PluginError(`command ${commandId} returned a ${typeof output}; return { payload, message }`, {
      code: ErrorCode.INTERNAL_ERROR
    });
  }
  const result = {};
  if (output.payload !== void 0)
    result.payload = output.payload;
  if (output.message !== void 0) {
    if (typeof output.message !== "string") {
      throw new PluginError(`command ${commandId} returned a message that is not a string`, {
        code: ErrorCode.INTERNAL_ERROR
      });
    }
    result.message = output.message;
  }
  return result;
}
function readWireError(value) {
  if (isRecord(value) && typeof value.code === "number" && typeof value.message === "string") {
    return { code: value.code, message: value.message, data: value.data };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: "the host sent a malformed error" };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isInteger(value);
}
function isVersion(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// node_modules/@rim-platform/plugin-sdk/dist/index.js
var definePlugin = createDefinePlugin(nodePlatform);

// src/kubectl.ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
var KubeError = class extends Error {
  kind;
  detail;
  constructor(kind, detail) {
    super(detail);
    this.name = "KubeError";
    this.kind = kind;
    this.detail = detail;
  }
};
var CALL_TIMEOUT_MS = 2e4;
var REQUEST_TIMEOUT = "--request-timeout=15s";
var MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
var MAX_DETAIL_LENGTH = 300;
function fallbackDirs() {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".rd", "bin")
  ];
}
function findKubectl(env = process.env) {
  if (env.RIM_KUBECTL) return env.RIM_KUBECTL;
  const name = process.platform === "win32" ? "kubectl.exe" : "kubectl";
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...fallbackDirs()];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}
function systemKubectl(binary = findKubectl()) {
  return (args) => new Promise((resolve2, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve2(stdout);
        const code = error.code;
        if (code === "ENOENT") {
          return reject(new KubeError("kubectl_missing", `${binary} was not found`));
        }
        if (error.killed || error.signal) {
          return reject(
            new KubeError(
              "unreachable",
              `kubectl did not answer within ${CALL_TIMEOUT_MS / 1e3} seconds`
            )
          );
        }
        reject(classify(stderr || error.message));
      }
    );
  });
}
function classify(stderr) {
  const text2 = stderr.trim();
  const detail = firstErrorLine(text2);
  const kind = (() => {
    if (/\bforbidden\b/i.test(text2)) return "forbidden";
    if (/unauthorized|must be logged in|provide credentials/i.test(text2)) return "unauthorized";
    if (/context .*(does not exist|not found)|no context exists/i.test(text2))
      return "context_missing";
    if (/no configuration has been provided|current-context is not set|invalid configuration/i.test(
      text2
    ))
      return "no_kubeconfig";
    if (/unable to connect to the server|connection refused|was refused|no such host|i\/o timeout|dial tcp|tls handshake timeout|context deadline exceeded|network is unreachable|connection reset|server is currently unable/i.test(
      text2
    ))
      return "unreachable";
    if (/\bnot ?found\b/i.test(text2)) return "not_found";
    return "failed";
  })();
  return new KubeError(kind, detail);
}
function firstErrorLine(text2) {
  const lines = text2.split(/\r?\n/).map((line2) => line2.trim());
  const line = lines.find((l) => /^error/i.test(l)) ?? lines.find((l) => l.length > 0) ?? "kubectl failed";
  const clean = line.replace(/^error(:\s*)?/i, "").trim() || line;
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}\u2026` : clean;
}
async function readConfig(kubectl) {
  const raw = parseJson(await kubectl(["config", "view", "-o", "json"]));
  const contexts = [];
  const namespaces = {};
  for (const entry of asArray(raw.contexts)) {
    if (typeof entry.name !== "string" || entry.name.length === 0) continue;
    contexts.push(entry.name);
    const namespace = asRecord(entry.context).namespace;
    if (typeof namespace === "string" && namespace.length > 0) namespaces[entry.name] = namespace;
  }
  if (contexts.length === 0) {
    throw new KubeError("no_kubeconfig", "the kubeconfig has no contexts");
  }
  const current = raw["current-context"];
  return {
    contexts,
    current: typeof current === "string" && contexts.includes(current) ? current : null,
    namespaces
  };
}
async function listNamespaces(kubectl, context) {
  try {
    const raw = parseJson(
      await kubectl(["get", "namespaces", "-o", "json", `--context=${context}`, REQUEST_TIMEOUT])
    );
    return asArray(raw.items).map((item) => asRecord(item.metadata).name).filter((name) => typeof name === "string").sort();
  } catch (error) {
    if (error instanceof KubeError && error.kind === "forbidden") return null;
    throw error;
  }
}
async function getPods(kubectl, context, namespace) {
  return parseJson(
    await kubectl([
      "get",
      "pods",
      "-o",
      "json",
      `--context=${context}`,
      `--namespace=${namespace}`,
      REQUEST_TIMEOUT
    ])
  );
}
async function getPod(kubectl, context, namespace, pod) {
  return parseJson(
    await kubectl([
      "get",
      "pod",
      pod,
      "-o",
      "json",
      `--context=${context}`,
      `--namespace=${namespace}`,
      REQUEST_TIMEOUT
    ])
  );
}
async function deletePod(kubectl, context, namespace, pod) {
  await kubectl([
    "delete",
    "pod",
    pod,
    "--wait=false",
    `--context=${context}`,
    `--namespace=${namespace}`,
    REQUEST_TIMEOUT
  ]);
}
function parseJson(text2) {
  try {
    return asRecord(JSON.parse(text2));
  } catch {
    throw new KubeError("failed", "kubectl printed something that is not JSON");
  }
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function asArray(value) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

// src/pods.ts
function summarizePods(list, now) {
  return asArray(asRecord(list).items).map((pod) => summarizePod(pod, now)).sort((a, b) => a.name.localeCompare(b.name));
}
function summarizePod(pod, now) {
  const metadata = asRecord(pod.metadata);
  const spec = asRecord(pod.spec);
  const columns = podColumns(pod);
  const created = typeof metadata.creationTimestamp === "string" ? metadata.creationTimestamp : "";
  const createdAt = created && !Number.isNaN(Date.parse(created)) ? created : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name : "(unnamed)",
    status: columns.status,
    ready: `${columns.readyCount}/${columns.containerCount}`,
    restarts: columns.restarts,
    age: createdAt ? formatAge(new Date(createdAt), now) : "",
    createdAt,
    node: typeof spec.nodeName === "string" ? spec.nodeName : "",
    controller: controllerOf(pod)
  };
}
function podColumns(pod) {
  const metadata = asRecord(pod.metadata);
  const spec = asRecord(pod.spec);
  const status = asRecord(pod.status);
  const conditions = asArray(status.conditions);
  let reason = text(status.reason) || text(status.phase) || "Unknown";
  if (conditions.some((c) => c.type === "PodScheduled" && c.reason === "SchedulingGated")) {
    reason = "SchedulingGated";
  }
  const initSpecs = asArray(spec.initContainers);
  const sidecars = new Set(
    initSpecs.filter((c) => c.restartPolicy === "Always").map((c) => text(c.name))
  );
  const inits = asArray(status.initContainerStatuses);
  const initCount = Math.max(initSpecs.length, inits.length);
  const containerCount = Math.max(asArray(spec.containers).length, asArray(status.containerStatuses).length) + sidecars.size;
  let readyCount = 0;
  let restarts = 0;
  let sidecarRestarts = 0;
  let initializing = false;
  for (const [index, init] of inits.entries()) {
    const sidecar = sidecars.has(text(init.name));
    restarts += restartCount(init);
    if (sidecar) sidecarRestarts += restartCount(init);
    const state = asRecord(init.state);
    const terminated = asRecord(state.terminated);
    const waiting = asRecord(state.waiting);
    if (state.terminated !== void 0 && terminated.exitCode === 0) continue;
    if (sidecar && init.started === true) {
      if (init.ready === true) readyCount++;
      continue;
    }
    initializing = true;
    if (state.terminated !== void 0) {
      reason = `Init:${text(terminated.reason) || exitText(terminated)}`;
    } else if (text(waiting.reason) && waiting.reason !== "PodInitializing") {
      reason = `Init:${text(waiting.reason)}`;
    } else {
      reason = `Init:${index}/${initCount}`;
    }
    break;
  }
  const initialized = conditions.some((c) => c.type === "Initialized" && c.status === "True");
  if (!initializing || initialized) {
    restarts = sidecarRestarts;
    let running = false;
    for (const container of asArray(status.containerStatuses).reverse()) {
      restarts += restartCount(container);
      const state = asRecord(container.state);
      const waiting = asRecord(state.waiting);
      const terminated = asRecord(state.terminated);
      if (text(waiting.reason)) {
        reason = text(waiting.reason);
      } else if (state.terminated !== void 0) {
        reason = text(terminated.reason) || exitText(terminated);
      } else if (state.running !== void 0 && container.ready === true) {
        running = true;
        readyCount++;
      }
    }
    if (reason === "Completed" && running) {
      const ready = conditions.some((c) => c.type === "Ready" && c.status === "True");
      reason = ready ? "Running" : "NotReady";
    }
  }
  if (metadata.deletionTimestamp !== void 0 && metadata.deletionTimestamp !== null) {
    if (status.reason === "NodeLost") {
      reason = "Unknown";
    } else if (status.phase !== "Succeeded" && status.phase !== "Failed") {
      reason = "Terminating";
    }
  }
  return { status: reason, readyCount, containerCount, restarts };
}
function controllerOf(pod) {
  const owner = asArray(asRecord(pod.metadata).ownerReferences).find((o) => o.controller === true);
  if (!owner || typeof owner.kind !== "string" || typeof owner.name !== "string") return null;
  return `${owner.kind}/${owner.name}`;
}
function formatAge(from, now) {
  const seconds = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1e3));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 730) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}
function restartCount(status) {
  return typeof status.restartCount === "number" ? status.restartCount : 0;
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function exitText(terminated) {
  if (typeof terminated.signal === "number" && terminated.signal !== 0) {
    return `Signal:${terminated.signal}`;
  }
  return `ExitCode:${typeof terminated.exitCode === "number" ? terminated.exitCode : "?"}`;
}

// src/plugin.ts
var PLUGIN_ID = "chat.rim.k8s-pods";
var PANEL_ID = "pods";
var DEFAULT_INTERVAL_SECONDS = 15;
var MIN_INTERVAL_SECONDS = 5;
var MAX_INTERVAL_SECONDS = 3600;
var MAX_PANEL_PODS = 2e3;
var MAX_PAYLOAD_PODS = 500;
var MAX_FILTER_LENGTH = 100;
var NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
var POD_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
var defaultEvery = (ms, run) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};
function createPlugin(options = {}) {
  const kubectl = options.kubectl ?? systemKubectl();
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const every = options.every ?? defaultEvery;
  let state = {
    contexts: [],
    context: null,
    namespace: null,
    namespaces: null,
    filter: "",
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    pods: [],
    totalPods: 0,
    fetchedAt: null,
    loading: false,
    error: null,
    lastAction: null
  };
  let allPods = [];
  const namespaceCache = /* @__PURE__ */ new Map();
  let host = null;
  let panelDenied = false;
  let stopTimer = () => {
  };
  let inFlight = null;
  let queued = null;
  async function publish(patch) {
    state = { ...state, ...patch };
    if (!host || panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, state);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the pods panel stays empty: the ui.panel permission is not approved");
      } else {
        host.log.warn(`could not update the pods panel: ${error.message}`);
      }
    }
  }
  function visiblePods(filter) {
    const needle = filter.trim().toLowerCase();
    const matching = needle ? allPods.filter(
      (p) => p.name.toLowerCase().includes(needle) || p.status.toLowerCase().includes(needle)
    ) : allPods;
    return matching.slice(0, MAX_PANEL_PODS);
  }
  async function resolveSelection() {
    const config = await readConfig(kubectl);
    const keep = state.context !== null && config.contexts.includes(state.context);
    const context = keep ? state.context : config.current ?? config.contexts[0];
    const namespace = keep && state.namespace ? state.namespace : config.namespaces[context] ?? "default";
    return { config, context, namespace };
  }
  async function load() {
    await publish({ loading: true });
    let where = {
      context: state.context,
      namespace: state.namespace
    };
    try {
      const { config, context, namespace } = await resolveSelection();
      where = { context, namespace };
      await publish({ contexts: config.contexts, context, namespace });
      if (!namespaceCache.has(context)) {
        namespaceCache.set(context, await listNamespaces(kubectl, context));
      }
      const list = await getPods(kubectl, context, namespace);
      if (state.context !== context || state.namespace !== namespace) return state;
      allPods = summarizePods(list, now());
      await publish({
        namespaces: namespaceCache.get(context) ?? null,
        pods: visiblePods(state.filter),
        totalPods: allPods.length,
        fetchedAt: now().toISOString(),
        loading: false,
        error: null
      });
    } catch (error) {
      allPods = [];
      await publish({
        pods: [],
        totalPods: 0,
        loading: false,
        error: describe(error, where.context, where.namespace)
      });
    }
    return state;
  }
  function refresh() {
    if (!inFlight) {
      inFlight = load().finally(() => {
        inFlight = null;
      });
      return inFlight;
    }
    queued ??= inFlight.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }
  function startTimer() {
    stopTimer();
    stopTimer = () => {
    };
    if (state.intervalSeconds > 0) {
      stopTimer = every(state.intervalSeconds * 1e3, () => {
        if (!inFlight) void refresh();
      });
    }
  }
  function listingResult(listed) {
    if (listed.error) {
      throw new PluginError(listed.error.message, { data: { reason: listed.error.kind } });
    }
    const pods = listed.pods.slice(0, MAX_PAYLOAD_PODS).map((p) => ({
      name: p.name,
      status: p.status,
      ready: p.ready,
      restarts: p.restarts,
      age: p.age,
      node: p.node
    }));
    const shown = listed.filter && listed.pods.length !== listed.totalPods ? `${listed.pods.length} of ${listed.totalPods} pods match "${listed.filter}"` : `${listed.totalPods} pod${listed.totalPods === 1 ? "" : "s"}`;
    return {
      payload: {
        context: listed.context ?? "",
        namespace: listed.namespace ?? "",
        totalPods: listed.totalPods,
        pods
      },
      message: `${shown} in ${listed.namespace} (${listed.context})`
    };
  }
  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      refresh: {
        async run() {
          return listingResult(await refresh());
        }
      },
      filter: {
        async run({ args }) {
          const text2 = optionalString(args.text, "text", MAX_FILTER_LENGTH);
          const namespace = optionalString(args.namespace, "namespace", 63);
          const context = optionalString(args.context, "context", 253);
          const interval = optionalInterval(args.interval_seconds);
          if (namespace !== void 0 && !NAMESPACE.test(namespace)) {
            throw invalid(`"${namespace}" is not a namespace name`);
          }
          if (context !== void 0) {
            const config = await readConfig(kubectl).catch((error) => {
              throw toPluginError(error, null, null);
            });
            if (!config.contexts.includes(context)) {
              throw invalid(`context "${context}" is not in your kubeconfig`);
            }
          }
          const nothingGiven = text2 === void 0 && namespace === void 0 && context === void 0 && interval === void 0;
          const contextChanged = context !== void 0 && context !== state.context;
          const patch = {};
          if (text2 !== void 0 || nothingGiven) patch.filter = (text2 ?? "").trim();
          if (context !== void 0) patch.context = context;
          if (namespace !== void 0) patch.namespace = namespace;
          else if (contextChanged) patch.namespace = null;
          if (interval !== void 0) patch.intervalSeconds = interval;
          if (patch.filter !== void 0) patch.pods = visiblePods(patch.filter);
          await publish(patch);
          if (interval !== void 0) startTimer();
          return listingResult(await refresh());
        }
      },
      restart_pod: {
        dangerous: true,
        async run({ args }) {
          const pod = requiredName(args.pod);
          const namespaceArg = optionalString(args.namespace, "namespace", 63);
          const contextArg = optionalString(args.context, "context", 253);
          if (namespaceArg !== void 0 && !NAMESPACE.test(namespaceArg)) {
            throw invalid(`"${namespaceArg}" is not a namespace name`);
          }
          let context = contextArg ?? state.context;
          let namespace = namespaceArg ?? null;
          try {
            const config = await readConfig(kubectl);
            context ??= config.current ?? config.contexts[0];
            if (!config.contexts.includes(context)) {
              throw invalid(`context "${context}" is not in your kubeconfig`);
            }
            namespace ??= (context === state.context ? state.namespace : null) ?? config.namespaces[context] ?? "default";
            const controller = controllerOf(await getPod(kubectl, context, namespace, pod));
            if (!controller) {
              throw new PluginError(
                `${pod} has no controller to start it again, so restarting it would delete it for good. Only pods managed by a Deployment, StatefulSet, DaemonSet, ReplicaSet or Job can be restarted here.`,
                { data: { reason: "no_controller" } }
              );
            }
            if (controller.startsWith("Node/")) {
              throw new PluginError(
                `${pod} is a static pod: the kubelet on its node runs it from a file, so deleting it here restarts nothing. Restart it on the node instead.`,
                { data: { reason: "static_pod" } }
              );
            }
            await deletePod(kubectl, context, namespace, pod);
            const message = `Restarted ${pod} in ${namespace}: ${controller} starts a new pod.`;
            await publish({ lastAction: action(pod, namespace, context, true, message) });
            void refresh();
            return { payload: { pod, namespace, context, controller }, message };
          } catch (error) {
            const failure = error instanceof PluginError ? error : toPluginError(error, context, namespace);
            await publish({
              lastAction: action(
                pod,
                namespace ?? "",
                context ?? "",
                false,
                `Could not restart ${pod}: ${failure.message}`
              )
            });
            throw failure;
          }
        }
      }
    },
    async onReady(ready) {
      host = ready;
      host.log.info("listing pods with kubectl on this device; credentials stay local");
      startTimer();
      await refresh();
    },
    onShutdown() {
      stopTimer();
      host = null;
    }
  });
  function action(pod, namespace, context, ok, message) {
    return { pod, namespace, context, ok, message, at: now().toISOString() };
  }
}
function describe(error, context, namespace) {
  if (!(error instanceof KubeError)) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const ctx = context ? `"${context}"` : "the current context";
  const ns = namespace ? `"${namespace}"` : "this namespace";
  const message = (() => {
    switch (error.kind) {
      case "kubectl_missing":
        return "kubectl was not found on this device. Install kubectl and restart RIM, so the plugin can find it on your PATH.";
      case "no_kubeconfig":
        return "No kubeconfig found. The plugin reads the same file kubectl does: $KUBECONFIG, or ~/.kube/config.";
      case "context_missing":
        return `The context ${ctx} is not in your kubeconfig. Pick another context.`;
      case "unreachable":
        return `Cannot reach the cluster of ${ctx}. Check your network or VPN, and that the cluster is running.`;
      case "unauthorized":
        return `The cluster of ${ctx} did not accept your credentials. Sign in again with your cluster's tools, then refresh.`;
      case "forbidden":
        return `Your account may not do this in the namespace ${ns} on ${ctx}. Pick another namespace or ask a cluster admin for access.`;
      case "not_found":
        return `Not found in the namespace ${ns}: ${error.detail}`;
      case "failed":
        return `kubectl failed: ${error.detail}`;
    }
  })();
  return { kind: error.kind, message, detail: error.detail };
}
function toPluginError(error, context, namespace) {
  if (error instanceof PluginError) return error;
  const described = describe(error, context, namespace);
  return new PluginError(described.message, { data: { reason: described.kind } });
}
function invalid(message) {
  return new PluginError(message, { code: ErrorCode.INVALID_PARAMS });
}
function optionalString(value, name, maxLength) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  if (value.length > maxLength) throw invalid(`${name} is longer than ${maxLength} characters`);
  return value;
}
function requiredName(value) {
  if (value === void 0 || value === null || value === "") {
    throw invalid("pod is required: use the Restart button next to a pod in the Pods panel");
  }
  if (typeof value !== "string" || !POD_NAME.test(value)) {
    throw invalid(`"${String(value)}" is not a pod name`);
  }
  return value;
}
function optionalInterval(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds !== 0 && (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS)) {
    throw invalid(
      `interval_seconds must be 0 or a whole number from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}`
    );
  }
  return seconds;
}

// src/main.ts
await createPlugin().run();
