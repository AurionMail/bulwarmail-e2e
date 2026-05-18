// Process-wide registry of active sandboxed plugins. The loader populates it
// after a successful boot; PluginIframeSlot reads it to spawn slot iframes
// and to call evaluateShouldShow on the background instance.

import type { Disposable, InstalledPlugin, SlotName } from '../plugin-types';
import type { SandboxInstance } from './host-bridge';

export interface SlotOffer {
  name: SlotName;
  order: number;
  hasShouldShow: boolean;
}

export interface ActivePlugin {
  plugin: InstalledPlugin;
  /** Verified bundle source. Reused when spinning up slot iframes. */
  code: string;
  background: SandboxInstance;
  slotOffers: SlotOffer[];
  hookDisposables: Disposable[];
}

const active = new Map<string, ActivePlugin>();
const listeners = new Set<() => void>();

function emit(): void { for (const l of listeners) try { l(); } catch { /* ignore */ } }

export function register(entry: ActivePlugin): void {
  active.set(entry.plugin.id, entry);
  emit();
}

export function deregister(pluginId: string): ActivePlugin | undefined {
  const e = active.get(pluginId);
  if (!e) return undefined;
  active.delete(pluginId);
  emit();
  return e;
}

export function get(pluginId: string): ActivePlugin | undefined {
  return active.get(pluginId);
}

export function all(): ActivePlugin[] {
  return [...active.values()];
}

/** Returns active plugins ordered by `order`, that offer the requested slot. */
export function offersForSlot(slot: SlotName): Array<{ pluginId: string; order: number; hasShouldShow: boolean }> {
  const out: Array<{ pluginId: string; order: number; hasShouldShow: boolean }> = [];
  for (const entry of active.values()) {
    for (const offer of entry.slotOffers) {
      if (offer.name === slot) {
        out.push({ pluginId: entry.plugin.id, order: offer.order, hasShouldShow: offer.hasShouldShow });
      }
    }
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
