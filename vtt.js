/* Sparks of Dynasty Virtual Tabletop — Browser Client with Popovers, Sheet Tabs & Raycasted POV */
(function () {
  'use strict';

  const R = window.SPARKS_RULES;
  const D = window.SPARKS_DATA;

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e, dialog) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
      let pressedOutside = false;
      dialog.addEventListener('pointerdown', e => { pressedOutside = outside(e, dialog); });
      dialog.addEventListener('pointerup', e => { if (pressedOutside && outside(e, dialog)) dialog.close(); });
    });
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sign = v => (v >= 0 ? '+' : '−') + Math.abs(v);

  const spriteCache = new Map();
  function getSprite(src) {
    if (!src) return null;
    if (spriteCache.has(src)) return spriteCache.get(src);
    const img = new Image();
    img.src = src;
    img.onload = () => drawMap();
    spriteCache.set(src, img);
    return img;
  }

  let state = null;
  let conditionsCatalog = [];
  let activeDrawer = 'sheet';
  let activeSheetTab = 'combat'; // 'combat' | 'stats' | 'magic' | 'conditions'
  let sheetSectionOpen = true;
  let activeTool = 'select';
  let dockMinimized = false;
  let hudToolsOpen = true;
  let hudViewOpen = true;
  let logFilter = 'all'; // 'all' | 'chat' | 'rolls'
  let chatSenderManual = false;
  let useReactionMode = false;
  let showGrid = true;
  let showLights = true;
  let pov = { mode: 'dm', tokenId: null }; // mode: 'dm' | 'player' | 'token'
  let targeting = null;
  let pendingConfirmFn = null;
  let rollMode = 'normal';
  let mapBgImage = null;
  let lastBgUrl = null;
  const cam = { x: 40, y: 50, scale: 1 };

  // Offscreen Fog of War canvas
  const fogCanvas = document.createElement('canvas');
  const fogCtx = fogCanvas.getContext('2d');

  // Position popovers cleanly beneath their trigger buttons
  document.querySelectorAll('[popover]').forEach(pop => {
    pop.addEventListener('beforetoggle', e => {
      if (e.newState !== 'open') return;
      const btn = document.querySelector(`[popovertarget="${pop.id}"]`);
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const left = clamp(r.left, 8, Math.max(8, window.innerWidth - 260));
      const top = Math.min(r.bottom + 6, window.innerHeight - 120);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    });
  });

  function closeMenus() {
    document.querySelectorAll('[popover]:popover-open').forEach(p => { try { p.hidePopover(); } catch {} });
  }

  async function apiGet(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function apiPost(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? '{}' : JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(txt || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function syncBgImage() {
    const url = state?.map?.imageDataUrl || null;
    if (url === lastBgUrl) return;
    lastBgUrl = url;
    if (!url) { mapBgImage = null; return; }
    const img = new Image();
    img.onload = () => { mapBgImage = img; fitMapToView(); };
    img.src = url;
  }

  function applyServerEnvelope(env) {
    state = env.state ? env.state : env;
    syncBgImage();
    if (env.toast) toast(esc(env.toast), env.toast_kind || '');
    renderAll();
    drawMap();
  }

  async function runPost(url, body) {
    try {
      const env = await apiPost(url, body);
      applyServerEnvelope(env);
    } catch (err) {
      toast(`Server error: ${esc(err.message)}`, 'dmg');
    }
  }

  function getToken(id) { return state?.tokens?.find(t => t.id === id) || null; }
  function activeSlot() { return state?.combatActive ? (state?.initiative?.[state.turnIndex] || null) : null; }
  function activeToken() { const s = activeSlot(); return s ? getToken(s.tokenId) : null; }
  function selectedToken() { return getToken(state?.selectedId) || activeToken() || state?.tokens?.[0] || null; }
  function isGmMode() { return pov.mode === 'dm'; }
  function isTokensTurn(tok) {
    if (!state?.combatActive || !tok) return true;
    const act = activeToken();
    return act?.id === tok.id;
  }
  function hasAnyReaction(tok) {
    return !!tok && !tok.dying?.dead && (tok.reactionAvailable || (tok.permissions?.extraReactions || 0) > 0);
  }
  function canActNormally(tok, permKey) {
    return isTokensTurn(tok) || !!tok?.permissions?.[permKey];
  }
  function maybePromptOffTurnAction(tok, permKey, actionLabel, callback) {
    if (!state?.combatActive || !tok || canActNormally(tok, permKey)) {
      callback(false);
      return;
    }
    if (useReactionMode) {
      callback(true);
      return;
    }
    if (!hasAnyReaction(tok)) {
      toast(`${esc(tok.name)} is off-turn and has no Reaction left (GM can grant off-turn permission).`, 'dmg');
      return;
    }
    openConfirmDialog({
      title: `Off-Turn Reaction — ${tok.name}`,
      bodyHtml: `<div class="confirm-box"><p><strong>Combat is active</strong> and it is currently <strong>${esc(activeToken()?.name || 'another combatant')}'s</strong> turn.</p><p style="margin-top:6px">Spend <strong>${esc(tok.name)}'s Reaction</strong> to ${esc(actionLabel)}?</p></div>`,
      onApply: async () => { await callback(true); }
    });
  }

  function toast(html, kind = '') {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = html;
    stack.appendChild(el);
    setTimeout(() => { el.remove(); }, 4200);
  }

  function openConfirmDialog({ title, bodyHtml, onApply }) {
    const dlg = $('#dlg-confirm');
    $('#dlg-confirm-title').textContent = title;
    $('#dlg-confirm-body').innerHTML = bodyHtml;
    pendingConfirmFn = async () => { await onApply(); dlg.close('apply'); };
    dlg.showModal();
  }
  $('#dlg-confirm-apply').addEventListener('click', () => {
    if (pendingConfirmFn) { const fn = pendingConfirmFn; pendingConfirmFn = null; fn(); }
  });

  // ---- 2D Raycasting Line-of-Sight & POV Visibility Engine
  function raySegmentDist(ox, oy, dx, dy, x1, y1, x2, y2) {
    const rx = x2 - x1, ry = y2 - y1;
    const denom = dx * ry - dy * rx;
    if (Math.abs(denom) < 1e-9) return null;
    const qpx = x1 - ox, qpy = y1 - oy;
    const t = (qpx * ry - qpy * rx) / denom;
    const u = (qpx * dy - qpy * dx) / denom;
    if (t >= 0 && u >= -1e-6 && u <= 1 + 1e-6) return t;
    return null;
  }

  function buildWallSegments() {
    const m = state.map;
    const cp = m.cellPx;
    const segs = [];
    const ox = m.offsetX, oy = m.offsetY;
    const w = m.cols * cp, h = m.rows * cp;
    // Map boundary
    segs.push([ox, oy, ox + w, oy], [ox + w, oy, ox + w, oy + h], [ox + w, oy + h, ox, oy + h], [ox, oy + h, ox, oy]);
    for (const wl of (m.walls || [])) {
      segs.push([ox + wl.x1 * cp, oy + wl.y1 * cp, ox + wl.x2 * cp, oy + wl.y2 * cp]);
    }
    for (const p of (m.portals || [])) {
      if (p.closed) segs.push([ox + p.x1 * cp, oy + p.y1 * cp, ox + p.x2 * cp, oy + p.y2 * cp]);
    }
    return segs;
  }

  function computeVisibilityPolygon(originX, originY, segs, maxDistPx) {
    const angles = [];
    // Add 24 base rays for clean circular bounds + corner rays to every wall endpoint
    for (let i = 0; i < 36; i++) angles.push((i / 36) * Math.PI * 2);
    for (const [x1, y1, x2, y2] of segs) {
      const a1 = Math.atan2(y1 - originY, x1 - originX);
      const a2 = Math.atan2(y2 - originY, x2 - originX);
      angles.push(a1 - 0.0002, a1, a1 + 0.0002, a2 - 0.0002, a2, a2 + 0.0002);
    }
    angles.sort((a, b) => a - b);
    const pts = [];
    for (const ang of angles) {
      const dx = Math.cos(ang), dy = Math.sin(ang);
      let best = maxDistPx;
      for (const [x1, y1, x2, y2] of segs) {
        const d = raySegmentDist(originX, originY, dx, dy, x1, y1, x2, y2);
        if (d !== null && d < best) best = d;
      }
      pts.push([originX + dx * best, originY + dy * best]);
    }
    return pts;
  }

  function hasLineOfSight(ax, ay, bx, by, segs) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const ux = dx / len, uy = dy / len;
    for (const [x1, y1, x2, y2] of segs) {
      const d = raySegmentDist(ax, ay, ux, uy, x1, y1, x2, y2);
      if (d !== null && d < len - 2) return false;
    }
    return true;
  }

  function getPovObservers() {
    if (!state || pov.mode === 'dm') return [];
    if (pov.mode === 'player') return state.tokens.filter(t => t.faction === 'party' && !t.dying.dead);
    const tok = getToken(pov.tokenId);
    return tok ? [tok] : [];
  }

  function isTokenVisibleInPov(tok, observers, segs) {
    if (pov.mode === 'dm') return true;
    if (observers.some(o => o.id === tok.id)) return true;
    if (tok.hidden) return false;

    const m = state.map, cp = m.cellPx;
    const tf = R.tokenFootprint(tok);
    const tx = m.offsetX + (tok.x + tf / 2) * cp;
    const ty = m.offsetY + (tok.y + tf / 2) * cp;
    const isInvisible = (tok.conditions || []).some(c => c.name === 'Invisible');
    const inTrueDarkness = (m.darkness || []).includes(`${tok.x},${tok.y}`);
    const isDarkAmbient = m.ambient === 'darkness';

    const litByTorch = (m.lights || []).some(lt => {
      const lx = m.offsetX + (lt.x + 0.5) * cp;
      const ly = m.offsetY + (lt.y + 0.5) * cp;
      return Math.hypot(tx - lx, ty - ly) <= (lt.dim || 8) * cp;
    });

    for (const obs of observers) {
      const obsCond = (obs.conditions || []).map(c => c.name);
      const isBlind = obsCond.includes('Blind');
      const v = obs.vision || 'Normal';
      if (isBlind && v !== 'Blind Sight') continue;

      const of = R.tokenFootprint(obs);
      const ox = m.offsetX + (obs.x + of / 2) * cp;
      const oy = m.offsetY + (obs.y + of / 2) * cp;
      const distMeters = Math.hypot(tx - ox, ty - oy) / cp;

      if (!hasLineOfSight(ox, oy, tx, ty, segs)) continue;
      if (isInvisible && v !== 'True Vision' && !(v === 'Blind Sight' && distMeters <= 10)) continue;
      if (inTrueDarkness && v !== 'True Vision' && v !== 'Supernatural Vision' && !(v === 'Blind Sight' && distMeters <= 10)) continue;
      if (isDarkAmbient && !litByTorch && v === 'Normal' && distMeters > 2.5) continue;
      if (v === 'Dark Sight' && isDarkAmbient && !litByTorch && distMeters > 30) continue;
      if (v === 'Blind Sight' && isBlind && distMeters > 10) continue;
      return true;
    }
    return false;
  }

  function setPov(mode, tokenId = null) {
    pov = { mode, tokenId };
    updatePovUi();
    renderAll();
    drawMap();
  }

  function updatePovUi() {
    $$('[data-pov-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.povMode === pov.mode)));
    const sel = $('#pov-token-select');
    if (sel && state) {
      sel.innerHTML = `<option value="">Choose token…</option>` +
        state.tokens.map(t => `<option value="${esc(t.id)}"${pov.mode === 'token' && pov.tokenId === t.id ? ' selected' : ''}>${esc(t.name)} (${esc(t.vision)})</option>`).join('');
    }
    const banner = $('#pov-banner');
    const tokenBtn = $('#btn-pov-token-pill');
    if (pov.mode === 'dm') {
      banner.hidden = true;
      if (tokenBtn) { tokenBtn.textContent = 'Token ▾'; tokenBtn.setAttribute('aria-pressed', 'false'); }
    } else if (pov.mode === 'player') {
      banner.hidden = false;
      const nParty = state?.tokens?.filter(t => t.faction === 'party').length || 0;
      $('#pov-banner-text').textContent = `Player POV (${nParty} Party Tokens · ${state?.map?.ambient === 'darkness' ? 'Dungeon Darkness' : 'Bright'})`;
      if (tokenBtn) { tokenBtn.textContent = 'Token ▾'; tokenBtn.setAttribute('aria-pressed', 'false'); }
    } else {
      const tok = getToken(pov.tokenId);
      banner.hidden = false;
      $('#pov-banner-text').textContent = `Token POV: ${tok ? `${tok.name} (${tok.vision})` : 'Unknown'}`;
      if (tokenBtn) { tokenBtn.textContent = tok ? `${tok.name.split(' ')[0]} ▾` : 'Token ▾'; tokenBtn.setAttribute('aria-pressed', 'true'); }
    }
  }

  // ---- Attack & AoE Confirmations
  function startAttackTargeting(attackerId, attackIndex, label) {
    targeting = { attackerId, attackIndex, label };
    activeTool = 'attack';
    $('#targeting-text').textContent = `${getToken(attackerId)?.name}: Click a target for ${label}…`;
    $('#targeting-banner').hidden = false;
    updateToolButtons();
  }
  function cancelTargeting() {
    targeting = null;
    if (activeTool === 'attack') activeTool = 'select';
    $('#targeting-banner').hidden = true;
    updateToolButtons();
    drawMap();
  }
  $('#btn-cancel-target').addEventListener('click', cancelTargeting);

  async function launchAttackConfirmation(attackerId, targetId, attackIndex, forceReaction = false) {
    const atkTok = getToken(attackerId);
    if (!forceReaction && state?.combatActive && atkTok && !canActNormally(atkTok, 'allowActions') && !useReactionMode) {
      maybePromptOffTurnAction(atkTok, 'allowActions', `attack ${getToken(targetId)?.name || 'target'}`, useReact => {
        launchAttackConfirmation(attackerId, targetId, attackIndex, useReact);
      });
      return;
    }
    const asReaction = forceReaction || (state?.combatActive && !canActNormally(atkTok, 'allowActions') && useReactionMode);
    try {
      const p = await apiPost('/api/attack/preview', { attackerId, targetId, attackIndex, rollMode, asReaction, gmOverride: false });
      const outcomeColor = p.hit ? 'var(--good-color)' : 'var(--ink-crimson)';
      const outcomeText = p.hit
        ? (p.strikeKind === 'decisive' ? `DECISIVE STRIKE (×${p.mult} + Crippled)` : p.strikeKind === 'critical' ? 'CRITICAL STRIKE (×2)' : 'HIT')
        : (p.missedByChance ? `MISSED (Miss Chance d100=${p.missRoll} ≤ ${p.highestMiss}%)` : 'MISS');

      const bodyHtml = `
        <div class="confirm-box">
          <div><strong>${esc(p.attackerName)}</strong> attacks <strong>${esc(p.targetName)}</strong> with <strong>${esc(p.attackName)}</strong> (${p.dist} m)</div>
          ${p.notes.length ? `<div class="muted" style="margin-top:4px">${esc(p.notes.join(' · '))}</div>` : ''}
        </div>
        <div class="confirm-grid">
          <div><strong>Attack Roll:</strong> ${esc(p.d20Text)} ${sign(p.modTotal)} = <b>${p.totalAtk}</b> vs AC <b>${p.effectiveAc}</b></div>
          <div><strong>Outcome:</strong> <b style="color:${outcomeColor}">${outcomeText}</b>
            ${p.critRoll != null ? `<br><small class="muted">Crit d100: ${p.critRoll} vs ≤ ${p.critChance} (Decisive on ${p.decFrom}–20)</small>` : ''}
          </div>
        </div>
        <div class="confirm-grid">
          <label>Main Damage (${esc(p.dmgType)})<input type="number" id="cf-dmg" class="vtt-input" value="${p.mainDamage}" min="0"></label>
          <label>Damage Type<select id="cf-dmg-type" class="vtt-input">${D.damageTypes.physical.concat(D.damageTypes.magical, D.damageTypes.alignment).map(t => `<option value="${esc(t)}"${t === p.dmgType ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
          <label>Extra Magic Damage (${esc(p.extraSummary)})<input type="number" id="cf-extra" class="vtt-input" value="${p.extraDamage}" min="0"></label>
          <label>Extra Type<select id="cf-extra-type" class="vtt-input">${D.damageTypes.magical.concat(D.damageTypes.alignment, D.damageTypes.physical).map(t => `<option value="${esc(t)}"${t === p.extraType ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        </div>
        <div class="row" style="margin-top:6px">
          <label class="row"><input type="checkbox" id="cf-crippled" ${p.appliesCrippled ? 'checked' : ''}> Apply Crippled</label>
          <label class="row"><input type="checkbox" id="cf-nonlethal"> Nonlethal</label>
          <label class="row"><input type="checkbox" id="cf-true"> True Damage</label>
          <label class="row"><input type="checkbox" id="cf-spend-ap" checked> Spend ${p.apCost} AP</label>
        </div>
        <div class="confirm-box" style="margin-top:8px">
          <strong>Rust Engine Armor Preview:</strong> ${esc(p.previewSteps.join(' · '))}
        </div>`;

      openConfirmDialog({
        title: `Confirm Attack — ${p.attackName}`,
        bodyHtml,
        onApply: async () => {
          await runPost('/api/attack/apply', {
            attackerId, targetId, attackName: p.attackName, rollSummary: `Roll ${p.totalAtk} vs AC ${p.effectiveAc}`,
            hit: p.hit, strikeKind: p.strikeKind,
            mainDamage: parseInt($('#cf-dmg').value, 10) || 0, dmgType: $('#cf-dmg-type').value,
            extraDamage: parseInt($('#cf-extra').value, 10) || 0, extraType: $('#cf-extra-type').value,
            applyCrippled: $('#cf-crippled').checked, nonlethal: $('#cf-nonlethal').checked,
            isTrue: $('#cf-true').checked, spendAp: $('#cf-spend-ap').checked,
            apCost: p.apCost, enchanted: p.enchanted, vorpal: p.vorpal,
            asReaction, gmOverride: false
          });
          if (asReaction) useReactionMode = false;
        }
      });
    } catch (err) { toast(`Preview error: ${esc(err.message)}`, 'dmg'); }
  }

  function runAreaTemplateConfirm(affectedTokens, templateKind, radiusMeters) {
    if (!affectedTokens.length) { toast('No tokens inside template area.'); return; }
    const bodyHtml = `
      <div class="confirm-box"><strong>${affectedTokens.length}</strong> token(s) inside <strong>${esc(templateKind)} (${radiusMeters} m)</strong>: ${affectedTokens.map(t => esc(t.name)).join(', ')}</div>
      <div class="confirm-grid">
        <label>Save Type<select id="aoe-save" class="vtt-input"><option value="evasion">Evasion</option><option value="body">Resistance (Body)</option><option value="mind">Resistance (Mind)</option></select></label>
        <label>Save DC<input type="number" id="aoe-dc" class="vtt-input" value="15"></label>
        <label>Damage Dice<input type="text" id="aoe-dice" class="vtt-input" value="3d6"></label>
        <label>Damage Type<select id="aoe-type" class="vtt-input">${D.damageTypes.magical.concat(D.damageTypes.physical, D.damageTypes.alignment).map(t => `<option value="${esc(t)}"${t === 'Fire' ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label class="row"><input type="checkbox" id="aoe-half" checked> Half damage on save</label>
        <label class="row"><input type="checkbox" id="aoe-upcast"> Upcast (+double dice)</label>
      </div>`;

    openConfirmDialog({
      title: 'Resolve Area Template (Batch Saves)',
      bodyHtml,
      onApply: async () => {
        await runPost('/api/aoe/resolve', {
          tokenIds: affectedTokens.map(t => t.id), templateKind, saveType: $('#aoe-save').value,
          dc: parseInt($('#aoe-dc').value, 10) || 15, dice: $('#aoe-dice').value.trim() || '3d6',
          dmgType: $('#aoe-type').value, half: $('#aoe-half').checked, upcast: $('#aoe-upcast').checked
        });
      }
    });
  }

  // ---- Canvas 2D Map Engine
  const canvas = $('#map-canvas');
  const ctx = canvas.getContext('2d');
  let dragState = null, hoverCell = null, templatePreview = null, measureLine = null, calibrateBox = null;

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMap();
  }
  window.addEventListener('resize', resizeCanvas);

  function screenToWorld(sx, sy) { return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale }; }
  function worldToCell(wx, wy) {
    const m = state.map;
    return { cx: Math.floor((wx - m.offsetX) / m.cellPx), cy: Math.floor((wy - m.offsetY) / m.cellPx) };
  }
  function findTokenAtCell(cx, cy, visibleOnly = false) {
    if (!state) return null;
    const observers = visibleOnly ? getPovObservers() : [];
    const segs = visibleOnly ? buildWallSegments() : [];
    for (let i = state.tokens.length - 1; i >= 0; i--) {
      const t = state.tokens[i];
      if (visibleOnly && !isTokenVisibleInPov(t, observers, segs)) continue;
      const f = R.tokenFootprint(t);
      if (cx >= t.x && cx < t.x + f && cy >= t.y && cy < t.y + f) return t;
    }
    return null;
  }

  function fitMapToView() {
    if (!state) return;
    const rect = canvas.getBoundingClientRect();
    const m = state.map;
    const desktop = window.innerWidth > 900;
    const shell = $('#vtt-shell');
    const leftPad = desktop && !shell.classList.contains('hide-left') ? ($('#rail-left')?.offsetWidth || 266) + 20 : 20;
    const rightPad = desktop && !shell.classList.contains('hide-right') ? ($('#rail-right')?.offsetWidth || 352) + 20 : 20;
    const availW = Math.max(240, rect.width - leftPad - rightPad);
    const mapW = m.cols * m.cellPx, mapH = m.rows * m.cellPx;
    const scale = clamp(Math.min(availW / mapW, (rect.height - 110) / mapH), 0.35, 2.2);
    cam.scale = scale;
    cam.x = leftPad + (availW - mapW * scale) / 2;
    cam.y = (rect.height - mapH * scale) / 2;
    $('#zoom-readout').textContent = `${Math.round(cam.scale * 100)}%`;
    drawMap();
  }

  function getTemplateCells(t) {
    const cells = [], { cols, rows } = state.map;
    if (t.kind === 'template-circle') {
      const r = Math.max(1, Math.round(Math.hypot(t.x2 - t.x1, t.y2 - t.y1)));
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (Math.hypot(x - t.x1, y - t.y1) <= r + 0.35) cells.push({ x, y });
      return { cells, radius: r };
    }
    if (t.kind === 'template-cone') {
      const len = Math.max(2, Math.round(Math.hypot(t.x2 - t.x1, t.y2 - t.y1)));
      const ang = Math.atan2(t.y2 - t.y1, t.x2 - t.x1);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const dx = x - t.x1, dy = y - t.y1, d = Math.hypot(dx, dy);
        if (d > 0.2 && d <= len + 0.35) {
          let diff = Math.abs(Math.atan2(dy, dx) - ang);
          if (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff <= Math.PI / 5) cells.push({ x, y });
        }
      }
      return { cells, radius: len };
    }
    const dx = t.x2 - t.x1, dy = t.y2 - t.y1, steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 2)), seen = new Set();
    for (let i = 0; i <= steps; i++) {
      const px = Math.round(t.x1 + (dx * i) / steps), py = Math.round(t.y1 + (dy * i) / steps);
      if (px >= 0 && px < cols && py >= 0 && py < rows) { const k = `${px},${py}`; if (!seen.has(k)) { seen.add(k); cells.push({ x: px, y: py }); } }
    }
    return { cells, radius: Math.max(1, Math.round(Math.hypot(dx, dy))) };
  }

  function drawMap() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#120a06';
    ctx.fillRect(0, 0, rect.width, rect.height);
    if (!state) return;

    const m = state.map;
    const cp = m.cellPx;
    const mapW = m.cols * cp, mapH = m.rows * cp;
    const segs = buildWallSegments();
    const observers = getPovObservers();

    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.scale, cam.scale);

    // 1. Floor
    if (mapBgImage && mapBgImage.complete) {
      ctx.drawImage(mapBgImage, 0, 0);
    } else {
      ctx.fillStyle = state.scenario === 'colossus' ? '#252b24' : '#2d241c';
      ctx.fillRect(m.offsetX, m.offsetY, mapW, mapH);
      for (let y = 0; y < m.rows; y++) {
        for (let x = 0; x < m.cols; x++) {
          const shade = ((x * 7 + y * 13) % 5) * 3;
          ctx.fillStyle = state.scenario === 'colossus'
            ? `rgb(${38 + shade}, ${44 + shade}, ${36 + shade})`
            : `rgb(${48 + shade}, ${39 + shade}, ${31 + shade})`;
          ctx.fillRect(m.offsetX + x * cp + 1, m.offsetY + y * cp + 1, cp - 2, cp - 2);
        }
      }
    }

    // 2. Difficult Terrain & True Darkness Tiles
    ctx.fillStyle = 'rgba(176, 114, 42, 0.32)';
    for (const k of (m.difficult || [])) {
      const [x, y] = k.split(',').map(Number);
      const px = m.offsetX + x * cp, py = m.offsetY + y * cp;
      ctx.fillRect(px, py, cp, cp);
      ctx.strokeStyle = 'rgba(218, 165, 85, 0.45)';
      ctx.beginPath(); ctx.moveTo(px + 4, py + cp - 6); ctx.lineTo(px + cp - 6, py + 4); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(10, 6, 18, 0.72)';
    for (const k of (m.darkness || [])) {
      const [x, y] = k.split(',').map(Number);
      ctx.fillRect(m.offsetX + x * cp, m.offsetY + y * cp, cp, cp);
    }

    // 3. Light Halos
    if (showLights) {
      for (const lt of (m.lights || [])) {
        const lx = m.offsetX + (lt.x + 0.5) * cp, ly = m.offsetY + (lt.y + 0.5) * cp;
        const g = ctx.createRadialGradient(lx, ly, cp * 0.2, lx, ly, (lt.dim || 6) * cp);
        g.addColorStop(0, 'rgba(255, 195, 95, 0.28)');
        g.addColorStop(0.55, 'rgba(255, 155, 55, 0.11)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(lx, ly, (lt.dim || 6) * cp, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#f5d77f';
        ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // 4. Grid
    if (showGrid) {
      ctx.strokeStyle = 'rgba(251, 240, 203, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= m.cols; x++) { const px = m.offsetX + x * cp; ctx.moveTo(px, m.offsetY); ctx.lineTo(px, m.offsetY + mapH); }
      for (let y = 0; y <= m.rows; y++) { const py = m.offsetY + y * cp; ctx.moveTo(m.offsetX, py); ctx.lineTo(m.offsetX + mapW, py); }
      ctx.stroke();
    }

    // 5. Move range highlight
    const sel = selectedToken();
    if (sel && activeTool === 'select' && dragState && dragState.type === 'token') {
      const eff = R.getConditionEffects(sel.conditions);
      const maxMeters = eff.canMove ? Math.floor((sel.movePool + sel.ap * sel.speed) * eff.speedMult) : 0;
      const footprint = R.tokenFootprint(sel);
      ctx.fillStyle = 'rgba(72, 168, 112, 0.14)';
      for (let y = 0; y < m.rows; y++) for (let x = 0; x < m.cols; x++) {
        if (Math.max(Math.abs(x - sel.x), Math.abs(y - sel.y)) <= maxMeters) ctx.fillRect(m.offsetX + x * cp + 1, m.offsetY + y * cp + 1, cp - 2, cp - 2);
      }
      if (hoverCell) {
        const dist = Math.max(Math.abs(hoverCell.cx - sel.x), Math.abs(hoverCell.cy - sel.y));
        ctx.strokeStyle = dist <= maxMeters ? '#8be08b' : '#ff7b7b';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(m.offsetX + hoverCell.cx * cp, m.offsetY + hoverCell.cy * cp, footprint * cp, footprint * cp);
      }
    }

    // 6. Walls & Portals
    ctx.lineCap = 'round';
    for (const w of (m.walls || [])) {
      ctx.strokeStyle = '#d8c29d'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(m.offsetX + w.x1 * cp, m.offsetY + w.y1 * cp); ctx.lineTo(m.offsetX + w.x2 * cp, m.offsetY + w.y2 * cp); ctx.stroke();
    }
    for (const p of (m.portals || [])) {
      ctx.strokeStyle = p.closed ? '#b8423a' : '#5ca36c'; ctx.lineWidth = 5;
      ctx.setLineDash(p.closed ? [] : [5, 5]);
      ctx.beginPath(); ctx.moveTo(m.offsetX + p.x1 * cp, m.offsetY + p.y1 * cp); ctx.lineTo(m.offsetX + p.x2 * cp, m.offsetY + p.y2 * cp); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 7. Area Template Preview
    if (templatePreview) {
      const { cells } = getTemplateCells(templatePreview);
      ctx.fillStyle = 'rgba(212, 72, 55, 0.34)';
      for (const c of cells) ctx.fillRect(m.offsetX + c.x * cp + 1, m.offsetY + c.y * cp + 1, cp - 2, cp - 2);
    }

    // 8. Tokens (filtered by POV when in Player/Token POV)
    const actTok = activeToken();
    for (const tok of state.tokens) {
      if (!isTokenVisibleInPov(tok, observers, segs)) continue;
      const f = R.tokenFootprint(tok);
      const tx = m.offsetX + tok.x * cp, ty = m.offsetY + tok.y * cp, tw = f * cp;

      ctx.save();
      if (tok.hidden || (tok.conditions || []).some(c => c.name === 'Invisible')) ctx.globalAlpha = 0.48;

      if (actTok && actTok.id === tok.id) {
        ctx.strokeStyle = '#f5d77f'; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(tx + tw / 2, ty + tw / 2, tw / 2 - 1, 0, Math.PI * 2); ctx.stroke();
      }
      if (state.selectedId === tok.id) {
        ctx.strokeStyle = '#d9382e'; ctx.lineWidth = 2;
        ctx.strokeRect(tx + 1, ty + 1, tw - 2, tw - 2);
      }

      ctx.save();
      ctx.beginPath(); ctx.arc(tx + tw / 2, ty + tw / 2, tw / 2 - 4, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = tok.color || '#331d13';
      ctx.fillRect(tx, ty, tw, tw);
      if (tok.sprite) {
        const img = getSprite(tok.sprite);
        if (img && img.complete) { ctx.imageSmoothingEnabled = false; ctx.drawImage(img, tx + 3, ty + 3, tw - 6, tw - 6); }
      } else {
        ctx.fillStyle = '#fbf0cb'; ctx.font = `700 ${Math.max(13, Math.floor(tw * 0.34))}px Cinzel, serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(tok.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase(), tx + tw / 2, ty + tw / 2);
      }
      ctx.restore();

      if (tok.dying.dead || tok.hp <= 0) {
        ctx.fillStyle = 'rgba(120, 15, 15, 0.45)';
        ctx.beginPath(); ctx.arc(tx + tw / 2, ty + tw / 2, tw / 2 - 4, 0, Math.PI * 2); ctx.fill();
      }

      const barW = tw - 6, barX = tx + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(barX, ty + tw - 8, barW, 5);
      ctx.fillStyle = tok.faction === 'party' ? '#4fb36b' : '#d43f37';
      ctx.fillRect(barX, ty + tw - 8, barW * clamp(tok.hp / Math.max(1, tok.maxHp), 0, 1), 5);

      const armorNow = tok.kind === 'monster' ? tok.av : (tok.pa + tok.ma);
      const armorMax = tok.kind === 'monster' ? tok.maxAv : (tok.maxPa + tok.maxMa);
      if (armorMax > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(barX, ty + tw - 13, barW, 3.5);
        ctx.fillStyle = '#7ba6c7'; ctx.fillRect(barX, ty + tw - 13, barW * clamp(armorNow / armorMax, 0, 1), 3.5);
      }

      if (tok.reactionAvailable && !tok.dying.dead) {
        ctx.fillStyle = '#f5d77f'; ctx.beginPath(); ctx.arc(tx + tw - 7, ty + 7, 4, 0, Math.PI * 2); ctx.fill();
      }

      ctx.font = '600 11px Cinzel, serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(16, 8, 4, 0.82)';
      const lbl = tok.hidden ? `${tok.name} [Hidden]` : tok.name;
      const lblW = ctx.measureText(lbl).width + 8;
      ctx.fillRect(tx + tw / 2 - lblW / 2, ty - 14, lblW, 13);
      ctx.fillStyle = '#fbf0cb'; ctx.fillText(lbl, tx + tw / 2, ty - 4);
      ctx.restore();
    }

    // 9. Raycasted Fog of War Mask for Player / Token POV
    if (pov.mode !== 'dm') {
      if (fogCanvas.width !== mapW || fogCanvas.height !== mapH) {
        fogCanvas.width = Math.max(1, mapW);
        fogCanvas.height = Math.max(1, mapH);
      }
      fogCtx.globalCompositeOperation = 'source-over';
      fogCtx.clearRect(0, 0, mapW, mapH);
      fogCtx.fillStyle = 'rgba(7, 4, 2, 0.88)';
      fogCtx.fillRect(0, 0, mapW, mapH);

      fogCtx.globalCompositeOperation = 'destination-out';
      for (const obs of observers) {
        const of = R.tokenFootprint(obs);
        const ox = m.offsetX + (obs.x + of / 2) * cp;
        const oy = m.offsetY + (obs.y + of / 2) * cp;
        const v = obs.vision || 'Normal';
        let maxR = Math.hypot(mapW, mapH);
        if (m.ambient === 'darkness') {
          if (v === 'Normal') maxR = 2.5 * cp;
          else if (v === 'Dark Sight') maxR = 30 * cp;
          else if (v === 'Blind Sight') maxR = 10 * cp;
        }
        const poly = computeVisibilityPolygon(ox, oy, segs, maxR);
        if (poly.length >= 3) {
          fogCtx.fillStyle = 'rgba(0, 0, 0, 1)';
          fogCtx.beginPath();
          fogCtx.moveTo(poly[0][0] - m.offsetX, poly[0][1] - m.offsetY);
          for (let i = 1; i < poly.length; i++) fogCtx.lineTo(poly[i][0] - m.offsetX, poly[i][1] - m.offsetY);
          fogCtx.closePath();
          fogCtx.fill();
        }
        // In Darkness with Normal vision, also carve out lit torches that observer has LOS to
        if (m.ambient === 'darkness' && v === 'Normal') {
          for (const lt of (m.lights || [])) {
            const lx = m.offsetX + (lt.x + 0.5) * cp;
            const ly = m.offsetY + (lt.y + 0.5) * cp;
            if (hasLineOfSight(ox, oy, lx, ly, segs)) {
              const lPoly = computeVisibilityPolygon(lx, ly, segs, (lt.dim || 8) * cp);
              if (lPoly.length >= 3) {
                fogCtx.beginPath();
                fogCtx.moveTo(lPoly[0][0] - m.offsetX, lPoly[0][1] - m.offsetY);
                for (let i = 1; i < lPoly.length; i++) fogCtx.lineTo(lPoly[i][0] - m.offsetX, lPoly[i][1] - m.offsetY);
                fogCtx.closePath();
                fogCtx.fill();
              }
            }
          }
        }
      }
      ctx.drawImage(fogCanvas, m.offsetX, m.offsetY);
    } else if (m.ambient === 'darkness') {
      // Subtle ambient darkness tint in DM view so DM knows darkness is active
      ctx.fillStyle = 'rgba(10, 12, 24, 0.25)';
      ctx.fillRect(m.offsetX, m.offsetY, mapW, mapH);
    }

    // 10. Measure & Calibration
    if (measureLine) {
      const sx = m.offsetX + (measureLine.x1 + 0.5) * cp, sy = m.offsetY + (measureLine.y1 + 0.5) * cp;
      const ex = m.offsetX + (measureLine.x2 + 0.5) * cp, ey = m.offsetY + (measureLine.y2 + 0.5) * cp;
      const distM = Math.max(Math.abs(measureLine.x2 - measureLine.x1), Math.abs(measureLine.y2 - measureLine.y1));
      ctx.strokeStyle = '#f5d77f'; ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#180c07'; ctx.fillRect((sx + ex) / 2 - 22, (sy + ey) / 2 - 11, 44, 20);
      ctx.fillStyle = '#f5d77f'; ctx.font = '700 12px Cinzel, serif'; ctx.textAlign = 'center';
      ctx.fillText(`${distM} m`, (sx + ex) / 2, (sy + ey) / 2 + 4);
    }
    if (calibrateBox) {
      ctx.strokeStyle = '#73e68c'; ctx.lineWidth = 2;
      ctx.strokeRect(calibrateBox.x1, calibrateBox.y1, calibrateBox.x2 - calibrateBox.x1, calibrateBox.y2 - calibrateBox.y1);
    }

    ctx.restore();
  }

  // ---- Canvas Pointer Events
  canvas.addEventListener('pointerdown', e => {
    if (!state) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    const { cx, cy } = worldToCell(w.x, w.y);

    if (e.button === 1 || activeTool === 'pan') {
      dragState = { type: 'pan', startX: sx - cam.x, startY: sy - cam.y };
      canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId); return;
    }

    if (activeTool === 'attack' && targeting) {
      const target = findTokenAtCell(cx, cy, pov.mode !== 'dm');
      if (target && target.id !== targeting.attackerId) {
        const { attackerId, attackIndex } = targeting;
        cancelTargeting();
        launchAttackConfirmation(attackerId, target.id, attackIndex);
      } else toast('Click a valid visible target token on the map.');
      return;
    }

    if (activeTool === 'calibrate') {
      calibrateBox = { x1: w.x, y1: w.y, x2: w.x, y2: w.y };
      dragState = { type: 'calibrate' }; canvas.setPointerCapture(e.pointerId); return;
    }
    if (activeTool.startsWith('template-')) {
      templatePreview = { kind: activeTool, x1: cx, y1: cy, x2: cx, y2: cy };
      dragState = { type: 'template' }; canvas.setPointerCapture(e.pointerId); drawMap(); return;
    }
    if (activeTool === 'measure') {
      measureLine = { x1: cx, y1: cy, x2: cx, y2: cy };
      dragState = { type: 'measure' }; canvas.setPointerCapture(e.pointerId); drawMap(); return;
    }
    if (activeTool === 'wall') {
      const fx = (w.x - state.map.offsetX) / state.map.cellPx - cx;
      const fy = (w.y - state.map.offsetY) / state.map.cellPx - cy;
      let seg;
      if (Math.min(fx, 1 - fx) < Math.min(fy, 1 - fy)) { const ex = fx < 0.5 ? cx : cx + 1; seg = { x1: ex, y1: cy, x2: ex, y2: cy + 1 }; }
      else { const ey = fy < 0.5 ? cy : cy + 1; seg = { x1: cx, y1: ey, x2: cx + 1, y2: ey }; }
      apiPost('/api/map/wall', seg).then(applyServerEnvelope);
      return;
    }
    if (activeTool === 'terrain') { apiPost('/api/map/terrain', { cx, cy }).then(applyServerEnvelope); return; }
    if (activeTool === 'light') { runPost('/api/map/light', { x: cx, y: cy }); return; }
    if (activeTool === 'darkness') { apiPost('/api/map/darkness', { cx, cy }).then(applyServerEnvelope); return; }

    const hit = findTokenAtCell(cx, cy, pov.mode !== 'dm');
    if (hit) {
      apiPost('/api/select', { tokenId: hit.id }).then(applyServerEnvelope);
      dragState = { type: 'token', tokenId: hit.id, fromX: hit.x, fromY: hit.y, freeMove: isGmMode() && e.shiftKey };
      canvas.setPointerCapture(e.pointerId);
    } else {
      const pIdx = (state.map.portals || []).findIndex(p => Math.hypot((p.x1 + p.x2) / 2 - (cx + 0.5), (p.y1 + p.y2) / 2 - (cy + 0.5)) < 1.0);
      if (pIdx >= 0) { runPost('/api/map/portal', { index: pIdx }); return; }
      dragState = { type: 'pan', startX: sx - cam.x, startY: sy - cam.y };
      canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener('pointermove', e => {
    if (!state) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(sx, sy);
    const { cx, cy } = worldToCell(w.x, w.y);
    hoverCell = { cx, cy };
    if (!dragState) return;
    if (dragState.type === 'pan') { cam.x = sx - dragState.startX; cam.y = sy - dragState.startY; drawMap(); }
    else if (dragState.type === 'measure' && measureLine) { measureLine.x2 = cx; measureLine.y2 = cy; drawMap(); }
    else if (dragState.type === 'template' && templatePreview) { templatePreview.x2 = cx; templatePreview.y2 = cy; drawMap(); }
    else if (dragState.type === 'calibrate' && calibrateBox) { calibrateBox.x2 = w.x; calibrateBox.y2 = w.y; drawMap(); }
    else if (dragState.type === 'token') drawMap();
  });

  canvas.addEventListener('pointerup', e => {
    if (!dragState) return;
    const ds = dragState;
    dragState = null; canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    if (ds.type === 'calibrate' && calibrateBox) {
      const sizePx = Math.max(16, Math.round(Math.max(Math.abs(calibrateBox.x2 - calibrateBox.x1), Math.abs(calibrateBox.y2 - calibrateBox.y1))));
      const ox = Math.round(Math.min(calibrateBox.x1, calibrateBox.x2) % sizePx);
      const oy = Math.round(Math.min(calibrateBox.y1, calibrateBox.y2) % sizePx);
      calibrateBox = null; activeTool = 'select'; updateToolButtons();
      const cols = mapBgImage ? Math.max(4, Math.floor((mapBgImage.width - ox) / sizePx)) : state.map.cols;
      const rows = mapBgImage ? Math.max(4, Math.floor((mapBgImage.height - oy) / sizePx)) : state.map.rows;
      runPost('/api/map/image', { imageDataUrl: state.map.imageDataUrl, cols, rows, cellPx: sizePx, offsetX: ox, offsetY: oy });
      return;
    }
    if (ds.type === 'template' && templatePreview) {
      const tp = templatePreview; templatePreview = null;
      const { cells, radius } = getTemplateCells(tp);
      const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
      const hitTokens = state.tokens.filter(t => {
        const f = R.tokenFootprint(t);
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) if (cellSet.has(`${t.x + dx},${t.y + dy}`)) return true;
        return false;
      });
      drawMap();
      runAreaTemplateConfirm(hitTokens, tp.kind.replace('template-', ''), radius);
      return;
    }
    if (ds.type === 'measure') { setTimeout(() => { measureLine = null; drawMap(); }, 1800); return; }
    if (ds.type === 'token' && hoverCell) {
      if (hoverCell.cx === ds.fromX && hoverCell.cy === ds.fromY) { drawMap(); return; }
      const tok = getToken(ds.tokenId);
      const toX = hoverCell.cx, toY = hoverCell.cy;
      if (!ds.freeMove && state?.combatActive && tok && !canActNormally(tok, 'allowMove') && !useReactionMode) {
        maybePromptOffTurnAction(tok, 'allowMove', `move to (${toX}, ${toY})`, async asReaction => {
          await runPost('/api/move', { tokenId: ds.tokenId, toX, toY, freeMove: false, asReaction, gmOverride: false });
          if (asReaction) useReactionMode = false;
        });
        drawMap();
        return;
      }
      const asReaction = !ds.freeMove && state?.combatActive && !canActNormally(tok, 'allowMove') && useReactionMode;
      runPost('/api/move', { tokenId: ds.tokenId, toX, toY, freeMove: ds.freeMove, asReaction, gmOverride: ds.freeMove }).then(() => {
        if (asReaction) useReactionMode = false;
      });
    }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const next = clamp(cam.scale * factor, 0.3, 3.0);
    cam.x = sx - (sx - cam.x) * (next / cam.scale);
    cam.y = sy - (sy - cam.y) * (next / cam.scale);
    cam.scale = next;
    $('#zoom-readout').textContent = `${Math.round(cam.scale * 100)}%`;
    drawMap();
  }, { passive: false });

  // ---- UI Rendering
  function updateToolButtons() {
    $$('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === activeTool)));
    const aoeBtn = $('#btn-aoe-menu');
    const editBtn = $('#btn-edit-menu');
    if (aoeBtn) aoeBtn.setAttribute('aria-pressed', String(activeTool.startsWith('template-')));
    if (editBtn) editBtn.setAttribute('aria-pressed', String(['wall', 'terrain', 'light', 'darkness'].includes(activeTool)));
    canvas.className = 'map-canvas' + (activeTool !== 'select' ? ` tool-${activeTool.split('-')[0]}` : '');
  }

  function renderInitiativeAndBudget() {
    const budget = state.budget || { partyBudget: 0, spent: 0, band: 'Empty' };
    const pct = budget.partyBudget > 0 ? clamp((budget.spent / (budget.partyBudget * 2)) * 100, 0, 100) : 0;
    const cls = budget.band === 'Deadly' ? 'deadly' : budget.band === 'Hard' ? 'hard' : '';
    $('#encounter-budget').innerHTML = `
      <div class="row-between"><span><strong>Budget:</strong> ${budget.spent} / ${budget.partyBudget}</span><span class="pill ${budget.band === 'Deadly' ? 'crimson' : 'gold'}">${esc(budget.band)}</span></div>
      <div class="budget-track"><span class="budget-fill ${cls}" style="width:${pct}%"></span></div>`;

    const inCombat = !!state.combatActive;
    const gm = isGmMode();
    const statusPill = $('#combat-status-pill');
    if (statusPill) {
      statusPill.textContent = inCombat ? 'Combat Active' : 'Exploration';
      statusPill.className = `pill ${inCombat ? 'crimson' : ''}`;
    }
    const toggleBtn = $('#btn-toggle-combat');
    if (toggleBtn) {
      toggleBtn.textContent = inCombat ? 'End Combat' : 'Start Combat';
      toggleBtn.setAttribute('aria-pressed', String(inCombat));
      toggleBtn.disabled = !gm;
      toggleBtn.title = gm ? 'GM: Toggle combat & initiative lock' : 'GM only (switch to DM View)';
    }
    if ($('#btn-next-turn')) $('#btn-next-turn').disabled = !inCombat || !gm;
    if ($('#btn-roll-init')) $('#btn-roll-init').disabled = !inCombat || !gm;

    const sec = inCombat ? (state.round - 1) * 12 : 0;
    const mm = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
    $('#round-clock').textContent = inCombat ? `Round ${state.round} · ${mm}:${ss}` : 'Out of Combat';

    const observers = getPovObservers();
    const segs = pov.mode === 'dm' ? [] : buildWallSegments();

    const listEntries = inCombat
      ? state.initiative.map((slot, idx) => ({ t: getToken(slot.tokenId), slot, idx }))
      : state.tokens.map((t, idx) => ({ t, slot: { tokenId: t.id, roll: '—', slot: 1 }, idx }));

    $('#init-list').innerHTML = listEntries.map(({ t, slot, idx }) => {
      if (!t) return '';
      if (pov.mode !== 'dm' && !isTokenVisibleInPov(t, observers, segs)) return '';
      const isAct = inCombat && idx === state.turnIndex;
      const isSel = t.id === state.selectedId;
      const conds = t.conditions.slice(0, 2).map(c => `<span class="pill crimson">${esc(c.name)}</span>`).join('');
      const p = t.permissions || {};
      const permBadges = [
        p.allowMove ? '<span class="pill">Move✓</span>' : '',
        p.allowRoll ? '<span class="pill">Roll✓</span>' : '',
        p.allowActions ? '<span class="pill">Act✓</span>' : '',
        p.extraReactions > 0 ? `<span class="pill gold">+${p.extraReactions}R</span>` : ''
      ].join('');
      return `
        <li class="init-card${isAct ? ' active' : ''}${isSel ? ' selected' : ''}${t.dying.dead ? ' dead' : ''}" data-select-token="${esc(t.id)}">
          <div class="init-avatar ${t.faction}">${t.sprite ? `<img src="${esc(t.sprite)}" alt="">` : esc(t.name.slice(0, 2).toUpperCase())}</div>
          <div class="init-meta">
            <div class="init-name">${esc(t.name)}${t.hidden ? ' <span class="pill">Hidden</span>' : ''}${inCombat && t.maxTurns > 1 ? ` <span class="pill gold">T${slot.slot}/${t.maxTurns}</span>` : ''}</div>
            <div class="init-sub">
              <span>HP ${t.hp}/${t.maxHp}</span><span>AC ${t.ac}</span>
              ${t.kind === 'monster' ? `<span>AV ${t.av}</span>` : `<span>PA ${t.pa} · MA ${t.ma}</span>`}
              ${permBadges}${conds}
            </div>
          </div>
          <div class="init-roll">${slot.roll}</div>
        </li>`;
    }).join('');
  }

  function renderActionDock() {
    const dock = $('#action-dock');
    const showDock = $('#chk-panel-dock')?.checked !== false;
    dock.hidden = !showDock;
    if (!showDock) return;

    const tok = activeToken();
    const sel = selectedToken();
    dock.classList.toggle('minimized', dockMinimized);

    if (dockMinimized) {
      const chipLabel = state.combatActive && tok
        ? `${esc(tok.name)} · ${tok.ap}/${tok.maxAp} AP`
        : (sel ? `Actions · ${esc(sel.name)}` : 'Actions');
      dock.innerHTML = `<button type="button" class="glass-chip" id="btn-toggle-dock-min" title="Expand actions">${chipLabel} <span class="tri" aria-hidden="true">▴</span></button>`;
      return;
    }

    if (!state.combatActive) {
      dock.innerHTML = `
        <span class="pill">Exploration Mode</span>
        <span class="muted" style="color:#d9c8a5">${sel ? `Selected: <b style="color:#fbf0cb">${esc(sel.name)}</b>` : 'Drag tokens & roll freely'}</span>
        ${isGmMode() ? '<button type="button" class="btn btn-crimson btn-xs" id="btn-dock-start-combat">Start Combat</button>' : ''}
        <button type="button" class="chip-close" id="btn-toggle-dock-min" title="Minimize dock" aria-label="Minimize action dock">▾</button>`;
      return;
    }

    if (!tok) {
      dock.innerHTML = '<span class="muted">No active combatant</span><button type="button" class="chip-close" id="btn-toggle-dock-min" title="Minimize dock" aria-label="Minimize action dock">▾</button>';
      return;
    }
    const pips = [];
    for (let i = 0; i < tok.maxAp; i++) pips.push(`<span class="ap-pip${i < tok.ap ? ' on' : ''}"></span>`);
    const isKd = tok.conditions.some(c => c.name === 'Knocked Down');
    const offTurnSel = sel && sel.id !== tok.id;
    const reactTarget = offTurnSel ? sel : tok;
    const reactLeft = (reactTarget.reactionAvailable ? 1 : 0) + (reactTarget.permissions?.extraReactions || 0);
    dock.innerHTML = `
      <div class="ap-pips" title="Action Points">${pips.join('')} <span class="mono" style="margin-left:4px">${tok.ap}/${tok.maxAp} AP</span></div>
      <span class="pill gold">Move: ${tok.movePool}m</span>
      <button type="button" class="btn btn-dark btn-xs" data-act="spend-move">Move (+1 AP)</button>
      <button type="button" class="btn btn-crimson btn-xs" data-act="quick-attack">Attack (3 AP)</button>
      <button type="button" class="btn btn-dark btn-xs" data-act="help">Help (2 AP)</button>
      ${isKd ? `<button type="button" class="btn btn-dark btn-xs" data-act="stand-up">Stand Up (1 AP)</button>` : ''}
      ${offTurnSel ? `<span class="pill crimson">${esc(sel.name)} Off-Turn (${reactLeft} React)</span>` : ''}
      <button type="button" class="btn btn-dark btn-xs" id="btn-toggle-react-mode" aria-pressed="${useReactionMode}" title="Next move, roll, or attack off-turn spends 1 Reaction">${useReactionMode ? 'React Mode: ON' : `Use Reaction (${reactLeft})`}</button>
      <button type="button" class="chip-close" id="btn-toggle-dock-min" title="Minimize dock" aria-label="Minimize action dock">▾</button>`;
  }

  function renderSheetDrawer() {
    const box = $('#drawer-sheet');
    const tok = selectedToken();
    if (!tok) { box.innerHTML = '<p class="muted">Select a token on the map or initiative list.</p>'; return; }

    const cFx = R.getConditionEffects(tok.conditions);
    const isMonster = tok.kind === 'monster';
    const isDying = tok.conditions.some(c => c.name === 'Dying');

    const headerCard = `
      <div class="card">
        <div class="row-between">
          <div>
            <h3>${esc(tok.name)}</h3>
            <div class="muted">${esc(tok.size)} · ${esc(tok.alignment)} · ${isMonster ? `TR ${tok.tr} (${esc(tok.tier)})` : `Level ${tok.level}`}</div>
          </div>
          <div class="row">
            <span class="pill gold">AC ${tok.ac + cFx.acDelta}</span>
            <span class="pill">${tok.speed}m</span>
          </div>
        </div>
        <div class="row-between">
          <button type="button" class="btn btn-xs" id="btn-view-token-pov" aria-pressed="${pov.mode === 'token' && pov.tokenId === tok.id}">Preview Token POV</button>
          <button type="button" class="btn btn-xs" id="btn-toggle-token-hidden" aria-pressed="${!!tok.hidden}">${tok.hidden ? 'Hidden (DM Only)' : 'Visible to Players'}</button>
        </div>
        <div class="sheet-subtabs" role="tablist" aria-label="Token sheet sections">
          ${[
            ['combat', 'Combat'],
            ['stats', 'Stats'],
            ['magic', 'Abilities'],
            ['conditions', `Conds (${tok.conditions.length})`]
          ].map(([key, label]) => {
            const open = activeSheetTab === key && sheetSectionOpen;
            return `<button type="button" role="tab" class="sheet-subtab" data-sheet-tab="${key}" aria-selected="${open}">${label} <span class="tri" aria-hidden="true">${open ? '▴' : '▾'}</span></button>`;
          }).join('')}
        </div>
      </div>`;

    let bodyCard = '';
    if (!sheetSectionOpen) {
      box.innerHTML = headerCard;
      return;
    }
    if (activeSheetTab === 'combat') {
      const p = tok.permissions || { allowMove: false, allowRoll: false, allowActions: false, extraReactions: 0 };
      const onTurn = isTokensTurn(tok);
      const reactLeft = (tok.reactionAvailable ? 1 : 0) + (p.extraReactions || 0);
      const combatCard = state.combatActive ? `
        <div class="card">
          <div class="row-between">
            <h3>${isGmMode() ? 'GM Turn &amp; Off-Turn Grants' : 'Turn &amp; Reaction Status'}</h3>
            <span class="pill ${onTurn ? 'gold' : 'crimson'}">${onTurn ? 'On Turn' : 'Off-Turn'} · ${reactLeft} React</span>
          </div>
          ${isGmMode() ? `
            <div class="perm-grid">
              <button type="button" class="perm-pill" data-perm="allowMove" aria-pressed="${!!p.allowMove}">Allow Move</button>
              <button type="button" class="perm-pill" data-perm="allowRoll" aria-pressed="${!!p.allowRoll}">Allow Roll</button>
              <button type="button" class="perm-pill" data-perm="allowActions" aria-pressed="${!!p.allowActions}">Allow Actions</button>
            </div>
            <div class="row-between">
              <div class="row">
                <span class="muted">Extra Reactions:</span>
                <button type="button" class="btn btn-xs" data-extra-react="-1">−</button>
                <strong class="mono">${p.extraReactions || 0}</strong>
                <button type="button" class="btn btn-xs" data-extra-react="1">+</button>
              </div>
              <div class="row">
                <button type="button" class="btn btn-xs" id="btn-refresh-react"${tok.reactionAvailable ? ' disabled' : ''}>Refresh React</button>
                <button type="button" class="btn btn-xs" id="btn-clear-perms">Clear</button>
              </div>
            </div>` : `
            <div class="row-between">
              <span class="muted">Grants: ${[p.allowMove ? 'Move' : '', p.allowRoll ? 'Roll' : '', p.allowActions ? 'Actions' : '', p.extraReactions > 0 ? `+${p.extraReactions} React` : ''].filter(Boolean).join(', ') || 'None (Reaction only off-turn)'}</span>
              ${!onTurn ? `<button type="button" class="btn btn-xs" id="btn-toggle-react-mode" aria-pressed="${useReactionMode}">${useReactionMode ? 'React Mode: ON' : 'Use Reaction'}</button>` : ''}
            </div>`}
        </div>` : '';

      bodyCard = `${combatCard}
        <div class="card">
          <div class="vitals-grid">
            <div class="vital-box">
              <div class="vital-head"><span>Health</span><span>${tok.hp} / ${tok.maxHp}</span></div>
              <div class="vital-val"><button type="button" class="btn btn-xs" data-vital="hp:-5">−5</button><span>${tok.hp}</span><button type="button" class="btn btn-xs" data-vital="hp:+5">+5</button></div>
              <div class="vital-bar"><span style="width:${clamp((tok.hp / Math.max(1, tok.maxHp)) * 100, 0, 100)}%"></span></div>
            </div>
            ${isMonster ? `
            <div class="vital-box pa">
              <div class="vital-head"><span>Armor Value</span><span>${tok.av} / ${tok.maxAv}</span></div>
              <div class="vital-val"><button type="button" class="btn btn-xs" data-vital="av:-5">−5</button><span>${tok.av}</span><button type="button" class="btn btn-xs" data-vital="av:+5">+5</button></div>
              <div class="vital-bar"><span style="width:${clamp((tok.av / Math.max(1, tok.maxAv)) * 100, 0, 100)}%"></span></div>
            </div>` : `
            <div class="vital-box pa">
              <div class="vital-head"><span>Physical Armor</span><span>${tok.pa} / ${tok.maxPa}</span></div>
              <div class="vital-val"><button type="button" class="btn btn-xs" data-vital="pa:-5">−5</button><span>${tok.pa}</span><button type="button" class="btn btn-xs" data-vital="pa:+5">+5</button></div>
              <div class="vital-bar"><span style="width:${clamp((tok.pa / Math.max(1, tok.maxPa)) * 100, 0, 100)}%"></span></div>
            </div>
            <div class="vital-box ma">
              <div class="vital-head"><span>Magical Armor</span><span>${tok.ma} / ${tok.maxMa}</span></div>
              <div class="vital-val"><button type="button" class="btn btn-xs" data-vital="ma:-5">−5</button><span>${tok.ma}</span><button type="button" class="btn btn-xs" data-vital="ma:+5">+5</button></div>
              <div class="vital-bar"><span style="width:${clamp((tok.ma / Math.max(1, tok.maxMa)) * 100, 0, 100)}%"></span></div>
            </div>`}
            ${tok.maxMana > 0 ? `<div class="vital-box mana"><div class="vital-head"><span>Mana</span><span>${tok.mana} / ${tok.maxMana}</span></div><div class="vital-val"><button type="button" class="btn btn-xs" data-vital="mana:-5">−5</button><span>${tok.mana}</span><button type="button" class="btn btn-xs" data-vital="mana:+5">+5</button></div><div class="vital-bar"><span style="width:${clamp((tok.mana / Math.max(1, tok.maxMana)) * 100, 0, 100)}%"></span></div></div>` : ''}
            ${tok.maxStamina > 0 ? `<div class="vital-box sta"><div class="vital-head"><span>Stamina</span><span>${tok.stamina} / ${tok.maxStamina}</span></div><div class="vital-val"><button type="button" class="btn btn-xs" data-vital="sta:-5">−5</button><span>${tok.stamina}</span><button type="button" class="btn btn-xs" data-vital="sta:+5">+5</button></div><div class="vital-bar"><span style="width:${clamp((tok.stamina / Math.max(1, tok.maxStamina)) * 100, 0, 100)}%"></span></div></div>` : ''}
          </div>
          <div class="row">
            <input type="number" id="quick-dmg-amt" class="vtt-input" value="8" min="0" style="width:62px">
            <select id="quick-dmg-type" class="vtt-input" style="flex:1">${D.damageTypes.physical.concat(D.damageTypes.magical, D.damageTypes.alignment).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select>
            <button type="button" class="btn btn-crimson btn-xs" id="btn-apply-dmg">Dmg</button>
            <button type="button" class="btn btn-xs" id="btn-apply-heal">Heal</button>
          </div>
          ${isDying ? `<div class="confirm-box" style="border-color:var(--ink-crimson)"><strong>Dying!</strong> Fails: ${tok.dying.fails}/3 · Rounds: ${tok.dying.rounds}/5 ${tok.dying.dead ? '· <b>DEAD</b>' : ''}<div class="row" style="margin-top:4px"><button type="button" class="btn btn-crimson btn-xs" id="btn-death-save">Death Save</button><button type="button" class="btn btn-xs" id="btn-stabilize">Stabilize (DC ${Math.max(0, -tok.hp)})</button></div></div>` : ''}
        </div>
        <div class="card">
          <h3>Attacks</h3>
          ${(tok.attacks || []).map((a, i) => `
            <div class="attack-row">
              <div class="attack-top"><strong>${esc(a.name)} (${a.ap || 3} AP)</strong><button type="button" class="btn btn-crimson btn-xs" data-start-attack="${i}">Target &amp; Attack</button></div>
              <div class="attack-sub">1d20${sign(a.atkMod)} · ${esc(a.dice)}${a.flat ? sign(a.flat) : ''} ${esc(a.dmgType)} · Range ${a.range || 1} m</div>
            </div>`).join('')}
          ${(tok.actions || []).map(a => `<div class="attack-row"><div class="attack-top"><strong>${esc(a.name)} (${a.ap} AP${a.oncePerRound ? ', 1/rd' : ''})</strong></div><div class="attack-sub">${esc(a.text)}</div></div>`).join('')}
        </div>`;
    } else if (activeSheetTab === 'stats') {
      bodyCard = `
        <div class="card">
          <h3>Saves &amp; Statistics (Click to Roll)</h3>
          <div class="stats-strip">
            <button type="button" class="stat-mini" data-roll-check="Evasion:${tok.saves.evasion}"><b>Evasion</b><span>${sign(tok.saves.evasion)}</span></button>
            <button type="button" class="stat-mini" data-roll-check="Resistance (Body):${tok.saves.body}"><b>Body Save</b><span>${sign(tok.saves.body)}</span></button>
            <button type="button" class="stat-mini" data-roll-check="Resistance (Mind):${tok.saves.mind}"><b>Mind Save</b><span>${sign(tok.saves.mind)}</span></button>
            ${['str', 'fin', 'fort', 'int', 'wits', 'cha'].map(k => `<button type="button" class="stat-mini" data-roll-check="${k.toUpperCase()}:${tok.stats[k].mod}"><b>${k.toUpperCase()}</b><span>${tok.stats[k].score} (${sign(tok.stats[k].mod)})</span></button>`).join('')}
          </div>
          <div class="muted">Vision: <b>${esc(tok.vision)}</b> · Crit Chance: <b>≤ ${tok.critChance}</b></div>
          ${Object.keys(tok.resistances || {}).length ? `<div class="muted">Resistances: ${Object.entries(tok.resistances).map(([k, v]) => `${k} ${v}`).join(', ')}</div>` : ''}
          ${(tok.vulnerabilities || []).length ? `<div class="muted">Vulnerable: ${esc(tok.vulnerabilities.join(', '))}</div>` : ''}
          ${(tok.immunities || []).length ? `<div class="muted">Immunities: ${esc(tok.immunities.join(', '))}</div>` : ''}
        </div>`;
    } else if (activeSheetTab === 'magic') {
      bodyCard = `
        <div class="card">
          <h3>Spells, Maneuvers &amp; Abilities</h3>
          ${(tok.spells || []).map((sp, i) => `<div class="attack-row"><div class="attack-top"><strong>${esc(sp.name)} (${esc(sp.tier)})</strong><button type="button" class="btn btn-xs" data-cast-spell="${i}">Cast</button></div><div class="attack-sub">${esc(sp.school)} · ${esc(sp.notes)}</div></div>`).join('')}
          ${(tok.maneuvers || []).map((mn, i) => `<div class="attack-row"><div class="attack-top"><strong>${esc(mn.name)} (${esc(mn.tier)})</strong><button type="button" class="btn btn-xs" data-use-maneuver="${i}">Use</button></div><div class="attack-sub">${esc(mn.notes)}</div></div>`).join('')}
          ${(tok.abilities || []).map(ab => `<div class="attack-row"><strong>${esc(ab.name)}${ab.isReaction ? ' (Reaction)' : ''}</strong><div class="attack-sub">${esc(ab.text)}</div></div>`).join('')}
          ${isMonster && tok.tier === 'solo' ? `
            <h4 style="margin-top:4px">Solo Boss Controls</h4>
            <div class="row">
              <button type="button" class="btn btn-xs" id="btn-solo-shake">Shake It Off</button>
              <button type="button" class="btn btn-xs" id="btn-solo-unbreakable" ${tok.unbreakableUsedThisRound ? 'disabled' : ''}>Unbreakable Will</button>
              <button type="button" class="btn btn-crimson btn-xs" id="btn-solo-phase">Second Phase</button>
            </div>` : ''}
          ${!tok.spells?.length && !tok.maneuvers?.length && !tok.abilities?.length ? '<p class="muted">No spells or special abilities.</p>' : ''}
        </div>`;
    } else {
      bodyCard = `
        <div class="card">
          <div class="row-between">
            <h3>Conditions (${tok.conditions.length})</h3>
            <select id="add-cond-select" class="vtt-input" style="width:155px" aria-label="Apply condition">
              <option value="">+ Add condition…</option>
              ${conditionsCatalog.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="cond-chips">
            ${tok.conditions.map(c => `<button type="button" class="cond-chip on" data-remove-cond="${esc(c.name)}" title="Click to remove">${esc(c.name)}${c.stacks > 1 ? ` ×${c.stacks}` : ''} ×</button>`).join('') || '<span class="muted">None active</span>'}
          </div>
          ${cFx.gmChips.map(ch => `<div class="muted"><b>${esc(ch.name)}:</b> ${esc(ch.note)}</div>`).join('')}
          <div class="row" style="margin-top:6px">
            <button type="button" class="btn btn-crimson btn-xs" id="btn-remove-token">Remove Token from Map</button>
          </div>
        </div>`;
    }

    box.innerHTML = headerCard + bodyCard;
  }

  async function updateMonsterList() {
    const q = encodeURIComponent($('#mon-search')?.value || '');
    const tier = encodeURIComponent($('#mon-tier')?.value || '');
    const maxTr = $('#mon-tr-max')?.value || '';
    const url = `/api/monsters?q=${q}&tier=${tier}${maxTr ? `&max_tr=${encodeURIComponent(maxTr)}` : ''}`;
    try {
      const list = await apiGet(url);
      const listEl = $('#mon-results');
      if (!listEl) return;
      listEl.innerHTML = list.map(m => `
        <div class="monster-item">
          ${m.sprite ? `<img src="${esc(m.sprite)}" alt="" loading="lazy" width="40" height="40">` : '<div style="width:40px;height:40px;background:#24140d;border-radius:4px"></div>'}
          <div class="monster-item-info"><strong>${esc(m.name)}</strong><small>TR ${m.tr} ${esc(m.tier)} · ${esc(m.size)} · HP ${m.hp} · AC ${m.ac}</small></div>
          <button type="button" class="btn btn-crimson btn-xs" data-drop-monster="${esc(m.id)}">Drop</button>
        </div>`).join('') || '<p class="muted">No monsters match that filter.</p>';
    } catch {}
  }

  function renderMonstersDrawer() {
    const box = $('#drawer-monsters');
    if (!box.dataset.init) {
      box.dataset.init = '1';
      box.innerHTML = `
        <search class="card">
          <input type="search" id="mon-search" class="vtt-input" placeholder="Search 249 monsters by name or type…" aria-label="Search monsters">
          <div class="row">
            <select id="mon-tier" class="vtt-input" style="flex:1" aria-label="Filter tier">
              <option value="">All Tiers</option><option value="minion">Minion (½×TR)</option><option value="elite">Elite (1×TR)</option><option value="solo">Solo (2×TR)</option>
            </select>
            <input type="number" id="mon-tr-max" class="vtt-input" placeholder="Max TR" min="1" max="30" style="width:82px" aria-label="Maximum Threat Rating">
          </div>
        </search>
        <div id="mon-results" class="monster-list"></div>`;
      $('#mon-search').addEventListener('input', updateMonsterList);
      $('#mon-tier').addEventListener('change', updateMonsterList);
      $('#mon-tr-max').addEventListener('input', updateMonsterList);
    }
    updateMonsterList();
  }

  function syncChatSenderOptions() {
    const sel = $('#chat-sender');
    if (!sel || !state) return;
    const prev = sel.value;
    const party = state.tokens.filter(t => t.faction === 'party');
    const selected = selectedToken();
    const extraSel = selected && !party.some(t => t.id === selected.id) && pov.mode !== 'player' ? [selected] : [];
    const opts = [
      ...(pov.mode === 'dm' ? [{ value: 'host:Host (GM)', label: 'Host (GM)' }] : []),
      ...party.map(t => ({ value: `player:${t.name}`, label: `${t.name} (Player)` })),
      ...extraSel.map(t => ({ value: `player:${t.name}`, label: `${t.name}` })),
      { value: 'player:Player', label: 'Player (Table)' },
      ...(pov.mode !== 'dm' ? [{ value: 'host:Host (GM)', label: 'Host (GM)' }] : [])
    ];
    sel.innerHTML = opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    if (chatSenderManual && opts.some(o => o.value === prev)) {
      sel.value = prev;
    } else if (pov.mode === 'token' && getToken(pov.tokenId)) {
      sel.value = `player:${getToken(pov.tokenId).name}`;
    } else if (pov.mode === 'player' && party.length) {
      const pick = selected && selected.faction === 'party' ? selected : party[0];
      sel.value = `player:${pick.name}`;
    } else if (pov.mode === 'dm') {
      sel.value = 'host:Host (GM)';
    }
  }

  function renderLogDrawer() {
    const box = $('#drawer-log');
    if (!box.dataset.init) {
      box.dataset.init = '1';
      box.innerHTML = `
        <div class="card">
          <h3>Table Chat</h3>
          <div class="row-between">
            <span class="muted">Speaker</span>
            <select id="chat-sender" class="vtt-input" style="flex:1" aria-label="Chat speaker"></select>
          </div>
          <form id="chat-form" class="chat-form">
            <input type="text" id="chat-input" class="vtt-input" maxlength="500" placeholder="Type message to table…" aria-label="Chat message" autocomplete="off">
            <button type="submit" class="btn btn-crimson btn-xs">Send</button>
          </form>
        </div>
        <div class="card">
          <h3>Quick Dice Roller</h3>
          <div class="row">${['dis', 'normal', 'adv'].map(m => `<button type="button" class="btn btn-xs" data-roll-mode="${m}" aria-pressed="${rollMode === m}">${m === 'dis' ? 'Disadvantage' : m === 'adv' ? 'Advantage' : 'Normal'}</button>`).join('')}</div>
          <div class="row">${[4, 6, 8, 10, 12, 20, 100].map(s => `<button type="button" class="btn btn-xs" data-quick-die="${s}">d${s}</button>`).join('')}</div>
        </div>
        <div class="card">
          <div class="row-between">
            <h3>Rolls &amp; Chat Log</h3>
            <div class="row" style="gap:3px">
              <button type="button" class="btn btn-xs" data-log-filter="all" aria-pressed="true">All</button>
              <button type="button" class="btn btn-xs" data-log-filter="chat" aria-pressed="false">Chat</button>
              <button type="button" class="btn btn-xs" data-log-filter="rolls" aria-pressed="false">Rolls</button>
            </div>
          </div>
          <ul id="log-feed" class="log-list"></ul>
        </div>`;

      $('#chat-sender').addEventListener('change', () => { chatSenderManual = true; });
      $('#chat-form').addEventListener('submit', async e => {
        e.preventDefault();
        const inp = $('#chat-input');
        const message = inp.value.trim();
        if (!message) return;
        const [role, ...rest] = ($('#chat-sender').value || 'player:Player').split(':');
        const sender = rest.join(':') || 'Player';
        inp.value = '';
        await runPost('/api/chat', { sender, role, message });
      });
    }

    syncChatSenderOptions();
    $$('[data-roll-mode]', box).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rollMode === rollMode)));
    $$('[data-log-filter]', box).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.logFilter === logFilter)));

    const entries = (state.log || []).filter(entry => {
      const isChat = entry.kind === 'chat-host' || entry.kind === 'chat-player';
      if (logFilter === 'chat') return isChat;
      if (logFilter === 'rolls') return !isChat;
      return true;
    });

    $('#log-feed').innerHTML = entries.map(entry => {
      if (entry.kind === 'chat-host' || entry.kind === 'chat-player') {
        const isHost = entry.kind === 'chat-host';
        return `<li class="log-entry ${esc(entry.kind)}">
          <div class="log-head-row">
            <strong>${esc(entry.title)}</strong>
            <span class="pill ${isHost ? 'gold' : ''}">${isHost ? 'Host' : 'Player'}</span>
          </div>
          <span class="chat-msg-text">${esc(entry.detail)}</span>
        </li>`;
      }
      return `<li class="log-entry ${esc(entry.kind)}"><strong>${esc(entry.title)}</strong><small>${esc(entry.detail)}</small></li>`;
    }).join('') || '<li class="muted">No entries match this filter.</li>';
  }

  function updateHudBars() {
    $('#hud-tools').hidden = !hudToolsOpen;
    $('#btn-reopen-tools').hidden = hudToolsOpen;
    $('#hud-view').hidden = !hudViewOpen;
    $('#btn-reopen-view').hidden = hudViewOpen;
    const povTag = pov.mode === 'dm' ? 'DM' : pov.mode === 'player' ? 'Players' : (getToken(pov.tokenId)?.name?.split(' ')[0] || 'Token');
    $('#reopen-view-label').textContent = `${povTag} · ${Math.round(cam.scale * 100)}%`;
  }

  function selectDrawer(name) {
    activeDrawer = name;
    if ($('#vtt-shell').classList.contains('hide-right')) togglePanel('right', true);
    $$('[data-drawer]').forEach(b => {
      const sel = b.dataset.drawer === activeDrawer;
      b.setAttribute('aria-selected', String(sel));
      const tri = b.querySelector('.tri');
      if (tri) tri.textContent = sel ? '▸' : '◂';
    });
    $('#drawer-sheet').hidden = activeDrawer !== 'sheet';
    $('#drawer-monsters').hidden = activeDrawer !== 'monsters';
    $('#drawer-log').hidden = activeDrawer !== 'log';
    renderAll();
  }

  function renderAll() {
    if (!state) return;
    $('#hdr-subtitle').textContent = `Rust Engine · ${state.map.title} (${state.map.ambient === 'darkness' ? 'Darkness' : 'Bright'})`;
    $('#btn-undo').disabled = !state.canUndo;
    $('#btn-redo').disabled = !state.canRedo;
    $('#btn-ambient-bright').setAttribute('aria-pressed', String(state.map.ambient !== 'darkness'));
    $('#btn-ambient-dark').setAttribute('aria-pressed', String(state.map.ambient === 'darkness'));
    updatePovUi();
    updateHudBars();
    renderInitiativeAndBudget();
    renderActionDock();
    if (activeDrawer === 'sheet') renderSheetDrawer();
    else if (activeDrawer === 'monsters') renderMonstersDrawer();
    else renderLogDrawer();
  }

  function togglePanel(side, show) {
    const shell = $('#vtt-shell');
    if (side === 'left') {
      shell.classList.toggle('hide-left', !show);
      $('#btn-toggle-left').setAttribute('aria-pressed', String(show));
      $('#chk-panel-left').checked = show;
    } else {
      shell.classList.toggle('hide-right', !show);
      $('#btn-toggle-right').setAttribute('aria-pressed', String(show));
      $('#chk-panel-right').checked = show;
    }
    setTimeout(resizeCanvas, 20);
  }

  // ---- Delegated Click & Change Handlers
  document.addEventListener('click', e => {
    if (e.target.closest('#btn-collapse-left')) { togglePanel('left', false); return; }
    if (e.target.closest('#btn-reopen-left')) { togglePanel('left', true); return; }
    if (e.target.closest('#btn-collapse-right')) { togglePanel('right', false); return; }
    if (e.target.closest('#btn-collapse-tools')) { hudToolsOpen = false; updateHudBars(); return; }
    if (e.target.closest('#btn-reopen-tools')) { hudToolsOpen = true; updateHudBars(); return; }
    if (e.target.closest('#btn-collapse-view')) { hudViewOpen = false; updateHudBars(); return; }
    if (e.target.closest('#btn-reopen-view')) { hudViewOpen = true; updateHudBars(); return; }

    const openDrawerChip = e.target.closest('[data-open-drawer]');
    if (openDrawerChip) { selectDrawer(openDrawerChip.dataset.openDrawer); return; }

    const toolBtn = e.target.closest('[data-tool]');
    if (toolBtn) { cancelTargeting(); activeTool = toolBtn.dataset.tool; updateToolButtons(); closeMenus(); return; }

    const povBtn = e.target.closest('[data-pov-mode]');
    if (povBtn) { setPov(povBtn.dataset.povMode, null); closeMenus(); return; }

    const sheetTab = e.target.closest('[data-sheet-tab]');
    if (sheetTab) {
      const k = sheetTab.dataset.sheetTab;
      if (activeSheetTab === k) sheetSectionOpen = !sheetSectionOpen;
      else { activeSheetTab = k; sheetSectionOpen = true; }
      renderSheetDrawer();
      return;
    }

    const tabBtn = e.target.closest('[data-drawer]');
    if (tabBtn) {
      if (tabBtn.dataset.drawer === activeDrawer && !$('#vtt-shell').classList.contains('hide-right')) {
        togglePanel('right', false);
      } else {
        selectDrawer(tabBtn.dataset.drawer);
      }
      return;
    }

    const selTok = e.target.closest('[data-select-token]');
    if (selTok) { apiPost('/api/select', { tokenId: selTok.dataset.selectToken }).then(applyServerEnvelope); return; }

    const vitalBtn = e.target.closest('[data-vital]');
    if (vitalBtn) {
      const tok = selectedToken(); if (!tok) return;
      const [key, deltaStr] = vitalBtn.dataset.vital.split(':');
      runPost('/api/vital', { tokenId: tok.id, key, delta: parseInt(deltaStr, 10) });
      return;
    }

    const atkBtn = e.target.closest('[data-start-attack]');
    if (atkBtn) {
      const tok = selectedToken();
      const idx = parseInt(atkBtn.dataset.startAttack, 10);
      const atk = tok?.attacks?.[idx];
      if (tok && atk) startAttackTargeting(tok.id, idx, atk.name);
      return;
    }

    const rollChk = e.target.closest('[data-roll-check]');
    if (rollChk) {
      const [name, modStr] = rollChk.dataset.rollCheck.split(':');
      const tok = selectedToken();
      maybePromptOffTurnAction(tok, 'allowRoll', `roll ${name}`, async asReaction => {
        await runPost('/api/dice', {
          sides: 20, mode: rollMode, label: `${tok?.name || 'Check'} — ${name}`,
          mod_val: parseInt(modStr, 10) || 0, tokenId: tok?.id || null, asReaction, gmOverride: false
        });
        if (asReaction) useReactionMode = false;
      });
      return;
    }

    const permBtn = e.target.closest('[data-perm]');
    if (permBtn && isGmMode()) {
      const tok = selectedToken(); if (!tok) return;
      const p = { allowMove: false, allowRoll: false, allowActions: false, extraReactions: 0, ...(tok.permissions || {}) };
      const k = permBtn.dataset.perm;
      p[k] = !p[k];
      runPost('/api/token/permissions', { tokenId: tok.id, ...p, refreshReaction: false });
      return;
    }

    const extraReactBtn = e.target.closest('[data-extra-react]');
    if (extraReactBtn && isGmMode()) {
      const tok = selectedToken(); if (!tok) return;
      const p = { allowMove: false, allowRoll: false, allowActions: false, extraReactions: 0, ...(tok.permissions || {}) };
      p.extraReactions = Math.max(0, (p.extraReactions || 0) + parseInt(extraReactBtn.dataset.extraReact, 10));
      runPost('/api/token/permissions', { tokenId: tok.id, ...p, refreshReaction: false });
      return;
    }

    if (e.target.id === 'btn-refresh-react' && isGmMode()) {
      const tok = selectedToken(); if (!tok) return;
      const p = { allowMove: false, allowRoll: false, allowActions: false, extraReactions: 0, ...(tok.permissions || {}) };
      runPost('/api/token/permissions', { tokenId: tok.id, ...p, refreshReaction: true });
      return;
    }
    if (e.target.id === 'btn-clear-perms' && isGmMode()) {
      const tok = selectedToken(); if (!tok) return;
      runPost('/api/token/permissions', { tokenId: tok.id, allowMove: false, allowRoll: false, allowActions: false, extraReactions: 0, refreshReaction: false });
      return;
    }

    const rmCond = e.target.closest('[data-remove-cond]');
    if (rmCond) {
      const tok = selectedToken(); if (!tok) return;
      runPost('/api/condition/remove', { tokenId: tok.id, condition: rmCond.dataset.removeCond });
      return;
    }

    const dropBtn = e.target.closest('[data-drop-monster]');
    if (dropBtn) { runPost('/api/monster/drop', { monsterId: dropBtn.dataset.dropMonster }); return; }

    const castBtn = e.target.closest('[data-cast-spell]');
    if (castBtn) {
      const tok = selectedToken(); if (!tok) return;
      const idx = parseInt(castBtn.dataset.castSpell, 10);
      maybePromptOffTurnAction(tok, 'allowActions', `cast ${tok.spells?.[idx]?.name || 'spell'}`, async asReaction => {
        await runPost('/api/action/spend', { tokenId: tok.id, action: 'cast-spell', index: idx, asReaction, gmOverride: false });
        if (asReaction) useReactionMode = false;
      });
      return;
    }

    const manBtn = e.target.closest('[data-use-maneuver]');
    if (manBtn) {
      const tok = selectedToken(); if (!tok) return;
      const idx = parseInt(manBtn.dataset.useManeuver, 10);
      maybePromptOffTurnAction(tok, 'allowActions', `use ${tok.maneuvers?.[idx]?.name || 'maneuver'}`, async asReaction => {
        await runPost('/api/action/spend', { tokenId: tok.id, action: 'use-maneuver', index: idx, asReaction, gmOverride: false });
        if (asReaction) useReactionMode = false;
      });
      return;
    }

    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const tok = activeToken(); if (!tok) return;
      const act = actBtn.dataset.act;
      if (act === 'quick-attack') { const first = tok.attacks?.[0]; if (first) startAttackTargeting(tok.id, 0, first.name); }
      else runPost('/api/action/spend', { tokenId: tok.id, action: act, asReaction: false, gmOverride: false });
      return;
    }

    const modeBtn = e.target.closest('[data-roll-mode]');
    if (modeBtn) { rollMode = modeBtn.dataset.rollMode; renderLogDrawer(); return; }

    const filterBtn = e.target.closest('[data-log-filter]');
    if (filterBtn) { logFilter = filterBtn.dataset.logFilter; renderLogDrawer(); return; }

    const dieBtn = e.target.closest('[data-quick-die]');
    if (dieBtn) {
      const sides = parseInt(dieBtn.dataset.quickDie, 10);
      const tok = selectedToken();
      if (state?.combatActive && tok && !canActNormally(tok, 'allowRoll')) {
        maybePromptOffTurnAction(tok, 'allowRoll', `roll d${sides}`, async asReaction => {
          await runPost('/api/dice', { sides, mode: rollMode, tokenId: tok.id, asReaction, gmOverride: false });
          if (asReaction) useReactionMode = false;
        });
      } else {
        runPost('/api/dice', { sides, mode: rollMode, tokenId: tok?.id || null, asReaction: false, gmOverride: isGmMode() && !state?.combatActive });
      }
      return;
    }

    if (e.target.id === 'btn-toggle-react-mode') {
      useReactionMode = !useReactionMode;
      renderActionDock();
      renderSheetDrawer();
      return;
    }
    if (e.target.id === 'btn-dock-start-combat' && isGmMode()) {
      runPost('/api/combat/toggle', { active: true });
      return;
    }

    if (e.target.id === 'btn-apply-dmg' || e.target.id === 'btn-apply-heal') {
      const tok = selectedToken(); if (!tok) return;
      runPost(e.target.id === 'btn-apply-dmg' ? '/api/damage' : '/api/heal', {
        tokenId: tok.id, amount: parseInt($('#quick-dmg-amt').value, 10) || 0, dmgType: $('#quick-dmg-type').value
      });
      return;
    }

    if (['btn-death-save', 'btn-stabilize', 'btn-solo-shake', 'btn-solo-unbreakable', 'btn-solo-phase'].includes(e.target.id)) {
      const tok = selectedToken(); if (!tok) return;
      const map = { 'btn-death-save': 'death-save', 'btn-stabilize': 'stabilize', 'btn-solo-shake': 'solo-shake', 'btn-solo-unbreakable': 'solo-unbreakable', 'btn-solo-phase': 'solo-phase' };
      runPost('/api/action/spend', { tokenId: tok.id, action: map[e.target.id] });
      return;
    }

    if (e.target.id === 'btn-remove-token') { const tok = selectedToken(); if (tok) runPost('/api/token/remove', { tokenId: tok.id }); return; }
    if (e.target.id === 'btn-view-token-pov') {
      const tok = selectedToken(); if (!tok) return;
      if (pov.mode === 'token' && pov.tokenId === tok.id) setPov('dm', null);
      else setPov('token', tok.id);
      return;
    }
    if (e.target.id === 'btn-toggle-token-hidden') {
      const tok = selectedToken(); if (!tok) return;
      runPost('/api/token/hidden', { tokenId: tok.id, hidden: !tok.hidden });
      return;
    }
    if (e.target.closest('#btn-toggle-dock-min')) {
      dockMinimized = !dockMinimized;
      renderActionDock();
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'add-cond-select' && e.target.value) {
      const tok = selectedToken(), condition = e.target.value; e.target.value = '';
      if (tok) runPost('/api/condition/add', { tokenId: tok.id, condition });
    }
    if (e.target.id === 'pov-token-select' && e.target.value) {
      setPov('token', e.target.value);
      closeMenus();
    }
    if (e.target.id === 'chk-panel-left') togglePanel('left', e.target.checked);
    if (e.target.id === 'chk-panel-right') togglePanel('right', e.target.checked);
    if (e.target.id === 'chk-panel-dock') renderActionDock();
    if (e.target.id === 'chk-show-grid') { showGrid = e.target.checked; drawMap(); }
    if (e.target.id === 'chk-show-lights') { showLights = e.target.checked; drawMap(); }
  });

  // ---- Static Header & Menu Bindings
  $('#btn-toggle-left').addEventListener('click', () => togglePanel('left', $('#vtt-shell').classList.contains('hide-left')));
  $('#btn-toggle-right').addEventListener('click', () => togglePanel('right', $('#vtt-shell').classList.contains('hide-right')));
  $('#btn-return-dm').addEventListener('click', () => setPov('dm', null));
  $('#btn-undo').addEventListener('click', () => runPost('/api/undo'));
  $('#btn-redo').addEventListener('click', () => runPost('/api/redo'));
  $('#btn-toggle-combat').addEventListener('click', () => {
    if (!isGmMode()) { toast('Only the GM (DM View) can start or end combat.', 'dmg'); return; }
    useReactionMode = false;
    runPost('/api/combat/toggle', { active: !state?.combatActive });
  });
  $('#btn-next-turn').addEventListener('click', () => { useReactionMode = false; runPost('/api/turn/next'); });
  $('#btn-roll-init').addEventListener('click', () => { useReactionMode = false; runPost('/api/initiative/roll'); });
  $('#btn-reset-scenario').addEventListener('click', async () => {
    closeMenus();
    await runPost('/api/scenario', { kind: $('#scenario-select').value });
    fitMapToView();
  });

  $('#btn-ambient-bright').addEventListener('click', () => { closeMenus(); runPost('/api/map/ambient', { ambient: 'bright' }); });
  $('#btn-ambient-dark').addEventListener('click', () => { closeMenus(); runPost('/api/map/ambient', { ambient: 'darkness' }); });
  $('#btn-calibrate-from-menu').addEventListener('click', () => {
    closeMenus(); activeTool = 'calibrate'; updateToolButtons();
    toast('Drag a 1×1 square over one grid tile on the map image to calibrate 1 meter.');
  });

  $('#btn-zoom-in').addEventListener('click', () => { cam.scale = clamp(cam.scale * 1.2, 0.3, 3.0); $('#zoom-readout').textContent = `${Math.round(cam.scale * 100)}%`; updateHudBars(); drawMap(); });
  $('#btn-zoom-out').addEventListener('click', () => { cam.scale = clamp(cam.scale * 0.82, 0.3, 3.0); $('#zoom-readout').textContent = `${Math.round(cam.scale * 100)}%`; updateHudBars(); drawMap(); });
  $('#btn-zoom-fit').addEventListener('click', fitMapToView);

  $('#btn-map-import').addEventListener('click', () => { closeMenus(); $('#dlg-map').showModal(); });
  $('#btn-rest-menu').addEventListener('click', () => { closeMenus(); $('#dlg-rest').showModal(); });
  $('#btn-rules-ref').addEventListener('click', () => $('#dlg-rules').showModal());

  $('#btn-do-partial-rest').addEventListener('click', () => { runPost('/api/rest', { kind: 'partial' }); $('#dlg-rest').close(); });
  $('#btn-do-full-rest').addEventListener('click', () => { runPost('/api/rest', { kind: 'full' }); $('#dlg-rest').close(); });

  $('#in-map-img').addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result, img = new Image();
      img.onload = () => {
        const cols = parseInt($('#in-map-cols').value, 10) || 24, rows = parseInt($('#in-map-rows').value, 10) || 18;
        runPost('/api/map/image', { imageDataUrl: dataUrl, cols, rows, cellPx: Math.max(16, Math.round(img.width / cols)), offsetX: 0, offsetY: 0 });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

  $('#in-map-dd2vtt').addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try { await runPost('/api/map/dd2vtt', { name: file.name, data: JSON.parse(reader.result) }); $('#dlg-map').close(); }
      catch (err) { toast(`Could not parse .dd2vtt/.uvtt: ${esc(err.message)}`, 'dmg'); }
    };
    reader.readAsText(file);
  });

  $('#btn-calibrate-grid').addEventListener('click', () => {
    $('#dlg-map').close(); activeTool = 'calibrate'; updateToolButtons();
    toast('Drag a 1×1 square over one grid tile on the map image to calibrate 1 meter.');
  });
  $('#btn-clear-map-img').addEventListener('click', () => {
    runPost('/api/map/image', { imageDataUrl: null, cols: 24, rows: 18, cellPx: 48, offsetX: 0, offsetY: 0 });
    $('#dlg-map').close();
  });

  $('#btn-export-state').addEventListener('click', () => {
    closeMenus();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `sparks-vtt-${state.scenario || 'encounter'}.json`; a.click();
  });
  $('#btn-import-state').addEventListener('click', () => { closeMenus(); $('#file-import-state').click(); });
  $('#file-import-state').addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { runPost('/api/import/state', JSON.parse(reader.result)); }
      catch (err) { toast(`Load failed: ${esc(err.message)}`, 'dmg'); }
    };
    reader.readAsText(file);
  });

  $('#btn-char-import').addEventListener('click', () => { closeMenus(); $('#file-import-char').click(); });
  $('#file-import-char').addEventListener('change', e => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        const charObj = raw.chars ? raw.chars[raw.active || raw.order?.[0]] : raw;
        if (!charObj || !charObj.stats) throw new Error('Expected Sparks Character Sheet JSON');
        const d = R.compute(charObj);
        const attacks = (d.weapon || []).filter(Boolean).map(w => {
          const dm = String(w.data.die).match(/^(\d*d\d+)/i), fm = String(w.data.die).match(/^\d+$/);
          return {
            name: w.title, ap: w.tempo ? 2 : 3, isSpell: false, atkMod: w.atk.total,
            dice: dm ? dm[1] : '0', flat: w.dmg.total + (fm ? parseInt(fm[0], 10) : 0),
            dmgType: w.data.type, extra: w.extra || [], range: w.range || 1, ranged: w.ranged,
            reach: w.reach || 0, deadly: w.deadly.total, enchanted: w.ench.total, vorpal: w.vorpal,
            decisiveMult: w.decisive.total, traits: w.data.traits || [], magicBonus: 0, magicTraits: [], note: ''
          };
        });
        const tok = {
          id: 'pc_imp', kind: 'pc', faction: 'party', name: charObj.name || 'Imported Hero',
          baseName: charObj.name || 'Imported Hero', tier: '', tr: 0, size: d.size.name,
          type: 'Humanoid', alignment: charObj.alignment || 'True Neutral', level: d.level,
          x: 2, y: Math.floor(state.map.rows / 2),
          hp: charObj.cur?.hp ?? d.hp.total, maxHp: d.hp.total, pa: charObj.cur?.pa ?? d.pa.total, maxPa: d.pa.total,
          ma: charObj.cur?.ma ?? d.ma.total, maxMa: d.ma.total, ta: charObj.cur?.ta ?? d.ta.total, maxTa: d.ta.total,
          av: 0, maxAv: 0, mana: charObj.cur?.mana ?? d.mana.total, maxMana: d.mana.total,
          stamina: charObj.cur?.stamina ?? d.stamina.total, maxStamina: d.stamina.total,
          ac: d.ac.total, speed: d.walk, critChance: d.crit.total, initMod: d.init.total, initiative: 0,
          vision: charObj.race === 'Elf' || charObj.race === 'Dwarf' ? 'Dark Sight' : 'Normal',
          saves: { evasion: d.save.evasion.total, body: d.save.body.total, mind: d.save.mind.total },
          stats: Object.fromEntries(['str', 'fin', 'fort', 'int', 'wits', 'cha'].map(k => [k, { score: d.stat[k].score, mod: d.stat[k].mod }])),
          resistances: d.resist, immunities: d.immune, vulnerabilities: d.vuln,
          conditions: [], dying: { fails: 0, rounds: 0, dead: false },
          ap: 6, maxAp: 6, apOwed: 0, movePool: 0, reactionAvailable: true, maxTurns: 1,
          secondPhaseTriggered: false, unbreakableUsedThisRound: false, hidden: false,
          permissions: { allowMove: false, allowRoll: false, allowActions: false, extraReactions: 0 },
          race: charObj.race || '',
          color: '#4e3d80', sprite: null, maxReach: Math.max(0, ...attacks.map(a => a.reach)),
          attacks, actions: [], abilities: [],
          spells: (charObj.spells || []).map(s => ({ name: s.name, school: s.school || '', tier: s.tier || 'Minor', notes: s.notes || '' })),
          maneuvers: (charObj.maneuvers || []).map(m => ({ name: m.name, school: 'Martial', tier: m.tier || 'Basic', notes: m.notes || '' }))
        };
        runPost('/api/import/token', { token: tok });
      } catch (err) { toast(`PC import failed: ${esc(err.message)}`, 'dmg'); }
    };
    reader.readAsText(file);
  });

  // ---- Boot
  (async function boot() {
    const [initState, conds] = await Promise.all([apiGet('/api/state'), apiGet('/api/conditions')]);
    state = initState;
    conditionsCatalog = conds;
    $('#scenario-select').value = state.scenario || 'chapel';
    syncBgImage();
    resizeCanvas();
    fitMapToView();
    renderAll();

    // Sync state & chat across Host / Player tabs without disrupting focused inputs
    setInterval(async () => {
      if (dragState || document.querySelector('dialog[open]')) return;
      try {
        const fresh = await apiGet('/api/state');
        if (!state || JSON.stringify(fresh.log) !== JSON.stringify(state.log) ||
            fresh.turnIndex !== state.turnIndex || fresh.combatActive !== state.combatActive ||
            fresh.tokens.length !== state.tokens.length || fresh.round !== state.round) {
          state = fresh;
          renderAll();
          drawMap();
        }
      } catch {}
    }, 2500);
  })();
})();
