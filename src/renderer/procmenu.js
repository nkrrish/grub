// The "⋯" menu on a hungry app: Quit, or Force quit after a second click. Shared by window and menu bar.
const ProcMenu = (() => {
  const menu = document.createElement('div');
  menu.className = 'proc-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  let owner = null;

  function item(text, cls, onclick) {
    const b = document.createElement('button');
    b.className = `proc-menu-item ${cls || ''}`;
    b.setAttribute('role', 'menuitem');
    b.textContent = text;
    b.addEventListener('click', onclick);
    return b;
  }

  function note(text) {
    const p = document.createElement('p');
    p.className = 'proc-menu-note';
    p.textContent = text;
    return p;
  }

  function close() {
    menu.hidden = true;
    owner?.setAttribute('aria-expanded', 'false');
    owner = null;
  }

  async function quit(p, force) {
    menu.replaceChildren(note(force ? `Force quitting ${p.label}…` : `Asking ${p.label} to quit…`));
    const r = await window.mole.quitApp(p.app, force);
    if (r.ok) return close();
    menu.replaceChildren(note(r.error), ...(r.waiting ? [item('Force quit', 'is-danger', () => confirmForce(p))] : []));
  }

  function confirmForce(p) {
    menu.replaceChildren(
      note('Unsaved work in it will be lost.'),
      item(`Force quit ${p.label}`, 'is-danger', () => quit(p, true)),
      item('Never mind', '', close)
    );
  }

  function open(btn, p) {
    if (owner === btn) return close();
    close();
    owner = btn;
    btn.setAttribute('aria-expanded', 'true');
    if (!p.app || p.app.startsWith('/System/Library/')) menu.replaceChildren(note('Part of macOS. Grub leaves it alone.'));
    else
      menu.replaceChildren(
        item(`Quit ${p.label}`, '', () => quit(p, false)),
        item('Force quit…', 'is-danger', () => confirmForce(p)),
        note('Stops its helpers too.')
      );
    menu.hidden = false;
    // under the button, kept inside the window
    const b = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(b.right - w, innerWidth - w - 8))}px`;
    const below = b.bottom + 4;
    menu.style.top = `${below + menu.offsetHeight > innerHeight - 8 ? b.top - menu.offsetHeight - 4 : below}px`;
  }

  document.addEventListener('pointerdown', (e) => {
    if (owner && !menu.contains(e.target) && !owner.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  addEventListener('scroll', close, true);
  addEventListener('blur', close);
  document.body.append(menu);

  // `getProc` returns the row's current app, since rows are reused across updates
  function button(getProc) {
    const btn = document.createElement('button');
    btn.className = 'proc-more';
    btn.setAttribute('aria-label', 'More');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '⋯';
    btn.addEventListener('click', () => open(btn, getProc()));
    return btn;
  }

  return { button };
})();
