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
