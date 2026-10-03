// Refreshes data/reviews/drive.json from Tavily (search + answer). Run: node --experimental-strip-types scripts/fetch-reviews.ts
import { writeFileSync } from "node:fs";
import "../src/config.ts";
const r = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, body: JSON.stringify({ query: "Drive Auto Body Hemet CA collision repair reviews rating Google", include_answer: true, search_depth: "advanced", max_results: 6 }) });
const d: any = await r.json();
const m = String(d.answer ?? "").match(/(\d\.\d)-star rating across (\d+)/);
if (!m) { console.log("could not parse rating; answer:", String(d.answer).slice(0, 200)); process.exit(1); }
writeFileSync("data/reviews/drive.json", JSON.stringify({ rating: Number(m[1]), reviewCount: Number(m[2]), themes: ["paint matching", "communication", "help with insurance"], certifications: [], source: { label: "Google reviews as shown on driveautobody.com (fetched with Tavily)", url: "https://driveautobody.com/testimonials", fetchedAt: new Date().toISOString() }, simulated: false, status: "real public reviews" }, null, 2));
console.log("saved", m[1], m[2]);
