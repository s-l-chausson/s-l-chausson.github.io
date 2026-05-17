import { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fromArrayBuffer } from 'geotiff';

// ── Layer definitions ─────────────────────────────────────────────────────────
interface Layer {
  id:            string;
  label:         string;
  description:   string;
  note?:         string;
  defaultWeight: number;
  min:           number;
  max:           number;
  step:          number;
  group:         'pollen' | 'pollution';
}

// Weights follow McInnes et al. (2017) Science of the Total Environment.
// Birch default = pollen-only (10.8); food cross-reactants add another 14.5 → 25.3.
const LAYERS: Layer[] = [
  {
    id: 'birch', label: 'Birch', group: 'pollen',
    description: 'Bet v 1 — pollen sensitisation',
    note: 'Increase to 25.3 if you also react to birch-related foods (apple, hazelnut, cherry…)',
    defaultWeight: 10.8, min: 0, max: 30, step: 0.1,
  },
  {
    id: 'alder', label: 'Alder', group: 'pollen',
    description: 'Aln g 1',
    defaultWeight: 1.1, min: 0, max: 5, step: 0.1,
  },
  {
    id: 'hazel', label: 'Hazel', group: 'pollen',
    description: 'Cor a 1.0101',
    defaultWeight: 2.3, min: 0, max: 5, step: 0.1,
  },
  {
    id: 'grassland', label: 'Grass', group: 'pollen',
    description: 'Timothy grass (Phl p 1 + Phl p 5)',
    defaultWeight: 5.0, min: 0, max: 10, step: 0.1,
  },
  {
    id: 'plane', label: 'Plane tree', group: 'pollen',
    description: 'Pla a 1 — urban street trees',
    defaultWeight: 5.5, min: 0, max: 10, step: 0.1,
  },
  {
    id: 'no2', label: 'NO₂', group: 'pollution',
    description: 'Annual mean µg/m³ (DEFRA PCM 2024)',
    defaultWeight: 1.0, min: 0, max: 5, step: 0.1,
  },
  {
    id: 'pm25', label: 'PM2.5', group: 'pollution',
    description: 'Annual mean µg/m³ (DEFRA PCM 2024)',
    defaultWeight: 1.0, min: 0, max: 5, step: 0.1,
  },
];

const DEFAULT_WEIGHTS = Object.fromEntries(LAYERS.map(l => [l.id, l.defaultWeight]));

// ── Metadata type ─────────────────────────────────────────────────────────────
interface LayerMeta {
  ncols: number; nrows: number;
  west: number;  east: number;
  south: number; north: number;
}

// ── Colour ramp (YlOrRd sequential: low exposure → high exposure) ─────────────
// ColorBrewer YlOrRd-5, perceptually uniform for sequential exposure data.
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
const STOPS: [number, [number, number, number]][] = [
  [0.0,  [255, 255, 204]],  // very light yellow
  [0.25, [254, 217,  82]],  // yellow
  [0.5,  [253, 141,  60]],  // orange
  [0.75, [227,  26,  28]],  // red
  [1.0,  [128,   0,  38]],  // dark red
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

// ── Composite renderer — paints directly into a provided canvas ───────────────
function renderCompositeToCanvas(
  canvas: HTMLCanvasElement,
  arrays: Record<string, Float32Array>,
  weights: Record<string, number>,
  ncols: number,
  nrows: number,
): void {
  const n = ncols * nrows;

  // Compute composite and collect valid (land) values for percentile scaling
  const composite = new Float32Array(n);
  const valid: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, land = true;
    for (const [id, arr] of Object.entries(arrays)) {
      const v = arr[i];
      if (!isFinite(v)) { land = false; break; }
      sum += (weights[id] ?? 0) * v;
    }
    composite[i] = land ? sum : NaN;
    if (land && i % 5 === 0) valid.push(sum); // sample ~20% for perf
  }

  // Stretch colour scale across p05–p95 of land values so 90% of pixels
  // use the full ramp, avoiding near-white wash from skewed distributions.
  valid.sort((a, b) => a - b);
  const lo = valid[Math.floor(valid.length * 0.05)] ?? 0;
  const hi = valid[Math.floor(valid.length * 0.95)] ?? 1;
  const range = Math.max(hi - lo, 0.001);

  // Paint into the canvas
  canvas.width  = ncols;
  canvas.height = nrows;
  const ctx     = canvas.getContext('2d')!;
  const imgData = ctx.createImageData(ncols, nrows);
  const d       = imgData.data;

  for (let i = 0; i < n; i++) {
    const v    = composite[i];
    const base = i * 4;
    if (!isFinite(v)) {
      d[base + 3] = 0; // transparent (sea / outside GB)
    } else {
      const t       = Math.max(0, Math.min(1, (v - lo) / range));
      const [r,g,b] = colorRamp(t);
      d[base]     = r;
      d[base + 1] = g;
      d[base + 2] = b;
      d[base + 3] = 215;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

// ── Weight slider ─────────────────────────────────────────────────────────────
function WeightSlider({
  layer, value, onChange,
}: {
  layer: Layer; value: number; onChange: (id: string, v: number) => void;
}) {
  return (
    <div className="py-2">
      <div className="flex justify-between items-baseline mb-0.5">
        <span className="text-sm font-medium text-stone-700">{layer.label}</span>
        <span className="text-xs text-stone-400 tabular-nums">{value.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={layer.min} max={layer.max} step={layer.step}
        value={value}
        onChange={e => onChange(layer.id, parseFloat(e.target.value))}
        className="w-full h-1.5 rounded accent-stone-600 cursor-pointer"
      />
      <p className="text-xs text-stone-400 mt-0.5">{layer.description}</p>
      {layer.note && value === layer.defaultWeight && (
        <p className="text-xs text-stone-300 mt-0.5 italic leading-snug">{layer.note}</p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AllergenMap() {
  const mapRef           = useRef<maplibregl.Map | null>(null);
  const containerRef     = useRef<HTMLDivElement>(null);
  const layerData        = useRef<Record<string, Float32Array>>({});
  const metaRef          = useRef<LayerMeta | null>(null);
  const compositeCanvas  = useRef<HTMLCanvasElement | null>(null);
  const debounceTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapReady         = useRef(false);

  const [weights, setWeights]     = useState<Record<string, number>>(DEFAULT_WEIGHTS);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadMsg, setLoadMsg]     = useState('Loading allergen layers…');

  // Update composite by repainting the canvas — MapLibre reads it each frame.
  const updateMap = useCallback((w: Record<string, number>) => {
    const meta   = metaRef.current;
    const canvas = compositeCanvas.current;
    if (!meta || !canvas || !mapReady.current) return;
    if (Object.keys(layerData.current).length !== LAYERS.length) return;
    renderCompositeToCanvas(canvas, layerData.current, w, meta.ncols, meta.nrows);
  }, []);

  // Debounced weight change
  function handleWeight(id: string, value: number) {
    const next = { ...weights, [id]: value };
    setWeights(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => updateMap(next), 80);
  }

  function handleReset() {
    setWeights(DEFAULT_WEIGHTS);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => updateMap(DEFAULT_WEIGHTS), 80);
  }

  // Load GeoTIFFs + initialise map
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Load metadata
      let meta: Record<string, LayerMeta>;
      try {
        const res = await fetch('/data/layers_meta.json');
        if (!res.ok) throw new Error('layers_meta.json not found');
        meta = await res.json();
      } catch {
        if (!cancelled) setLoadState('error');
        return;
      }

      const anyMeta = meta[LAYERS[0].id];
      if (!anyMeta) { if (!cancelled) setLoadState('error'); return; }
      metaRef.current = anyMeta;

      // Load each layer in parallel
      const ids = LAYERS.map(l => l.id);
      setLoadMsg(`Loading ${ids.length} allergen layers…`);
      try {
        await Promise.all(ids.map(async id => {
          const res    = await fetch(`/data/${id}.tif`);
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${id}.tif`);
          const buf    = await res.arrayBuffer();
          const tiff   = await fromArrayBuffer(buf);
          const image  = await tiff.getImage();
          const rasters = await image.readRasters();
          layerData.current[id] = rasters[0] as Float32Array;
        }));
      } catch {
        if (!cancelled) setLoadState('error');
        return;
      }
      if (cancelled) return;
      setLoadMsg('Rendering…');

      // Initialise map
      if (!containerRef.current || mapRef.current) return;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: [-2.0, 55.5],
        zoom: 5,
        attributionControl: false,
      });
      map.addControl(new maplibregl.NavigationControl(), 'top-right');
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      mapRef.current = map;

      map.on('load', () => {
        if (cancelled) return;
        const m = anyMeta;
        const coords: [[number,number],[number,number],[number,number],[number,number]] = [
          [m.west,  m.north],
          [m.east,  m.north],
          [m.east,  m.south],
          [m.west,  m.south],
        ];

        // Create canvas, paint composite, hand directly to MapLibre (no data URL needed)
        const canvas = document.createElement('canvas');
        compositeCanvas.current = canvas;
        renderCompositeToCanvas(canvas, layerData.current, DEFAULT_WEIGHTS, m.ncols, m.nrows);

        map.addSource('composite', {
          type: 'canvas',
          canvas,
          coordinates: coords,
          animate: true,   // MapLibre reads the canvas each frame → updateMap just repaints
        } as unknown as maplibregl.CanvasSourceSpecification);
        map.addLayer({
          id: 'composite-layer', type: 'raster', source: 'composite',
          paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 },
        });

        mapReady.current = true;
        if (!cancelled) setLoadState('ready');
      });
    }

    init();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      compositeCanvas.current = null;
      mapReady.current = false;
    };
  }, []);

  const pollenLayers    = LAYERS.filter(l => l.group === 'pollen');
  const pollutionLayers = LAYERS.filter(l => l.group === 'pollution');
  const totalW          = Object.values(weights).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col lg:flex-row gap-0 border border-stone-200 rounded-lg overflow-hidden">

      {/* Map */}
      <div className="relative w-full lg:flex-1 h-[500px] lg:h-[640px]">
        <div ref={containerRef} className="absolute inset-0" />

        {/* Loading / error overlay */}
        {loadState !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-stone-50/90 z-10">
            {loadState === 'loading' ? (
              <>
                <div className="w-8 h-8 border-4 border-stone-300 border-t-stone-600 rounded-full animate-spin mb-3" />
                <p className="text-sm text-stone-500">{loadMsg}</p>
              </>
            ) : (
              <p className="text-sm text-red-500 px-6 text-center">
                Could not load allergen layers. Run <code>export_web_layers.R</code> and push <code>public/data/</code>.
              </p>
            )}
          </div>
        )}

        {/* Colour legend */}
        {loadState === 'ready' && (
          <div className="absolute bottom-8 left-3 bg-white/90 rounded px-2.5 py-2 shadow text-xs text-stone-600 z-10">
            <p className="font-medium mb-1">Composite index</p>
            <div className="flex items-center gap-1.5">
              <span className="text-stone-400">Low</span>
              <div className="w-24 h-2.5 rounded"
                   style={{ background: 'linear-gradient(to right, #ffffcc, #fed152, #fd8d3c, #e31a1c, #800026)' }} />
              <span className="text-stone-400">High</span>
            </div>
            <p className="text-stone-300 mt-0.5 text-[10px]">relative to GB p5–p95</p>
          </div>
        )}
      </div>

      {/* Control panel */}
      <div className="w-full lg:w-72 bg-white border-t lg:border-t-0 lg:border-l border-stone-200 p-5 overflow-y-auto lg:max-h-[640px]">
        <div className="flex justify-between items-center mb-1">
          <h2 className="font-semibold text-stone-800 text-sm">Allergen weights</h2>
          <button onClick={handleReset}
                  className="text-xs text-stone-400 hover:text-stone-600 transition-colors">
            Reset
          </button>
        </div>
        <p className="text-xs text-stone-400 mb-4 leading-relaxed">
          Drag sliders to reflect your sensitivities. Weights follow{' '}
          <a href="https://doi.org/10.1016/j.scitotenv.2017.02.100" target="_blank" rel="noopener"
             className="underline hover:text-stone-600">McInnes et al. (2017)</a>.
        </p>

        <p className="text-xs font-medium text-stone-500 uppercase tracking-wide mb-1">Pollen</p>
        <div className="divide-y divide-stone-100 mb-5">
          {pollenLayers.map(l => (
            <WeightSlider key={l.id} layer={l} value={weights[l.id]} onChange={handleWeight} />
          ))}
        </div>

        <p className="text-xs font-medium text-stone-500 uppercase tracking-wide mb-1">Air pollution</p>
        <div className="divide-y divide-stone-100 mb-5">
          {pollutionLayers.map(l => (
            <WeightSlider key={l.id} layer={l} value={weights[l.id]} onChange={handleWeight} />
          ))}
        </div>

        {/* Weight breakdown bars */}
        <div className="pt-4 border-t border-stone-100">
          <p className="text-xs text-stone-400 mb-2">Weight breakdown</p>
          <div className="space-y-1.5">
            {LAYERS.map(l => {
              const pct = totalW > 0 ? (weights[l.id] / totalW) * 100 : 0;
              return (
                <div key={l.id} className="flex items-center gap-2">
                  <div className="h-1.5 rounded-full bg-stone-400 flex-shrink-0"
                       style={{ width: `${pct.toFixed(1)}%`, maxWidth: '100%',
                                minWidth: weights[l.id] > 0 ? '2px' : '0',
                                transition: 'width 0.15s ease' }} />
                  <span className="text-xs text-stone-400 whitespace-nowrap">
                    {l.label} {Math.round(pct)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
