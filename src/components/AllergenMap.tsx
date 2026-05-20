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
const SPECIES_CONFIG: {
  key: string; label: string; defaultWeight: number;
}[] = [
  // ── Pollen allergens ──────────────────────────────────────
  { key: 'grass',    label: 'Grass',    defaultWeight: 0.9  },
  { key: 'birch',    label: 'Birch',    defaultWeight: 0.55 },
  { key: 'hazel',    label: 'Hazel',    defaultWeight: 0.5  },
  { key: 'alder',    label: 'Alder',    defaultWeight: 0.45 },
  { key: 'oak',      label: 'Oak',      defaultWeight: 0.3  },
  { key: 'ash',      label: 'Ash',      defaultWeight: 0.25 },
  { key: 'mugwort',  label: 'Mugwort',  defaultWeight: 0.15 },
  { key: 'plane',    label: 'Plane',    defaultWeight: 0.15 },
  { key: 'plantain', label: 'Plantain', defaultWeight: 0.12 },
  { key: 'nettle',   label: 'Nettle',   defaultWeight: 0.1  },
  // ── Air pollutants ────────────────────────────────────────
  { key: 'no2',      label: 'NO₂',      defaultWeight: 0.15 },
  { key: 'pm25',     label: 'PM₂.₅',   defaultWeight: 0.15 },
];

// ── Colour ramp (YlOrRd sequential) ──────────────────────────────────────────
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
const STOPS: [number, [number, number, number]][] = [
  [0.0,  [255, 255, 204]],
  [0.25, [254, 217,  82]],
  [0.5,  [253, 141,  60]],
  [0.75, [227,  26,  28]],
  [1.0,  [128,   0,  38]],
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
function computeComposite(
  month:   number,
  layers:  Record<string, Float32Array>,
  weights: Record<string, number>,
  season:  Record<string, number[]>,
  nPixels: number,
): Float32Array {
  const out = new Float32Array(nPixels);
  for (let i = 0; i < nPixels; i++) {
    let sum  = 0;
    let land = false;
    for (const [species, layer] of Object.entries(layers)) {
      if (!isFinite(layer[i])) continue;
      land = true;
      sum += (weights[species] ?? 0) * (season[species]?.[month] ?? 1) * layer[i];
    }
    out[i] = land ? sum : NaN;
  }
  return out;
}

// ── Colour scale upper bound ──────────────────────────────────────────────────
// hi = Σ_s weight_s × max(season_s)  — the theoretical maximum composite.
// lo is always 0 (off-season / zero exposure → pale end of ramp).
function computeScaleHi(
  weights: Record<string, number>,
  season:  Record<string, number[]>,
): number {
  return Math.max(
    Object.entries(weights).reduce((sum, [s, w]) => {
      const maxSf = Math.max(...(season[s] ?? [1]));
      return sum + w * maxSf;
    }, 0),
    1e-6,
  );
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

  function rebuildComposites(weights: Record<string, number>) {
    const n = nPixelsRef.current;
    if (n === 0) return;
    compositesRef.current = Array.from({ length: 12 }, (_, m) =>
      computeComposite(m, layersRef.current, weights, seasonRef.current, n),
    );
    scaleHiRef.current = computeScaleHi(weights, seasonRef.current);
  }

  // ── Generate handler ──────────────────────────────────────────────────────
  function handleGenerate() {
    const weights: Record<string, number> = {};
    for (const { key } of SPECIES_CONFIG) {
      const v = parseFloat(weightInputs[key]);
      weights[key] = isFinite(v) && v >= 0 ? v : 0;
    }
    rebuildComposites(weights);
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
        rebuildComposites(initWeights);

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
                 style={{ background: 'linear-gradient(to right, #ffffcc, #fed152, #fd8d3c, #e31a1c, #800026)' }} />
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
        width: 200, flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        background: '#fafaf9',
        border: '1px solid #e7e5e4',
        borderRadius: 10,
        padding: '14px 14px 12px',
      }}>
        <p style={{ fontSize: 13, fontWeight: 700, color: '#44403c', margin: '0 0 12px' }}>
          Allergen weights
        </p>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {SPECIES_CONFIG.map(({ key, label }) => (
            <div key={key} style={{
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', marginBottom: 8, gap: 8,
            }}>
              <label style={{ fontSize: 12, color: '#57534e', whiteSpace: 'nowrap' }}>
                {label}
              </label>
              <input
                type="number"
                min={0}
                step="any"
                value={weightInputs[key]}
                onChange={e =>
                  setWeightInputs(prev => ({ ...prev, [key]: e.target.value }))
                }
                style={{
                  width: 58, fontSize: 12, padding: '3px 6px',
                  border: '1px solid #d6d3d1', borderRadius: 5,
                  textAlign: 'right', outline: 'none',
                  color: '#1c1917', background: '#fff',
                }}
              />
            </div>
          ))}
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
