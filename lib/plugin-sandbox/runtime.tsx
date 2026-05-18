'use client';

// Runtime that boots inside the null-origin plugin sandbox iframe.
//
// Lifecycle:
//   1. Iframe loads → posts 'sandbox-ready' to parent (targetOrigin '*' is OK;
//      the message carries no secrets, and the parent's first inbound message
//      gives us the origin to pin for everything that follows).
//   2. Parent posts 'init' with the bundle code + manifest + mode/slot.
//   3. We evaluate the bundle in a `new Function` scope with React/ReactDOM
//      injected as globals; the bundle is CommonJS-style (`module.exports = {
//      slots, hooks, activate }`). ES-module syntax inside the bundle is a
//      build-time concern handled by the plugin's bundler.
//   4. In background mode: register hook handlers and call `activate(api)`.
//      The host installs HookBus stubs and dispatches via 'hook-invoke'.
//   5. In slot mode: look up `slots[slot].component`, render it into the
//      iframe body, push height back via ResizeObserver.

import { useEffect, useRef } from 'react';
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import type {
  HostToSandbox,
  SandboxToHost,
  InitPayload,
  BackgroundInit,
  SlotInit,
} from './protocol';
import type { SlotName } from '../plugin-types';

// ─── Module-scope state ──────────────────────────────────────

interface PluginExports {
  slots?: Record<string, { component: React.ComponentType<Record<string, unknown>>; shouldShow?: (ctx: unknown) => boolean; order?: number }>;
  hooks?: Record<string, (...args: unknown[]) => unknown>;
  activate?: (api: unknown) => void | Promise<void> | { dispose: () => void };
  default?: unknown;
}

let parentWindow: Window | null = null;
let parentOrigin: string | null = null;
let pluginExports: PluginExports | null = null;
let mode: 'background' | 'slot' | null = null;
let slotName: SlotName | null = null;
let bootDone = false;

const pendingApi = new Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void }>();
const hookHandlers: Record<string, (...args: unknown[]) => unknown> = {};

function sendToHost(msg: SandboxToHost): void {
  if (!parentWindow || !parentOrigin) return;
  parentWindow.postMessage(msg, parentOrigin);
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Sandboxed API facade (calls flow to host via postMessage) ─

function callApi(method: string, args: unknown[]): Promise<unknown> {
  const id = uid();
  return new Promise((resolve, reject) => {
    pendingApi.set(id, { resolve, reject });
    sendToHost({ type: 'api-request', id, method, args });
    // Reject after 30s to prevent unbounded promise leaks if the host hangs.
    setTimeout(() => {
      const entry = pendingApi.get(id);
      if (!entry) return;
      pendingApi.delete(id);
      entry.reject(new Error(`API call ${method} timed out after 30s`));
    }, 30_000);
  });
}

function buildPluginApi(manifest: BackgroundInit['manifest']) {
  return {
    plugin: {
      id: manifest.id,
      version: manifest.version,
      settings: { ...manifest.settings },
    },
    storage: {
      get: (key: string) => callApi('storage.get', [key]),
      set: (key: string, value: unknown) => callApi('storage.set', [key, value]),
      remove: (key: string) => callApi('storage.remove', [key]),
      keys: () => callApi('storage.keys', []),
    },
    http: {
      post: (path: string, body: Record<string, unknown>) => callApi('http.post', [path, body]),
      fetch: (url: string, init?: unknown) => callApi('http.fetch', [url, init]),
    },
    toast: {
      success: (m: string) => { void callApi('toast.success', [m]); },
      error: (m: string) => { void callApi('toast.error', [m]); },
      info: (m: string) => { void callApi('toast.info', [m]); },
      warning: (m: string) => { void callApi('toast.warning', [m]); },
    },
    admin: {
      getConfig: (key: string) => callApi('admin.getConfig', [key]),
      getAllConfig: () => callApi('admin.getAllConfig', []),
      setConfig: (key: string, v: unknown) => callApi('admin.setConfig', [key, v]),
      deleteConfig: (key: string) => callApi('admin.deleteConfig', [key]),
    },
    log: {
      debug: (...a: unknown[]) => console.debug(`[plugin:${manifest.id}]`, ...a),
      info:  (...a: unknown[]) => console.info(`[plugin:${manifest.id}]`, ...a),
      warn:  (...a: unknown[]) => console.warn(`[plugin:${manifest.id}]`, ...a),
      error: (...a: unknown[]) => console.error(`[plugin:${manifest.id}]`, ...a),
    },
  };
}

// ─── Bundle evaluation ───────────────────────────────────────

/**
 * Resolve a bundler-emitted `require(name)` call inside the sandbox. Plugin
 * bundlers should be configured to externalise React; the runtime provides
 * those modules here. Anything else is refused — the sandbox has no Node-
 * compatible module resolution and we don't want plugins probing globals.
 */
function makePluginRequire(): (name: string) => unknown {
  const known: Record<string, unknown> = {
    'react': React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOM,
    'react/jsx-runtime': ReactJSXRuntime,
    'react/jsx-dev-runtime': ReactJSXRuntime,
  };
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(known, name)) return known[name];
    throw new Error(`Plugin sandbox: module "${name}" is not available. Externalise it in your bundler or ship it bundled.`);
  };
}

function evaluateBundle(code: string): PluginExports {
  const mod: { exports: PluginExports } = { exports: {} };
  const requireShim = makePluginRequire();
  let fn: (...args: unknown[]) => void;
  try {
    fn = new Function(
      'module', 'exports', 'require', 'React', 'ReactDOM', 'JsxRuntime', 'console',
      code,
    ) as (...args: unknown[]) => void;
  } catch (err) {
    throw new Error(`Bundle parse error: ${(err as Error).message}`);
  }
  try {
    fn(mod, mod.exports, requireShim, React, ReactDOM, ReactJSXRuntime, console);
  } catch (err) {
    throw new Error(`Bundle evaluation threw: ${(err as Error).message}`);
  }
  const exports = (mod.exports?.default ?? mod.exports) as PluginExports;
  if (!exports || typeof exports !== 'object') {
    throw new Error('Bundle did not produce module.exports object');
  }
  return exports;
}

// ─── Init flow ───────────────────────────────────────────────

async function bootBackground(payload: BackgroundInit): Promise<void> {
  const exports = evaluateBundle(payload.code);
  pluginExports = exports;

  // Register hooks (each value must be a function).
  const hookNames: string[] = [];
  const hooks = exports.hooks ?? {};
  for (const [name, handler] of Object.entries(hooks)) {
    if (typeof handler === 'function') {
      hookHandlers[name] = handler;
      hookNames.push(name);
    }
  }

  // Enumerate slot offers.
  const slotInfo: Array<{ name: SlotName; hasShouldShow: boolean; order: number }> = [];
  const slots = exports.slots ?? {};
  for (const [name, def] of Object.entries(slots)) {
    if (def && typeof def.component === 'function') {
      slotInfo.push({
        name: name as SlotName,
        hasShouldShow: typeof def.shouldShow === 'function',
        order: typeof def.order === 'number' ? def.order : 100,
      });
    }
  }

  // Side effects.
  if (typeof exports.activate === 'function') {
    await Promise.resolve(exports.activate(buildPluginApi(payload.manifest)));
  }

  sendToHost({ type: 'init-done', hooks: hookNames, slots: slotInfo });
}

function bootSlot(payload: SlotInit): void {
  const exports = evaluateBundle(payload.code);
  pluginExports = exports;
  slotName = payload.slot;

  const slotDef = exports.slots?.[payload.slot];
  if (!slotDef || typeof slotDef.component !== 'function') {
    throw new Error(`Plugin "${payload.pluginId}" does not export slots["${payload.slot}"].component`);
  }

  const rootEl = document.getElementById('plugin-sandbox-root');
  if (!rootEl) throw new Error('Sandbox root element missing');

  let currentProps: Record<string, unknown> = payload.extraProps;
  const Component = slotDef.component;

  const SlotShell = () => {
    const wrapRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (!wrapRef.current) return;
      let lastHeight = -1;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const h = Math.ceil(entry.contentRect.height);
          if (h !== lastHeight) {
            lastHeight = h;
            sendToHost({ type: 'slot-resize', height: h });
          }
        }
      });
      ro.observe(wrapRef.current);
      return () => ro.disconnect();
    }, []);
    return React.createElement('div', { ref: wrapRef }, React.createElement(Component, currentProps));
  };

  const reactRoot = ReactDOM.createRoot(rootEl);
  reactRoot.render(React.createElement(SlotShell));
  sendToHost({ type: 'init-done', hooks: [], slots: [] });
}

async function handleInit(payload: InitPayload): Promise<void> {
  if (bootDone) return;
  bootDone = true;
  mode = payload.mode;
  try {
    if (payload.mode === 'background') {
      await bootBackground(payload);
    } else {
      bootSlot(payload);
    }
  } catch (err) {
    sendToHost({ type: 'init-error', error: (err as Error).message ?? String(err) });
  }
}

// ─── Host message handler ────────────────────────────────────

function handleHostMessage(ev: MessageEvent): void {
  // First inbound message pins source + origin. Reject everything else.
  if (!parentWindow) {
    if (!ev.source || ev.source === window) return;
    parentWindow = ev.source as Window;
    parentOrigin = ev.origin || null;
  }
  if (ev.source !== parentWindow) return;
  if (parentOrigin && ev.origin !== parentOrigin) return;

  const msg = ev.data as HostToSandbox;
  if (!msg || typeof (msg as { type?: unknown }).type !== 'string') return;

  switch (msg.type) {
    case 'init':
      void handleInit(msg.payload);
      break;

    case 'api-response': {
      const pending = pendingApi.get(msg.id);
      if (!pending) return;
      pendingApi.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error ?? 'api error'));
      break;
    }

    case 'hook-invoke': {
      const handler = hookHandlers[msg.hookName];
      if (!handler) {
        sendToHost({ type: 'hook-result', id: msg.id, ok: false, error: `no handler for ${msg.hookName}` });
        return;
      }
      try {
        const result = handler(...(msg.args ?? []));
        Promise.resolve(result).then(
          (v) => sendToHost({ type: 'hook-result', id: msg.id, ok: true, result: v }),
          (e) => sendToHost({ type: 'hook-result', id: msg.id, ok: false, error: (e as Error).message ?? String(e) }),
        );
      } catch (err) {
        sendToHost({ type: 'hook-result', id: msg.id, ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'slot-should-show': {
      // Resolved by the background instance for any slot it offers.
      const slotDef = pluginExports?.slots?.[msg.slot];
      let show = true;
      try {
        if (slotDef && typeof slotDef.shouldShow === 'function') {
          show = !!slotDef.shouldShow(msg.context);
        }
      } catch {
        show = false;
      }
      sendToHost({ type: 'slot-should-show-result', id: msg.id, show });
      break;
    }

    case 'locale-change':
      (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ = msg.locale;
      break;

    case 'props-update':
      // Phase-2: would push updates into the slot shell. Currently the slot
      // iframe is torn down and recreated when props change at the host.
      break;
  }
}

// ─── React entry ─────────────────────────────────────────────

export function SandboxRuntime(): React.JSX.Element {
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    window.addEventListener('message', handleHostMessage);
    // Initial ping. We don't know parent origin yet, so '*' is required.
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'sandbox-ready' } satisfies SandboxToHost, '*');
    }
    return () => {
      window.removeEventListener('message', handleHostMessage);
    };
  }, []);
  return <div id="plugin-sandbox-root" />;
}

// Suppress unused-variable warning when `mode` is only read for debugging.
void mode;
void slotName;
