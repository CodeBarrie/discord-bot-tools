'use strict';
/**
 * gpu.js — is the machine doing heavy lifting right now?
 *
 * The desk never starts a job on a busy box: a video export, a model run or a render queue would slow down, and
 * so would the job. "Busy" is any of:
 *   - GPU utilization averaging >= BUSY_UTIL over the last few samples (a single spike is not load),
 *   - an NVENC session open (a video export: util can read low while the encoder is saturated),
 *   - a known render process running (DESK_RENDER_PROCS, default aerender.exe).
 * Clearing needs CLEAR_SAMPLES consecutive samples under CLEAR_UTIL with no encoder session, so a
 * render that pauses between items does not let a job slip in.
 */

const { execFileSync } = require('child_process');

const BUSY_UTIL = Number(process.env.DESK_BUSY_UTIL || 40);
const CLEAR_UTIL = Number(process.env.DESK_CLEAR_UTIL || 20);
const WINDOW = 3;            // samples averaged for "busy"
const CLEAR_SAMPLES = 6;     // ~2 min at the 20 s tick
const RENDER_PROCS = (process.env.DESK_RENDER_PROCS || 'aerender.exe').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const os = require('os');
const WIN = process.platform === 'win32';

/**
 * One reading. `source` says where `util` came from: 'nvidia' (GPU utilization), 'cpu' (no NVIDIA card,
 * so a Mac or Linux box: 1-minute load average over core count, as a percent), or 'none' (nothing to go on;
 * the gate then never holds a job).
 */
function sample() {
    const s = { at: Date.now(), util: null, vramUsed: null, vramTotal: null, encoders: 0, renders: [], name: null, source: 'none', error: null };
    try {
        const out = execFileSync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,encoder.stats.sessionCount',
            '--format=csv,noheader,nounits'], { encoding: 'utf-8', windowsHide: true, timeout: 15000 });
        const [name, util, used, total, enc] = out.trim().split('\n')[0].split(',').map(x => x.trim());
        Object.assign(s, { name, util: Number(util), vramUsed: Number(used), vramTotal: Number(total), encoders: Number(enc) || 0, source: 'nvidia' });
    } catch (e) {
        s.error = 'nvidia-smi: ' + (e.message || e).split('\n')[0];
        // Windows reports a load average of 0, so the CPU fallback only means something elsewhere
        if (!WIN) Object.assign(s, { util: Math.round(os.loadavg()[0] / os.cpus().length * 100), name: os.cpus()[0] && os.cpus()[0].model, source: 'cpu' });
    }
    try {
        let names;
        if (WIN) {
            const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true, timeout: 15000 });
            names = new Set(out.split('\n').map(l => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase()));
        } else {
            const out = execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf-8', timeout: 15000 });
            names = new Set(out.split('\n').map(l => l.trim().split('/').pop().toLowerCase()));
        }
        s.renders = RENDER_PROCS.filter(p => names.has(p) || names.has(p.replace(/\.exe$/, '')));
    } catch (e) { /* no process list is not load */ }
    return s;
}

/** Stateful gate: feed it samples, ask it whether the box is busy and why. */
function createGate() {
    const hist = [];
    let busy = false, clearRun = 0;
    return {
        push(s) {
            hist.push(s); while (hist.length > 20) hist.shift();
            const recent = hist.slice(-WINDOW).filter(x => x.util !== null);
            const avg = recent.length ? recent.reduce((n, x) => n + x.util, 0) / recent.length : 0;
            // utilization only counts once the window is full: one spike at startup is not load
            const cool = (s.util === null || s.util < CLEAR_UTIL) && s.encoders === 0 && !s.renders.length;
            const hot = !cool && ((recent.length >= WINDOW && avg >= BUSY_UTIL) || s.encoders > 0 || s.renders.length > 0);
            if (hot) { busy = true; clearRun = 0; }
            else if (busy) { clearRun = cool ? clearRun + 1 : 0; if (clearRun >= CLEAR_SAMPLES) busy = false; }
            return this.status();
        },
        status() {
            const s = hist[hist.length - 1] || {};
            const recent = hist.slice(-WINDOW).filter(x => x.util !== null);
            const avg = recent.length ? Math.round(recent.reduce((n, x) => n + x.util, 0) / recent.length) : null;
            const why = [];
            if (avg !== null && avg >= BUSY_UTIL) why.push(`${s.source === 'cpu' ? 'CPU' : 'GPU'} at ${avg}%`);
            if (s.encoders > 0) why.push(`${s.encoders} video export${s.encoders > 1 ? 's' : ''} running`);
            if (s.renders && s.renders.length) why.push(`a render running (${s.renders.join(', ')})`);
            if (busy && !why.length) why.push(`settling after load (${s.util}%)`);
            return { busy, avg, util: s.util, encoders: s.encoders || 0, renders: s.renders || [], why: why.join(', '), error: s.error || null };
        }
    };
}

module.exports = { sample, createGate, BUSY_UTIL, CLEAR_UTIL };
