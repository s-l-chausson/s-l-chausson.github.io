import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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

function paintCanvas(
  canvas: HTMLCanvasElement,
  data: Float32Array,
  ncols: number,
  nrows: number,
) {
  // Collect finite (land) values for p05–p95 stretch
  const valid: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (isFinite(data[i])) valid.push(data[i]);
  }
  valid.sort((a, b) => a - b);
  const lo    = valid[Math.floor(valid.length * 0.05)] ?? 0;
  const hi    = valid[Math.floor(valid.length * 0.95)] ?? 1;
  const range = Math.max(hi - lo, 1e-6);

  canvas.width  = ncols;
  canvas.height = nrows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ncols, nrows);
  const d   = img.data;

  for (let i = 0; i < data.length; i++) {
    const v    = data[i];
    const base = i * 4;
    if (!isFinite(v)) {
      d[base + 3] = 0; // transparent — sea / outside GB
    } else {
      const t       = (v - lo) / range;
      const [r,g,b] = colorRamp(t);
      d[base]     = r;
      d[base + 1] = g;
      d[base + 2] = b;
      d[base + 3] = 210;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ── Constants ─────────────────────────────────────────────────────────────────
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_KEYS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

// ── Component ─────────────────────────────────────────────────────────────────
export default function AllergenMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);
  const monthDataRef = useRef<(Float32Array | null)[]>(Array(12).fill(null));
  const gridRef      = useRef<{ ncols: number; nrows: number } | null>(null);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [month, setMonth]   = useState(() => new Date().getMonth());

  // ── Effect 1: initialise map and load all monthly data ────────────────────
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
        const meta = await fetch('/data/layers_meta.json').then(r => r.json());
        const { ncols, nrows, west, east, south, north } = meta.month_january;
        gridRef.current = { ncols, nrows };

        // Fetch all 12 monthly composites in parallel
        const buffers = await Promise.all(
          MONTH_KEYS.map(k =>
            fetch(`/data/month_${k}.bin`).then(r => r.arrayBuffer()),
          ),
        );
        if (cancelled) return;

        buffers.forEach((buf, i) => {
          monthDataRef.current[i] = new Float32Array(buf);
        });

        // Paint initial month
        const initialMonth = new Date().getMonth();
        const canvas = document.createElement('canvas');
        canvasRef.current = canvas;
        paintCanvas(canvas, monthDataRef.current[initialMonth]!, ncols, nrows);

        // animate:true so MapLibre re-reads the canvas when we repaint it
        map.addSource('overlay', {
          type: 'canvas',
          canvas,
          coordinates: [[west, north], [east, north], [east, south], [west, south]],
          animate: true,
        } as unknown as maplibregl.CanvasSourceSpecification);

        map.addLayer({
          id: 'overlay-layer',
          type: 'raster',
          source: 'overlay',
          paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 },
        });

        if (!cancelled) setStatus('ready');
      } catch (e) {
        console.error('[AllergenMap] failed to load data', e);
        if (!cancelled) setStatus('error');
      }
    });

    return () => {
      cancelled = true;
      map.remove();
    };
  }, []);

  // ── Effect 2: repaint canvas whenever month changes ───────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const grid   = gridRef.current;
    const data   = monthDataRef.current[month];
    if (!canvas || !grid || !data) return; // map not ready yet — no-op
    paintCanvas(canvas, data, grid.ncols, grid.nrows);
  }, [month]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', width: '100%', height: '600px' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Loading spinner */}
      {status === 'loading' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(250,250,249,0.85)', zIndex: 10,
        }}>
          <div className="w-7 h-7 border-4 border-stone-300 border-t-stone-600 rounded-full animate-spin" />
        </div>
      )}

      {/* Error message */}
      {status === 'error' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(250,250,249,0.85)', zIndex: 10,
        }}>
          <p className="text-sm text-red-500 px-6 text-center">
            Failed to load allergen data.
          </p>
        </div>
      )}

      {/* Controls (visible once data is ready) */}
      {status === 'ready' && (
        <>
          {/* Month slider — centred at bottom */}
          <div style={{
            position: 'absolute', bottom: 36, left: '50%',
            transform: 'translateX(-50%)', zIndex: 10,
            background: 'rgba(255,255,255,0.93)',
            borderRadius: 10, padding: '8px 18px 10px',
            boxShadow: '0 1px 6px rgba(0,0,0,0.14)',
            minWidth: 230, textAlign: 'center',
          }}>
            <p style={{
              fontSize: 13, fontWeight: 600, color: '#44403c',
              marginBottom: 6, marginTop: 0,
            }}>
              {MONTH_NAMES[month]}
            </p>
            <input
              type="range"
              min={0}
              max={11}
              step={1}
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              style={{ width: '100%', accentColor: '#e31a1c', cursor: 'pointer' }}
            />
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 10, color: '#a8a29e', marginTop: 3,
            }}>
              <span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span><span>Dec</span>
            </div>
          </div>

          {/* Legend — bottom-left */}
          <div style={{
            position: 'absolute', bottom: 120, left: 12, zIndex: 10,
          }}
               className="bg-white/90 rounded px-2.5 py-2 shadow text-xs text-stone-600">
            <p className="font-medium mb-1">Composite allergen risk</p>
            <div className="flex items-center gap-1.5">
              <span className="text-stone-400">Low</span>
              <div className="w-24 h-2.5 rounded"
                   style={{ background: 'linear-gradient(to right, #ffffcc, #fed152, #fd8d3c, #e31a1c, #800026)' }} />
              <span className="text-stone-400">High</span>
            </div>
            <p className="text-stone-400 mt-0.5 text-[10px]">relative to GB p5–p95</p>
          </div>
        </>
      )}
    </div>
  );
}
