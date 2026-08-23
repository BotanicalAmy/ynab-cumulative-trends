// ==UserScript==
// @name         YNAB Cumulative Trends
// @namespace    https://github.com/BotanicalAmy/ynab-cumulative-trends
// @version      1.1.0
// @description  Adds cumulative (running-total) line charts, Income vs. Spend and Spending Trends by group, above YNAB's monthly Spending Trends
// @author       Amy Folkestad
// @match        https://app.ynab.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      api.ynab.com
// @updateURL    https://raw.githubusercontent.com/BotanicalAmy/ynab-cumulative-trends/main/CumulativeTrends.user.js
// @downloadURL  https://raw.githubusercontent.com/BotanicalAmy/ynab-cumulative-trends/main/CumulativeTrends.user.js
// @homepageURL  https://github.com/BotanicalAmy/ynab-cumulative-trends
// @supportURL   https://github.com/BotanicalAmy/ynab-cumulative-trends/issues
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    // The script starts with no default Spending Trends groups selected.
    // Users can pick their own defaults from the chart header, and those choices are saved per budget in Tampermonkey local storage.
    DEFAULT_CATEGORY_TRENDS_GROUPS: [],

    // These groups are internal YNAB bookkeeping, not real spending. Keep them out of the picker and all category-based spending totals.
    SYSTEM_GROUPS: ['Internal Master Category', 'Credit Card Payments'],

    // Optional fallback CSS selector for YNAB's native chart card. Leave null to use the automatic heading-based search.
    NATIVE_CHART_SELECTOR: null,

    // Only activate these custom charts on the spending trends page
    PAGE_PATH_MATCH: /\/reflect\/spending-trends/,
  };

  const API_BASE = 'https://api.ynab.com/v1';
  const DEFAULT_GROUPS_STORAGE_PREFIX = 'ynab_cumulative_default_groups_';
  const log = (...args) => console.log('[YNAB Cumulative]', ...args);
  const warn = (...args) => console.warn('[YNAB Cumulative]', ...args);

  // Match the YNAB budget UUID expression from the URL path.
  const BUDGET_PATH = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

  // Read the active YNAB budget id from the current URL so the script can fetch data for the correct budget without asking the user to enter it.
  function getBudgetIdFromUrl() {
    const match = location.pathname.match(BUDGET_PATH);
    return match ? match[1] : null;
  }

  // ---------- local browser token storage (never save in this file) ----------
  const TOKEN_KEY = 'ynab_cumulative_pat';

  function getStoredToken() {
    return GM_getValue(TOKEN_KEY, null);
  }

  // Show the API/token prompt only when no token is stored or a token was cleared.
  function promptForToken() {
    const entered = window.prompt(
      'Paste your YNAB Personal Access Token (YNAB → Account Settings → Developer Settings → New Token).\n\n' +
      'It will be stored locally via Tampermonkey (GM_setValue), never written into this script file.'
    );
    if (entered && entered.trim()) {
      const token = entered.trim();
      GM_setValue(TOKEN_KEY, token);
      log('Token saved.');
      return token;
    }
    return null;
  }

  // Return the stored API token or prompt once when no token exists.
  function getOrPromptToken() {
    const stored = getStoredToken();
    if (stored) return stored;
    return promptForToken();
  }

  function clearToken() {
    GM_deleteValue(TOKEN_KEY);
  }

  // Store the default Spending Trends groups in Tampermonkey local storage so the user saves their preferences 
  // Saved per unique budget ID to handle users with multiple budgets
  function getDefaultGroupsKey(budgetId) {
    return `${DEFAULT_GROUPS_STORAGE_PREFIX}${budgetId}`;
  }

  function getSavedDefaultGroups(budgetId) {
    const stored = GM_getValue(getDefaultGroupsKey(budgetId), null);
    if (!Array.isArray(stored)) return null;
    return stored.filter((name) => typeof name === 'string' && name.trim().length > 0);
  }

  function saveDefaultGroups(budgetId, groupNames) {
    const cleaned = Array.from(new Set((groupNames || []).filter(Boolean)));
    GM_setValue(getDefaultGroupsKey(budgetId), cleaned);
    return cleaned;
  }

  function clearSavedDefaultGroups(budgetId) {
    GM_deleteValue(getDefaultGroupsKey(budgetId));
  }

  function getDefaultCategoryNames(categoryTree, budgetId) {
    const saved = getSavedDefaultGroups(budgetId);
    if (saved !== null) {
      const valid = saved.filter((name) => categoryTree.some((g) => g.name === name));
      return valid;
    }
    return [];
  }

  function idsForGroupNames(categoryTree, groupNames) {
    const selected = new Set();
    categoryTree.forEach((group) => {
      if ((groupNames || []).includes(group.name)) {
        group.categories.forEach((cat) => selected.add(cat.id));
      }
    });
    return selected;
  }

  // Expose a simple Tampermonkey menu action so the user can replace an expired or rejected YNAB token without editing this file.
  GM_registerMenuCommand('Reset YNAB API Token', () => {
    clearToken();
    log('Token cleared. Reloading so you can enter a new one…');
    location.reload();
  });

  // Wrapper around the YNAB API that adds the stored bearer token and handles
  // the common 401 case by clearing the stale token before surfacing the error.
  function apiGet(path) {
    return new Promise((resolve, reject) => {
      const token = getStoredToken();
      GM_xmlhttpRequest({
        method: 'GET',
        url: API_BASE + path,
        headers: { Authorization: 'Bearer ' + token },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            resolve(JSON.parse(res.responseText).data);
          } else if (res.status === 401) {
            // Clear rejected tokens so the next visit prompts again.
            clearToken();
            reject(new Error(`YNAB API 401 on ${path} — token was rejected and has been cleared. Reload the page to enter a new one.`));
          } else {
            reject(new Error(`YNAB API ${res.status} on ${path}: ${res.responseText}`));
          }
        },
        onerror: () => reject(new Error('Network error calling ' + path)),
      });
    });
  }

  // Fetch the current budget snapshot and reorganize the data to match what is used by the charts: 
  // a category tree for selectors and month-level totals for cumulative calculations, then sum cumulative values across months
  async function fetchYearData(budgetId, reportYear) {
    // One budget request includes each month's per-category activity.
    const budgetData = await apiGet(`/budgets/${encodeURIComponent(budgetId)}`);
    const budget = budgetData.budget;

    // This endpoint returns bare category groups. Categories are in the separate flat `categories[]` array and point back to their group ID.
    const groupNameById = {};
    budget.category_groups.forEach((g) => { groupNameById[g.id] = g.name; });
    const catMeta = {};
    budget.categories.forEach((c) => {
      catMeta[c.id] = { name: c.name, group: groupNameById[c.category_group_id] || '' };
    });

    // Build the same category tree YNAB shows, excluding system groups.
    const categoryTree = budget.category_groups
      .filter((g) => !g.deleted && !CONFIG.SYSTEM_GROUPS.includes(g.name))
      .map((g) => ({
        id: g.id,
        name: g.name,
        categories: budget.categories
          .filter((c) => c.category_group_id === g.id && !c.deleted)
          .map((c) => ({ id: c.id, name: c.name, hidden: c.hidden })),
      }))
      .filter((g) => g.categories.length > 0);

    const now = new Date();
    const availableYears = Array.from(new Set(
      budget.months.filter((m) => !m.deleted).map((m) => Number(m.month.slice(0, 4)))
    )).sort((a, b) => b - a);
    const resolvedYear = availableYears.includes(reportYear) ? reportYear : (availableYears[0] || reportYear);
    const isCurrentYear = resolvedYear === now.getFullYear();
    const lastMonthIdx = isCurrentYear ? now.getMonth() : 11;

    // Parse month strings as text so local time zones cannot shift the date.
    const months = budget.months
      .filter((m) => {
        if (m.deleted) return false;
        const [y, mo] = m.month.split('-').map(Number);
        return y === resolvedYear && mo - 1 <= lastMonthIdx;
      })
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({
        month: m.month,
        year: Number(m.month.slice(0, 4)),
        monthIndex: Number(m.month.slice(5, 7)) - 1,
        // Store spending in dollars. Refunds remain negative and system categories are excluded because they are not in the picker tree.
        categories: (m.categories || [])
          .filter((c) => catMeta[c.id])
          .map((c) => ({ id: c.id, spend: -(c.activity / 1000) })),
        // Use YNAB's month-level income total rather than matching a name.
        income: m.income / 1000,
      }));

    return { catMeta, months, categoryTree, availableYears, reportYear: resolvedYear };
  }

  // A flat list of leaf category ids used to seed the default selection for the
  // Income vs. Spend chart and to support "select all" behavior in the picker.
  function allLeafIds(categoryTree) {
    const ids = [];
    categoryTree.forEach((g) => g.categories.forEach((c) => ids.push(c.id)));
    return ids;
  }

  // Build the active Spending Trends group list from the selected leaf ids. 
  // Each group becomes a separate series in the cumulative chart.
  function getActiveGroups(categoryTree, selectedSet) {
    return categoryTree.filter((g) => g.categories.some((c) => selectedSet.has(c.id))).map((g) => g.name);
  }

  // Convert the raw month data into the values needed by the two cumulative charts:
  // total spend for the Income vs. Spend view and grouped spend totals for the Spending Trends view.
  function computeSummary(months, spendSet, categoryTrendsSet, catMeta, categoryTree) {
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const activeGroups = getActiveGroups(categoryTree, categoryTrendsSet);
    return months.map((m) => {
      let totalSpend = 0;
      const categoryTrends = {};
      activeGroups.forEach((g) => (categoryTrends[g] = 0));

      m.categories.forEach((c) => {
        if (spendSet.has(c.id)) totalSpend += c.spend;
        if (categoryTrendsSet.has(c.id)) {
          const meta = catMeta[c.id];
          if (meta && Object.prototype.hasOwnProperty.call(categoryTrends, meta.group)) {
            categoryTrends[meta.group] += c.spend;
          }
        }
      });

      const monthIdx = parseInt(m.month.split('-')[1], 10) - 1;
      return { m: MONTH_NAMES[monthIdx], monthIndex: monthIdx, income: m.income, totalSpend, ...categoryTrends };
    });
  }

  // ---------- charting (plain SVG) ----------
  // The app renders the cumulative charts manually with an SVG chart library so it can stay lightweight and match YNAB's styling
  const ns = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function createButton({ className, text, type = 'button' }) {
    const button = document.createElement('button');
    button.type = type;
    button.className = className;
    if (text !== undefined && text !== null) button.textContent = text;
    return button;
  }
  function createCheckboxRow({ labelText, checked, rowClassName, onToggle, hiddenText = null }) {
    const row = document.createElement('label');
    row.className = rowClassName;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => onToggle(checkbox.checked));
    const label = document.createElement('span');
    label.textContent = labelText;
    row.appendChild(checkbox);
    row.appendChild(label);
    if (hiddenText) {
      const tag = document.createElement('span');
      tag.className = 'yct-picker-hidden-tag';
      tag.textContent = hiddenText;
      row.appendChild(tag);
    }
    return row;
  }
  function bindOutsideClick(scope, panel, closePanel) {
    const outsideClickHandler = (event) => {
      if (panel.style.display !== 'none' && !scope.contains(event.target)) {
        closePanel();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 0);
    return outsideClickHandler;
  }
  function fmt(n) {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  }

  const ALL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Shared "nice round number" y-axis scaling, used by every chart so grid lines land on sensible values ($5k, $10k, $25k, ...), not weird decimals 
  function computeNiceAxis(dataMax, fallbackStep) {
    const axisBase = dataMax > 0 ? dataMax * 1.12 : Math.max(fallbackStep, 1);
    const roughStep = axisBase / 6;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const normalizedStep = roughStep / magnitude;
    const niceFactor = normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10;
    const axisStep = niceFactor * magnitude;
    const axisMax = Math.ceil(axisBase / axisStep) * axisStep;
    return { axisStep, axisMax };
  }

  // Fill the remaining calendar months with average pace when enabled (projected values for future months)
  function padToFullYear(actualRows, seriesKeys, allowProjection) {
    const avg = {};
    seriesKeys.forEach((k) => {
      avg[k] = actualRows.length ? actualRows.reduce((s, r) => s + (r[k] || 0), 0) / actualRows.length : 0;
    });
    const full = actualRows.map((r) => ({ ...r, projected: false }));
    if (!allowProjection) return { full, avg };
    const lastActualMonthIndex = actualRows.length ? actualRows[actualRows.length - 1].monthIndex : -1;
    for (let i = lastActualMonthIndex + 1; i < 12; i++) {
      const rec = { m: ALL_MONTH_NAMES[i], monthIndex: i, projected: true };
      seriesKeys.forEach((k) => (rec[k] = avg[k]));
      full.push(rec);
    }
    return { full, avg };
  }

  function drawCumulativeChart(mountEl, actualRows, seriesDefs, gridStep, titleText, makeStats, headerRightEl, makeTooltipExtras, allowProjection = true, emptyMessage = null) {
    const runKeys = seriesDefs.map((s) => s.key);
    const { full, avg } = padToFullYear(actualRows, runKeys, allowProjection);
    const projectionState = {
      hasProjection: allowProjection && actualRows.length > 0 && actualRows.length < 12,
      lastActualIdx: Math.max(actualRows.length - 1, 0),
    };

    let running = {};
    runKeys.forEach((k) => (running[k] = 0));
    const data = full.map((row) => {
      const rec = { m: row.m, monthIndex: row.monthIndex, projected: row.projected };
      runKeys.forEach((k) => {
        running[k] += row[k] || 0;
        rec[k] = running[k];
      });
      return rec;
    });

    const n = data.length;
    const W = 780, H = 300;
    const padL = 50, padR = 76, padTop = 32, padBottom = 26;
    const plotW = W - padL - padR, plotH = H - padTop - padBottom;
    const xStep = n > 1 ? plotW / (n - 1) : 0;
    const xAt = (i) => padL + xStep * i;

    let dataMax = 0;
    data.forEach((d) => runKeys.forEach((k) => { if (d[k] > dataMax) dataMax = d[k]; }));
    const { axisStep, axisMax } = computeNiceAxis(dataMax, gridStep);
    const yAt = (v) => padTop + plotH - (v / axisMax) * plotH;

    function formatAxisValue(value) {
      if (value >= 1000) {
        const thousands = value / 1000;
        return '$' + thousands.toFixed(Number.isInteger(thousands) ? 0 : 1) + 'k';
      }
      return '$' + Math.round(value).toLocaleString('en-US');
    }

    function renderLegend() {
      const legend = document.createElement('div');
      legend.className = 'yct-legend';
      seriesDefs.forEach((s) => {
        const item = document.createElement('span');
        item.className = 'yct-legend-item';
        const swatchShape = s.marker === 'diamond' ? 'yct-swatch-diamond' : 'yct-swatch-circle';
        const lineSwatch = document.createElement('span');
        lineSwatch.className = 'yct-line-swatch';
        lineSwatch.style.background = s.color;
        const dotSwatch = document.createElement('span');
        dotSwatch.className = `yct-swatch ${swatchShape}`;
        dotSwatch.style.background = s.color;
        item.append(lineSwatch, dotSwatch, s.label);
        legend.appendChild(item);
      });
      if (projectionState.hasProjection) {
        const proj = document.createElement('span');
        proj.className = 'yct-legend-item';
        const projSwatch = document.createElement('span');
        projSwatch.className = 'yct-line-swatch yct-line-dashed';
        proj.append(projSwatch, 'Projected pace');
        legend.appendChild(proj);
      }
      return legend;
    }

    function renderGrid(svg) {
      for (let v = 0; v <= axisMax; v += axisStep) {
        const y = yAt(v);
        svg.appendChild(el('line', { class: 'yct-grid', x1: padL, x2: W - padR, y1: y, y2: y }));
        const lbl = el('text', { class: 'yct-axis', x: padL - 7, y: y + 3, 'text-anchor': 'end' });
        lbl.textContent = formatAxisValue(v);
        svg.appendChild(lbl);
      }

      if (!projectionState.hasProjection) return;
      const dx = (xAt(projectionState.lastActualIdx) + xAt(projectionState.lastActualIdx + 1)) / 2;
      svg.appendChild(el('line', { class: 'yct-divider', x1: dx, x2: dx, y1: padTop, y2: padTop + plotH }));
      const t1 = el('text', { class: 'yct-zone', x: padL, y: padTop - 10 });
      t1.textContent = 'ACTUAL';
      svg.appendChild(t1);
      const t2 = el('text', { class: 'yct-zone', x: dx + 8, y: padTop - 10 });
      t2.textContent = 'PROJECTED';
      svg.appendChild(t2);
    }

    function pathFor(key, from, to) {
      let d = '';
      for (let i = from; i <= to; i++) {
        const x = xAt(i), y = yAt(data[i][key]);
        d += (i === from ? 'M' : 'L') + x + ' ' + y + ' ';
      }
      return d;
    }

    function renderSeries(svg) {
      const solidEnd = projectionState.hasProjection ? projectionState.lastActualIdx : n - 1;
      seriesDefs.forEach((s) => {
        if (solidEnd > 0) {
          svg.appendChild(el('path', { d: pathFor(s.key, 0, solidEnd), fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
        }
        if (projectionState.hasProjection) {
          svg.appendChild(el('path', { d: pathFor(s.key, projectionState.lastActualIdx, n - 1), fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round' }));
        }
      });
    }

    function renderMarkersAndLabels(svg) {
      data.forEach((row, i) => {
        const x = xAt(i);
        seriesDefs.forEach((s) => {
          const y = yAt(row[s.key]);
          const hollow = row.projected;
          if (s.marker === 'diamond') {
            const sz = 5;
            svg.appendChild(el('rect', {
              x: x - sz / 1.6, y: y - sz / 1.6, width: sz * 1.25, height: sz * 1.25,
              fill: hollow ? '#fff' : s.color, stroke: s.color, 'stroke-width': hollow ? 2 : 0,
              transform: `rotate(45 ${x} ${y})`,
            }));
          } else {
            svg.appendChild(el('circle', { cx: x, cy: y, r: 4, fill: hollow ? '#fff' : s.color, stroke: s.color, 'stroke-width': hollow ? 2 : 0 }));
          }
        });

        const mLbl = el('text', { class: 'yct-month', x, y: H - 6, 'text-anchor': 'middle' });
        mLbl.textContent = ALL_MONTH_NAMES[row.monthIndex] || row.m;
        svg.appendChild(mLbl);
      });
    }

    function appendTooltipValue(container, labelText, amount, color, signed) {
      const value = document.createElement('div');
      value.className = 'yct-tooltip-value';
      const labelRow = document.createElement('div');
      labelRow.className = 'yct-tooltip-label-row';
      const label = document.createElement('span');
      label.textContent = labelText;
      labelRow.appendChild(label);
      const amountLabel = document.createElement('div');
      amountLabel.className = 'yct-tooltip-amount';
      amountLabel.style.color = color || '#17181d';
      amountLabel.textContent = signed && amount >= 0 ? `+${fmt(amount)}` : fmt(amount);
      value.appendChild(labelRow);
      value.appendChild(amountLabel);
      container.appendChild(value);
    }

    function attachHoverTargets(svg, tooltip) {
      data.forEach((row, i) => {
        const hit = el('rect', {
          class: 'yct-hover-target',
          x: i === 0 ? padL : (xAt(i - 1) + xAt(i)) / 2,
          y: padTop,
          width: n === 1 ? plotW : (i === 0 || i === n - 1 ? xStep / 2 : (xAt(i + 1) - xAt(i - 1)) / 2),
          height: plotH,
        });
        hit.addEventListener('pointerenter', (event) => showTooltip(i, event));
        hit.addEventListener('pointermove', (event) => showTooltip(i, event));
        hit.addEventListener('pointerleave', () => { tooltip.style.display = 'none'; tooltip.style.visibility = ''; });
        svg.appendChild(hit);
      });
    }

    function showTooltip(index, event) {
      const row = data[index];
      tooltip.innerHTML = '';
      const month = document.createElement('div');
      month.className = `yct-tooltip-month${row.projected ? ' yct-tooltip-month-projected' : ''}`;
      month.textContent = ALL_MONTH_NAMES[row.monthIndex] || row.m;
      tooltip.appendChild(month);
      seriesDefs.forEach((s) => {
        appendTooltipValue(tooltip, s.label, row[s.key], s.color, false);
      });
      if (makeTooltipExtras) {
        makeTooltipExtras(row).forEach((extra) => {
          appendTooltipValue(tooltip, extra.label, extra.value, extra.color, extra.signed);
        });
      }

      const wrapRect = wrap.getBoundingClientRect();
      tooltip.style.visibility = 'hidden';
      tooltip.style.display = 'block';
      const tooltipWidth = tooltip.offsetWidth;
      const tooltipHeight = tooltip.offsetHeight;
      const pointerX = event.clientX - wrapRect.left;
      const left = Math.max(8, Math.min(pointerX - tooltipWidth / 2, wrapRect.width - tooltipWidth - 8));
      const top = Math.max(8, event.clientY - wrapRect.top - tooltipHeight - 14);
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.setProperty('--yct-caret-left', `${pointerX - left}px`);
      tooltip.style.visibility = 'visible';
    }

    const wrap = document.createElement('div');
    wrap.className = 'yct-card';
    const h3 = document.createElement('h3');
    h3.className = 'yct-title';
    h3.textContent = titleText;
    mountEl.appendChild(h3);
    const tooltip = document.createElement('div');
    tooltip.className = 'yct-tooltip';
    tooltip.style.display = 'none';
    wrap.appendChild(tooltip);

    const head = document.createElement('div');
    head.className = 'yct-card-head';
    const headLeft = document.createElement('div');
    headLeft.className = 'yct-card-head-left';

    if (makeStats && data[n - 1] && !emptyMessage) {
      const statsRow = document.createElement('div');
      statsRow.className = 'yct-stats';
      const currentRow = data[Math.max(0, projectionState.lastActualIdx)] || data[n - 1];
      makeStats(data[n - 1], avg, currentRow).forEach((s) => {
        const tile = document.createElement('div');
        tile.className = `yct-stat ${s.className || ''}`;
        const labelEl = document.createElement('div');
        labelEl.className = 'yct-stat-label';
        labelEl.textContent = s.label;
        const valueEl = document.createElement('div');
        valueEl.className = 'yct-stat-value';
        if (s.color) valueEl.style.color = s.color;
        valueEl.textContent = s.value;
        tile.append(labelEl, valueEl);
        statsRow.appendChild(tile);
      });
      headLeft.appendChild(statsRow);
    }
    head.appendChild(headLeft);

    if (headerRightEl) {
      const headRight = document.createElement('div');
      headRight.className = 'yct-card-head-right';
      headRight.appendChild(headerRightEl);
      head.appendChild(headRight);
    }
    wrap.appendChild(head);

    if (!data.length) {
      const empty = document.createElement('div');
      empty.className = 'yct-empty-hint';
      empty.textContent = 'No data is available for this year.';
      wrap.appendChild(empty);
      mountEl.appendChild(wrap);
      return;
    }
    if (emptyMessage) {
      const empty = document.createElement('div');
      empty.className = 'yct-empty-hint';
      const marker = document.createElement('span');
      marker.className = 'yct-empty-hint-marker';
      marker.textContent = '!';
      const message = document.createElement('span');
      message.textContent = emptyMessage;
      empty.appendChild(marker);
      empty.appendChild(message);
      wrap.appendChild(empty);
      mountEl.appendChild(wrap);
      return;
    }

    wrap.appendChild(renderLegend());

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'yct-chart' });
    renderGrid(svg);
    renderSeries(svg);
    renderMarkersAndLabels(svg);
    attachHoverTargets(svg, tooltip);

    const endPts = seriesDefs.map((s) => ({ s, y: yAt(data[n - 1][s.key]), val: data[n - 1][s.key] }));
    endPts.sort((a, b) => a.y - b.y);
    for (let i = 1; i < endPts.length; i++) {
      if (endPts[i].y - endPts[i - 1].y < 15) endPts[i].y = endPts[i - 1].y + 15;
    }
    endPts.forEach((p) => {
      const t = el('text', { class: 'yct-end', x: W - 4, y: p.y + 4, fill: p.s.color, 'text-anchor': 'end' });
      t.textContent = fmt(p.val);
      svg.appendChild(t);
    });

    wrap.appendChild(svg);
    mountEl.appendChild(wrap);
  }

  // Give each category group a stable color so the same group stays the same color even if the selected set changes between renders.
  const GROUP_PALETTE = ['#2d7ff9', '#f26b38', '#20b875', '#e3a51a', '#d94f9d', '#6074d9', '#e04b59', '#62b642', '#9a63d8', '#20a6b8'];
  function buildGroupColorMap(categoryTree) {
    const map = {};
    categoryTree.forEach((g, i) => { map[g.name] = GROUP_PALETTE[i % GROUP_PALETTE.length]; });
    return map;
  }

  // ---------- shared category picker ----------
  // Each chart uses a menu that lets a user pick categories or category groups.
  // For the spend view, selection is by leaf category; for Spending Trends, we count selected groups and then roll all of their leaf categories up together.
  let pickerInstanceId = 0;
  function createCategoryPicker({ tree, selected, onDone }) {
    const totalGroups = tree.length;
    const pickerId = ++pickerInstanceId;
    let applied = new Set(selected);
    let draft = new Set(applied);

    const wrap = document.createElement('div');
    wrap.className = 'yct-picker';

    const btn = createButton({ className: 'yct-picker-btn', text: 'No Groups ▾' });
    wrap.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'yct-picker-panel';
    panel.style.display = 'none';
    wrap.appendChild(panel);

    function selectedGroupCount(set) {
      return tree.filter((g) => g.categories.some((c) => set.has(c.id))).length;
    }

    function labelFor(set) {
      if (set.size === 0) return 'No Groups';
      const count = selectedGroupCount(set);
      if (count === totalGroups) return 'All Groups';
      return `${count} ${count === 1 ? 'Group' : 'Groups'}`;
    }
    function updateButton() { btn.textContent = labelFor(applied) + ' ▾'; }
    updateButton();

    function syncGroupState(groupName) {
      const group = tree.find((g) => g.name === groupName);
      if (!group) return;
      const cb = panel.querySelector(`input[data-group="${cssEscape(groupName)}"]`);
      if (!cb) return;
      const total = group.categories.length;
      const checkedCount = group.categories.filter((c) => draft.has(c.id)).length;
      cb.checked = checkedCount > 0;
      cb.indeterminate = checkedCount > 0 && checkedCount < total;
    }

    function cssEscape(s) {
      return String(s).replace(/["\\]/g, '\\$&');
    }

    function renderList(filterText) {
      const list = panel.querySelector('.yct-picker-list');
      const scrollTop = list.scrollTop;
      list.innerHTML = '';
      const q = (filterText || '').trim().toLowerCase();
      tree.forEach((g, groupIndex) => {
        const groupMatches = g.name.toLowerCase().includes(q);
        const visibleCats = q && !groupMatches ? g.categories.filter((c) => c.name.toLowerCase().includes(q)) : g.categories;
        if (q && !groupMatches && visibleCats.length === 0) return;

        const gRow = document.createElement('div');
        gRow.className = 'yct-picker-row yct-picker-row-group';
        const gCb = document.createElement('input');
        gCb.type = 'checkbox';
        gCb.id = `yct-picker-${pickerId}-group-${groupIndex}`;
        gCb.dataset.group = g.name;
        gCb.addEventListener('change', () => {
          g.categories.forEach((c) => { if (gCb.checked) draft.add(c.id); else draft.delete(c.id); });
          renderList(filterText);
          applyChanges();
        });
        const gLabel = document.createElement('label');
        gLabel.htmlFor = gCb.id;
        gLabel.textContent = g.name;
        gRow.appendChild(gCb);
        gRow.appendChild(gLabel);
        list.appendChild(gRow);

        visibleCats.forEach((c, categoryIndex) => {
          const cRow = document.createElement('div');
          cRow.className = 'yct-picker-row yct-picker-row-cat';
          const cCb = document.createElement('input');
          cCb.type = 'checkbox';
          cCb.id = `yct-picker-${pickerId}-category-${groupIndex}-${categoryIndex}`;
          cCb.checked = draft.has(c.id);
          cCb.addEventListener('change', () => {
            if (cCb.checked) draft.add(c.id); else draft.delete(c.id);
            syncGroupState(g.name);
            applyChanges();
          });
          const cLabel = document.createElement('label');
          cLabel.htmlFor = cCb.id;
          cLabel.textContent = c.name;
          cRow.appendChild(cCb);
          cRow.appendChild(cLabel);
          if (c.hidden) {
            const tag = document.createElement('span');
            tag.className = 'yct-picker-hidden-tag';
            tag.textContent = 'Hidden';
            cRow.appendChild(tag);
          }
          list.appendChild(cRow);
        });
      });
      tree.forEach((g) => syncGroupState(g.name));
      list.scrollTop = scrollTop;
    }

    function applyChanges() {
      applied = new Set(draft);
      updateButton();
      // onDone re-renders the chart card, which detaches/reattaches this picker's DOM and would otherwise reset the list's scroll position.
      const list = panel.querySelector('.yct-picker-list');
      const scrollTop = list ? list.scrollTop : 0;
      onDone(new Set(applied));
      if (list) list.scrollTop = scrollTop;
    }

    function setsEqual(a, b) {
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
      return true;
    }

    let outsideClickHandler = null;
    let openedWith = null;
    function open() {
      draft = new Set(applied);
      openedWith = new Set(applied);
      panel.innerHTML = `
        <input type="text" class="yct-picker-search" placeholder="Search Categories" />
        <div class="yct-picker-list"></div>
        <div class="yct-picker-footer">
          <div class="yct-picker-footer-links">
            <button type="button" class="yct-picker-link" data-act="all">Select All</button>
            <button type="button" class="yct-picker-link" data-act="none">Select None</button>
          </div>
          <div class="yct-picker-footer-actions">
            <button type="button" class="yct-picker-cancel">Cancel</button>
            <button type="button" class="yct-picker-done">Done</button>
          </div>
        </div>
      `;
      renderList('');
      panel.querySelector('.yct-picker-search').addEventListener('input', (e) => renderList(e.target.value));
      panel.querySelector('[data-act="all"]').addEventListener('click', () => { draft = new Set(allLeafIds(tree)); renderList(panel.querySelector('.yct-picker-search').value); applyChanges(); });
      panel.querySelector('[data-act="none"]').addEventListener('click', () => { draft = new Set(); renderList(panel.querySelector('.yct-picker-search').value); applyChanges(); });
      panel.querySelector('.yct-picker-cancel').addEventListener('click', () => {
        if (openedWith && !setsEqual(applied, openedWith)) {
          applied = new Set(openedWith);
          updateButton();
          onDone(new Set(applied));
        }
        close();
      });
      panel.querySelector('.yct-picker-done').addEventListener('click', close);
      panel.style.display = 'block';
      outsideClickHandler = bindOutsideClick(wrap, panel, close);
    }
    function close() {
      panel.style.display = 'none';
      if (outsideClickHandler) { document.removeEventListener('mousedown', outsideClickHandler); outsideClickHandler = null; }
    }
    btn.addEventListener('click', () => { panel.style.display === 'none' ? open() : close(); });

    return wrap;
  }

  // The app injects a small style sheet so the custom controls and SVG chart match YNAB's look without depending on external CSS or libraries.
  function injectStyles() {
    GM_addStyle(`
      :root {
        --yct-blue: #4e57f8;
        --yct-blue-soft: #edf2ff;
        --yct-blue-soft-hover: #e5edff;
        --yct-blue-border: #dfe7ff;
        --yct-text: #17181d;
        --yct-text-muted: #6f7380;
        --yct-panel-border: #e2e5ec;
        --yct-panel-shadow: rgba(20, 24, 40, 0.16);
        --yct-row-hover: #f7f8fb;
        --yct-divider: #ece9e0;
      }
      #yct-root {
        font-family: system-ui, -apple-system, sans-serif;
        display: flex; flex-direction: column; gap: 20px;
        margin: 16px 0;
      }
      .yct-chart-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .yct-year-control { display: flex; align-items: center; gap: 4px; }
      .yct-year-label { margin-right: 4px; color: var(--yct-text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      .yct-year-select {
        font-family: inherit; font-size: 13px; font-weight: 600; color: var(--yct-blue);
        background: #eef3fd; border: 1px solid var(--yct-blue-border); border-radius: 8px;
        padding: 7px 28px 7px 11px; cursor: pointer;
      }
      .yct-card {
        background: #fff; border: 1px solid #e6e1d3; border-radius: 12px;
        padding: 18px 20px 12px;
      }
      .yct-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .yct-card-head-left { flex: 1 1 auto; min-width: 0; }
      .yct-card-head-right { flex: 0 0 auto; }

      .yct-title { font-size: 1.5em; font-weight: 700; margin: 0 0 8px; color: #17181d; }
      .yct-empty-hint {
        display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600;
        color: #2c2e38; background: #fff8e5; border-left: 4px solid #e3a51a;
        padding: 10px 12px; margin: 0 0 16px;
      }
      .yct-empty-hint-marker {
        display: inline-flex; align-items: center; justify-content: center;
        width: 22px; height: 22px; border-radius: 50%; background: #e3a51a;
        color: #fff; font-size: 15px; font-weight: 800; flex: 0 0 auto;
      }

      .yct-stats { display: flex; gap: 26px; flex-wrap: wrap; margin: 0 0 16px; }
      .yct-stat { display: flex; flex-direction: column; gap: 2px; }
      .yct-stat-projected { border-top: 4px solid #000; padding-top: 6px; }
      .yct-stat-label { font-size: 14px; font-weight: 600; color: #51504d; }
      .yct-stat-value { font-size: 24px; font-weight: 700; color: #000; line-height: 1.15; }

      .yct-legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; color: #6f7380; margin-bottom: 6px; }
      .yct-legend-item { display: flex; align-items: center; gap: 5px; }
      .yct-line-swatch { width: 16px; height: 2.5px; border-radius: 2px; display: inline-block; flex-shrink: 0; }
      .yct-line-dashed { background: none !important; border-top: 2.5px dashed #9a9d8c; height: 0; }
      .yct-swatch { width: 8px; height: 8px; display: inline-block; flex-shrink: 0; }
      .yct-swatch-circle { border-radius: 50%; }
      .yct-swatch-diamond { border-radius: 1px; transform: rotate(45deg); }

      .yct-card { position: relative; }
      .yct-chart { width: 100%; height: auto; display: block; overflow: visible; }
      .yct-hover-target { fill: transparent; cursor: crosshair; pointer-events: all; }
      .yct-tooltip {
        position: absolute; z-index: 10; min-width: 150px; pointer-events: none;
        padding: 9px 11px; border: 1px solid #dfe4ed; border-radius: 7px;
        background: rgba(255, 255, 255, .98); box-shadow: 0 5px 18px rgba(20, 24, 40, .16);
        color: #2c2e38; font-size: 13px; line-height: 1.5; white-space: nowrap;
      }
      .yct-tooltip::after {
        content: ''; position: absolute; left: var(--yct-caret-left, 50%); bottom: -7px; width: 12px; height: 12px;
        background: #fff; border-right: 1px solid #dfe4ed; border-bottom: 1px solid #dfe4ed;
        transform: translateX(-50%) rotate(45deg);
      }
      .yct-tooltip-month { margin-bottom: 3px; color: #17181d; font-size: 14px; font-weight: 700; }
      .yct-tooltip-month-projected { color: #b3ae9d; }
      .yct-tooltip-value { display: flex; flex-direction: column; gap: 1px; margin-top: 7px; }
      .yct-tooltip-label-row { color: #17181d; font-size: 13px; font-weight: 600; }
      .yct-tooltip-amount { color: #17181d; font-size: 14px; font-weight: 700; line-height: 1.2; }
      .yct-grid { stroke: #ece7d9; stroke-width: 1; }
      .yct-axis { font-size: 10px; fill: #51504d; }
      .yct-month { font-size: 9.5px; fill: #6f7380; font-weight: 600; }
      .yct-end { font-size: 11.5px; font-weight: 700; }
      .yct-net-rule { stroke: #000; stroke-width: 1; }
      .yct-divider { stroke: #d8d3c4; stroke-width: 1; stroke-dasharray: 3 3; }
      .yct-zone { font-size: 9.5px; fill: #b3ae9d; letter-spacing: .07em; font-weight: 700; }

      /* ---- category picker (mimics YNAB's own "All Categories" selector) ---- */
      .yct-picker { position: relative; font-size: 13px; }
      .yct-picker-btn,
      .yct-default-groups-btn,
      .yct-default-groups-save,
      .yct-default-groups-reset {
        font-family: inherit; font-size: 13px; font-weight: 600; color: var(--yct-blue);
        background: var(--yct-blue-soft); border: 1px solid var(--yct-blue-border); border-radius: 8px;
        padding: 7px 12px; cursor: pointer; white-space: nowrap;
      }
      .yct-picker-btn:hover,
      .yct-default-groups-btn:hover,
      .yct-default-groups-save:hover,
      .yct-default-groups-reset:hover { background: var(--yct-blue-soft-hover); }
      .yct-default-groups-wrap { position: relative; }
      .yct-default-groups-panel {
        position: absolute; top: calc(100% + 6px); right: 0; z-index: 20;
        width: 240px; background: #fff; border: 1px solid var(--yct-panel-border); border-radius: 10px;
        box-shadow: 0 8px 28px var(--yct-panel-shadow); display: flex; flex-direction: column; overflow: hidden;
      }
      .yct-default-groups-note {
        padding: 10px 12px 8px; font-size: 12px; line-height: 1.4; color: #5b6170; border-bottom: 1px solid var(--yct-divider);
      }
      .yct-default-groups-list { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; padding: 8px 0; }
      .yct-default-groups-row {
        display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 13px; color: #2c2e38;
      }
      .yct-default-groups-row:hover { background: var(--yct-row-hover); }
      .yct-default-groups-row input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--yct-blue); }
      .yct-default-groups-footer {
        display: flex; justify-content: space-between; gap: 8px; border-top: 1px solid var(--yct-divider); padding: 9px 12px;
      }
      .yct-picker-panel {
        position: absolute; top: calc(100% + 6px); right: 0; z-index: 20;
        width: 300px; max-width: 80vw; background: #fff; border: 1px solid var(--yct-panel-border);
        border-radius: 10px; box-shadow: 0 8px 28px var(--yct-panel-shadow);
        display: flex; flex-direction: column; overflow: hidden;
      }
      .yct-picker-search {
        font-family: inherit; font-size: 13px; border: none; border-bottom: 1px solid var(--yct-divider);
        padding: 11px 14px; outline: none; color: var(--yct-text);
      }
      .yct-picker-search::placeholder { color: #9a9d8c; }
      .yct-picker-list { max-height: 260px; overflow-y: auto; padding: 6px 0; }
      .yct-picker-row {
        display: flex; align-items: center; gap: 9px; padding: 6px 14px;
        font-size: 13px; color: #2c2e38;
      }
      .yct-picker-row:hover { background: var(--yct-row-hover); }
      .yct-picker-row-group { font-weight: 700; }
      .yct-picker-row-cat { padding-left: 30px; font-weight: 400; }
      .yct-picker-row input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--yct-blue); flex-shrink: 0; }
      .yct-picker-row label { flex: 1 1 auto; cursor: pointer; }
      .yct-picker-hidden-tag { font-size: 10.5px; color: #9a9d8c; font-weight: 600; white-space: nowrap; }
      .yct-picker-footer {
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid var(--yct-divider); padding: 9px 12px; gap: 8px;
      }
      .yct-picker-footer-links { display: flex; gap: 12px; }
      .yct-picker-link {
        font-family: inherit; font-size: 12px; font-weight: 600; color: var(--yct-blue);
        background: none; border: none; cursor: pointer; padding: 2px;
      }
      .yct-picker-link:hover { text-decoration: underline; }
      .yct-picker-footer-actions { display: flex; gap: 8px; }
      .yct-picker-cancel, .yct-picker-done {
        font-family: inherit; font-size: 12.5px; font-weight: 600; border-radius: 7px;
        padding: 6px 13px; cursor: pointer; border: 1px solid transparent;
      }
      .yct-picker-cancel { background: #f0f1f4; color: #4a4d59; }
      .yct-picker-cancel:hover { background: #e6e7ec; }
      .yct-picker-done { background: var(--yct-blue); color: #fff; }
      .yct-picker-done:hover { background: #424deb; }
    `);
  }

  function findNativeChartContainer() {
    if (CONFIG.NATIVE_CHART_SELECTOR) {
      const found = document.querySelector(CONFIG.NATIVE_CHART_SELECTOR);
      if (found) return found;
      warn('NATIVE_CHART_SELECTOR did not match anything — falling back to auto-detect.');
    }
    const heading = Array.from(document.querySelectorAll('h1, h2, h3'))
      .find((h) => h.textContent.trim().toLowerCase() === 'spending trends');
    if (!heading) return null;
    let node = heading.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      if (node.querySelector('svg, canvas')) return node;
      node = node.parentElement;
    }
    return heading.parentElement;
  }

  // ---------- route-aware mount and unmount ----------
  // These values keep a single custom panel mounted while the user stays on the spending-trends route, and they cache budget data 
  // so the app does not unnecessarily refetch the same information when the user changes only the selected year.
  let panelState = null; // { root, nativeContainer } while mounted, else null
  let dataPromise = null; // cache the fetch so re-entering the page doesn't re-fetch every time
  let dataBudgetId = null;
  let dataYear = null;
  let selectedYear = new Date().getFullYear();
  let panelRequestId = 0;

  // Selections last until a full reload, null means defaults are not set yet.
  let spendSelection = null;
  let categoryTrendsSelection = null;

  function onSpendingTrendsPage() {
    return CONFIG.PAGE_PATH_MATCH.test(location.pathname);
  }

  function teardownPanel() {
    if (!panelState) return;
    panelState.root.remove();
    panelState = null;
    log('Left Spending Trends — removed panel.');
  }

  function createYearSelector(reportYear, availableYears) {
    const yearControl = document.createElement('div');
    yearControl.className = 'yct-year-control';
    const yearLabel = document.createElement('span');
    yearLabel.className = 'yct-year-label';
    yearLabel.textContent = 'Year';
    yearControl.appendChild(yearLabel);
    const yearSelect = document.createElement('select');
    yearSelect.className = 'yct-year-select';
    yearSelect.setAttribute('aria-label', 'Report year');
    availableYears.forEach((year) => {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      option.selected = year === reportYear;
      yearSelect.appendChild(option);
    });
    yearSelect.addEventListener('change', () => {
      const year = Number(yearSelect.value);
      if (year === selectedYear) return;
      selectedYear = year;
      teardownPanel();
      dataPromise = null;
      dataBudgetId = null;
      dataYear = null;
      ensurePanel();
    });
    yearControl.appendChild(yearSelect);
    return yearControl;
  }

  // This menu allows the user to choose and save their default Spending Trends groups for the current budget. 
  // Those saved values are reapplied automatically on later visits to this budget's Spending Trends page.
  function createDefaultGroupsButton({ budgetId, categoryTree, onSave }) {
    const wrap = document.createElement('div');
    wrap.className = 'yct-default-groups-wrap';

    const btn = createButton({ className: 'yct-default-groups-btn', text: 'Default Groups' });
    const panel = document.createElement('div');
    panel.className = 'yct-default-groups-panel';
    panel.style.display = 'none';

    let draft = new Set(getDefaultCategoryNames(categoryTree, budgetId));
    let outsideClickHandler = null;

    function closePanel() {
      panel.style.display = 'none';
      if (outsideClickHandler) {
        document.removeEventListener('mousedown', outsideClickHandler);
        outsideClickHandler = null;
      }
    }

    function renderPanel() {
      panel.innerHTML = '';
      const note = document.createElement('div');
      note.className = 'yct-default-groups-note';
      note.textContent = 'Select the default groups to monitor with the Spending Trends view.';
      panel.appendChild(note);

      const list = document.createElement('div');
      list.className = 'yct-default-groups-list';
      categoryTree.forEach((group) => {
        const row = createCheckboxRow({
          labelText: group.name,
          checked: draft.has(group.name),
          rowClassName: 'yct-default-groups-row',
          onToggle: (isChecked) => {
            if (isChecked) draft.add(group.name);
            else draft.delete(group.name);
          },
        });
        list.appendChild(row);
      });

      const footer = document.createElement('div');
      footer.className = 'yct-default-groups-footer';

      const resetBtn = createButton({ className: 'yct-default-groups-reset', text: 'Reset' });
      resetBtn.addEventListener('click', () => {
        clearSavedDefaultGroups(budgetId);
        draft = new Set();
        onSave([]);
        closePanel();
      });

      const saveBtn = createButton({ className: 'yct-default-groups-save', text: 'Save' });
      saveBtn.addEventListener('click', () => {
        const groupNames = Array.from(draft);
        saveDefaultGroups(budgetId, groupNames);
        onSave(groupNames);
        closePanel();
      });

      footer.appendChild(resetBtn);
      footer.appendChild(saveBtn);
      panel.appendChild(list);
      panel.appendChild(footer);
    }

    btn.addEventListener('click', () => {
      draft = new Set(getDefaultCategoryNames(categoryTree, budgetId));
      renderPanel();
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        outsideClickHandler = bindOutsideClick(wrap, panel, closePanel);
      } else {
        closePanel();
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    return wrap;
  }

  // Compose the shared header controls for each chart: 
  // year selector, category picker, and any optional budget-specific control like "Default Groups".
  function createChartControls(reportYear, picker, availableYears, extraControl = null) {
    const controls = document.createElement('div');
    controls.className = 'yct-chart-controls';
    controls.appendChild(createYearSelector(reportYear, availableYears));
    controls.appendChild(picker);
    if (extraControl) controls.appendChild(extraControl);
    return controls;
  }

  // Build the custom panel that sits above YNAB's native chart and renders the
  // two cumulative cards plus their controls and saved default-group selector.
  function buildPanel({ catMeta, months, categoryTree, availableYears }, budgetId, reportYear) {
    injectStyles();
    const root = document.createElement('div');
    root.id = 'yct-root';

    const nativeContainer = findNativeChartContainer();
    if (nativeContainer) {
      nativeContainer.insertAdjacentElement('beforebegin', root);
      log('Found native Spending Trends chart — added cumulative charts above it.');
    } else {
      const anchor = document.querySelector('main') || document.body;
      anchor.prepend(root);
      log('Native chart not found — added panel above the page content instead.');
    }

    // Set defaults once. Edit CONFIG.DEFAULT_CATEGORY_TRENDS_GROUPS to choose yours.
    if (!spendSelection) spendSelection = new Set(allLeafIds(categoryTree));
    if (!categoryTrendsSelection) {
      categoryTrendsSelection = idsForGroupNames(categoryTree, getDefaultCategoryNames(categoryTree, budgetId));
    }
    const groupColor = buildGroupColorMap(categoryTree);

    const incomeMount = document.createElement('div');
    root.appendChild(incomeMount);
    const incomePicker = createCategoryPicker({
      tree: categoryTree,
      selected: spendSelection,
      onDone: (newSet) => { spendSelection = newSet; renderIncomeCard(); },
    });
    const incomeChartControls = createChartControls(reportYear, incomePicker, availableYears);
    function renderIncomeCard() {
      incomeMount.innerHTML = '';
      const summary = computeSummary(months, spendSelection, new Set(), catMeta, categoryTree);
      const chartControls = incomeChartControls;
      drawCumulativeChart(
        incomeMount,
        summary.map((r) => ({ m: r.m, monthIndex: r.monthIndex, income: r.income, totalSpend: r.totalSpend })),
        [
          { key: 'income', color: '#20b875', label: 'Income', marker: 'circle' },
          { key: 'totalSpend', color: '#e04b59', label: 'Spend', marker: 'diamond' },
        ],
        // Fallback target for Y-axis grid spacing when there is no positive data.
        25000,
        `Income vs. Spend ${reportYear}`,
        (finalRow, avg, currentRow) => {
          const currentNet = currentRow.income - currentRow.totalSpend;
          return [
            { label: 'Income', value: fmt(currentRow.income), color: '#20b875' },
            { label: 'Spend', value: fmt(currentRow.totalSpend), color: '#e04b59' },
            { label: 'Net', value: fmt(currentNet), color: currentNet >= 0 ? '#20b875' : '#e04b59' },
          ];
        },
        chartControls,
        (finalRow) => {
          const net = finalRow.income - finalRow.totalSpend;
          return [{ label: finalRow.projected ? 'Projected Net' : 'Net Difference', value: net, color: net >= 0 ? '#20b875' : '#e04b59', signed: true }];
        },
        reportYear === new Date().getFullYear()
      );
    }
    renderIncomeCard();

    const categoryTrendsMount = document.createElement('div');
    root.appendChild(categoryTrendsMount);
    const categoryTrendsPicker = createCategoryPicker({
      tree: categoryTree,
      selected: categoryTrendsSelection,
      countMode: 'groups',
      onDone: (newSet) => { categoryTrendsSelection = newSet; renderCategoryTrendsCard(); },
    });
    const defaultGroupsBtn = createDefaultGroupsButton({
      budgetId,
      categoryTree,
      onSave: (groupNames) => {
        categoryTrendsSelection = idsForGroupNames(categoryTree, groupNames);
        renderCategoryTrendsCard();
      },
    });
    const categoryTrendsChartControls = createChartControls(reportYear, categoryTrendsPicker, availableYears, defaultGroupsBtn);
    function renderCategoryTrendsCard() {
      categoryTrendsMount.innerHTML = '';
      const summary = computeSummary(months, new Set(), categoryTrendsSelection, catMeta, categoryTree);
      const activeGroups = getActiveGroups(categoryTree, categoryTrendsSelection);
      const seriesDefs = activeGroups.map((name) => ({ key: name, color: groupColor[name], label: name, marker: 'circle' }));
      const chartControls = categoryTrendsChartControls;
      drawCumulativeChart(
        categoryTrendsMount,
        summary,
        seriesDefs,
        2500,
        `Spending Trends ${reportYear}`,
        (finalRow, avg) => {
          const totalAvg = activeGroups.reduce((s, g) => s + (avg[g] || 0), 0);
          const totalPace = activeGroups.reduce((s, g) => s + (finalRow[g] || 0), 0);
          return [
            { label: `Avg. Monthly (${activeGroups.length} groups)`, value: fmt(totalAvg) },
            { label: 'Year-End Pace', value: fmt(totalPace) },
          ];
        },
        chartControls,
        undefined,
        reportYear === new Date().getFullYear(),
        activeGroups.length === 0 ? 'Start by picking your default Spending Trends groups from the selector.' : null
      );
    }
    renderCategoryTrendsCard();

    panelState = { root, nativeContainer, budgetId };
  }

  // Ensure the custom panel exists only on the Spending Trends page and reuses the cached budget data unless the user changed years or budgets.
  async function ensurePanel() {
    const budgetId = getBudgetIdFromUrl();
    const reportYear = selectedYear;
    const requestId = ++panelRequestId;
    if (!onSpendingTrendsPage() || !budgetId) {
      teardownPanel();
      return;
    }
    if (panelState) {
      if (panelState.budgetId === budgetId) return;
      teardownPanel();
      spendSelection = null;
      categoryTrendsSelection = null;
    }

    if (!getOrPromptToken()) {
      warn('No personal access token set — reload the page to be prompted again, or use "Reset YNAB API Token" from the Tampermonkey menu.');
      return;
    }
    try {
      if (!dataPromise || dataBudgetId !== budgetId || dataYear !== reportYear) {
        log('Fetching budget data…');
        dataBudgetId = budgetId;
        dataYear = reportYear;
        dataPromise = fetchYearData(budgetId, reportYear);
      }
      const data = await dataPromise;
      // page may have navigated away while we were waiting on the fetch
      if (requestId !== panelRequestId || panelState || !onSpendingTrendsPage() || getBudgetIdFromUrl() !== budgetId || selectedYear !== reportYear) return;
      selectedYear = data.reportYear;
      buildPanel(data, budgetId, data.reportYear);
      log('Done.');
    } catch (e) {
      console.error('[YNAB Cumulative] Failed:', e);
      if (requestId === panelRequestId) {
        dataPromise = null; // allow retry on next visit to the page
        dataBudgetId = null;
        dataYear = null;
      }
    }
  }

  // Listen for YNAB route changes so the script can mount/unmount itself when the
  // user navigates away from or onto the Spending Trends screen.
  function watchRoute() {
    let lastPath = location.pathname;
    const check = () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        ensurePanel();
      }
    };
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (...args) { origPush.apply(this, args); check(); };
    history.replaceState = function (...args) { origReplace.apply(this, args); check(); };
    window.addEventListener('popstate', check);
  }

  // Boot the script after the page finishes loading and start the route watcher.
  function boot() {
    watchRoute();
    ensurePanel();
  }

  if (document.readyState === 'complete') {
    setTimeout(boot, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(boot, 1500));
  }
})();