/* ---------- AI tools: cleanup and care for Claude Code, Codex, Cursor and OpenCode ---------- */

const AI_TOOLS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', gemini: 'Gemini & Antigravity', chatgpt: 'ChatGPT' };
const AI_RETENTION = [
  [15, '15 days'],
  [30, '30 days'],
  [90, '90 days'],
  [120, '120 days'],
  [0, 'Never'],
];
const AI_GROUPS = [
  { key: 'gone', title: 'Removed apps', note: 'These apps are gone but left data behind. Nothing here is ticked; pick what to clear.' },
  { key: 'cache', title: 'Caches and old versions', note: 'They come back on their own when needed, so they’re ticked for you.' },
  { key: 'session', title: 'Old sessions', note: 'Chats you haven’t opened in a while, or whose project is gone. They don’t come back, so pick them yourself.' },
  { key: 'worktree', title: 'Finished worktrees', note: 'Nothing uncommitted in them. The folder goes; the branch and its commits stay.' },
  { key: 'maint', title: 'Maintenance', note: 'Frees space without removing anything you made.' },
];

const ai = { loaded: false, at: 0, data: null, picked: new Set(), open: new Set(), busy: false, settings: {} };

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function aiLoad({ quiet } = {}) {
  ai.loaded = true;
  if (!quiet) unsettle('view-ai');
  if (!quiet && !ai.data) $('#ai-body').replaceChildren(digging('Sniffing through your AI tools…'));
  if (!quiet) setFreshness('ai-fresh', ai.at, true);
  const res = await window.mole.ai.scan();
  ai.settings = await window.mole.settings.get();
  if (!res.ok) {
    setFreshness('ai-fresh', ai.at);
    return $('#ai-body').replaceChildren(el('div', { class: 'empty' }, 'Grub couldn’t look: ' + (res.error || 'unknown problem')));
  }
  ai.data = res.data;
  ai.at = res.data.at;
  ai.picked = new Set(res.data.items.filter((i) => i.on).map((i) => i.id));
  aiNav();
  if (!quiet || $('#view-ai').classList.contains('is-active')) aiRender();
}

// The sidebar entry only shows up when there's AI tool data, and it can be hidden in About.
function aiNav() {
  const has = !!ai.data && (ai.data.items.length > 0 || ai.data.tools.length > 0);
  $('#nav-ai').hidden = !(ai.settings.aiCare ?? true) || !has;
  const crumbs = ai.data?.items || [];
  $('#nav-ai-count').textContent = crumbs.length ? bytes(crumbs.reduce((n, i) => n + i.bytes, 0)) : '';
}

// Rows slide in on the first draw only. Ticking a box redraws the page, and replaying that each time made it blink.
const aiIcons = new Map();

function aiRender() {
  setFreshness('ai-fresh', ai.at);
  const { tools, retention } = ai.data;
  const items = ai.data.items;
  const total = items.reduce((n, i) => n + i.bytes, 0);
  $('#ai-title').textContent = items.length ? `Your AI helpers left ${bytes(total)} of crumbs.` : 'Your AI helpers are tidy.';

  $('#ai-tools').replaceChildren(
    el('h2', { class: 'ai-footprint-title' }, 'Space each tool takes'),
    el(
      'div',
      { class: 'ai-footprint-grid' },
      ...tools.sort((a, b) => b.bytes - a.bytes).map((t) => {
        const mark = el('span', { class: 'ai-tool-mark', 'aria-hidden': 'true' }, (AI_TOOLS[t.key] || t.key)[0]);
        const showIcon = (url) => url && mark.replaceChildren(el('img', { src: url, alt: '', width: 18, height: 18 }));
        // remembered, so a redraw shows the icon straight away instead of the letter first
        if (aiIcons.has(t.app)) showIcon(aiIcons.get(t.app));
        else if (t.app) window.mole.appIcon(t.app).then((url) => (aiIcons.set(t.app, url), showIcon(url)));
        return el(
          'div',
          { class: 'ai-tool', title: `Everything in ${t.dirs.join(' and ')}: chats, settings and caches. Only what’s listed below is safe to clear.` },
          el('div', { class: 'ai-tool-name' }, mark, AI_TOOLS[t.key] || t.key),
          el('div', { class: 'ai-tool-size' }, bytes(t.bytes)),
          t.gone ? el('span', { class: 'ai-tool-gone' }, 'Removed') : null
        );
      })
    )
  );
  $('#ai-tools').hidden = !tools.length;

  if (!items.length) {
    $('#ai-body').replaceChildren(
      el('div', { class: 'empty' }, 'Nothing to clean. Sessions used in the last day are never listed.'),
      aiKeep(retention)
    );
    return aiBar();
  }

  $('#ai-body').replaceChildren(
    ...AI_GROUPS.map((g) => {
      const rows = items.filter((i) => i.group === g.key);
      if (!rows.length) return null;
      // sessions get one fold per tool, so 90 chats don't bury the rest
      const parts = g.key === 'session' ? Object.keys(AI_TOOLS).map((t) => rows.filter((r) => r.tool === t)).filter((r) => r.length) : [rows];
      return el(
        'section',
        { class: 'ai-group' },
        el(
          'header',
          { class: 'ai-group-head' },
          el('h2', {}, g.title),
          el('span', { class: 'ai-group-size' }, bytes(rows.reduce((n, r) => n + r.bytes, 0)))
        ),
        el('p', { class: 'ai-note' }, g.note),
        g.key === 'session' ? aiKeep(retention) : null,
        ...parts.map((part) => (g.key === 'session' ? aiFold(part) : aiList(part)))
      );
    }).filter(Boolean) // replaceChildren would print an empty group as the word "null"
  );
  aiBar();
}

// One card per tool: tick them all at once, or open it to pick sessions one by one.
function aiFold(rows) {
  const key = rows[0].tool;
  const open = ai.open.has(key);
  const orphans = rows.filter((r) => r.orphan).length;
  const head = aiAllRow(rows, `${AI_TOOLS[key]} · ${rows.length} session${rows.length === 1 ? '' : 's'}`, orphans ? `${orphans} with no project` : '');
  const toggle = el(
    'button',
    {
      class: 'ai-fold-toggle',
      'aria-expanded': String(open),
      'aria-label': open ? `Hide ${AI_TOOLS[key]} sessions` : `Show each ${AI_TOOLS[key]} session`,
      title: open ? 'Hide sessions' : 'Show each session',
      onclick: () => {
        ai.open.has(key) ? ai.open.delete(key) : ai.open.add(key);
        aiRender();
      },
    },
    icon('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>')
  );
  return el('div', { class: 'ai-fold' + (open ? ' is-open' : '') }, el('div', { class: 'ai-fold-head' }, head, toggle), open ? aiList(rows, true) : null);
}

// How old a chat must be before it's listed, set right where those chats show up.
function aiKeep(retention) {
  return el(
    'div',
    { class: 'ai-keep-row' },
    el('span', { class: 'ai-keep-lead' }, 'List sessions older than'),
    ...['claude', 'codex'].map((tool) =>
      el(
        'label',
        { class: 'ai-keep' },
        el('span', {}, AI_TOOLS[tool]),
        el(
          'select',
          {
            class: 'ai-select',
            onchange: async (e) => {
              await window.mole.settings.set({ aiRetention: { ...retention, [tool]: +e.target.value } });
              aiLoad();
            },
          },
          ...AI_RETENTION.map(([v, label]) => {
            const o = el('option', { value: v }, label);
            o.selected = retention[tool] === v;
            return o;
          })
        )
      )
    )
  );
}

function aiAllRow(rows, label, sub) {
  const usable = rows.filter((r) => !r.blocked);
  const on = usable.filter((r) => ai.picked.has(r.id));
  const state = usable.length && on.length === usable.length ? 'true' : on.length ? 'mixed' : 'false';
  const size = bytes(rows.reduce((n, r) => n + r.bytes, 0));
  const attrs = {
    class: 'pick-all',
    role: 'checkbox',
    'aria-checked': state,
    onclick: () => {
      const target = state !== 'true';
      usable.forEach((r) => (target ? ai.picked.add(r.id) : ai.picked.delete(r.id)));
      aiRender();
    },
  };
  if (!usable.length) attrs.disabled = ''; // el() would turn a null into disabled="null"
  return el(
    'button',
    attrs,
    el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': state }),
    el('span', { class: 'pick-all-label' }, el('b', {}, label), sub ? el('span', { class: 'row-sub' }, sub) : null),
    el('span', { class: 'pick-all-count' }, size)
  );
}

function aiList(rows, sessions) {
  return el(
    'div',
    { class: 'list pick-list ai-list' },
    ...rows.map((r, i) => {
      const on = ai.picked.has(r.id);
      const sub = [r.sub, sessions && r.last ? `last used ${dayFmt.format(r.last)}` : null, r.blocked].filter(Boolean).join(' · ');
      const attrs = {
        class: `row pick-row${r.blocked ? ' is-blocked' : ''}`,
        role: 'checkbox',
        'aria-checked': String(on),
        style: `--i:${Math.min(i, 20)}`,
        onclick: () => {
          if (r.blocked) return;
          on ? ai.picked.delete(r.id) : ai.picked.add(r.id);
          aiRender();
        },
      };
      if (r.blocked) attrs['aria-disabled'] = 'true';
      return el(
        'button',
        attrs,
        el('span', { class: 'pick-box', 'aria-hidden': 'true', 'aria-checked': String(on) }),
        el('div', { class: 'row-name' }, r.name, sub ? el('span', { class: 'row-sub' }, sub) : null),
        el('div', { class: 'row-size' }, bytes(r.bytes))
      );
    })
  );
}

function aiPicked() {
  return (ai.data?.items || []).filter((i) => ai.picked.has(i.id) && !i.blocked);
}

function aiBar() {
  const picked = aiPicked();
  const size = bytes(picked.reduce((n, i) => n + i.bytes, 0));
  const go = $('#ai-go');
  go.disabled = ai.busy || !picked.length;
  go.textContent = ai.busy ? 'Burying…' : picked.length ? `Bury ${picked.length} · ${size}` : 'Pick something';
  $('#ai-bar-note').textContent = picked.some((i) => i.group !== 'cache')
    ? 'Files go to the Trash. Worktrees are removed with git; their branches stay.'
    : 'Everything goes to the Trash, so you can change your mind.';
}

function aiSummary(picked) {
  const by = (g) => picked.filter((i) => i.group === g).length;
  const parts = [
    by('cache') && `${by('cache')} cache${by('cache') === 1 ? '' : 's'} or old version${by('cache') === 1 ? '' : 's'}`,
    by('session') && `${by('session')} session${by('session') === 1 ? '' : 's'}`,
    by('worktree') && `${by('worktree')} worktree${by('worktree') === 1 ? '' : 's'}`,
    by('maint') && 'a database compaction',
    by('gone') && `what ${by('gone') === 1 ? 'a removed app' : `${by('gone')} removed apps`} left behind`,
  ].filter(Boolean);
  return parts.join(', ').replace(/, ([^,]*)$/, ' and $1');
}

$('#ai-go').addEventListener('click', () => {
  const picked = aiPicked();
  if (!picked.length) return;
  const sessions = picked.some((i) => i.group === 'session');
  confirmRun(
    `Grub will remove ${aiSummary(picked)}, about ${bytes(picked.reduce((n, i) => n + i.bytes, 0))}.${sessions ? ' Sessions won’t rebuild, but they sit in the Trash until you empty it.' : ''}`,
    'Bury',
    async () => {
      ai.busy = true;
      aiBar();
      const before = await window.mole.diskFree();
      const res = await window.mole.ai.clean(picked.map((i) => i.id));
      ai.busy = false;
      const results = res.data?.results || [];
      const failed = results.filter((r) => !r.ok);
      const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const names = new Map(picked.map((i) => [i.id, i.name]));
      const after = await window.mole.diskFree();
      await aiLoad({ quiet: true });
      aiRender();
      // one row per kind of thing, so twenty sessions read as one line
      const rows = AI_GROUPS.map((g) => {
        const went = picked.filter((i) => i.group === g.key && done.has(i.id));
        return went.length ? { name: g.title, sub: went.length === 1 ? went[0].name : `${went.length} items`, size: went.reduce((n, i) => n + i.bytes, 0) } : null;
      }).filter(Boolean);
      celebrate({
        title: failed.length ? 'Mostly buried.' : 'Buried.',
        ...{
          amount: res.data?.freed || 0,
          verb: 'moved to the Trash',
          trash: true,
          disk: after && { before: before?.free ?? null, after: after.free, total: after.total },
          rows,
          note: failed.length
            ? `Left alone: ${failed.map((f) => `${names.get(f.id) || 'Something'} (${f.error})`).join('; ')}`
            : 'It’s in the Trash, so you can put it back. The space comes back once you empty the Trash.',
        },
      });
    }
  );
});

$('#ai-refresh').addEventListener('click', () => aiLoad());
$('#nav-ai').addEventListener('click', () => {
  if (!ai.loaded || isStale(ai.at, HOUR)) aiLoad();
  else aiRender();
});

// About: hide or show the sidebar entry
async function aiSyncSwitch(s) {
  ai.settings = s;
  setSwitch($('#about-ai'), s.aiCare ?? true);
  aiNav();
}
$('#about-ai').addEventListener('click', async () => aiSyncSwitch(await window.mole.settings.set({ aiCare: !(ai.settings.aiCare ?? true) })));
window.mole.settings.onChange(aiSyncSwitch);

// A quiet look a few seconds after launch decides whether the sidebar entry appears.
window.mole.settings.get().then((s) => {
  aiSyncSwitch(s);
  setTimeout(() => aiLoad({ quiet: true }), 4000);
});
