import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// ── Types ─────────────────────────────────────────────────────────────────────
interface AllergenConfig {
  weights: Record<string, number>;
  season:  Record<string, number[]>;
}

// ── Species available for weight customisation ────────────────────────────────
// key           — must match both the .bin filename and allergen_config.json
// label         — display name in the UI
// defaultWeight — from the McInnes et al. methodology (allergen_config.json)
// group         — 'pollen' enters CI_allergens; 'pollutant' enters CI_pollutants
const SPECIES_CONFIG: {
  key: string; label: string; defaultWeight: number; group: 'pollen' | 'pollutant';
}[] = [
  // ── Pollen allergens ──────────────────────────────────────
  { key: 'grass',    label: 'Grass',    defaultWeight: 0.9,  group: 'pollen' },
  { key: 'birch',    label: 'Birch',    defaultWeight: 0.55, group: 'pollen' },
  { key: 'hazel',    label: 'Hazel',    defaultWeight: 0.5,  group: 'pollen' },
  { key: 'alder',    label: 'Alder',    defaultWeight: 0.45, group: 'pollen' },
  { key: 'oak',      label: 'Oak',      defaultWeight: 0.3,  group: 'pollen' },
  { key: 'ash',      label: 'Ash',      defaultWeight: 0.25, group: 'pollen' },
  { key: 'mugwort',  label: 'Mugwort',  defaultWeight: 0.15, group: 'pollen' },
  { key: 'plane',    label: 'Plane',    defaultWeight: 0.15, group: 'pollen' },
  { key: 'plantain', label: 'Plantain', defaultWeight: 0.12, group: 'pollen' },
  { key: 'nettle',   label: 'Nettle',   defaultWeight: 0.1,  group: 'pollen' },
  // ── Air pollutants ────────────────────────────────────────
  { key: 'no2',      label: 'NO₂',      defaultWeight: 0.5,  group: 'pollutant' },
  { key: 'pm25',     label: 'PM₂.₅',   defaultWeight: 0.5,  group: 'pollutant' },
];

const DEFAULT_K = 0.3; // pollution amplification factor

// ── Colour ramp (magma reversed: pale yellow → black/dark purple) ─────────────
// Stops sampled from matplotlib's magma_r at uniform intervals.
// t=0 (no exposure) → pale yellow; t=1 (max exposure) → near-black.
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
const STOPS: [number, [number, number, number]][] = [
  [0.000, [252, 253, 191]],  // pale yellow
  [0.125, [255, 232, 168]],  // light cream-orange
  [0.250, [252, 182,  98]],  // warm orange
  [0.375, [243, 118,  74]],  // orange-red
  [0.500, [208,  75, 109]],  // pink-red
  [0.625, [163,  47, 127]],  // magenta-purple
  [0.750, [ 81,  18, 124]],  // dark purple
  [0.875, [ 29,  17,  71]],  // very dark purple
  [1.000, [  0,   0,   4]],  // near black
];
function colorRamp(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (t <= t1) {
      const s = (t - t0) / (t1 - t0);
      return [
        Math.round(lerp(c0[0], c1[0], s)),
        Math.round(lerp(c0[1], c1[1], s)),
        Math.round(lerp(c0[2], c1[2], s)),
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// ── Composite computation ─────────────────────────────────────────────────────
// Formula: CI_overall = CI_allergens × (1 + k × CI_pollutants)
//   CI_allergens  = Σ_pollen  weight × season[month] × layer
//   CI_pollutants = Σ_pollutant weight × layer   (season is all-ones for pollutants)
// When k = 0 the result reduces to CI_allergens only.
// When pollution = 0 the result equals CI_allergens with no penalty.
const POLLEN_KEYS    = SPECIES_CONFIG.filter(s => s.group === 'pollen'   ).map(s => s.key);
const POLLUTANT_KEYS = SPECIES_CONFIG.filter(s => s.group === 'pollutant').map(s => s.key);

function computeComposite(
  month:   number,
  layers:  Record<string, Float32Array>,
  weights: Record<string, number>,
  season:  Record<string, number[]>,
  nPixels: number,
  k:       number,
): Float32Array {
  const out = new Float32Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    let allergen  = 0;
    let pollutant = 0;
    let land      = false;
    for (const key of POLLEN_KEYS) {
      const v = layers[key]?.[i];
      if (v == null || !isFinite(v)) continue;
      land = true;
      allergen += (weights[key] ?? 0) * (season[key]?.[month] ?? 1) * v;
    }
    for (const key of POLLUTANT_KEYS) {
      const v = layers[key]?.[i];
      if (v == null || !isFinite(v)) continue;
      land = true;
      pollutant += (weights[key] ?? 0) * v;
    }
    out[i] = land ? allergen * (1 + k * pollutant) : NaN;
  }
  return out;
}

// ── Colour scale upper bound ──────────────────────────────────────────────────
// hi_allergens  = Σ_pollen   weight × max(season)
// hi_pollutants = Σ_pollutant weight               (season max = 1)
// hi_overall    = hi_allergens × (1 + k × hi_pollutants)
function computeScaleHi(
  weights: Record<string, number>,
  season:  Record<string, number[]>,
  k:       number,
): number {
  const hiAllergen = POLLEN_KEYS.reduce((sum, key) => {
    const maxSf = Math.max(...(season[key] ?? [1]));
    return sum + (weights[key] ?? 0) * maxSf;
  }, 0);
  const hiPollutant = POLLUTANT_KEYS.reduce((sum, key) => {
    return sum + (weights[key] ?? 0); // season max = 1 for all pollutants
  }, 0);
  return Math.max(hiAllergen * (1 + k * hiPollutant), 1e-6);
}

// ── Canvas painter (Mercator-corrected) ───────────────────────────────────────
// Source data is linearly spaced in WGS84 latitude; MapLibre renders canvas
// sources with linear interpolation in Web Mercator y.  At UK latitudes this
// causes ~35–40 km northward displacement without correction.
// Fix: for each canvas row r, invert the Mercator formula to find the WGS84
// latitude that MapLibre will place that row at, then sample source data there.
function paintCanvas(
  canvas: HTMLCanvasElement,
  data:   Float32Array,
  ncols:  number,
  nrows:  number,
  lo:     number,
  hi:     number,
  west:   number,
  east:   number,
  south:  number,
  north:  number,
) {
  const R     = 6_378_137;
  const toRad = Math.PI / 180;
  const yN    = R * Math.log(Math.tan(Math.PI / 4 + north * toRad / 2));
  const yS    = R * Math.log(Math.tan(Math.PI / 4 + south * toRad / 2));
  const range = Math.max(hi - lo, 1e-6);

  canvas.width  = ncols;
  canvas.height = nrows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ncols, nrows);
  const d   = img.data;

  for (let row = 0; row < nrows; row++) {
    const yMerc  = yN - (row / nrows) * (yN - yS);
    const lat    = (2 * Math.atan(Math.exp(yMerc / R)) - Math.PI / 2) / toRad;
    const srcRow = Math.round((north - lat) / (north - south) * nrows);

    for (let col = 0; col < ncols; col++) {
      const base = (row * ncols + col) * 4;
      if (srcRow < 0 || srcRow >= nrows) { d[base + 3] = 0; continue; }
      const v = data[srcRow * ncols + col];
      if (!isFinite(v)) {
        d[base + 3] = 0;
      } else {
        const t       = (v - lo) / range;
        const [r,g,b] = colorRamp(t);
        d[base]     = r;
        d[base + 1] = g;
        d[base + 2] = b;
        d[base + 3] = 210;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ── Shared weight row ─────────────────────────────────────────────────────────
function WeightRow({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', marginBottom: 7, gap: 8,
    }}>
      <label style={{ fontSize: 12, color: '#57534e', whiteSpace: 'nowrap' }}>
        {label}
      </label>
      <input
        type="number" min={0} step="any"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: 58, fontSize: 12, padding: '3px 6px',
          border: '1px solid #d6d3d1', borderRadius: 5,
          textAlign: 'right', outline: 'none',
          color: '#1c1917', background: '#fff',
        }}
      />
    </div>
  );
}

// ── Month names ───────────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Component ─────────────────────────────────────────────────────────────────
export default function AllergenMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);

  // Persisted across renders — set once on load, read in handleGenerate
  const layersRef    = useRef<Record<string, Float32Array>>({});
  const seasonRef    = useRef<Record<string, number[]>>({});
  const nPixelsRef   = useRef<number>(0);
  const gridRef      = useRef<{
    ncols: number; nrows: number;
    west: number; east: number; south: number; north: number;
  } | null>(null);

  // Derived from current weights — updated by handleGenerate
  const compositesRef = useRef<Float32Array[]>([]);
  const scaleHiRef    = useRef<number>(1);

  const [status, setStatus]           = useState<'loading' | 'ready' | 'error'>('loading');
  const [month, setMonth]             = useState(() => new Date().getMonth());
  // String values so the <input> is fully controlled while the user types
  const [weightInputs, setWeightInputs] = useState<Record<string, string>>(
    () => Object.fromEntries(SPECIES_CONFIG.map(({ key, defaultWeight }) => [key, String(defaultWeight)])),
  );
  const [kInput, setKInput] = useState(String(DEFAULT_K));

  // ── Helpers ───────────────────────────────────────────────────────────────
  function repaint(m: number) {
    const canvas = canvasRef.current;
    const grid   = gridRef.current;
    if (!canvas || !grid || compositesRef.current.length === 0) return;
    const { ncols, nrows, west, east, south, north } = grid;
    paintCanvas(
      canvas, compositesRef.current[m],
      ncols, nrows, 0, scaleHiRef.current,
      west, east, south, north,
    );
  }

  function rebuildComposites(weights: Record<string, number>, k: number) {
    const n = nPixelsRef.current;
    if (n === 0) return;
    compositesRef.current = Array.from({ length: 12 }, (_, m) =>
      computeComposite(m, layersRef.current, weights, seasonRef.current, n, k),
    );
    scaleHiRef.current = computeScaleHi(weights, seasonRef.current, k);
  }

  // ── Generate handler ──────────────────────────────────────────────────────
  function handleGenerate() {
    const weights: Record<string, number> = {};
    for (const { key } of SPECIES_CONFIG) {
      const v = parseFloat(weightInputs[key]);
      weights[key] = isFinite(v) && v >= 0 ? v : 0;
    }
    const k = Math.max(0, isFinite(parseFloat(kInput)) ? parseFloat(kInput) : DEFAULT_K);
    rebuildComposites(weights, k);
    repaint(month);
  }

  // ── Effect 1: initialise map + load all species layers ────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [-2.5, 54.5],
      zoom: 5,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    let cancelled = false;

    map.on('load', async () => {
      try {
        const [meta, config]: [
          Record<string, { ncols: number; nrows: number; west: number; east: number; south: number; north: number }>,
          AllergenConfig,
        ] = await Promise.all([
          fetch('/data/layers_meta.json').then(r => r.json()),
          fetch('/data/allergen_config.json').then(r => r.json()),
        ]);

        const keys = SPECIES_CONFIG.map(s => s.key);
        const { ncols, nrows, west, east, south, north } = meta[keys[0]];
        gridRef.current  = { ncols, nrows, west, east, south, north };
        nPixelsRef.current = ncols * nrows;
        seasonRef.current  = config.season;

        // Fetch all species in parallel
        const buffers = await Promise.all(
          keys.map(k => fetch(`/data/${k}.bin`).then(r => r.arrayBuffer())),
        );
        if (cancelled) return;

        keys.forEach((k, i) => {
          layersRef.current[k] = new Float32Array(buffers[i]);
        });

        // Initial weights from SPECIES_CONFIG defaultWeight values
        const initWeights = Object.fromEntries(
          SPECIES_CONFIG.map(({ key, defaultWeight }) => [key, defaultWeight]),
        );
        rebuildComposites(initWeights, DEFAULT_K);

        // Create canvas + add MapLibre source
        const canvas = document.createElement('canvas');
        canvasRef.current = canvas;
        const initMonth = new Date().getMonth();
        paintCanvas(
          canvas, compositesRef.current[initMonth],
          ncols, nrows, 0, scaleHiRef.current,
          west, east, south, north,
        );

        map.addSource('overlay', {
          type: 'canvas', canvas,
          coordinates: [[west, north], [east, north], [east, south], [west, south]],
          animate: true,
        } as unknown as maplibregl.CanvasSourceSpecification);

        map.addLayer({
          id: 'overlay-layer', type: 'raster', source: 'overlay',
          paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
        });

        if (!cancelled) setStatus('ready');
      } catch (e) {
        console.error('[AllergenMap] failed to load data', e);
        if (!cancelled) setStatus('error');
      }
    });

    return () => { cancelled = true; map.remove(); };
  }, []);

  // ── Effect 2: repaint when month slider moves ─────────────────────────────
  useEffect(() => { repaint(month); }, [month]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 16, width: '100%' }}>

      {/* ── Map column ───────────────────────────────────────────────────────── */}
      <div style={{ position: 'relative', flex: '1 1 0', minWidth: 0, height: '640px' }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* Loading */}
        {status === 'loading' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(250,250,249,0.85)', zIndex: 10,
          }}>
            <div className="w-7 h-7 border-4 border-stone-300 border-t-stone-600 rounded-full animate-spin" />
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(250,250,249,0.85)', zIndex: 10,
          }}>
            <p className="text-sm text-red-500 px-6 text-center">Failed to load allergen data.</p>
          </div>
        )}

        {/* ── Legend — top-left ── */}
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10 }}
             className="bg-white/90 rounded px-2.5 py-2 shadow text-xs text-stone-600">
          <p className="font-medium mb-1">Composite allergen risk</p>
          <div className="flex items-center gap-1.5">
            <span className="text-stone-400">Low</span>
            <div className="w-24 h-2.5 rounded"
                 style={{ background: 'linear-gradient(to right, #fcfdbf, #fcb661, #f04f6e, #812a8c, #000004)' }} />
            <span className="text-stone-400">High</span>
          </div>
        </div>

        {/* ── Month slider — full-width at bottom ── */}
        <div style={{
          position: 'absolute', bottom: 28, left: 12, right: 12, zIndex: 10,
          background: 'rgba(255,255,255,0.93)',
          borderRadius: 10, padding: '8px 14px 10px',
          boxShadow: '0 1px 6px rgba(0,0,0,0.14)',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: '#44403c', margin: '0 0 4px' }}>
            {MONTH_NAMES[month]}
          </p>
          <input
            type="range" min={0} max={11} step={1}
            value={month}
            onChange={e => setMonth(Number(e.target.value))}
            style={{ width: '100%', accentColor: '#e31a1c', cursor: 'pointer' }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: '#a8a29e', marginTop: 3,
            userSelect: 'none',
          }}>
            {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => (
              <span key={m}>{m}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Sidebar — weights panel ───────────────────────────────────────────── */}
      <div style={{
        width: 210, flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        background: '#fafaf9',
        border: '1px solid #e7e5e4',
        borderRadius: 10,
        padding: '14px 14px 12px',
      }}>

        {/* ── Pollen allergens ── */}
        <p style={{ fontSize: 11, fontWeight: 700, color: '#78716c', textTransform: 'uppercase',
                    letterSpacing: '0.05em', margin: '0 0 8px' }}>
          Pollen allergens
        </p>
        <div style={{ overflowY: 'auto' }}>
          {SPECIES_CONFIG.filter(s => s.group === 'pollen').map(({ key, label }) => (
            <WeightRow key={key} label={label} value={weightInputs[key]}
              onChange={v => setWeightInputs(prev => ({ ...prev, [key]: v }))} />
          ))}
        </div>

        {/* ── Divider ── */}
        <div style={{ borderTop: '1px solid #e7e5e4', margin: '10px 0' }} />

        {/* ── Air pollutants ── */}
        <p style={{ fontSize: 11, fontWeight: 700, color: '#78716c', textTransform: 'uppercase',
                    letterSpacing: '0.05em', margin: '0 0 8px' }}>
          Air pollutants
        </p>
        {SPECIES_CONFIG.filter(s => s.group === 'pollutant').map(({ key, label }) => (
          <WeightRow key={key} label={label} value={weightInputs[key]}
            onChange={v => setWeightInputs(prev => ({ ...prev, [key]: v }))} />
        ))}

        {/* Amplification factor k */}
        <div style={{ marginTop: 6, padding: '8px 8px 6px', background: '#f5f5f4',
                      borderRadius: 7, border: '1px solid #e7e5e4' }}>
          <p style={{ fontSize: 11, color: '#57534e', margin: '0 0 2px' }}>
            Amplification factor <em>k</em>
          </p>
          <p style={{ fontSize: 10, color: '#a8a29e', margin: '0 0 6px', lineHeight: 1.4 }}>
            CI = CI<sub>pollen</sub> × (1 + <em>k</em> × CI<sub>poll.</sub>)
          </p>
          <input
            type="number" min={0} step="0.05"
            value={kInput}
            onChange={e => setKInput(e.target.value)}
            style={{
              width: '100%', fontSize: 12, padding: '3px 6px',
              border: '1px solid #d6d3d1', borderRadius: 5,
              textAlign: 'right', outline: 'none', boxSizing: 'border-box',
              color: '#1c1917', background: '#fff',
            }}
          />
        </div>

        <button
          onClick={handleGenerate}
          style={{
            marginTop: 10, width: '100%', padding: '6px 0',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: '#e31a1c', color: '#fff',
            border: 'none', borderRadius: 6,
          }}
        >
          Generate
        </button>
      </div>

    </div>
  );
}
