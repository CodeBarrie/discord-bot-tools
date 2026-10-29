'use strict';
/**
 * drive-share.js — make a Google Drive file or folder open for anyone who has the link (view only).
 *
 *   node lib/drive-share.js <url-or-id> [...]      share each, print the working link
 *   node lib/drive-share.js --check <url-or-id>    only report whether it is open
 *   const { share, shareLinksIn } = require('./drive-share')
 *
 * Why: a file uploaded with rclone into a private folder inherits that folder's sharing, and a
 * `drive.google.com/file/d/<id>/view` URL built from the id says nothing about access. A link only the uploader
 * can open is worse than no link.
 *
 * How: the Drive API's permissions.create with {type: "anyone", role: "reader"}, using the OAuth login rclone
 * already holds for the remote (full `drive` scope). The token is read in-process from `rclone config dump`
 * and never printed. Remotes are tried in order (DESK_DRIVE_REMOTES, default "gdrive"), because a file can
 * belong to any of several Drive accounts and only an owner or editor may change its sharing.
 */

const { spawnSync } = require('child_process');

const REMOTES = (process.env.DESK_DRIVE_REMOTES || 'gdrive').split(',').map(s => s.trim().replace(/:$/, '')).filter(Boolean);
const API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_URL = /https:\/\/(?:drive|docs)\.google\.com\/[^\s<>)"'\]]+/g;

/** The file or folder id in a Drive / Docs URL, or the argument itself when it already is one. */
function idFromUrl(u) {
    const s = String(u || '').trim();
    const m = /\/(?:folders|d|file\/d|document\/d|spreadsheets\/d|presentation\/d)\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
}

function rclone(args) {
    const r = spawnSync('rclone', args, { encoding: 'utf-8', windowsHide: true, timeout: 120000 });
    if (r.error) throw new Error(`rclone not runnable (${r.error.message})`);
    return r;
}

/** A fresh access token for a remote. `rclone about` refreshes an expired one and saves it back to the config. */
const tokens = {};
function accessToken(remote) {
    const t = tokens[remote];
    if (t && Date.parse(t.expiry) - Date.now() > 120000) return t.access_token;
    rclone(['about', `${remote}:`, '--json']);
    const dump = rclone(['config', 'dump']);
    let conf; try { conf = JSON.parse(dump.stdout); } catch (e) { throw new Error('could not read the rclone config'); }
    if (!conf[remote] || !conf[remote].token) throw new Error(`rclone remote "${remote}" has no token`);
    const tok = JSON.parse(conf[remote].token);
    tokens[remote] = tok;
    return tok.access_token;
}

async function api(remote, method, route, body) {
    const res = await fetch(`${API}${route}`, {
        method, headers: { Authorization: `Bearer ${accessToken(remote)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (!res.ok) { const e = new Error(`Drive ${res.status}: ${(json && json.error && json.error.message) || text.slice(0, 160)}`); e.status = res.status; throw e; }
    return json;
}

/**
 * Open a file or folder to anyone with the link (view only). Idempotent: an existing "anyone" permission is
 * left as it is. Returns { id, name, url, remote, already }.
 */
async function share(urlOrId) {
    const id = idFromUrl(urlOrId);
    if (!id) throw new Error(`not a Drive link or id: ${urlOrId}`);
    const errors = [];
    for (const remote of REMOTES) {
        try {
            const f = await api(remote, 'GET', `/${id}?fields=id,name,mimeType,webViewLink,capabilities(canShare)&supportsAllDrives=true`);
            const perms = await api(remote, 'GET', `/${id}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`).catch(() => ({ permissions: [] }));
            const already = (perms.permissions || []).some(p => p.type === 'anyone');
            if (!already) {
                if (f.capabilities && f.capabilities.canShare === false) throw Object.assign(new Error('this account can see it but not change its sharing'), { status: 403 });
                await api(remote, 'POST', `/${id}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, { type: 'anyone', role: 'reader', allowFileDiscovery: false });
            }
            return { id, name: f.name, url: f.webViewLink || urlOrId, remote, already };
        } catch (e) {
            errors.push(`${remote}: ${e.message}`);
            if (e.status && ![403, 404].includes(e.status)) break;   // a real failure, not "wrong account"
        }
    }
    throw new Error(`could not share ${id} (${errors.join('; ')})`);
}

/** Is it open to anyone with the link? Checked as a logged-out visitor, so it answers what Discord readers see. */
async function isOpen(urlOrId) {
    const id = idFromUrl(urlOrId);
    const page = /\/folders\//.test(String(urlOrId)) ? `https://drive.google.com/drive/folders/${id}` : `https://drive.google.com/file/d/${id}/view`;
    const res = await fetch(page, { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    return res.status === 200 || (res.status >= 300 && res.status < 400 && !/accounts\.google\.com|ServiceLogin/.test(loc));
}

/**
 * Share every Drive link in a piece of text before it is posted. Never throws: a link that cannot be shared is
 * reported back so the caller can warn in the same message instead of posting a dead link silently.
 */
async function shareLinksIn(text) {
    const urls = [...new Set(String(text || '').match(DRIVE_URL) || [])];
    const done = [], failed = [];
    for (const u of urls) {
        try { done.push({ url: u, ...(await share(u)) }); }
        catch (e) { failed.push({ url: u, error: e.message }); }
    }
    return { done, failed };
}

module.exports = { share, shareLinksIn, isOpen, idFromUrl, DRIVE_URL };

if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);
        const check = args.includes('--check');
        const targets = args.filter(a => a !== '--check');
        if (!targets.length) { console.error('usage: node drive-share.js [--check] <drive url or id> ...'); process.exitCode = 2; return; }
        for (const t of targets) {
            try {
                if (check) { console.log(`${(await isOpen(t)) ? 'OPEN   ' : 'PRIVATE'} ${t}`); continue; }
                const r = await share(t);
                console.log(`${r.already ? 'already open' : 'now open    '}  ${r.name}  ${r.url}  (via ${r.remote})`);
            } catch (e) { console.log(`FAILED  ${t}  ${e.message}`); process.exitCode = 1; }
        }
    })();
}
