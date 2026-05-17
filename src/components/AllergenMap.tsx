import { useState, useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fromUrl } from 'geotiff';

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

// ── Colour ramp (blue → white → red, diverging) ───────────────────────────────
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
const STOPS: [number, [number, number, number]][] = [
  [0.0,  [49,  54,  149]],
  [0.25, [116, 173, 209]],
  [0.5,  [255, 255, 255]],
  [0.75, [253, 141,  60]],
  [1.0,  [165,   0,  38]],
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

// ── Composite renderer ────────────────────────────────────────────────────────
function renderComposite(
  arrays: Record<string, Float32Array>,
  weights: Record<string, number>,
  ncols: number,
  nrows: number,
): string {
  const n = ncols * nrows;

  // Compute composite and collect valid values for percentile scaling
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
    if (land && i % 7 === 0) valid.push(sum); // sample ~14 % for perf
  }

  // Symmetric clip at 98th-percentile absolute value for colour scale
  valid.sort((a, b) => a - b);
  const p02 = valid[Math.floor(valid.length * 0.02)] ?? -1;
  const p98 = valid[Math.floor(valid.length * 0.98)] ??  1;
  const clip = Math.max(Math.abs(p02), Math.abs(p98), 0.001);

  // Render to canvas
  const canvas = document.createElement('canvas');
  canvas.width  = ncols;
  canvas.height = nrows;
  const ctx      = canvas.getContext('2d')!;
  const imgData  = ctx.createImageData(ncols, nrows);
  const d        = imgData.data;

  for (let i = 0; i < n; i++) {
    const v    = composite[i];
    const base = i * 4;
    if (!isFinite(v)) {
      d[base + 3] = 0; // transparent
    } else {
      const t       = 0.5 + v / (2 * clip);
      const [r,g,b] = colorRamp(t);
      d[base]     = r;
      d[base + 1] = g;
      d[base + 2] = b;
      d[base + 3] = 210;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
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
  const mapRef        = useRef<maplibregl.Map | null>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const layerData     = useRef<Record<string, Float32Array>>({});
  const metaRef       = useRef<LayerMeta | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapReady      = useRef(false);

  const [weights, setWeights]     = useState<Record<string, number>>(DEFAULT_WEIGHTS);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadMsg, setLoadMsg]     = useState('Loading allergen layers…');

  // Update composite image on the map
  const updateMap = useCallback((w: Record<string, number>) => {
    const map  = mapRef.current;
    const meta = metaRef.current;
    if (!map || !meta || !mapReady.current) return;
    const loaded = Object.keys(layerData.current).length === LAYERS.length;
    if (!loaded) return;

    const dataUrl = renderComposite(layerData.current, w, meta.ncols, meta.nrows);
    const src = map.getSource('composite') as maplibregl.ImageSource | undefined;
    if (src) {
      src.updateImage({ url: dataUrl });
    }
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
          const tiff  = await fromUrl(`/data/${id}.tif`);
          const image = await tiff.getImage();
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
        const dataUrl = renderComposite(layerData.current, DEFAULT_WEIGHTS, m.ncols, m.nrows);
        map.addSource('composite', { type: 'image', url: dataUrl, coordinates: coords });
        map.addLayer({ id: 'composite-layer', type: 'raster', source: 'composite',
                       paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 } });
        mapReady.current = true;
        if (!cancelled) setLoadState('ready');
      });
    }

    init();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
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
                   style={{ background: 'linear-gradient(to right, #3136d5, #74add1, #ffffff, #fd8d3c, #a50026)' }} />
              <span className="text-stone-400">High</span>
            </div>
            <p className="text-stone-300 mt-0.5 text-[10px]">relative to GB average</p>
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
