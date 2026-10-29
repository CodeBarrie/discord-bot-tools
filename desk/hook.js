#!/usr/bin/env node
/**
 * desk/hook.js — Claude Code hook that tells the desk "the operator is at the keyboard".
 *
 * Wired into ~/.claude/settings.json on SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd.
 * It is a no-op outside the configured project roots and inside the desk's own hidden workers (they carry
 * DESK_WORKER=1), so only a live, attended session in a project folder counts.
 *
 *   - every event (throttled to once a minute) refreshes ~/.discord-desk/attended.json;
 *   - SessionEnd marks it ended, so closing the terminal frees the desk at once;
 *   - UserPromptSubmit hands any Discord requests the desk passed to the operator into the session as context.
 *
 * A hook must never break the session: every failure is swallowed and the exit code is always 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = process.env.DESK_DIR || path.join(os.homedir(), '.discord-desk');
const ATTENDED = path.join(DIR, 'attended.json');
const INBOX = path.join(DIR, 'inbox.jsonl');
const DESK_CFG = (() => { try { return JSON.parse(fs.readFileSync(process.env.DESK_CONFIG || path.join(os.homedir(), '.discord-desk.json'), 'utf-8')); } catch (e) { return {}; } })();
// "~/Projects" in the config has to become an absolute path, or no session's cwd would ever match it
const flat = p => String(p).replace(/^~(?=$|[\\/])/, os.homedir()).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const ROOTS = (process.env.DESK_PROJECT_ROOTS ? process.env.DESK_PROJECT_ROOTS.split(path.delimiter) : (Array.isArray(DESK_CFG.projectRoots) ? DESK_CFG.projectRoots : []))
    .filter(Boolean).map(flat);
const OPERATOR_NAME = (DESK_CFG.operator && DESK_CFG.operator.name) || 'the operator';

function readStdin() {
    try { return JSON.parse(fs.readFileSync(0, 'utf-8') || '{}'); } catch (e) { return {}; }
}

function main() {
    if (process.env.DESK_WORKER) return;
    const input = readStdin();
    const cwd = flat(input.cwd || process.cwd());
    if (!ROOTS.some(r => cwd === r || cwd.startsWith(r + '\\'))) return;
    const event = input.hook_event_name || process.argv[2] || 'unknown';
    fs.mkdirSync(DIR, { recursive: true });

    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(ATTENDED, 'utf-8')); } catch (e) { /* first run */ }
    const now = Date.now();
    if (event === 'SessionEnd') {
        if (!prev || prev.sessionId === input.session_id) fs.writeFileSync(ATTENDED, JSON.stringify({ ...(prev || {}), sessionId: input.session_id, endedAt: new Date(now).toISOString(), at: now }, null, 2));
    } else if (event !== 'PostToolUse' || !prev || prev.endedAt || prev.sessionId !== input.session_id || now - prev.at > 60000) {
        fs.writeFileSync(ATTENDED, JSON.stringify({ sessionId: input.session_id, cwd: input.cwd, event, at: now, iso: new Date(now).toISOString() }, null, 2));
    }

    if (event !== 'UserPromptSubmit' || !fs.existsSync(INBOX)) return;
    const rows = fs.readFileSync(INBOX, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const fresh = rows.filter(r => !r.ackedAt && !r.promotedAt);
    if (!fresh.length) return;
    const lines = [`Discord requests the desk handed to you (${OPERATOR_NAME}) while you were at the keyboard. The people who asked were told you have them.`, ''];
    for (const r of fresh) {
        lines.push(`### ${r.project || 'general'} — ${r.at}`);
        lines.push(`Thread/channel: ${r.channelId}${r.threadUrl ? ' (' + r.threadUrl + ')' : ''}`);
        for (const m of r.messages || []) lines.push(`- **${m.author}**: ${JSON.stringify(m.text)}`);
        lines.push(`Answer in that thread (\`node "${path.join(__dirname, '..', 'desk.js')}" say --job=${r.jobId} --text-file=<file>\`), or tell ${OPERATOR_NAME} what it needs.`, '');
    }
    for (const r of fresh) r.ackedAt = new Date(now).toISOString();
    fs.writeFileSync(INBOX, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } }));
}

try { main(); } catch (e) { /* never break the session */ }
process.exitCode = 0;
