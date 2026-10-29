'use strict';
// node --test   (Node 18+, no dependencies)
// Which project folder a request lands in, which messages only acknowledge, and what counts as a go.
// Runs against throwaway folders; nothing touches Discord or ~/.discord-desk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-desk-route-'));
const root = path.join(tmp, 'projects');
for (const name of ['Acme', 'Acme Launch', 'Globex Website', 'Initech Q3 Report', '_archive', '.git']) fs.mkdirSync(path.join(root, name), { recursive: true });
const cfgPath = path.join(tmp, 'desk.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    projectRoots: [root], allow: ['100000000000000001'], operator: { id: '100000000000000001', name: 'Alice' },
    aliases: { 'Initech Q3 Report': ['tps'] }
}));
process.env.DESK_CONFIG = cfgPath;
process.env.DESK_DIR = path.join(tmp, 'desk');
const desk = require('../desk.js');

const conv = (text, extra) => ({ key: 'k' + Math.random(), threadId: 't1', threadName: null, messages: [{ text, authorId: '100000000000000001', author: 'alice' }], ...extra });
const state = () => ({ convProject: {} });
const routeOf = (text, extra, st) => desk.route(desk.buildIndex(), st || state(), conv(text, extra));

test('every folder under a root is a project, except helper folders', () => {
    assert.deepStrictEqual(desk.buildIndex().projects.map(p => p.key).sort(), ['Acme', 'Acme Launch', 'Globex Website', 'Initech Q3 Report']);
});

test('a project named in full wins, and the longer of two matching names wins', () => {
    assert.strictEqual(routeOf('can you check the Globex Website render?').project.key, 'Globex Website');
    assert.strictEqual(routeOf('<@200000000000000001> the acme launch cut needs a new intro').project.key, 'Acme Launch');
    assert.strictEqual(routeOf('how is acme going').project.key, 'Acme');
});

test('one distinctive word from a folder name is enough when only one project has it', () => {
    const r = routeOf('globex wants the hero image brighter');
    assert.strictEqual(r.project.key, 'Globex Website');
    assert.strictEqual(r.why, 'a word from the project name');
    assert.strictEqual(routeOf('the thread name says it', { threadName: 'Initech notes' }).project.key, 'Initech Q3 Report');
});

test('aliases point at their project', () => {
    assert.strictEqual(routeOf('the TPS cover sheet is wrong').project.key, 'Initech Q3 Report');
});

test('two projects named and nothing to choose between them is ambiguous', () => {
    const r = routeOf('launch and website both need a look');
    assert.strictEqual(r.project, null);
    assert.strictEqual(r.why, 'ambiguous');
    assert.deepStrictEqual(r.maybe.map(p => p.key).sort(), ['Acme Launch', 'Globex Website']);
    assert.strictEqual(routeOf('hello there').why, 'no project named');
});

test('between a finished project and an open one, the open one wins', () => {
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'desk.js'), 'finished', 'Globex Website'], { env: process.env, encoding: 'utf-8' });
    assert.strictEqual(run.status, 0, run.stderr);
    const r = routeOf('launch and website both need a look');
    assert.strictEqual(r.project.key, 'Acme Launch');
    assert.match(r.why, /not finished/);
    assert.ok(desk.buildIndex().projects.find(p => p.key === 'Globex Website').finished);
    spawnSync(process.execPath, [path.join(__dirname, '..', 'desk.js'), 'finished', 'Globex Website', '--off'], { env: process.env });
    assert.strictEqual(desk.buildIndex().projects.find(p => p.key === 'Globex Website').finished, null);
});

test('a thread keeps its project, and a loose follow-up continues the author\'s last one', () => {
    const st = state();
    st.convProject.k1 = 'Acme Launch';
    assert.strictEqual(desk.route(desk.buildIndex(), st, { key: 'k1', threadId: 'k1', messages: [{ text: 'globex', authorId: 'x' }] }).project.key, 'Acme Launch');
    st.lastByAuthor = { '100000000000000001': { projectKey: 'Globex Website', threadId: 't9', at: Date.now() - 60000 } };
    const loose = routeOf('and the thumbnail?', { threadId: null }, st);
    assert.strictEqual(loose.project.key, 'Globex Website');
    assert.strictEqual(loose.previousThreadId, 't9');
    // inside a thread, a message naming nothing is not a follow-up to somewhere else
    assert.strictEqual(routeOf('and the thumbnail?', {}, st).project, null);
});

test('projectWords keeps distinctive words only', () => {
    assert.deepStrictEqual(desk.projectWords('Initech Q3 Report - FINAL 2026'), ['initech', 'report']);
});

test('acknowledgements get a reaction; anything that asks or answers does not', () => {
    for (const t of ['thanks!', 'lgtm', '👍', '🙏🙏', 'good bot', 'well done', 'merging now, thanks', '<@200000000000000001> nice work']) assert.strictEqual(desk.ackOnly(t), true, t);
    for (const t of ['ok', 'yes', 'done', 'thanks, can you also export it?', 'go for it', 'merge this', '<@200000000000000001>', '']) assert.strictEqual(desk.ackOnly(t), false, t);
    assert.strictEqual(desk.ackOnly('thanks', 1), false);
});

test('go means go, and only as a whole message or a go phrase', () => {
    const job = text => ({ kind: 'message', messages: [{ text }] });
    for (const t of ['go', '<@200000000000000001> go!', 'go for it', 'ok go ahead', "that's everything", 'ship it']) assert.strictEqual(desk.saysGo(job(t)), true, t);
    for (const t of ['where did the take go?', 'go with option 2', 'can we go over the notes']) assert.strictEqual(desk.saysGo(job(t)), false, t);
});

test('the daemon will not start without a config', () => {
    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
    delete env.DESK_CONFIG;
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'desk.js'), 'run'], { env, encoding: 'utf-8' });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /no config at/);
});
