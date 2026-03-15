/**
 * ROUTER – REST API Backend
 * Express + Supabase (Auth + Postgres)
 *
 * Required env vars (set in Railway dashboard):
 *   SUPABASE_URL         → https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY → service_role key (Supabase → Settings → API)
 *   FRONTEND_URL         → https://your-site.netlify.app
 *   PORT                 → auto-set by Railway
 */
'use strict';

const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3001;

// Admin client — service_role key, NEVER sent to browser
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
    origin: [
        process.env.FRONTEND_URL || 'http://localhost:8080',
        'http://localhost:8080',
        'http://localhost:3000',
    ],
    credentials: true,
}));
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method} ${req.path}`);
    next();
});

// ── Auth middleware ───────────────────────────────────────────────────────────
// Reads the Bearer token the frontend sends with every request,
// validates it with Supabase, and attaches req.user.
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });

    req.user = user;
    next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();

function validateMap(body) {
    const errors = [];
    if (!body.name || typeof body.name !== 'string') errors.push('name is required');
    if (!Array.isArray(body.elements))               errors.push('elements must be an array');
    return errors;
}

// Shape the DB row into the API response the frontend expects
function formatMap(row) {
    return {
        id:        row.id,
        name:      row.name,
        direction: row.direction,
        ...(row.data || {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapSummary(row) {
    const d = row.data || {};
    return {
        id:           row.id,
        name:         row.name,
        direction:    row.direction,
        elementCount: (d.elements  || []).length,
        signalCount:  (d.signals   || []).length,
        lineCount:    (d.lineNames || []).length,
        createdAt:    row.created_at,
        updatedAt:    row.updated_at,
    };
}

// ── Health (public) ───────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: now() }));

// ── Auth: Sign up ─────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: false, // set true if you want email verification
    });

    if (error) return res.status(400).json({ error: error.message });

    // Sign them in immediately after signup
    const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr) return res.status(400).json({ error: signInErr.message });

    res.status(201).json({
        user:         { id: session.user.id, email: session.user.email },
        access_token: session.session.access_token,
        expires_at:   session.session.expires_at,
    });
});

// ── Auth: Log in ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Invalid email or password' });

    res.json({
        user:         { id: data.user.id, email: data.user.email },
        access_token: data.session.access_token,
        expires_at:   data.session.expires_at,
    });
});

// ── Auth: Refresh token ───────────────────────────────────────────────────────
app.post('/api/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: 'Session expired. Please log in again.' });

    res.json({
        user:         { id: data.user.id, email: data.user.email },
        access_token: data.session.access_token,
        expires_at:   data.session.expires_at,
    });
});

// ── Auth: Verify token (frontend calls on load to check if still valid) ───────
app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ── Maps: List ────────────────────────────────────────────────────────────────
app.get('/api/maps', requireAuth, async (req, res) => {
    const { data, error } = await supabase
        .from('maps')
        .select('id,name,direction,created_at,updated_at,data')
        .eq('user_id', req.user.id)
        .order('updated_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ maps: data.map(mapSummary), total: data.length });
});

// ── Maps: Get one ─────────────────────────────────────────────────────────────
app.get('/api/maps/:id', requireAuth, async (req, res) => {
    const { data, error } = await supabase
        .from('maps').select('*')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .single();

    if (error || !data) return res.status(404).json({ error: 'Map not found' });
    res.json({ map: formatMap(data) });
});

// ── Maps: Create ──────────────────────────────────────────────────────────────
app.post('/api/maps', requireAuth, async (req, res) => {
    const errors = validateMap(req.body);
    if (errors.length) return res.status(400).json({ errors });

    const { name, direction, elements, metaData, signals, lineNames } = req.body;
    const { data, error } = await supabase
        .from('maps')
        .insert({
            user_id:   req.user.id,
            name,
            direction: direction || 'rtl',
            data:      { elements: elements||[], metaData: metaData||{}, signals: signals||[], lineNames: lineNames||[] },
        })
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    console.log(`Created map "${name}" for ${req.user.email}`);
    res.status(201).json({ map: formatMap(data) });
});

// ── Maps: Update ──────────────────────────────────────────────────────────────
app.put('/api/maps/:id', requireAuth, async (req, res) => {
    const errors = validateMap(req.body);
    if (errors.length) return res.status(400).json({ errors });

    // Ownership check
    const { data: existing } = await supabase
        .from('maps').select('id')
        .eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!existing) return res.status(404).json({ error: 'Map not found' });

    const { name, direction, elements, metaData, signals, lineNames } = req.body;
    const { data, error } = await supabase
        .from('maps')
        .update({
            name,
            direction: direction || 'rtl',
            data:      { elements: elements||[], metaData: metaData||{}, signals: signals||[], lineNames: lineNames||[] },
        })
        .eq('id', req.params.id)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    console.log(`Updated map "${name}" for ${req.user.email}`);
    res.json({ map: formatMap(data) });
});

// ── Maps: Delete ──────────────────────────────────────────────────────────────
app.delete('/api/maps/:id', requireAuth, async (req, res) => {
    const { data: existing } = await supabase
        .from('maps').select('id,name')
        .eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!existing) return res.status(404).json({ error: 'Map not found' });

    const { error } = await supabase.from('maps').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });

    console.log(`Deleted map "${existing.name}" for ${req.user.email}`);
    res.json({ deleted: true, id: req.params.id });
});

// ── Maps: Export ──────────────────────────────────────────────────────────────
app.post('/api/maps/:id/export', requireAuth, async (req, res) => {
    const { data: row } = await supabase
        .from('maps').select('*')
        .eq('id', req.params.id).eq('user_id', req.user.id).single();
    if (!row) return res.status(404).json({ error: 'Map not found' });

    const r    = { name: row.name, direction: row.direction, ...row.data };
    const type = req.body.type || 'complete';
    const exporters = {
        complete:   r => ({ mapName:r.name, direction:r.direction, elements:r.elements, metaData:r.metaData, signals:r.signals, lineNames:r.lineNames }),
        tracks:     r => ({ mapName:r.name, elements:(r.elements||[]).filter(e=>e.type==='track') }),
        crossovers: r => ({ mapName:r.name, elements:(r.elements||[]).filter(e=>e.type==='crossover') }),
        metadata:   r => ({ mapName:r.name, metaData:r.metaData, lineNames:r.lineNames }),
        signals:    r => ({ mapName:r.name, signals:r.signals }),
        static:     r => ({ mapName:r.name, elements:(r.elements||[]).filter(e=>!['track','crossover'].includes(e.type)) }),
    };
    const fn = exporters[type];
    if (!fn) return res.status(400).json({ error: `Unknown export type "${type}"` });
    res.json({ export: fn(r), type, exportedAt: now() });
});

// ── SVG Import ────────────────────────────────────────────────────────────────
app.post('/api/maps/import/svg', requireAuth, (req, res) => {
    const { svgText } = req.body;
    if (!svgText) return res.status(400).json({ error: 'svgText is required' });
    const paths = [];
    const pathRe = /<path[^>]*\bd="([^"]+)"[^>]*>/gi;
    const polyRe = /<polyline[^>]*\bpoints="([^"]+)"[^>]*>/gi;
    let m;
    while ((m = pathRe.exec(svgText)) !== null) paths.push({ type:'path',     data:m[1].trim() });
    while ((m = polyRe.exec(svgText)) !== null) paths.push({ type:'polyline', data:m[1].trim() });
    res.json({ paths, count: paths.length });
});

// ── BFS Route ─────────────────────────────────────────────────────────────────
app.post('/api/route', requireAuth, (req, res) => {
    const { elements, metaData, elementIndex, directionMode, mapDirection } = req.body;
    if (!Array.isArray(elements) || elementIndex == null)
        return res.status(400).json({ error: 'elements and elementIndex required' });
    try { res.json(computeRoute({ elements, metaData:metaData||{}, elementIndex, directionMode, mapDirection })); }
    catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Speed Colours ─────────────────────────────────────────────────────────────
app.post('/api/speed-colours', requireAuth, (req, res) => {
    const { metaData, directionMode } = req.body;
    if (!metaData) return res.status(400).json({ error: 'metaData required' });
    const colours = {};
    for (const [idx, meta] of Object.entries(metaData))
        colours[idx] = getSpeedColourFromMeta(meta, directionMode, SPEED_COLOURS);
    res.json({ colours });
});

// ── Signal Validation ─────────────────────────────────────────────────────────
app.post('/api/validate-signal', requireAuth, (req, res) => {
    const { signals=[], newSignal, editingSignalId } = req.body;
    if (!newSignal) return res.status(400).json({ error: 'newSignal required' });
    const { signalId, x, y, direction } = newSignal;
    const dup = signals.find(s => s.signalId===signalId && s.signalId!==editingSignalId);
    if (dup) return res.json({ valid:false, errorType:'DUPLICATE_NAME', error:`Signal "${signalId}" already exists.` });
    const T=5, clash = signals.find(s=>s.signalId!==editingSignalId&&Math.abs(s.x-x)<T&&Math.abs(s.y-y)<T&&s.direction===direction);
    if (clash) return res.json({ valid:false, errorType:'LOCATION_CONFLICT', error:`Signal "${clash.signalId}" already at this location.` });
    res.json({ valid:true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPUTATION ENGINE  (BFS — never leaves the server)
// ═══════════════════════════════════════════════════════════════════════════════
const SPEED_COLOURS = {
    10:{track:'#fbbf24',xover:'#fbbf24',glow:'rgba(251,191,36,0.8)'},
    25:{track:'#a3e635',xover:'#a3e635',glow:'rgba(163,230,53,0.8)'},
    40:{track:'#4ade80',xover:'#4ade80',glow:'rgba(74,222,128,0.8)'},
    50:{track:'#16a34a',xover:'#16a34a',glow:'rgba(22,163,74,0.8)'},
    80:{track:'#60a5fa',xover:'#60a5fa',glow:'rgba(96,165,250,0.8)'},
    125:{track:'#bae6fd',xover:'#bae6fd',glow:'rgba(186,230,253,0.8)'},
};
function extractEndpoints(d){const c=d.match(/[\d.]+,[\d.]+/g)||[];return c.length<2?{start:null,end:null}:{start:c[0],end:c[c.length-1]};}
function normalizePoint(p){if(!p)return null;const[x,y]=p.split(',').map(parseFloat);return`${x.toFixed(2)},${y.toFixed(2)}`;}
function getX(p){return p?parseFloat(p.split(',')[0]):null;}
function getBFSParams(dir,mapDir){if(mapDir==='ltr')return dir==='left'?{initialEndpointKey:'start',passesCheck:(f,s)=>f>s}:{initialEndpointKey:'end',passesCheck:(f,s)=>f<s};return dir==='left'?{initialEndpointKey:'end',passesCheck:(f,s)=>f<s}:{initialEndpointKey:'start',passesCheck:(f,s)=>f>s};}
function directionAllowed(meta,dir){if(!dir||!meta||!meta.direction||meta.direction==='bidirectional')return true;if(meta.direction===dir)return true;if(meta.reversible)return'reversible';return false;}
function computeRoute({elements,metaData,elementIndex,directionMode,mapDirection}){
    const elems=elements.map((el,i)=>{const eps=extractEndpoints(el.pathData||'');return{...el,index:i,normalizedEndpoints:{start:normalizePoint(eps.start),end:normalizePoint(eps.end)}};});
    const epMap=new Map();elems.forEach(el=>{[el.normalizedEndpoints.start,el.normalizedEndpoints.end].forEach(ep=>{if(!ep)return;if(!epMap.has(ep))epMap.set(ep,[]);epMap.get(ep).push(el.index);});});
    const el=elems[elementIndex];if(!el)return{connected:[],conflict:[],reversible:[],noLine:[]};
    const connected=new Set(),conflict=new Set(),reversible=new Set();
    if(!directionMode){const q=[{index:elementIndex}],proc=new Set();while(q.length){const{index:ci}=q.shift();if(proc.has(ci))continue;proc.add(ci);connected.add(ci);const{start:cs,end:ce}=elems[ci].normalizedEndpoints;[cs,ce].forEach(ep=>(epMap.get(ep)||[]).forEach(ni=>{if(ni!==ci&&!proc.has(ni))q.push({index:ni});}));}connected.delete(elementIndex);return{connected:[...connected],conflict:[],reversible:[],noLine:[]};}
    const{initialEndpointKey,passesCheck}=getBFSParams(directionMode,mapDirection||'rtl');
    const initEp=el.normalizedEndpoints[initialEndpointKey],excluded=[];
    {const q=[{index:elementIndex,sharedPoint:null,allowedEndpoint:initEp}],proc=new Set();while(q.length){const{index:ci,sharedPoint:sp,allowedEndpoint:ae}=q.shift();if(proc.has(ci))continue;const{start:cs,end:ce}=elems[ci].normalizedEndpoints;const freeEp=sp?(cs===sp?ce:ce===sp?cs:null):null;if(sp&&freeEp&&!passesCheck(getX(freeEp),getX(sp))){proc.add(ci);excluded.push({index:ci,sharedEp:sp,freeEp});continue;}proc.add(ci);connected.add(ci);const eps=ae?[ae]:[cs,ce];eps.forEach(ep=>(epMap.get(ep)||[]).forEach(ni=>{if(ni!==ci&&!proc.has(ni))q.push({index:ni,sharedPoint:ep,allowedEndpoint:null});}));}}
    let changed=true;while(changed){changed=false;const still=[];for(const{index:ci,sharedEp,freeEp}of excluded){if(connected.has(ci))continue;if((epMap.get(freeEp)||[]).some(ni=>ni!==ci&&connected.has(ni))){connected.add(ci);changed=true;const q2=(epMap.get(freeEp)||[]).filter(ni=>ni!==ci&&!connected.has(ni)).map(ni=>({index:ni,sharedPoint:freeEp}));const proc2=new Set();while(q2.length){const{index:ci2,sharedPoint:sp2}=q2.shift();if(proc2.has(ci2)||connected.has(ci2))continue;const{start:cs2,end:ce2}=elems[ci2].normalizedEndpoints;const fe2=cs2===sp2?ce2:ce2===sp2?cs2:null;if(fe2&&!passesCheck(getX(fe2),getX(sp2))){proc2.add(ci2);still.push({index:ci2,sharedEp:sp2,freeEp:fe2});continue;}proc2.add(ci2);connected.add(ci2);[cs2,ce2].forEach(ep=>(epMap.get(ep)||[]).forEach(ni=>{if(ni!==ci2&&!connected.has(ni)&&!proc2.has(ni))q2.push({index:ni,sharedPoint:ep});}));}}else{still.push({index:ci,sharedEp,freeEp});}};excluded.length=0;excluded.push(...still);}
    for(const ci of connected){const a=directionAllowed(metaData[ci],directionMode);if(a==='reversible')reversible.add(ci);else if(!a)conflict.add(ci);}
    connected.delete(elementIndex);return{connected:[...connected],conflict:[...conflict],reversible:[...reversible],noLine:[]};
}
function getMetaSpeed(meta,dir){const s=dir==='left'?meta.speedDown:dir==='right'?(meta.speedUp||meta.speedDown):meta.speedDown;if(s)return s.custom?parseFloat(s.custom):(s.tier||null);if(meta.speedCustom)return parseFloat(meta.speedCustom);if(meta.speedTier)return meta.speedTier;return null;}
function getSpeedColourFromMeta(meta,dir,cols){if(!meta)return null;const r=getMetaSpeed(meta,dir||null);if(!r)return null;if(r<=10)return cols[10];if(r<=25)return cols[25];if(r<=40)return cols[40];if(r<=50)return cols[50];if(r<=80)return cols[80];return cols[125];}

// ── Error handlers ────────────────────────────────────────────────────────────
app.use((_req,res)=>res.status(404).json({error:'Not found'}));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});

app.listen(PORT,()=>console.log(`\n🚂  ROUTER API  →  http://localhost:${PORT}/api\n`));
module.exports=app;
