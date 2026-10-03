// Canonical damage vocabulary. Scope item identity = catalog id; the operation is an attribute.
// Loads data/catalog.json (built from Gio's anonymized estimates) when present, else the small
// data/catalog.sample.json used by tests. Pure lookups after the first read.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";
import type { ScopeItem } from "./engines.ts";

export interface CatalogOp { bodyHours?: number; refinishHours?: number; mechHours?: number; fixedCharge?: number; needsPart?: boolean }
export interface CatalogItem {
  id: string; label: string; area: string; kind: "visible" | "hidden" | "procedure" | "materials" | string;
  ops: Record<string, CatalogOp>; parts: { oem?: number | null; aftermarket?: number | null; used?: number | null } | null;
  mechHours?: number; fixedCharge?: number; evidence?: string; aliases?: string[];
}
export type PartKey = "oem" | "aftermarket" | "used";
export const PART_KEYS: PartKey[] = ["oem", "aftermarket", "used"];
const DISPLAY: Record<PartKey, string> = { oem: "OEM", aftermarket: "A/M", used: "LKQ" };

let cache: { version: number; note?: string; items: CatalogItem[]; source: string } | undefined;
let index: Map<string, CatalogItem> | undefined;

export function catalog() {
  if (cache) return cache;
  for (const f of ["data/catalog.json", "data/catalog.sample.json"]) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(j?.items) && j.items.length) { cache = { version: j.version ?? 1, note: j.note, items: j.items, source: f }; break; }
    } catch { /* fall through to the sample */ }
  }
  if (!cache) cache = { version: 0, items: [], source: "none" };
  index = new Map();
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
  for (const it of cache.items) index.set(key(it.id), it);
  for (const it of cache.items) for (const a of [it.label, ...(it.aliases ?? [])]) if (a && !index.has(key(a))) index.set(key(a), it);
  return cache;
}
// Test hook: forget the cached file (e.g. after the data builder writes catalog.json).
export function reloadCatalog() { cache = undefined; index = undefined; return catalog(); }

// Exact id first, then label/alias match (case- and punctuation-insensitive).
export function catalogItem(idOrAlias: string): CatalogItem | undefined {
  catalog();
  const k = String(idOrAlias ?? "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
  return index!.get(k);
}
export const catalogIds = () => catalog().items.map((i) => i.id);
// Compact list for agents: what they may name, and which operations each item supports.
export function catalogBrief() {
  return catalog().items.map((i) => ({ id: i.id, label: i.label, area: i.area, kind: i.kind, ops: Object.keys(i.ops ?? {}) }));
}

// Normalizes an operation name for an item. Procedures/materials accept anything (one way to do them).
export function normalizeOp(item: CatalogItem, op: string): string | undefined {
  const ops = Object.keys(item.ops ?? {});
  const o = String(op ?? "").toLowerCase().trim();
  if (ops.includes(o)) return o;
  const alias: Record<string, string> = { "r+i": "r&i", "r & i": "r&i", "remove and install": "r&i", "remove/install": "r&i", "r&r": "replace", "remove and replace": "replace", "refinish only": "refinish", paint: "refinish", fix: "repair", include: "perform", add: "perform" };
  const n = alias[o] ?? o;
  if (ops.includes(n)) return n;
  if (item.kind === "procedure" || item.kind === "materials") return ops[0] ?? "perform";
  if (!ops.length) return n || "perform";
  return undefined;
}
// Best default operation for an item (used when filling a fallback scope).
export function defaultOp(item: CatalogItem, severity?: string): string {
  const ops = Object.keys(item.ops ?? {});
  if (item.kind === "procedure" || item.kind === "materials") return ops[0] ?? "perform";
  if (severity === "minor" && ops.includes("repair")) return "repair";
  if (ops.includes("replace")) return "replace";
  return ops[0] ?? "repair";
}
export const opPhrase = (op: string) => ({ replace: "replace", repair: "repair", refinish: "refinish", blend: "blend", "r&i": "remove and reinstall", perform: "include", add: "include" } as Record<string, string>)[op] ?? op;

const partPrice = (item: CatalogItem, k: PartKey) => { const v = item.parts?.[k]; return typeof v === "number" && v > 0 ? v : undefined; };
const allowedKey = (k: PartKey, allow?: string[]) => !allow?.length || (k === "oem" ? allow.includes("OEM") : k === "aftermarket" ? allow.includes("A/M") || allow.includes("CAPA") : allow.includes("LKQ"));
export function toPartKey(s?: string): PartKey | undefined {
  const t = String(s ?? "").toLowerCase();
  if (!t) return undefined;
  if (t === "oem" || t.includes("oem")) return "oem";
  if (t === "used" || t === "lkq" || t.includes("recycl") || t.includes("salvage")) return "used";
  if (t === "aftermarket" || t === "a/m" || t === "am" || t === "capa" || t.includes("after")) return "aftermarket";
  return undefined;
}
// Picks the part source: the requested type if this shop allows it and a price exists, else the
// shop's policy for this mode, else the nearest allowed source with a price, else anything priced.
export function choosePart(item: CatalogItem, preferred: PartKey | undefined, policy: PartKey, allow?: string[]): { key: PartKey; type: string; price: number } | undefined {
  if (!item.parts) return undefined;
  const order: PartKey[] = [...new Set([preferred, policy, ...(policy === "oem" ? ["oem", "aftermarket", "used"] : ["aftermarket", "used", "oem"])].filter(Boolean) as PartKey[])];
  for (const k of order) { const p = partPrice(item, k); if (p && allowedKey(k, allow)) return { key: k, type: DISPLAY[k], price: p }; }
  for (const k of order) { const p = partPrice(item, k); if (p) return { key: k, type: DISPLAY[k], price: p }; }
  return undefined;
}

// Builds a priceable ScopeItem from catalog hours. Part prices live in the catalog and are looked up
// by catalogParts() through the part key `cat:<id>:<oem|aftermarket|used>`.
export function catalogScopeItem(item: CatalogItem, op: string, part?: { key: PartKey }): ScopeItem {
  const o = item.ops?.[op] ?? {};
  const needsPart = !!o.needsPart && !!part;
  const mech = (o.mechHours ?? 0) + (op === "replace" || item.kind === "procedure" || item.kind === "hidden" ? (item.mechHours ?? 0) : 0);
  const fixed = (o.fixedCharge ?? 0) + (item.fixedCharge ?? 0);
  const label = item.kind === "procedure" || item.kind === "materials" ? item.label : `${item.label}: ${opPhrase(op)}`;
  return {
    id: item.id, label, operation: op,
    ...(o.bodyHours ? { bodyHours: o.bodyHours } : {}), ...(o.refinishHours ? { refinishHours: o.refinishHours } : {}),
    ...(mech ? { mechHours: mech } : {}), ...(fixed ? { fixedCharge: fixed } : {}),
    ...(needsPart ? { part: `cat:${item.id}:${part!.key}` } : {}),
  };
}
// Parts table in the engine's shape for every catalog part key used by these items.
export function catalogParts(items: ScopeItem[], shopId: string): Record<string, Record<string, { type: string; price: number }>> {
  const out: Record<string, Record<string, { type: string; price: number }>> = {};
  for (const it of items) {
    const m = /^cat:(.+):(oem|aftermarket|used)$/.exec(it.part ?? "");
    if (!m) continue;
    const ci = catalogItem(m[1]); const k = m[2] as PartKey; const p = ci && partPrice(ci, k);
    if (p) out[it.part!] = { [shopId]: { type: DISPLAY[k], price: p } };
  }
  return out;
}
export const partTypeOf = (it: ScopeItem) => { const m = /:(oem|aftermarket|used)$/.exec(it.part ?? ""); return m ? DISPLAY[m[1] as PartKey] : undefined; };
