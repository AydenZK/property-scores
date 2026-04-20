import { useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoreBand { label: string; min: number | null; max: number | null; pts: number; }

interface Criterion {
  id: string; label: string; description: string;
  type: "band" | "select" | "suburb"; bands: ScoreBand[];
}

interface AppConfig {
  criteria: Criterion[];
  goodSuburbs: string[];
  decentSuburbs: string[];
  // Site value formula params
  landPricePerSqm: number;           // primary: $/m² — calibrate to your market
  siteValueBuildingPct: number;      // fallback: base building fraction for new build
  siteValueDepreciationRate: number; // fallback: depreciation per year
  siteValueFloor: number;            // fallback: minimum building fraction
  civMultiplier: number;             // askingPrice × this = estimated CIV
}

interface Property {
  id: string; street: string; suburb: string; price: string;
  beds: number | null; baths: number | null; cars: number | null;
  landSqm: number | null; buildYear: number | null;
  askingPriceK: number | null;
  weeklyRent: number | null;   // actual $/week — NOT in thousands
  siteValueK: number | null;   // in $k
  civK: number | null;         // in $k
  manualScores: Record<string, number | null>;
  physicalFlags: Record<string, boolean>;
  physicalChecks: Record<string, boolean>;
  notes: string;
}

interface AppState {
  properties: Property[];
  config: AppConfig;
  activePropertyId: string | null;
  view: "scorecard" | "config" | "add";
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "property_scorecard_v5_stable";

function loadState(): Partial<AppState> {
  try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
function persist(s: AppState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_GOOD_SUBURBS = ["Werribee","Hoppers Crossing","Melton","Melton South","Meadow Heights","Craigieburn","Frankston"];
const DEFAULT_DECENT_SUBURBS = ["Hampton Park","Cranbourne","Cranbourne North","Carrum Downs","Noble Park","Laverton","Preston","Reservoir","Boronia","Pakenham","Epping","Tarneit","Truganina","Wyndham Vale"];

const DEFAULT_CRITERIA: Criterion[] = [
  { id:"landRatio", label:"Land-to-Asset Ratio", type:"band",
    description:"Site Value ÷ CIV. Auto-calculated when both are entered or estimated.",
    bands:[{label:"≥70%",min:70,max:null,pts:3},{label:"65–69%",min:65,max:69.99,pts:2.5},{label:"60–64%",min:60,max:64.99,pts:1.5},{label:"50–59%",min:50,max:59.99,pts:1},{label:"45–49%",min:45,max:49.99,pts:-1},{label:"<45%",min:null,max:44.99,pts:-2}]},
  { id:"yield", label:"Rental Yield", type:"band",
    description:"Weekly rent × 52 ÷ asking price. Auto-calculated.",
    bands:[{label:">4.0%",min:4.001,max:null,pts:2},{label:"3.5–4.0%",min:3.5,max:4.0,pts:1},{label:"<3.5%",min:null,max:3.499,pts:0}]},
  { id:"suburb", label:"Suburb Quality", type:"suburb",
    description:"Auto-scored against your Good/Decent suburb lists.",
    bands:[{label:"Good list",min:null,max:null,pts:3},{label:"Decent list",min:null,max:null,pts:1},{label:"Not listed",min:null,max:null,pts:0}]},
  { id:"beds", label:"Bedrooms", type:"band", description:"Auto-scored from beds field.",
    bands:[{label:"4+ beds",min:4,max:null,pts:1},{label:"3 beds",min:3,max:3,pts:0},{label:"<3 beds",min:null,max:2.99,pts:-1}]},
  { id:"baths", label:"Bathrooms", type:"band", description:"Auto-scored from baths field.",
    bands:[{label:"2+ baths",min:2,max:null,pts:1},{label:"<2 baths",min:null,max:1.99,pts:0}]},
  { id:"cars", label:"Car Spaces", type:"band", description:"Auto-scored from cars field.",
    bands:[{label:"2+ spaces",min:2,max:null,pts:1},{label:"1 space",min:1,max:1,pts:0},{label:"0 spaces",min:0,max:0,pts:-1}]},
  { id:"zoning", label:"Zoning", type:"select", description:"Check VicPlan. Select manually.",
    bands:[{label:"RGZ",min:null,max:null,pts:2.5},{label:"GRZ",min:null,max:null,pts:1},{label:"UGZ / Other",min:null,max:null,pts:-1}]},
  { id:"buildingAge", label:"Building Age", type:"band", description:"Auto-scored from build year.",
    bands:[{label:">15 years",min:15.001,max:null,pts:1},{label:"10–15 years",min:10,max:15,pts:0},{label:"<10 years",min:null,max:9.99,pts:-1}]},
  { id:"landSize", label:"Land Size", type:"band", description:"Auto-scored from land size field.",
    bands:[{label:"700m²+",min:700,max:null,pts:3},{label:"650–699m²",min:650,max:699.99,pts:2.5},{label:"600–649m²",min:600,max:649.99,pts:2},{label:"550–599m²",min:550,max:599.99,pts:1.5},{label:"500–549m²",min:500,max:549.99,pts:1},{label:"<400m²",min:null,max:399.99,pts:-1}]},
];

const DEFAULT_CONFIG: AppConfig = {
  criteria: DEFAULT_CRITERIA,
  goodSuburbs: DEFAULT_GOOD_SUBURBS,
  decentSuburbs: DEFAULT_DECENT_SUBURBS,
  landPricePerSqm: 780,            // calibrated: Prop 1 = 512m² → $400k site = $781/m²
  siteValueBuildingPct: 0.65,
  siteValueDepreciationRate: 0.012,
  siteValueFloor: 0.30,            // floor at 30% building — stops land going >70% on very old stock
  civMultiplier: 1.0,
};

const PHYSICAL_CHECKS = [
  {id:"ridge",label:"Roof ridgeline straight",sub:"Sagging = structural settlement",canFlag:true},
  {id:"cracks",label:"No diagonal brickwork cracks",sub:"Diagonal = foundation movement",canFlag:true},
  {id:"damp",label:"No peeling paint at base of walls",sub:"Rising damp",canFlag:true},
  {id:"gutters",label:"Gutters and downpipes intact",sub:null,canFlag:false},
  {id:"termites",label:"No mud tubes under eaves",sub:"Active termites",canFlag:true},
  {id:"doors",label:"Doors and windows open/close smoothly",sub:"Sticking = structural shift",canFlag:true},
  {id:"ceiling",label:"No ceiling water stains",sub:"Roof/plumbing leak",canFlag:true},
  {id:"sinks",label:"Under sinks — no moisture or mould",sub:null,canFlag:true},
  {id:"water",label:"Water pressure OK",sub:"Run taps + flush toilet",canFlag:false},
  {id:"floors",label:"Floors solid — no bounce or unevenness",sub:"Use phone level app",canFlag:true},
  {id:"easement",label:"No concerning easements",sub:"Power lines, drain lids",canFlag:true},
  {id:"slope",label:"No significant slope",sub:"Adds development cost",canFlag:true},
];

// ─── Listing Parser ───────────────────────────────────────────────────────────

function parseListingText(text: string): Partial<Property> {
  const result: Partial<Property> = {};
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Address: first line "Street, Suburb, State Postcode"
  const addrParts = lines[0]?.split(",").map(s => s.trim()) ?? [];
  if (addrParts.length >= 2) {
    result.street = addrParts[0];
    result.suburb = addrParts[1];
  }

  // Beds/baths/cars from "* 4 * 2 * 1" pattern
  const statsMatch = text.match(/\*\s*(\d+)[\s\S]*?\*[^*\d]*(\d+)[\s\S]*?\*[^*\d]*(\d+)/);
  if (statsMatch) {
    result.beds = parseInt(statsMatch[1]);
    result.baths = parseInt(statsMatch[2]);
    result.cars = parseInt(statsMatch[3]);
  } else {
    const nums = [...text.matchAll(/[*•]\s*(\d+)(?!\s*m)/g)].map(m => parseInt(m[1]));
    if (nums[0] != null) result.beds = nums[0];
    if (nums[1] != null) result.baths = nums[1];
    if (nums[2] != null) result.cars = nums[2];
  }

  // Land size: "713m²"
  const land = text.match(/([\d,]+)\s*m[²2]/i);
  if (land) result.landSqm = parseInt(land[1].replace(/,/g, ""));

  // Price range "$675,000 - $725,000"
  const range = text.match(/\$\s*([\d,]+)\s*[-–]\s*\$?\s*([\d,]+)/);
  if (range) {
    const lo = parseInt(range[1].replace(/,/g, ""));
    const hi = parseInt(range[2].replace(/,/g, ""));
    result.price = `$${Math.round(lo/1000)}k–$${Math.round(hi/1000)}k`;
    result.askingPriceK = Math.round((lo + hi) / 2 / 1000);
  } else {
    const single = text.match(/\$\s*([\d,]+)/);
    if (single) {
      const v = parseInt(single[1].replace(/,/g, ""));
      if (v > 10000) { result.price = `$${Math.round(v/1000)}k`; result.askingPriceK = Math.round(v/1000); }
    }
  }

  return result;
}

// ─── Calculations ─────────────────────────────────────────────────────────────

function buildingAge(p: Property) { return p.buildYear ? new Date().getFullYear() - p.buildYear : null; }

function effectiveCIV(p: Property, cfg: AppConfig): number | null {
  return p.civK ?? (p.askingPriceK ? Math.round(p.askingPriceK * cfg.civMultiplier) : null);
}

/**
 * Site value estimator — two methods:
 *
 * PRIMARY (when land size known):
 *   siteValue = landSqm × landPricePerSqm
 *   Anchored to actual land market prices. Not age-sensitive — a bigger block is worth more regardless.
 *   Calibrated to Werribee/HC: Property 1 (512m², $400k site) → $781/m²
 *
 * FALLBACK (no land size):
 *   buildingFraction = max(floor, basePct − age × deprRate)
 *   siteValue = askingPrice × (1 − buildingFraction)
 *   Floor prevents land going above (1−floor) of asking for very old properties.
 */
function estimateSiteValueK(p: Property, cfg: AppConfig): { valueK: number; method: "land_sqm" | "age_fraction" } | null {
  if (!p.askingPriceK) return null;

  if (p.landSqm) {
    // Primary: land size × price per sqm
    const valueK = Math.round((p.landSqm * cfg.landPricePerSqm) / 1000);
    return { valueK, method: "land_sqm" };
  }

  if (p.buildYear) {
    // Fallback: age-based fraction
    const age = new Date().getFullYear() - p.buildYear;
    const buildFrac = Math.max(cfg.siteValueFloor, cfg.siteValueBuildingPct - age * cfg.siteValueDepreciationRate);
    const valueK = Math.round(p.askingPriceK * (1 - buildFrac));
    return { valueK, method: "age_fraction" };
  }

  return null;
}

function calcLandRatioPct(p: Property, cfg: AppConfig): number | null {
  const civ = effectiveCIV(p, cfg);
  if (!p.siteValueK || !civ) return null;
  return (p.siteValueK / civ) * 100;
}

function calcYieldPct(p: Property): number | null {
  if (!p.weeklyRent || !p.askingPriceK) return null;
  return (p.weeklyRent * 52 / (p.askingPriceK * 1000)) * 100;
}

function getSuburbScore(suburb: string, cfg: AppConfig): number | null {
  if (!suburb) return null;
  const s = suburb.toLowerCase().trim();
  if (cfg.goodSuburbs.some(g => g.toLowerCase() === s)) return 3;
  if (cfg.decentSuburbs.some(d => d.toLowerCase() === s)) return 1;
  return 0;
}

function getAutoScore(c: Criterion, p: Property, cfg: AppConfig): number | null {
  if (c.type === "suburb") return getSuburbScore(p.suburb, cfg);
  let val: number | null = null;
  if (c.id === "landRatio") val = calcLandRatioPct(p, cfg);
  else if (c.id === "yield") val = calcYieldPct(p);
  else if (c.id === "beds") val = p.beds;
  else if (c.id === "baths") val = p.baths;
  else if (c.id === "cars") val = p.cars;
  else if (c.id === "buildingAge") val = buildingAge(p);
  else if (c.id === "landSize") val = p.landSqm;
  if (val === null) return null;
  for (const b of c.bands) {
    if ((b.min === null || val >= b.min) && (b.max === null || val <= b.max)) return b.pts;
  }
  return null;
}

function getScore(c: Criterion, p: Property, cfg: AppConfig): number | null {
  if (c.type === "select") return p.manualScores[c.id] ?? null;
  const auto = getAutoScore(c, p, cfg);
  return auto !== null ? auto : (p.manualScores[c.id] ?? null);
}

function getTotalScore(cfg: AppConfig, p: Property) {
  return cfg.criteria.reduce((s, c) => s + (getScore(c, p, cfg) ?? 0), 0);
}
function getMaxScore(cfg: AppConfig) {
  return cfg.criteria.reduce((s, c) => s + Math.max(...c.bands.map(b => b.pts)), 0);
}
function getVerdict(score: number, max: number) {
  const pct = score / max;
  if (pct >= 0.82) return { label: "Strong Buy", color: "#16a34a" };
  if (pct >= 0.65) return { label: "Good Buy", color: "#2563eb" };
  if (pct >= 0.47) return { label: "Moderate", color: "#d97706" };
  return { label: "Pass", color: "#dc2626" };
}

function newProp(): Property {
  return { id: Date.now().toString(), street:"", suburb:"", price:"", beds:null, baths:null, cars:null, landSqm:null, buildYear:null, askingPriceK:null, weeklyRent:null, siteValueK:null, civK:null, manualScores:{}, physicalFlags:{}, physicalChecks:{}, notes:"" };
}

// ─── UI Primitives ────────────────────────────────────────────────────────────

const FL: React.CSSProperties = { display:"flex" };
const GR2: React.CSSProperties = { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 };

function Lbl({ t }: { t: string }) {
  return <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px", color:"#888", marginBottom:4 }}>{t}</div>;
}

function NumberInput({ lbl, value, onChange, placeholder, prefix, suffix, step, isK }: {
  lbl: string; value: number | null; onChange: (v: number | null) => void;
  placeholder?: string; prefix?: string; suffix?: string; step?: number; isK?: boolean;
}) {
  return (
    <div>
      <Lbl t={lbl} />
      <div style={{ display:"flex", alignItems:"center", border:"1px solid #ddd", borderRadius:4, overflow:"hidden", background:"#fff" }}>
        {prefix && <span style={{ padding:"7px 8px", fontSize:12, color:"#999", background:"#f5f5f5", borderRight:"1px solid #ddd" }}>{prefix}</span>}
        <input type="number" step={step ?? (isK ? 1 : 1)} value={value ?? ""}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}
          style={{ flex:1, border:"none", outline:"none", padding:"7px 8px", fontSize:13, fontFamily:"inherit", minWidth:0, width:"100%" }} />
        {suffix && <span style={{ padding:"7px 8px", fontSize:12, color:"#999", background:"#f5f5f5", borderLeft:"1px solid #ddd" }}>{suffix}</span>}
      </div>
    </div>
  );
}

function TxtInput({ lbl, value, onChange, placeholder }: { lbl: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <Lbl t={lbl} />
      <input type="text" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
        style={{ width:"100%", border:"1px solid #ddd", borderRadius:4, padding:"7px 10px", fontSize:13, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }} />
    </div>
  );
}

function Badge({ children, color="#111" }: { children: React.ReactNode; color?: string }) {
  return <div style={{ fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"1.5px", color:"#fff", background:color, padding:"4px 10px", display:"inline-block", borderRadius:3, marginBottom:10, marginTop:6 }}>{children}</div>;
}

function ResultPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ border:`1px solid ${color}33`, borderRadius:4, padding:"8px 12px", background:`${color}0d`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <span style={{ fontSize:12, color:"#444" }}>{label}</span>
      <span style={{ fontSize:18, fontWeight:700, color }}>{value}</span>
    </div>
  );
}

// ─── Add Panel ────────────────────────────────────────────────────────────────

function AddPanel({ onAdd, onCancel }: { onAdd: (p: Property) => void; onCancel: () => void }) {
  const [raw, setRaw] = useState("");
  const [p, setP] = useState<Property>(newProp());
  const upd = (k: keyof Property, v: any) => setP(prev => ({ ...prev, [k]: v }));

  return (
    <div style={{ paddingBottom:20 }}>
      <Badge>Paste Listing Text</Badge>
      <div style={{ fontSize:11, color:"#888", marginBottom:8 }}>Copy the property details from realestate.com.au and paste below.</div>
      <textarea value={raw} onChange={e => setRaw(e.target.value)}
        placeholder={"7 Englefield Court, Werribee, Vic 3030\nShareSaved\n\n* 4\n* \n* 2\n* 1\n* 713m²\n* •\n* House\n$675,000 - $725,000\nPrice guide details"}
        style={{ width:"100%", border:"1px solid #ddd", borderRadius:4, padding:"9px 10px", fontSize:12, fontFamily:"monospace", resize:"none", minHeight:130, outline:"none", boxSizing:"border-box", marginBottom:8 }} />
      <button onClick={() => { if (raw.trim()) setP(prev => ({ ...prev, ...parseListingText(raw) })); }}
        style={{ padding:"8px 16px", background:"#111", color:"#fff", border:"none", borderRadius:4, fontSize:12, cursor:"pointer", marginBottom:20, fontFamily:"inherit" }}>
        Parse & Autofill ↓
      </button>

      <Badge>Confirm Details</Badge>
      <div style={{ ...GR2, marginBottom:16 }}>
        <TxtInput lbl="Street" value={p.street} onChange={v => upd("street", v)} placeholder="7 Englefield Ct" />
        <TxtInput lbl="Suburb" value={p.suburb} onChange={v => upd("suburb", v)} placeholder="Werribee" />
        <TxtInput lbl="Price Range" value={p.price} onChange={v => upd("price", v)} placeholder="$675k–$725k" />
        <NumberInput lbl="Asking Price" value={p.askingPriceK} onChange={v => upd("askingPriceK", v)} suffix="k" placeholder="700" />
        <NumberInput lbl="Land Size" value={p.landSqm} onChange={v => upd("landSqm", v)} suffix="m²" placeholder="667" />
        <NumberInput lbl="Build Year" value={p.buildYear} onChange={v => upd("buildYear", v)} placeholder="2002" />
        <NumberInput lbl="Beds" value={p.beds} onChange={v => upd("beds", v)} placeholder="4" />
        <NumberInput lbl="Baths" value={p.baths} onChange={v => upd("baths", v)} placeholder="2" />
        <NumberInput lbl="Cars" value={p.cars} onChange={v => upd("cars", v)} placeholder="2" />
        <NumberInput lbl="Weekly Rent (est.)" value={p.weeklyRent} onChange={v => upd("weeklyRent", v)} prefix="$" suffix="/wk" placeholder="520" />
      </div>
      <div style={{ ...FL, gap:8 }}>
        <button onClick={() => { if (p.street || p.suburb) onAdd(p); }}
          style={{ flex:1, padding:"10px", background:"#111", color:"#fff", border:"none", borderRadius:4, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
          Add Property
        </button>
        <button onClick={onCancel}
          style={{ padding:"10px 16px", background:"#fff", color:"#888", border:"1px solid #ddd", borderRadius:4, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Config Panel ─────────────────────────────────────────────────────────────

function ConfigPanel({ config, onChange }: { config: AppConfig; onChange: (c: AppConfig) => void }) {
  const [suburbTab, setSuburbTab] = useState<"good" | "decent">("good");
  const [newSuburb, setNewSuburb] = useState("");
  const list = suburbTab === "good" ? config.goodSuburbs : config.decentSuburbs;
  const setList = (l: string[]) => onChange(suburbTab === "good" ? { ...config, goodSuburbs: l } : { ...config, decentSuburbs: l });

  // Preview calculations
  const p1est = Math.round(512 * config.landPricePerSqm / 1000);
  const p1actual = 400;
  const age7bfFallback = Math.max(config.siteValueFloor, config.siteValueBuildingPct - 7 * config.siteValueDepreciationRate);
  const age25bf = Math.max(config.siteValueFloor, config.siteValueBuildingPct - 25 * config.siteValueDepreciationRate);
  const age50bf = Math.max(config.siteValueFloor, config.siteValueBuildingPct - 50 * config.siteValueDepreciationRate);

  return (
    <div style={{ paddingBottom:20 }}>

      {/* ── Suburb Lists ── */}
      <Badge>Suburb Lists</Badge>
      <div style={{ ...FL, gap:6, marginBottom:12 }}>
        {(["good","decent"] as const).map(t => (
          <button key={t} onClick={() => setSuburbTab(t)}
            style={{ flex:1, padding:"7px", border:`1px solid ${suburbTab===t?"#111":"#ddd"}`, borderRadius:4, background:suburbTab===t?"#111":"#fff", color:suburbTab===t?"#fff":"#555", fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
            {t === "good" ? `✦ Good · 3pts (${config.goodSuburbs.length})` : `◇ Decent · 1pt (${config.decentSuburbs.length})`}
          </button>
        ))}
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}>
        {list.map((s, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:4, background:"#f5f5f5", border:"1px solid #e0e0e0", borderRadius:4, padding:"4px 8px" }}>
            <span style={{ fontSize:12 }}>{s}</span>
            <button onClick={() => setList(list.filter((_,j) => j !== i))} style={{ border:"none", background:"none", cursor:"pointer", color:"#aaa", fontSize:14, lineHeight:1, padding:0 }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ ...FL, gap:6, marginBottom:24 }}>
        <input value={newSuburb} onChange={e => setNewSuburb(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && newSuburb.trim()) { setList([...list, newSuburb.trim()]); setNewSuburb(""); } }}
          placeholder="Add suburb..." style={{ flex:1, border:"1px solid #ddd", borderRadius:4, padding:"7px 10px", fontSize:12, fontFamily:"inherit", outline:"none" }} />
        <button onClick={() => { if (newSuburb.trim()) { setList([...list, newSuburb.trim()]); setNewSuburb(""); } }}
          style={{ padding:"7px 14px", background:"#111", color:"#fff", border:"none", borderRadius:4, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>Add</button>
      </div>

      {/* ── Site Value Formula ── */}
      <Badge color="#555">Site Value Estimator Formula</Badge>
      <div style={{ background:"#f9f9f9", border:"1px solid #e0e0e0", borderRadius:4, padding:"14px", marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px", color:"#555", marginBottom:10 }}>Primary method — when land size is known</div>
        <div style={{ fontFamily:"monospace", fontSize:12, color:"#333", lineHeight:1.8, padding:"8px 10px", background:"#fff", border:"1px solid #e8e8e8", borderRadius:4, marginBottom:8 }}>
          siteValue = <b style={{color:"#2563eb"}}>landSqm</b> × <b style={{color:"#7c3aed"}}>landPricePerSqm</b>
        </div>
        <div style={{ fontSize:11, color:"#888", marginBottom:10 }}>
          Anchored to actual land market prices — not age-sensitive. A bigger block is worth more regardless of what's on it.<br/>
          <b>Calibration:</b> Property 1 (512m², $400k actual site) → $781/m². Current setting: ${config.landPricePerSqm}/m² → ${p1est}k est. vs ${p1actual}k actual.
        </div>

        <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px", color:"#555", marginBottom:10, marginTop:16 }}>Fallback method — when land size is not known</div>
        <div style={{ fontFamily:"monospace", fontSize:12, color:"#333", lineHeight:1.8, padding:"8px 10px", background:"#fff", border:"1px solid #e8e8e8", borderRadius:4, marginBottom:8 }}>
          buildFrac = max(<b style={{color:"#d97706"}}>floor</b>, <b style={{color:"#2563eb"}}>basePct</b> − age × <b style={{color:"#7c3aed"}}>deprRate</b>)<br/>
          siteValue = askingPrice × (1 − buildFrac)
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, fontSize:11, color:"#666" }}>
          {[
            { age:7,  bf:age7bfFallback },
            { age:25, bf:age25bf },
            { age:50, bf:age50bf },
          ].map(({age,bf}) => (
            <div key={age} style={{ background:"#fff", border:"1px solid #e8e8e8", borderRadius:4, padding:"6px 8px" }}>
              <div style={{ fontWeight:600, color:"#333" }}>{age}yr old</div>
              <div>{(bf*100).toFixed(0)}% building</div>
              <div style={{ color:"#16a34a", fontWeight:600 }}>{((1-bf)*100).toFixed(0)}% land</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ ...GR2, gap:10, marginBottom:12 }}>
        <NumberInput lbl="Land Price / m² ($)" value={config.landPricePerSqm} onChange={v => onChange({...config, landPricePerSqm: v??780})} placeholder="780" prefix="$" suffix="/m²" />
        <NumberInput lbl="CIV = askingPrice ×" value={config.civMultiplier} step={0.05} onChange={v => onChange({...config, civMultiplier: v??1.0})} placeholder="1.0" />
        <NumberInput lbl="Fallback: Base building %" value={config.siteValueBuildingPct*100} step={1} onChange={v => onChange({...config, siteValueBuildingPct:(v??65)/100})} suffix="%" placeholder="65" />
        <NumberInput lbl="Fallback: Depreciation /yr" value={config.siteValueDepreciationRate*100} step={0.1} onChange={v => onChange({...config, siteValueDepreciationRate:(v??1.2)/100})} suffix="%/yr" placeholder="1.2" />
        <NumberInput lbl="Fallback: Min building % (floor)" value={config.siteValueFloor*100} step={1} onChange={v => onChange({...config, siteValueFloor:(v??30)/100})} suffix="%" placeholder="30" />
      </div>

      {/* ── Score Bands ── */}
      <div style={{ borderTop:"1px solid #e0e0e0", marginTop:20, paddingTop:20 }}>
        <Badge color="#555">Score Bands</Badge>
        {config.criteria.map((c, ci) => (
          <div key={c.id} style={{ marginBottom:18, paddingBottom:18, borderBottom:"1px solid #f0f0f0" }}>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:2 }}>{c.label}</div>
            <div style={{ fontSize:11, color:"#888", marginBottom:8 }}>{c.description}</div>
            {c.bands.map((b, bi) => (
              <div key={bi} style={{ ...FL, alignItems:"center", gap:10, marginBottom:5 }}>
                <div style={{ flex:1, fontSize:12, color:"#444" }}>{b.label}</div>
                <span style={{ fontSize:11, color:"#aaa" }}>pts</span>
                <input type="number" step="0.5" value={b.pts}
                  onChange={e => { const next = config.criteria.map((cc,i) => i!==ci ? cc : {...cc, bands:cc.bands.map((bb,j) => j!==bi ? bb : {...bb, pts:Number(e.target.value)})}); onChange({...config, criteria:next}); }}
                  style={{ width:60, border:"1px solid #ddd", borderRadius:4, padding:"4px 8px", fontSize:13, fontFamily:"inherit", outline:"none", textAlign:"right" }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Property Card ────────────────────────────────────────────────────────────

function PropertyCard({ property, config, onChange, onDelete }: {
  property: Property; config: AppConfig; onChange: (p: Property) => void; onDelete: () => void;
}) {
  const p = property;
  const upd = (k: keyof Property, v: any) => onChange({ ...p, [k]: v });

  const score = getTotalScore(config, p);
  const max = getMaxScore(config);
  const verdict = getVerdict(score, max);
  const lrPct = calcLandRatioPct(p, config);
  const yldPct = calcYieldPct(p);
  const age = buildingAge(p);
  const svEst = estimateSiteValueK(p, config);
  const civEst = effectiveCIV(p, config);
  const flagCount = Object.values(p.physicalFlags).filter(Boolean).length;

  const sc = (v: number | null) => v === null ? "#ccc" : v > 0 ? "#16a34a" : v < 0 ? "#dc2626" : "#888";

  const toggleCheck = (id: string) => {
    if (p.physicalFlags[id]) onChange({ ...p, physicalFlags:{...p.physicalFlags,[id]:false}, physicalChecks:{...p.physicalChecks,[id]:false} });
    else onChange({ ...p, physicalChecks:{...p.physicalChecks,[id]:!p.physicalChecks[id]} });
  };
  const toggleFlag = (id: string) => {
    const nf = !p.physicalFlags[id];
    onChange({ ...p, physicalFlags:{...p.physicalFlags,[id]:nf}, physicalChecks:{...p.physicalChecks,[id]:nf?false:p.physicalChecks[id]} });
  };

  return (
    <div>
      {/* Header */}
      <div style={{ ...FL, justifyContent:"space-between", alignItems:"flex-start", paddingBottom:12, borderBottom:"2px solid #111", marginBottom:10 }}>
        <div>
          <h2 style={{ fontSize:20, fontWeight:700, letterSpacing:"-0.3px", margin:0 }}>{p.street || "Unnamed"}</h2>
          <div style={{ fontSize:11, color:"#888", marginTop:3, textTransform:"uppercase", letterSpacing:"0.5px" }}>
            {p.suburb}{p.price ? ` · ${p.price}` : ""}
          </div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:28, fontWeight:700, color:verdict.color, lineHeight:1 }}>{score.toFixed(1)}</div>
          <div style={{ fontSize:9, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.5px", marginTop:1 }}>of {max.toFixed(1)} pts</div>
          <div style={{ fontSize:11, fontWeight:700, color:verdict.color, marginTop:3, textTransform:"uppercase", letterSpacing:"0.5px" }}>{verdict.label}</div>
        </div>
      </div>
      <div style={{ height:4, background:"#eee", borderRadius:2, marginBottom:14, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${Math.max(0,Math.min(100,(score/max)*100))}%`, background:verdict.color, borderRadius:2, transition:"width 0.3s" }} />
      </div>

      {/* ── Property Details ── */}
      <Badge>Property Details</Badge>
      <div style={{ ...GR2, marginBottom:16 }}>
        <TxtInput lbl="Street" value={p.street} onChange={v=>upd("street",v)} placeholder="7 Englefield Ct" />
        <TxtInput lbl="Suburb" value={p.suburb} onChange={v=>upd("suburb",v)} placeholder="Werribee" />
        <TxtInput lbl="Price Range" value={p.price} onChange={v=>upd("price",v)} placeholder="$675k–$725k" />
        <NumberInput lbl="Asking Price" value={p.askingPriceK} onChange={v=>upd("askingPriceK",v)} suffix="k" placeholder="700" />
        <NumberInput lbl="Land Size" value={p.landSqm} onChange={v=>upd("landSqm",v)} suffix="m²" placeholder="667" />
        <NumberInput lbl="Build Year" value={p.buildYear} onChange={v=>upd("buildYear",v)} placeholder="2002" />
        <NumberInput lbl="Beds" value={p.beds} onChange={v=>upd("beds",v)} placeholder="4" />
        <NumberInput lbl="Baths" value={p.baths} onChange={v=>upd("baths",v)} placeholder="2" />
        <NumberInput lbl="Cars" value={p.cars} onChange={v=>upd("cars",v)} placeholder="2" />
        {age !== null && (
          <div>
            <Lbl t="Building Age" />
            <div style={{ border:"1px solid #e0e0e0", borderRadius:4, padding:"8px 10px", fontSize:13, color:"#555", background:"#f9f9f9" }}>{age} years old</div>
          </div>
        )}
      </div>

      {/* ── Financials ── */}
      <Badge>Financials</Badge>
      <div style={{ ...GR2, marginBottom:12 }}>
        <NumberInput lbl="Weekly Rent (est.)" value={p.weeklyRent} onChange={v=>upd("weeklyRent",v)} prefix="$" suffix="/wk" placeholder="520" />
        {yldPct !== null ? (
          <div>
            <Lbl t="Gross Yield (auto)" />
            <div style={{ border:`1px solid ${yldPct>=4?"#bbf7d0":yldPct>=3.5?"#fde68a":"#fecaca"}`, borderRadius:4, padding:"8px 10px", fontSize:16, fontWeight:700, color:yldPct>=4?"#16a34a":yldPct>=3.5?"#d97706":"#dc2626", background:yldPct>=4?"#f0fdf4":yldPct>=3.5?"#fffbeb":"#fef2f2" }}>
              {yldPct.toFixed(2)}%
            </div>
          </div>
        ) : <div />}
      </div>

      {/* ── Land Ratio ── */}
      <Badge>Land-to-Asset Ratio</Badge>
      <div style={{ ...GR2, marginBottom:10 }}>
        <NumberInput lbl="Site Value" value={p.siteValueK} onChange={v=>upd("siteValueK",v)} suffix="k" placeholder="450" />
        <NumberInput lbl={`CIV${civEst && !p.civK ? " (est.)" : ""}`} value={p.civK} onChange={v=>upd("civK",v)} suffix="k" placeholder={civEst?.toString() ?? "700"} />
      </div>
      {!p.civK && civEst && (
        <div style={{ fontSize:11, color:"#888", marginBottom:8 }}>CIV estimated as ${p.askingPriceK}k × {config.civMultiplier} = ${civEst}k. Enter actual value to override.</div>
      )}
      {lrPct !== null && (
        <div style={{ marginBottom:10 }}>
          <ResultPill label="Land-to-Asset Ratio" value={`${lrPct.toFixed(1)}%`} color={lrPct>=65?"#16a34a":lrPct>=50?"#d97706":"#dc2626"} />
        </div>
      )}

      {/* Site value estimator */}
      <div style={{ background:"#f9f9f9", border:"1px solid #e0e0e0", borderRadius:4, padding:"10px 12px", marginBottom:16 }}>
        <Lbl t="Site Value Estimator" />
        {svEst !== null ? (
          <>
            <div style={{ fontSize:11, color:"#888", marginBottom:8, fontFamily:"monospace" }}>
              {svEst.method === "land_sqm"
                ? `${p.landSqm}m² × $${config.landPricePerSqm}/m² = $${svEst.valueK}k`
                : `$${p.askingPriceK}k × (1 − max(${(config.siteValueFloor*100).toFixed(0)}%, ${(config.siteValueBuildingPct*100).toFixed(0)}% − ${age}yr × ${(config.siteValueDepreciationRate*100).toFixed(1)}%)) = $${svEst.valueK}k`
              }
            </div>
            {svEst.method === "age_fraction" && (
              <div style={{ fontSize:10, color:"#aaa", marginBottom:8 }}>Fallback method — enter land size for more accurate estimate</div>
            )}
            <div style={{ ...FL, justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#111" }}>${svEst.valueK}k estimated site value</div>
              <button onClick={() => upd("siteValueK", svEst.valueK)}
                style={{ fontSize:11, color:"#2563eb", background:"none", border:"1px solid #2563eb33", borderRadius:4, cursor:"pointer", padding:"4px 10px" }}>
                Use this →
              </button>
            </div>
          </>
        ) : (
          <div style={{ fontSize:12, color:"#bbb" }}>Enter asking price + land size (or build year) to estimate</div>
        )}
      </div>

      {/* ── Investment Score ── */}
      <Badge>Investment Score</Badge>
      <div style={{ marginBottom:16 }}>
        {config.criteria.map(c => {
          const isAuto = c.type !== "select" && getAutoScore(c, p, config) !== null;
          const s = getScore(c, p, config);
          return (
            <div key={c.id} style={{ paddingBottom:12, marginBottom:12, borderBottom:"1px solid #f0f0f0" }}>
              <div style={{ ...FL, justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <div style={{ ...FL, alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:13, fontWeight:600 }}>{c.label}</span>
                  {isAuto && <span style={{ fontSize:9, background:"#f0fdf4", color:"#16a34a", padding:"1px 5px", borderRadius:3, fontWeight:700 }}>AUTO</span>}
                </div>
                <span style={{ fontSize:15, fontWeight:700, color:sc(s) }}>{s !== null ? (s > 0 ? `+${s}` : s) : "–"}</span>
              </div>
              {isAuto ? (
                <div style={{ fontSize:11, color:"#888" }}>Scored automatically from inputs.</div>
              ) : (
                <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                  {c.bands.map((b, i) => {
                    const sel = p.manualScores[c.id] === b.pts;
                    return (
                      <button key={i} onClick={() => upd("manualScores", {...p.manualScores, [c.id]: p.manualScores[c.id]===b.pts ? null : b.pts})}
                        style={{ fontSize:11, padding:"5px 9px", border:`1px solid ${sel?"#111":"#ddd"}`, borderRadius:3, cursor:"pointer", fontFamily:"inherit", background:sel?"#111":"#fff", color:sel?"#fff":"#555" }}>
                        {b.label}
                        <span style={{ display:"block", fontSize:9, fontWeight:700, marginTop:1, color:sel?"#ccc":sc(b.pts) }}>{b.pts>0?`+${b.pts}`:b.pts}pts</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Physical Inspection ── */}
      <Badge color="#555">
        Physical Inspection{flagCount > 0 && <span style={{fontWeight:400}}> — ⚑ {flagCount} flag{flagCount>1?"s":""}</span>}
      </Badge>
      <div style={{ marginBottom:16 }}>
        {PHYSICAL_CHECKS.map(chk => {
          const checked = !!p.physicalChecks[chk.id], flagged = !!p.physicalFlags[chk.id];
          return (
            <div key={chk.id} style={{ ...FL, alignItems:"flex-start", gap:10, padding:"8px 0", borderBottom:"1px solid #f5f5f5", cursor:"pointer" }} onClick={() => toggleCheck(chk.id)}>
              <div style={{ width:18, height:18, minWidth:18, border:`${flagged?2:1.5}px solid ${flagged?"#dc2626":checked?"#111":"#ccc"}`, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center", marginTop:1, background:checked?"#111":"#fff" }}>
                {checked && <span style={{ color:"#fff", fontSize:11 }}>✓</span>}
                {flagged && <span style={{ color:"#dc2626", fontSize:11, fontWeight:900 }}>!</span>}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, color:flagged?"#dc2626":checked?"#bbb":"#111", fontWeight:flagged?600:400, textDecoration:checked?"line-through":"none" }}>{chk.label}</div>
                {chk.sub && <div style={{ fontSize:10, color:"#aaa", marginTop:1 }}>{chk.sub}</div>}
              </div>
              {chk.canFlag && (
                <button onClick={e => { e.stopPropagation(); toggleFlag(chk.id); }}
                  style={{ fontSize:11, padding:"2px 6px", border:`1px solid ${flagged?"#dc2626":"#e0e0e0"}`, borderRadius:3, background:"none", cursor:"pointer", color:flagged?"#dc2626":"#ccc", fontWeight:700 }}>⚑</button>
              )}
            </div>
          );
        })}
      </div>

      <Badge color="#555">Notes</Badge>
      <textarea value={p.notes} onChange={e => upd("notes", e.target.value)}
        placeholder="First impressions, agent info, rates notice values..."
        style={{ width:"100%", border:"1px solid #ddd", borderRadius:4, padding:"9px 10px", fontSize:13, fontFamily:"inherit", resize:"none", minHeight:72, outline:"none", boxSizing:"border-box", marginBottom:12 }} />

      <button onClick={() => { if (confirm(`Remove ${p.street}?`)) onDelete(); }}
        style={{ display:"block", width:"100%", padding:"9px", background:"#fff", border:"1px solid #e0e0e0", borderRadius:4, color:"#bbb", fontSize:10, cursor:"pointer", textTransform:"uppercase", letterSpacing:"1px", fontFamily:"inherit" }}>
        Remove this property
      </button>
    </div>
  );
}

// ─── Property Tab ─────────────────────────────────────────────────────────────

function PropertyTab({ p, idx, config, isActive, onClick }: { p: Property; idx: number; config: AppConfig; isActive: boolean; onClick: () => void }) {
  const score = getTotalScore(config, p);
  const max = getMaxScore(config);
  const verdict = getVerdict(score, max);
  const yldPct = calcYieldPct(p);
  const lrPct = calcLandRatioPct(p, config);
  const hasData = p.beds !== null || p.askingPriceK !== null || p.landSqm !== null;

  const tint = (c: string) => isActive ? c.replace("#16a34a","#4ade80").replace("#d97706","#fbbf24").replace("#dc2626","#f87171") : c;

  return (
    <button onClick={onClick} style={{ flex:"1 1 140px", border:`1px solid ${isActive?"#111":"#ddd"}`, borderRadius:6, padding:"9px 11px", background:isActive?"#111":"#fff", cursor:"pointer", textAlign:"left", fontFamily:"inherit" }}>
      <div style={{ fontSize:9, color:isActive?"#666":"#aaa", textTransform:"uppercase", letterSpacing:"0.5px", fontWeight:600, marginBottom:2 }}>P{idx+1}</div>
      <div style={{ fontSize:12, fontWeight:700, color:isActive?"#fff":"#111", marginBottom:6, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
        {p.street || "Unnamed"}
      </div>
      {hasData ? (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"3px 10px", marginBottom:6 }}>
            {[
              { l:"Price", v:p.askingPriceK?`$${p.askingPriceK}k`:p.price||"—", c:undefined },
              { l:"Land",  v:p.landSqm?`${p.landSqm}m²`:"—", c:undefined },
              { l:"Yield", v:yldPct?`${yldPct.toFixed(1)}%`:"—", c:yldPct?(yldPct>=4?"#16a34a":yldPct>=3.5?"#d97706":"#dc2626"):undefined },
              { l:"L/A",   v:lrPct?`${lrPct.toFixed(0)}%`:"—",  c:lrPct?(lrPct>=65?"#16a34a":lrPct>=50?"#d97706":"#dc2626"):undefined },
            ].map(({l,v,c}) => (
              <div key={l}>
                <div style={{ fontSize:8, color:isActive?"#555":"#aaa", textTransform:"uppercase", letterSpacing:"0.3px" }}>{l}</div>
                <div style={{ fontSize:11, fontWeight:600, color:c?tint(c):isActive?"#ddd":"#333" }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ ...FL, justifyContent:"space-between", alignItems:"center", paddingTop:5, borderTop:`1px solid ${isActive?"#333":"#f0f0f0"}` }}>
            <span style={{ fontSize:11, fontWeight:700, color:isActive?"#fff":"#111" }}>{score.toFixed(1)}/{max.toFixed(0)}</span>
            <span style={{ fontSize:10, fontWeight:700, color:tint(verdict.color) }}>{verdict.label}</span>
          </div>
        </>
      ) : (
        <div style={{ fontSize:11, color:isActive?"#666":"#aaa" }}>{p.suburb || "No details yet"}</div>
      )}
    </button>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function PropertyScorecard() {
  const [state, setState] = useState<AppState>(() => {
    const saved = loadState();
    return {
      properties: saved.properties ?? [],
      config: saved.config ? { ...DEFAULT_CONFIG, ...saved.config, criteria: saved.config.criteria ?? DEFAULT_CRITERIA } : DEFAULT_CONFIG,
      activePropertyId: saved.activePropertyId ?? null,
      view: "scorecard",
    };
  });

  const update = useCallback((next: AppState) => { setState(next); persist(next); }, []);
  const updateProp = (up: Property) => update({ ...state, properties: state.properties.map(p => p.id===up.id ? up : p) });
  const deleteProp = (id: string) => { const r = state.properties.filter(p => p.id!==id); update({...state, properties:r, activePropertyId:r[0]?.id??null}); };
  const addProp = (p: Property) => update({...state, properties:[...state.properties,p], activePropertyId:p.id, view:"scorecard"});
  const active = state.properties.find(p => p.id===state.activePropertyId) ?? null;

  return (
    <div style={{ fontFamily:"'Helvetica Neue', Helvetica, Arial, sans-serif", maxWidth:640, margin:"0 auto", padding:"0 16px 60px", color:"#111" }}>
      <div style={{ ...FL, padding:"20px 0 14px", borderBottom:"2px solid #111", marginBottom:16, justifyContent:"space-between", alignItems:"flex-end" }}>
        <div>
          <h1 style={{ fontSize:18, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px", margin:0 }}>Property Scorecard</h1>
          <p style={{ fontSize:11, color:"#888", margin:"3px 0 0", textTransform:"uppercase", letterSpacing:"0.5px" }}>
            {state.properties.length} propert{state.properties.length!==1?"ies":"y"}
          </p>
        </div>
        <div style={{ ...FL, gap:6 }}>
          {(["config","add"] as const).map(v => (
            <button key={v} onClick={() => update({...state, view:state.view===v?"scorecard":v})}
              style={{ padding:"6px 12px", border:`1px solid ${state.view===v?"#111":"#ddd"}`, borderRadius:4, background:state.view===v?"#111":"#fff", color:state.view===v?"#fff":"#555", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
              {v==="config" ? "⚙ Config" : "+ Add"}
            </button>
          ))}
        </div>
      </div>

      {state.view==="add" && <AddPanel onAdd={addProp} onCancel={() => update({...state, view:"scorecard"})} />}
      {state.view==="config" && <ConfigPanel config={state.config} onChange={cfg => update({...state, config:cfg})} />}

      {state.view==="scorecard" && (
        <>
          {state.properties.length > 0 && (
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:16 }}>
              {state.properties.map((p,i) => (
                <PropertyTab key={p.id} p={p} idx={i} config={state.config} isActive={p.id===state.activePropertyId}
                  onClick={() => update({...state, activePropertyId:p.id})} />
              ))}
            </div>
          )}
          {active ? (
            <PropertyCard property={active} config={state.config} onChange={updateProp} onDelete={() => deleteProp(active.id)} />
          ) : (
            <div style={{ textAlign:"center", padding:"60px 20px", color:"#aaa" }}>
              <div style={{ fontSize:40, marginBottom:12 }}>🏠</div>
              <div style={{ fontSize:14, fontWeight:600, color:"#555", marginBottom:6 }}>No properties yet</div>
              <div style={{ fontSize:12 }}>Tap + Add to get started</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
