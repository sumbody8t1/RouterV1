/**
 * ROUTER – Railway Track Map  |  REST API Backend
 * Node.js + Express
 *
 * Endpoints
 * ─────────
 * GET    /api/health                  → healthcheck
 * GET    /api/maps                    → list all saved maps
 * POST   /api/maps                    → create / save a map
 * GET    /api/maps/:id                → load a single map
 * PUT    /api/maps/:id                → update a map
 * DELETE /api/maps/:id                → delete a map
 * POST   /api/maps/:id/export         → generate partial exports
 * POST   /api/maps/import/svg         → parse a raw SVG into elements
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── In-memory store (swap for a real DB in production) ────────────────────────
// Shape: Map<id:string, MapRecord>
//
// MapRecord {
//   id:          string,
//   name:        string,
//   direction:   'rtl' | 'ltr',
//   elements:    ElementObj[],        // track / crossover objects
//   metaData:    Record<number, Meta>, // per-element metadata
//   signals:     SignalObj[],
//   lineNames:   string[],
//   createdAt:   ISO string,
//   updatedAt:   ISO string,
//   backups:     MapRecord[]          // last 5 snapshots
// }
const store = new Map();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Simple request logger
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
    next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }

function notFound(res, id) {
    return res.status(404).json({ error: `Map "${id}" not found` });
}

function validateMap(body) {
    const errors = [];
    if (!body.name || typeof body.name !== 'string') errors.push('name is required');
    if (!Array.isArray(body.elements))               errors.push('elements must be an array');
    return errors;
}

/** Snapshot: trim to max 5 historical backups */
function addBackup(record) {
    if (!record.backups) record.backups = [];
    const snap = { ...record };
    delete snap.backups;
    record.backups.unshift(snap);
    if (record.backups.length > 5) record.backups.length = 5;
}

/** Create a summary object (no elements, no backups) for list responses */
function summary(record) {
    return {
        id:          record.id,
        name:        record.name,
        direction:   record.direction,
        elementCount: (record.elements || []).length,
        signalCount:  (record.signals  || []).length,
        lineCount:    (record.lineNames || []).length,
        createdAt:   record.createdAt,
        updatedAt:   record.updatedAt,
    };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', maps: store.size, timestamp: now() });
});

// ── List all maps ─────────────────────────────────────────────────────────────
app.get('/api/maps', (_req, res) => {
    const list = [...store.values()].map(summary);
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json({ maps: list, total: list.length });
});

// ── Create a map ──────────────────────────────────────────────────────────────
app.post('/api/maps', (req, res) => {
    const errors = validateMap(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const id = uuid();
    const record = {
        id,
        name:      req.body.name,
        direction: req.body.direction || 'rtl',
        elements:  req.body.elements  || [],
        metaData:  req.body.metaData  || {},
        signals:   req.body.signals   || [],
        lineNames: req.body.lineNames || [],
        createdAt: now(),
        updatedAt: now(),
        backups:   [],
    };

    store.set(id, record);
    console.log(`Created map "${record.name}" (${id})`);
    res.status(201).json({ map: record });
});

// ── Get a single map ──────────────────────────────────────────────────────────
app.get('/api/maps/:id', (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return notFound(res, req.params.id);
    res.json({ map: record });
});

// ── Update a map ──────────────────────────────────────────────────────────────
app.put('/api/maps/:id', (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return notFound(res, req.params.id);

    const errors = validateMap(req.body);
    if (errors.length) return res.status(400).json({ errors });

    // Save a backup before overwriting
    addBackup(record);

    record.name      = req.body.name;
    record.direction = req.body.direction || record.direction;
    record.elements  = req.body.elements;
    record.metaData  = req.body.metaData  || {};
    record.signals   = req.body.signals   || [];
    record.lineNames = req.body.lineNames || [];
    record.updatedAt = now();

    store.set(record.id, record);
    console.log(`Updated map "${record.name}" (${record.id})`);
    res.json({ map: record });
});

// ── Delete a map ──────────────────────────────────────────────────────────────
app.delete('/api/maps/:id', (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return notFound(res, req.params.id);
    store.delete(req.params.id);
    console.log(`Deleted map "${record.name}" (${req.params.id})`);
    res.json({ deleted: true, id: req.params.id });
});

// ── Restore a backup ──────────────────────────────────────────────────────────
app.post('/api/maps/:id/restore', (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return notFound(res, req.params.id);

    const { backupIndex = 0 } = req.body;
    if (!record.backups || !record.backups[backupIndex]) {
        return res.status(404).json({ error: 'No backup found at that index' });
    }

    const snap = record.backups[backupIndex];
    addBackup(record);                 // save the current state before restoring

    record.name      = snap.name;
    record.direction = snap.direction;
    record.elements  = snap.elements;
    record.metaData  = snap.metaData;
    record.signals   = snap.signals;
    record.lineNames = snap.lineNames;
    record.updatedAt = now();

    store.set(record.id, record);
    res.json({ map: record, restored: backupIndex });
});

// ── Export partial data ───────────────────────────────────────────────────────
// POST /api/maps/:id/export
// body: { type: 'tracks' | 'metadata' | 'signals' | 'static' | 'complete' }
app.post('/api/maps/:id/export', (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return notFound(res, req.params.id);

    const type = req.body.type || 'complete';

    const exporters = {
        complete: (r) => ({
            mapName:   r.name,
            direction: r.direction,
            elements:  r.elements,
            metaData:  r.metaData,
            signals:   r.signals,
            lineNames: r.lineNames,
        }),
        tracks: (r) => ({
            mapName:  r.name,
            elements: r.elements.filter(e => e.type === 'track'),
        }),
        crossovers: (r) => ({
            mapName:  r.name,
            elements: r.elements.filter(e => e.type === 'crossover'),
        }),
        metadata: (r) => ({
            mapName:   r.name,
            metaData:  r.metaData,
            lineNames: r.lineNames,
        }),
        signals: (r) => ({
            mapName: r.name,
            signals: r.signals,
        }),
        static: (r) => ({
            mapName:  r.name,
            elements: r.elements.filter(e => !['track','crossover'].includes(e.type)),
        }),
    };

    const fn = exporters[type];
    if (!fn) return res.status(400).json({ error: `Unknown export type "${type}"` });

    const payload = fn(record);
    res.json({ export: payload, type, exportedAt: now() });
});

// ── BFS Route Finder ──────────────────────────────────────────────────────────
// POST /api/route
// body: { elements, metaData, elementIndex, directionMode, mapDirection }
// Returns: { connected: number[], conflict: number[], reversible: number[], noLine: number[] }
app.post('/api/route', (req, res) => {
    const { elements, metaData, elementIndex, directionMode, mapDirection } = req.body;

    if (!Array.isArray(elements) || elementIndex == null) {
        return res.status(400).json({ error: 'elements array and elementIndex are required' });
    }

    try {
        const result = computeRoute({ elements, metaData: metaData || {}, elementIndex, directionMode, mapDirection });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Speed Colours ─────────────────────────────────────────────────────────────
// POST /api/speed-colours
// body: { metaData, directionMode }
// Returns: { colours: { [index]: { track, xover, glow } | null } }
app.post('/api/speed-colours', (req, res) => {
    const { metaData, directionMode } = req.body;
    if (!metaData) return res.status(400).json({ error: 'metaData is required' });

    const SPEED_COLOURS = {
        10:  { track: '#fbbf24', xover: '#fbbf24', glow: 'rgba(251,191,36,0.8)'  },
        25:  { track: '#a3e635', xover: '#a3e635', glow: 'rgba(163,230,53,0.8)'  },
        40:  { track: '#4ade80', xover: '#4ade80', glow: 'rgba(74,222,128,0.8)'  },
        50:  { track: '#16a34a', xover: '#16a34a', glow: 'rgba(22,163,74,0.8)'   },
        80:  { track: '#60a5fa', xover: '#60a5fa', glow: 'rgba(96,165,250,0.8)'  },
        125: { track: '#bae6fd', xover: '#bae6fd', glow: 'rgba(186,230,253,0.8)' },
    };

    const colours = {};
    for (const [idx, meta] of Object.entries(metaData)) {
        colours[idx] = getSpeedColourFromMeta(meta, directionMode, SPEED_COLOURS);
    }
    res.json({ colours });
});

// ── Signal Validation ─────────────────────────────────────────────────────────
// POST /api/validate-signal
// body: { signals, newSignal, editingSignalId }
// Returns: { valid: bool, error?: string, errorType?: string }
app.post('/api/validate-signal', (req, res) => {
    const { signals = [], newSignal, editingSignalId } = req.body;

    if (!newSignal) return res.status(400).json({ error: 'newSignal is required' });

    const { signalId, x, y, direction } = newSignal;

    // Rule 1: duplicate name
    const dupName = signals.find(s => s.signalId === signalId && s.signalId !== editingSignalId);
    if (dupName) {
        return res.json({
            valid: false,
            errorType: 'DUPLICATE_NAME',
            error: `A signal named "${signalId}" already exists. Choose a different name or delete the existing signal first.`,
        });
    }

    // Rule 2: location + direction conflict (5px tolerance)
    const TOLERANCE = 5;
    const conflict = signals.find(s => {
        if (s.signalId === editingSignalId) return false;
        return Math.abs(s.x - x) < TOLERANCE &&
               Math.abs(s.y - y) < TOLERANCE &&
               s.direction === direction;
    });
    if (conflict) {
        return res.json({
            valid: false,
            errorType: 'LOCATION_CONFLICT',
            error: `Signal "${conflict.signalId}" already exists at this location facing the same direction. Move this signal or delete the existing one.`,
        });
    }

    res.json({ valid: true });
});

// ─── Route computation engine (pure functions, no DOM) ────────────────────────

function extractEndpoints(pathData) {
    const coords = pathData.match(/[\d.]+,[\d.]+/g) || [];
    if (coords.length < 2) return { start: null, end: null };
    return { start: coords[0], end: coords[coords.length - 1] };
}

function normalizePoint(point) {
    if (!point) return null;
    const [x, y] = point.split(',').map(v => parseFloat(v));
    return `${x.toFixed(2)},${y.toFixed(2)}`;
}

function getX(point) {
    if (!point) return null;
    return parseFloat(point.split(',')[0]);
}

function getBFSParams(directionMode, mapDirection) {
    if (mapDirection === 'ltr') {
        if (directionMode === 'left') {
            return { initialEndpointKey: 'start', passesCheck: (freeX, sharedX) => freeX > sharedX };
        } else {
            return { initialEndpointKey: 'end', passesCheck: (freeX, sharedX) => freeX < sharedX };
        }
    } else {
        if (directionMode === 'left') {
            return { initialEndpointKey: 'end', passesCheck: (freeX, sharedX) => freeX < sharedX };
        } else {
            return { initialEndpointKey: 'start', passesCheck: (freeX, sharedX) => freeX > sharedX };
        }
    }
}

function directionAllowed(meta, filterDir) {
    if (!filterDir) return true;
    if (!meta || !meta.direction || meta.direction === 'bidirectional') return true;
    if (meta.direction === filterDir) return true;
    if (meta.reversible) return 'reversible';
    return false;
}

function computeRoute({ elements, metaData, elementIndex, directionMode, mapDirection }) {
    // Build normalised elements with endpoints
    const elems = elements.map((el, i) => {
        const eps = extractEndpoints(el.pathData || '');
        return {
            ...el,
            index: i,
            normalizedEndpoints: {
                start: normalizePoint(eps.start),
                end:   normalizePoint(eps.end),
            },
        };
    });

    // Build endpoint map
    const endpointMap = new Map();
    elems.forEach(el => {
        const { start, end } = el.normalizedEndpoints;
        if (start) {
            if (!endpointMap.has(start)) endpointMap.set(start, []);
            endpointMap.get(start).push(el.index);
        }
        if (end) {
            if (!endpointMap.has(end)) endpointMap.set(end, []);
            endpointMap.get(end).push(el.index);
        }
    });

    const element = elems[elementIndex];
    if (!element) return { connected: [], conflict: [], reversible: [], noLine: [] };

    const connected = new Set();
    const conflict  = new Set();
    const reversible = new Set();

    if (!directionMode) {
        // Undirected BFS
        const queue = [{ index: elementIndex, sharedPoint: null }];
        const processed = new Set();
        while (queue.length > 0) {
            const { index: ci } = queue.shift();
            if (processed.has(ci)) continue;
            processed.add(ci); connected.add(ci);
            const { start: cs, end: ce } = elems[ci].normalizedEndpoints;
            [cs, ce].forEach(ep => {
                (endpointMap.get(ep) || []).forEach(ni => {
                    if (ni !== ci && !processed.has(ni)) queue.push({ index: ni, sharedPoint: ep });
                });
            });
        }
        connected.delete(elementIndex);
        return {
            connected: [...connected],
            conflict:  [],
            reversible: [],
            noLine: [],
        };
    }

    const { initialEndpointKey, passesCheck } = getBFSParams(directionMode, mapDirection || 'rtl');
    const initialEndpoint = element.normalizedEndpoints[initialEndpointKey];

    // Pass 1: strict directional BFS
    const excluded = [];
    {
        const queue = [{ index: elementIndex, sharedPoint: null, allowedEndpoint: initialEndpoint }];
        const processed = new Set();
        while (queue.length > 0) {
            const { index: ci, sharedPoint, allowedEndpoint } = queue.shift();
            if (processed.has(ci)) continue;
            const { start: cs, end: ce } = elems[ci].normalizedEndpoints;
            let freeEp = null;
            if (sharedPoint) freeEp = cs === sharedPoint ? ce : (ce === sharedPoint ? cs : null);

            if (sharedPoint && freeEp) {
                const freeX = getX(freeEp), sharedX = getX(sharedPoint);
                if (!passesCheck(freeX, sharedX)) {
                    processed.add(ci);
                    excluded.push({ index: ci, sharedEp: sharedPoint, freeEp });
                    continue;
                }
            }

            processed.add(ci); connected.add(ci);
            const eps = allowedEndpoint ? [allowedEndpoint] : [cs, ce];
            eps.forEach(ep => {
                (endpointMap.get(ep) || []).forEach(ni => {
                    if (ni !== ci && !processed.has(ni))
                        queue.push({ index: ni, sharedPoint: ep, allowedEndpoint: null });
                });
            });
        }
    }

    // Pass 2+: reconvergence rescue
    let changed = true;
    while (changed) {
        changed = false;
        const stillExcluded = [];
        for (const { index: ci, sharedEp, freeEp } of excluded) {
            if (connected.has(ci)) continue;
            const neighbours = endpointMap.get(freeEp) || [];
            const reconverges = neighbours.some(ni => ni !== ci && connected.has(ni));
            if (reconverges) {
                connected.add(ci); changed = true;
                const q2 = [];
                (endpointMap.get(freeEp) || []).forEach(ni => {
                    if (ni !== ci && !connected.has(ni)) q2.push({ index: ni, sharedPoint: freeEp });
                });
                const proc2 = new Set();
                while (q2.length > 0) {
                    const { index: ci2, sharedPoint: sp2 } = q2.shift();
                    if (proc2.has(ci2) || connected.has(ci2)) continue;
                    const { start: cs2, end: ce2 } = elems[ci2].normalizedEndpoints;
                    const freeEp2 = cs2 === sp2 ? ce2 : (ce2 === sp2 ? cs2 : null);
                    if (freeEp2) {
                        const fx2 = getX(freeEp2), sx2 = getX(sp2);
                        if (!passesCheck(fx2, sx2)) {
                            proc2.add(ci2);
                            stillExcluded.push({ index: ci2, sharedEp: sp2, freeEp: freeEp2 });
                            continue;
                        }
                    }
                    proc2.add(ci2); connected.add(ci2);
                    [cs2, ce2].forEach(ep => {
                        (endpointMap.get(ep) || []).forEach(ni => {
                            if (ni !== ci2 && !connected.has(ni) && !proc2.has(ni))
                                q2.push({ index: ni, sharedPoint: ep });
                        });
                    });
                }
            } else {
                stillExcluded.push({ index: ci, sharedEp, freeEp });
            }
        }
        excluded.length = 0; excluded.push(...stillExcluded);
    }

    // Classify by direction metadata
    for (const ci of connected) {
        const meta = metaData[ci];
        const allowed = directionAllowed(meta, directionMode);
        if (allowed === 'reversible') reversible.add(ci);
        else if (!allowed) conflict.add(ci);
    }

    connected.delete(elementIndex);
    return {
        connected:  [...connected],
        conflict:   [...conflict],
        reversible: [...reversible],
        noLine: [],
    };
}

function getMetaSpeed(meta, directionMode) {
    if (directionMode === 'left' && meta.speedDown) {
        const s = meta.speedDown;
        return s.custom ? parseFloat(s.custom) : (s.tier || null);
    }
    if (directionMode === 'right' && meta.speedUp) {
        const s = meta.speedUp;
        return s.custom ? parseFloat(s.custom) : (s.tier || null);
    }
    if (meta.speedDown) {
        const s = meta.speedDown;
        return s.custom ? parseFloat(s.custom) : (s.tier || null);
    }
    if (meta.speedCustom) return parseFloat(meta.speedCustom);
    if (meta.speedTier)   return meta.speedTier;
    return null;
}

function getSpeedColourFromMeta(meta, directionMode, SPEED_COLOURS) {
    if (!meta) return null;
    const raw = getMetaSpeed(meta, directionMode || null);
    if (!raw) return null;
    if (raw <= 10)  return SPEED_COLOURS[10];
    if (raw <= 25)  return SPEED_COLOURS[25];
    if (raw <= 40)  return SPEED_COLOURS[40];
    if (raw <= 50)  return SPEED_COLOURS[50];
    if (raw <= 80)  return SPEED_COLOURS[80];
    return SPEED_COLOURS[125];
}

// ── SVG Import – parse raw SVG path data into elements ───────────────────────
// The frontend sends the raw SVG text; the server strips it down to the
// path elements and returns a structured list the TrackMap class can consume.
// (Full normalisation still happens client-side to preserve the existing logic.)
app.post('/api/maps/import/svg', (req, res) => {
    const { svgText } = req.body;
    if (!svgText || typeof svgText !== 'string') {
        return res.status(400).json({ error: 'svgText is required' });
    }

    // Extract <path d="…"> and <polyline points="…"> attributes
    const paths = [];

    // Paths
    const pathRe = /<path[^>]*\bd="([^"]+)"[^>]*>/gi;
    let m;
    while ((m = pathRe.exec(svgText)) !== null) {
        paths.push({ type: 'path', data: m[1].trim() });
    }

    // Polylines
    const polyRe = /<polyline[^>]*\bpoints="([^"]+)"[^>]*>/gi;
    while ((m = polyRe.exec(svgText)) !== null) {
        // Convert points format to simple path-like string for the client
        paths.push({ type: 'polyline', data: m[1].trim() });
    }

    res.json({ paths, count: paths.length, importedAt: now() });
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚂  ROUTER API  →  http://localhost:${PORT}/api\n`);
});

module.exports = app; // for testing
