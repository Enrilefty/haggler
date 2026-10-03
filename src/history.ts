// Retrieval over Gio Oseguera's anonymized Drive Auto Body estimates.
// Pure and synchronous: reads data/gio/history.json, data/gio/playbook.json and data/catalog.json once.
// Data is built by scripts/build_gio_data.py (privacy-checked by scripts/check_pii.py).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export type HistoryLine = {
  catalogId: string;
  op: string; // repair | replace | refinish | blend | r&i | add
  partType?: string; // OEM | A/M | CAPA | LKQ | Reman (replace lines with a part only)
  bodyHours: number;
  refinishHours: number;
  mechHours?: number;
  partPrice?: number;
  side?: "left" | "right" | "both";
};

export type Job = {
  id: string;
  month: string; // YYYY-MM
  payer: "insurance" | "self_pay" | "unknown";
  vehicle: { year: number; make: string; model: string } | null;
  areas: string[]; // front | rear | left | right | top
  stage: string; // preliminary | supplement | estimate_of_record | estimate
  versions: number;
  hasSupplement: boolean;
  software: string;
  lines: HistoryLine[];
  total: number | null;
  preliminaryTotal?: number | null;
  supplementAdds: string[];
};

export type HistoryQuery = {
  areas?: string[];
  mode: "self_pay" | "insurance";
  make?: string;
  model?: string;
  catalogIds?: string[];
  limit?: number;
};

export type PlaybookAdd = { catalogId: string; rate: number; n: number; why: string };
export type HistoryResult = {
  jobs: Job[];
  playbook: {
    adds: PlaybookAdd[];
    repairs: { catalogId: string; rate: number; n?: number; why?: string }[];
    partTypeMix: Record<string, number>;
    skips?: { catalogId: string; insuranceRate: number; selfPayRate: number; why: string }[];
    blendRate?: number;
  };
  summary: string;
};

type AddEntry = PlaybookAdd & { count?: number; source?: string };
type Playbook = {
  insurance: {
    addsByArea: Record<string, AddEntry[]>;
    supplementAddsByArea: Record<string, AddEntry[]>;
    blendRate: number;
    partTypeMix: Record<string, number>;
    jobs: number;
  };
  self_pay: {
    repairInsteadOfReplace: { catalogId: string; rate: number; n: number; insuranceRate: number | null; insuranceN: number; why: string }[];
    partTypeMix: Record<string, number>;
    skips: { catalogId: string; insuranceRate: number; selfPayRate: number; why: string }[];
    blendRate: number;
    jobs: number;
  };
  stats: Record<string, unknown>;
};

let cache: { jobs: Job[]; playbook: Playbook; labels: Map<string, string>; kinds: Map<string, string> } | null = null;

function load() {
  if (cache) return cache;
  const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
  const history = read("data/gio/history.json");
  const playbook = read("data/gio/playbook.json") as Playbook;
  const catalog = read("data/catalog.json");
  const labels = new Map<string, string>();
  const kinds = new Map<string, string>();
  for (const it of catalog.items ?? []) {
    labels.set(it.id, it.label);
    kinds.set(it.id, it.kind);
  }
  cache = { jobs: (history.jobs ?? []) as Job[], playbook, labels, kinds };
  return cache;
}

const AREA_ALIASES: Record<string, string[]> = {
  front: ["front"], rear: ["rear"], back: ["rear"], left: ["left"], right: ["right"], top: ["top"], roof: ["top"],
  side: ["left", "right"], sides: ["left", "right"],
  "front-left": ["front", "left"], "front-right": ["front", "right"], "rear-left": ["rear", "left"], "rear-right": ["rear", "right"],
};
const AREA_WORD: Record<string, string> = { front: "front-end", rear: "rear-end", left: "left-side", right: "right-side", top: "roof" };

function normAreas(areas?: string[]): string[] {
  const out = new Set<string>();
  for (const a of areas ?? []) {
    for (const x of AREA_ALIASES[String(a).toLowerCase().trim()] ?? []) out.add(x);
  }
  return [...out];
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const lc = (s: string | undefined) => (s ?? "").toLowerCase().trim();

export function searchHistory(q: HistoryQuery): HistoryResult {
  const { jobs, playbook, labels, kinds } = load();
  const mode = q.mode === "self_pay" ? "self_pay" : "insurance";
  const areas = normAreas(q.areas);
  const ids = new Set(q.catalogIds ?? []);
  const limit = Math.max(1, Math.min(q.limit ?? 5, 25));
  const label = (id: string) => (labels.get(id) ?? id).toLowerCase();

  const pool = jobs.filter((j) => j.payer === mode && j.lines.length > 0);
  const inArea = areas.length ? pool.filter((j) => j.areas.some((a) => areas.includes(a))) : pool;
  const widened = areas.length > 0 && inArea.length < 3;
  const candidates = widened ? pool : inArea;

  const score = (j: Job) => {
    let s = 0;
    if (areas.length) s += 2 * j.areas.filter((a) => areas.includes(a)).length;
    if (q.make && lc(j.vehicle?.make) === lc(q.make)) s += 3;
    if (q.model && lc(j.vehicle?.model) && lc(q.model).includes(lc(j.vehicle?.model))) s += 3;
    if (ids.size) s += Math.min(5, j.lines.filter((l) => ids.has(l.catalogId)).length);
    return s;
  };
  const ranked = candidates
    .map((j) => ({ j, s: score(j) }))
    .sort((a, b) => b.s - a.s || b.j.month.localeCompare(a.j.month))
    .slice(0, limit)
    .map((x) => x.j);

  const areaKeys = areas.length ? areas : ["front", "rear", "left", "right", "top"];
  const areaWord = areas.map((a) => AREA_WORD[a] ?? a).join(" / ");
  const n = candidates.length;
  // Plain English lead-in: "On 23 similar front-end insurance jobs" when the area matched,
  // otherwise "Across 86 of Gio's insurance jobs" (no area given, or too few matches for it).
  const lead = (payer: string) => (areas.length && !widened ? `On ${n} similar ${areaWord} ${payer} jobs` : `Across ${n} of Gio's ${payer} jobs`);
  const who = areas.length && !widened ? "Gio" : "he";

  if (mode === "insurance") {
    const best = new Map<string, AddEntry>();
    for (const a of areaKeys) {
      for (const e of playbook.insurance.addsByArea[a] ?? []) {
        if (ids.has(e.catalogId)) continue; // already in the scope being priced
        const prev = best.get(e.catalogId);
        if (!prev || e.rate > prev.rate) best.set(e.catalogId, e);
      }
    }
    const adds = [...best.values()]
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 12)
      .map(({ catalogId, rate, n, why }) => ({ catalogId, rate, n, why }));
    let supp: AddEntry | undefined;
    for (const a of areaKeys) {
      for (const e of playbook.insurance.supplementAddsByArea[a] ?? []) {
        if (ids.has(e.catalogId)) continue;
        if (kinds.get(e.catalogId) === "hidden" && (!supp || e.rate > supp.rate)) supp = e;
      }
    }
    const repairs = playbook.self_pay.repairInsteadOfReplace
      .filter((r) => r.insuranceRate !== null && (!ids.size || ids.has(r.catalogId)))
      .map((r) => ({ catalogId: r.catalogId, rate: r.insuranceRate as number, n: r.insuranceN }));
    const parts: string[] = [];
    if (n === 0) {
      parts.push("No similar insurance jobs in Gio's history yet; use the shop playbook.");
    } else {
      // lead with what a thorough estimator adds (procedures, hidden parts), not consumables
      const proc = adds.find((a) => kinds.get(a.catalogId) === "procedure");
      const hid = adds.find((a) => kinds.get(a.catalogId) === "hidden");
      const top = [proc, hid].filter((x): x is PlaybookAdd => !!x);
      if (!top.length) top.push(...adds.slice(0, 2));
      parts.push(
        `${lead("insurance")}${widened ? ` (few ${areaWord} jobs, so all areas)` : ""}, ${who} wrote ` +
          (top.length
            ? top.map((t) => `${label(t.catalogId)} ${pct(t.rate)} of the time`).join(" and ")
            : "the visible damage only") +
          `, and blended an adjacent panel on ${pct(playbook.insurance.blendRate)} of insurance jobs.`,
      );
      if (supp && supp.count) {
        parts.push(`After teardown he added the ${label(supp.catalogId)} on a supplement in ${supp.count} of ${supp.n} jobs.`);
      }
    }
    return { jobs: ranked, playbook: { adds, repairs, partTypeMix: playbook.insurance.partTypeMix, blendRate: playbook.insurance.blendRate }, summary: parts.join(" ") };
  }

  // self_pay
  const repairsAll = playbook.self_pay.repairInsteadOfReplace;
  const repairs = repairsAll
    .filter((r) => !ids.size || ids.has(r.catalogId))
    .map((r) => ({ catalogId: r.catalogId, rate: r.rate, n: r.n, why: r.why }));
  const skips = [...playbook.self_pay.skips].sort((a, b) => b.insuranceRate - a.insuranceRate).slice(0, 8);
  const mix = playbook.self_pay.partTypeMix;
  const nonOem = (mix.aftermarket ?? 0) + (mix.used ?? 0);
  const parts: string[] = [];
  if (n === 0) {
    parts.push("No similar self-pay jobs in Gio's history yet; use the shop playbook.");
  } else {
    const topRepair = (repairs.length ? repairs : repairsAll).find((r) => r.rate > 0);
    parts.push(
      `${lead("self-pay")}${widened ? ` (few ${areaWord} jobs, so all areas)` : ""}, ` +
        (topRepair
          ? `${who} repaired the ${label(topRepair.catalogId)} instead of replacing it ${pct(topRepair.rate)} of the time (n=${topRepair.n})`
          : `${who} mostly replaced damaged panels`) +
        `, and ${pct(nonOem)} of his major parts were aftermarket or used.`,
    );
    const s = skips[0];
    if (s) parts.push(`He writes ${label(s.catalogId)} on ${pct(s.selfPayRate)} of cash jobs vs ${pct(s.insuranceRate)} of insurance jobs.`);
  }
  return { jobs: ranked, playbook: { adds: [], repairs, partTypeMix: mix, skips, blendRate: playbook.self_pay.blendRate }, summary: parts.join(" ") };
}

// Exposed for tests and the shop agent prompt (counts only, no job data).
export function historyStats(): Record<string, unknown> {
  return load().playbook.stats;
}
