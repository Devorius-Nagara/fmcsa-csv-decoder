/**
 * HOS Chart Module — Canvas-based Hours of Service graph
 * Features: status line, markers, hitboxes, tooltip, HOS recap
 */
class HOSChart {
    // ── Y-level mapping ──────────────────────────────────────────────
    static LEVELS      = { OFF: 0, SB: 1, D: 2, ON: 3 };
    static LEVEL_LABELS = ['OFF', 'SB', 'D', 'ON'];
    static LEVEL_NAMES  = ['Off Duty', 'Sleeper Berth', 'Driving', 'On Duty'];

    // ── Colours ──────────────────────────────────────────────────────
    static STATUS_COLORS = {
        OFF: '#ef4444',
        SB:  '#6b7280',
        D:   '#22c55e',
        ON:  '#f59e0b',
    };

    // ── Constructor ──────────────────────────────────────────────────
    constructor(canvasId, unifiedList, annotationsMap) {
        this.canvas         = document.getElementById(canvasId);
        this.ctx            = this.canvas.getContext('2d');
        this.events         = unifiedList;
        this.annotationsMap = annotationsMap || {};
        this.dpr            = window.devicePixelRatio || 1;

        this.dates   = this._collectDates();
        this.dateIdx = this.dates.length - 1;

        this.pad = { top: 20, right: 30, bottom: 50, left: 52 };

        /** @type {Array<{x1:number,x2:number,y1:number,y2:number,type:string,ev:object|null,startSec:number,endSec:number,level:number,isPC:boolean,isYM:boolean}>} */
        this.hitboxes = [];

        /** Currently hovered hitbox index or -1 */
        this._hoveredIdx = -1;

        // Tooltip DOM (created once, reused)
        this.tooltip = this._createTooltipElement();

        // HOS Recap data (set after render)
        this.recap = { OFF: 0, SB: 0, D: 0, ON: 0 };

        // Bind canvas events
        this._bindEvents();
    }

    // ══════════════════════════════════════════════════════════════════
    //  PUBLIC API
    // ══════════════════════════════════════════════════════════════════

    render() {
        this.hitboxes = [];
        this._resize();
        this._clear();
        this._drawGrid();

        const dayStr = this.dates[this.dateIdx];
        const { statusEvents, markerEvents } = this._filterDay(dayStr);
        const initialStatus = this._lookBackStatus(dayStr);

        this._drawStatusLine(statusEvents, initialStatus, dayStr);
        this._drawMarkers(markerEvents, dayStr);

        // Calculate recap
        this.recap = this._calcRecap(dayStr, statusEvents, initialStatus);
    }

    prevDay()  { if (this.dateIdx > 0) { this.dateIdx--; this.render(); } return this.currentDateFormatted(); }
    nextDay()  { if (this.dateIdx < this.dates.length - 1) { this.dateIdx++; this.render(); } return this.currentDateFormatted(); }
    hasPrev()  { return this.dateIdx > 0; }
    hasNext()  { return this.dateIdx < this.dates.length - 1; }

    currentDateFormatted() {
        const d = this.dates[this.dateIdx];
        if (!d || d.length < 6) return '-';
        return `${d.substring(0,2)}/${d.substring(2,4)}/20${d.substring(4,6)}`;
    }

    hideTooltip() {
        this.tooltip.style.display = 'none';
    }

    // ══════════════════════════════════════════════════════════════════
    //  TOOLTIP
    // ══════════════════════════════════════════════════════════════════

    _createTooltipElement() {
        let el = document.getElementById('hosTooltip');
        if (!el) {
            el = document.createElement('div');
            el.id = 'hosTooltip';
            el.className = 'absolute z-50 bg-white border border-gray-200 rounded-xl shadow-lg p-0 text-sm pointer-events-none';
            el.style.display = 'none';
            el.style.maxWidth = '340px';
            el.style.minWidth = '260px';
            document.body.appendChild(el);
        }
        return el;
    }

    _showTooltip(hitbox, mouseX, mouseY) {
        const tip = this.tooltip;
        tip.style.display = 'block';

        const isStatus = hitbox.type === 'status';
        const ev       = hitbox.ev;

        // ── Build content ────────────────────────────────────────────
        let label = '';
        let badgeColor = '';
        if (isStatus) {
            label = this._statusLabel(hitbox.level, hitbox.isPC, hitbox.isYM);
            const colorKey = HOSChart.LEVEL_LABELS[hitbox.level];
            badgeColor = HOSChart.STATUS_COLORS[colorKey];
        } else if (ev) {
            label = this._eventLabel(ev);
            // Distinctive badge colors for special types
            if (ev.isVirtualUnloading) badgeColor = '#8b5cf6';
            else badgeColor = '#6b7280';
        }

        const startTime = this._secToHHMMSS(hitbox.startSec);
        const endTime   = isStatus ? this._secToHHMMSS(hitbox.endSec) : null;
        const duration  = isStatus ? this._formatDuration(hitbox.endSec - hitbox.startSec) : null;

        let coords = '-';
        if (ev && ev.lat && ev.lon && ev.lat !== '-' && ev.lon !== '-') {
            coords = `${ev.lat}, ${ev.lon}`;
        }

        const hasMalf = ev && (ev.malfInd === '1' || ev.diagInd === '1');
        const comment = ev ? (this.annotationsMap[ev.seq] || '-') : '-';
        const hasViolations = ev && ev.violations && ev.violations.length > 0;

        let originText = '-';
        if (ev) {
            const o = parseInt(ev.origin, 10);
            if (o === 1) originText = 'Auto (ELD)';
            else if (o === 2) originText = 'Driver';
            else if (o === 3) originText = 'Fleet Manager';
            else if (o === 4) originText = 'Assumed (Unidentified)';
            else originText = `Unknown (${ev.origin})`;
        }

        const inactive = ev && ev.rs === '2';

        tip.innerHTML = `
            <div class="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2" style="background:${badgeColor}10">
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${badgeColor}"></span>
                <span class="font-bold text-gray-900 text-[13px]">${label}</span>
                ${inactive ? '<span class="ml-auto text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-bold uppercase">Inactive</span>' : ''}
            </div>
            <div class="px-4 py-3 space-y-1.5 text-xs">
                <div class="flex justify-between"><span class="text-gray-500">Початок:</span><span class="font-mono font-medium text-gray-800">${startTime}</span></div>
                ${endTime !== null ? `<div class="flex justify-between"><span class="text-gray-500">Кінець:</span><span class="font-mono font-medium text-gray-800">${endTime}</span></div>` : ''}
                ${duration !== null ? `<div class="flex justify-between"><span class="text-gray-500">Тривалість:</span><span class="font-bold text-gray-900">${duration}</span></div>` : ''}
                <div class="flex justify-between"><span class="text-gray-500">Локація:</span><span class="font-mono text-gray-700">${coords}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">Origin:</span><span class="text-gray-700">${originText}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">Malf / Diag:</span><span class="${hasMalf ? 'text-red-600 font-bold' : 'text-gray-400'}">${hasMalf ? 'Активно ⚠' : 'Ні'}</span></div>
                ${hasViolations ? `<div class="pt-1.5 border-t border-red-200 mt-1"><div class="text-red-700 font-bold text-[11px] mb-1">⚠ HOS ПОРУШЕННЯ:</div>${ev.violations.map(v => `<div class="text-red-600 text-[11px] font-semibold bg-red-50 rounded px-2 py-0.5 mt-0.5 border border-red-200">${v}</div>`).join('')}</div>` : ''}
                ${ev && ev.activeCargo && ev.source === 'Power Block' ? `<div class="pt-1.5 border-t border-gray-200 mt-1"><div class="flex justify-between text-[11px]"><span class="text-gray-500">Active Cargo:</span><span class="font-mono font-bold text-gray-800">${ev.activeCargo}</span></div></div>` : ''}
                ${ev && ev.cargoPickups && ev.cargoPickups.length > 0 ? `<div class="pt-1 mt-0.5">${ev.cargoPickups.map(d => `<div class="text-emerald-700 text-[11px] font-bold bg-emerald-50 rounded px-2 py-0.5 mt-0.5 border border-emerald-200">⬆ PICKUP: ${d}</div>`).join('')}</div>` : ''}
                ${ev && ev.cargoDrops && ev.cargoDrops.length > 0 ? `<div class="pt-1 mt-0.5">${ev.cargoDrops.map(d => `<div class="text-rose-700 text-[11px] font-bold bg-rose-50 rounded px-2 py-0.5 mt-0.5 border border-rose-200">⬇ DROP: ${d}</div>`).join('')}</div>` : ''}
                ${ev && ev.isVirtualUnloading ? `<div class="pt-1.5 border-t border-violet-200 mt-1"><div class="text-violet-700 font-bold text-[11px] mb-1">📦 UNLOADING RECORD</div><div class="flex justify-between text-[11px]"><span class="text-gray-500">Doc #:</span><span class="font-mono font-bold text-violet-800">${ev.activeCargo || '-'}</span></div><div class="flex justify-between text-[11px]"><span class="text-gray-500">Exempt:</span><span class="font-bold ${ev.shippingExempt ? 'text-yellow-700' : 'text-gray-500'}">${ev.shippingExempt ? 'Yes' : 'No'}</span></div>${ev.headerTvm && ev.headerTvm !== '-' ? `<div class="flex justify-between text-[11px]"><span class="text-gray-500">TVM:</span><span class="font-mono text-gray-800">${ev.headerTvm}</span></div>` : ''}${ev.headerTeh && ev.headerTeh !== '-' ? `<div class="flex justify-between text-[11px]"><span class="text-gray-500">TEH:</span><span class="font-mono text-gray-800">${ev.headerTeh}</span></div>` : ''}</div>` : ''}
                ${comment !== '-' ? `<div class="pt-1 border-t border-gray-100"><span class="text-gray-500">Коментар:</span><div class="mt-0.5 text-gray-700 italic whitespace-normal">${comment}</div></div>` : ''}
            </div>`;

        this._positionTooltip(mouseX, mouseY);
    }

    _positionTooltip(px, py) {
        const tip  = this.tooltip;
        const rect = this.canvas.getBoundingClientRect();
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

        let left = rect.left + scrollX + px + 14;
        let top  = rect.top  + scrollY + py - 20;

        const tipW = 320;
        if (left + tipW > window.innerWidth + scrollX - 16) {
            left = rect.left + scrollX + px - tipW - 14;
        }
        if (top + 200 > window.innerHeight + scrollY) {
            top = rect.top + scrollY + py - 200;
        }
        if (top < scrollY + 8) top = scrollY + 8;

        tip.style.left = left + 'px';
        tip.style.top  = top  + 'px';
    }

    // ══════════════════════════════════════════════════════════════════
    //  CANVAS EVENT HANDLING
    // ══════════════════════════════════════════════════════════════════

    _bindEvents() {
        this.canvas.addEventListener('mousemove', (e) => {
            const { offsetX, offsetY } = e;
            const idx = this._hitTest(offsetX, offsetY);
            if (idx !== -1) {
                this.canvas.style.cursor = 'pointer';
                if (idx !== this._hoveredIdx) {
                    this._hoveredIdx = idx;
                    this._showTooltip(this.hitboxes[idx], offsetX, offsetY);
                } else {
                    this._positionTooltip(offsetX, offsetY);
                }
            } else {
                this.canvas.style.cursor = 'default';
                this._hoveredIdx = -1;
                this.hideTooltip();
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.canvas.style.cursor = 'default';
            this._hoveredIdx = -1;
            this.hideTooltip();
        });

        this.canvas.addEventListener('click', (e) => {
            const { offsetX, offsetY } = e;
            const idx = this._hitTest(offsetX, offsetY);
            if (idx !== -1) {
                this._showTooltip(this.hitboxes[idx], offsetX, offsetY);
                this.tooltip.classList.remove('pointer-events-none');
                this.tooltip.classList.add('pointer-events-auto');

                const close = (ev) => {
                    if (!this.tooltip.contains(ev.target) && ev.target !== this.canvas) {
                        this.hideTooltip();
                        this.tooltip.classList.remove('pointer-events-auto');
                        this.tooltip.classList.add('pointer-events-none');
                        document.removeEventListener('mousedown', close);
                    }
                };
                setTimeout(() => document.addEventListener('mousedown', close), 0);
            }
        });
    }

    _hitTest(mx, my) {
        // Markers first (they are on top), then status segments
        for (let i = this.hitboxes.length - 1; i >= 0; i--) {
            const h = this.hitboxes[i];
            if (mx >= h.x1 && mx <= h.x2 && my >= h.y1 && my <= h.y2) return i;
        }
        return -1;
    }

    // ══════════════════════════════════════════════════════════════════
    //  HOS RECAP CALCULATION
    // ══════════════════════════════════════════════════════════════════

    _calcRecap(dateStr, statusEvents, initial) {
        const sums = { OFF: 0, SB: 0, D: 0, ON: 0 };
        let curLevel = initial.level;
        let curPC    = initial.isPC;
        let curYM    = initial.isYM;
        let prevSec  = 0;

        const active = statusEvents.filter(ev => ev.rs === '1');
        let lastType1Level = curLevel;

        const dayKey = `20${dateStr.substring(4,6)}${dateStr.substring(0,2)}${dateStr.substring(2,4)}`;
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (ev.rs !== '1') continue;
            const t = parseInt(ev.type, 10);
            if (t !== 1) continue;
            if (!ev.date || ev.date.length < 6) continue;
            const evKey = `20${ev.date.substring(4,6)}${ev.date.substring(0,2)}${ev.date.substring(2,4)}`;
            if (evKey >= dayKey) continue;
            lastType1Level = this._codeToLevel(parseInt(ev.code, 10));
            break;
        }

        const addTime = (fromSec, toSec, level, isPC, isYM) => {
            if (toSec <= fromSec) return;
            const dur = toSec - fromSec;
            if (isPC)       { sums.OFF += dur; return; }
            if (isYM)       { sums.ON  += dur; return; }
            const key = HOSChart.LEVEL_LABELS[level];
            sums[key] += dur;
        };

        active.forEach(ev => {
            const sec = HOSChart.timeToSec(ev.time);
            const t   = parseInt(ev.type, 10);
            const c   = parseInt(ev.code, 10);

            addTime(prevSec, sec, curLevel, curPC, curYM);

            let newLevel = curLevel, newPC = false, newYM = false;
            if (t === 1) { newLevel = this._codeToLevel(c); lastType1Level = newLevel; }
            else if (t === 3) {
                if (c === 1)      { newLevel = HOSChart.LEVELS.OFF; newPC = true; }
                else if (c === 2) { newLevel = HOSChart.LEVELS.ON;  newYM = true; }
                else if (c === 0) { newLevel = lastType1Level; }
            }

            curLevel = newLevel;
            curPC    = newPC;
            curYM    = newYM;
            prevSec  = sec;
        });

        let endSec = 86400;
        const today = this._todayMMDDYY();
        if (dateStr === today) {
            const now = new Date();
            endSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        }
        addTime(prevSec, endSec, curLevel, curPC, curYM);

        return sums;
    }

    /** Recap formatted as { OFF: 'HH:MM', SB: 'HH:MM', D: 'HH:MM', ON: 'HH:MM', TOTAL: 'HH:MM' } */
    getRecapFormatted() {
        const fmt = (sec) => {
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        };
        return {
            OFF:   fmt(this.recap.OFF),
            SB:    fmt(this.recap.SB),
            D:     fmt(this.recap.D),
            ON:    fmt(this.recap.ON),
            TOTAL: fmt(this.recap.OFF + this.recap.SB + this.recap.D + this.recap.ON),
        };
    }

    // ══════════════════════════════════════════════════════════════════
    //  INTERNAL — RESIZE / CLEAR / GRID
    // ══════════════════════════════════════════════════════════════════

    _resize() {
        const container = this.canvas.parentElement;
        const w = container.clientWidth;
        const h = 220;
        this.canvas.style.width  = w + 'px';
        this.canvas.style.height = h + 'px';
        this.canvas.width  = w * this.dpr;
        this.canvas.height = h * this.dpr;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.W = w; this.H = h;
        this.chartW = w - this.pad.left - this.pad.right;
        this.chartH = h - this.pad.top  - this.pad.bottom;
    }

    _clear() { this.ctx.clearRect(0, 0, this.W, this.H); }

    _drawGrid() {
        const ctx = this.ctx;
        const { left, top } = this.pad;

        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(left, top, this.chartW, this.chartH);

        ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        for (let i = 0; i < 4; i++) {
            const y = this._levelY(i);
            ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + this.chartW, y); ctx.stroke();
            ctx.fillStyle = '#6b7280'; ctx.fillText(HOSChart.LEVEL_LABELS[i], left - 6, y);
        }

        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.font = '10px ui-monospace, monospace';
        for (let h = 0; h <= 24; h++) {
            const x = this._timeX(h * 3600);
            ctx.strokeStyle = h % 6 === 0 ? '#d1d5db' : '#f3f4f6';
            ctx.lineWidth   = h % 6 === 0 ? 1 : 0.5;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + this.chartH); ctx.stroke();
            if (h % 2 === 0) {
                ctx.fillStyle = '#9ca3af';
                const label = h === 24 ? 'MN' : (h === 0 ? 'MN' : (h === 12 ? 'N' : String(h).padStart(2,'0')));
                ctx.fillText(label, x, top + this.chartH + 6);
            }
        }

        ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 0.3;
        for (let m = 0; m < 24 * 60; m += 15) {
            if (m % 60 === 0) continue;
            const x = this._timeX(m * 60);
            ctx.beginPath(); ctx.moveTo(x, top + this.chartH - 3); ctx.lineTo(x, top + this.chartH + 3); ctx.stroke();
        }

        ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1;
        ctx.strokeRect(left, top, this.chartW, this.chartH);
    }

    // ── Coordinate helpers ───────────────────────────────────────────
    _timeX(sec) { return this.pad.left + Math.min(Math.max(sec / 86400, 0), 1) * this.chartW; }
    _levelY(lvl) { return this.pad.top + lvl * (this.chartH / 3); }
    static timeToSec(t) {
        if (!t || t.length < 6) return 0;
        return parseInt(t.substring(0,2),10)*3600 + parseInt(t.substring(2,4),10)*60 + parseInt(t.substring(4,6),10);
    }

    // ── Date helpers ─────────────────────────────────────────────────
    _collectDates() {
        const s = new Set();
        this.events.forEach(ev => { if (ev.date && ev.date !== '-' && ev.date.length === 6) s.add(ev.date); });
        return [...s].sort((a, b) => {
            const ka = `20${a.substring(4,6)}${a.substring(0,2)}${a.substring(2,4)}`;
            const kb = `20${b.substring(4,6)}${b.substring(0,2)}${b.substring(2,4)}`;
            return ka.localeCompare(kb);
        });
    }

    _filterDay(dateStr) {
        const statusEvents = [], markerEvents = [];
        this.events.forEach(ev => {
            if (ev.date !== dateStr) return;
            const t = parseInt(ev.type, 10);
            // Virtual unloading (type=99) and all non-status types go to markers
            if (!ev.isVirtualUnloading && (t === 1 || t === 3)) {
                statusEvents.push(ev);
            } else {
                markerEvents.push(ev);
            }
        });
        return { statusEvents, markerEvents };
    }

    _lookBackStatus(dateStr) {
        const dayKey = `20${dateStr.substring(4,6)}${dateStr.substring(0,2)}${dateStr.substring(2,4)}`;
        let lastLevel = HOSChart.LEVELS.OFF, lastIsPC = false, lastIsYM = false;
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (ev.rs !== '1') continue;
            const t = parseInt(ev.type, 10);
            if (t !== 1 && t !== 3) continue;
            if (!ev.date || ev.date.length < 6) continue;
            const evKey = `20${ev.date.substring(4,6)}${ev.date.substring(0,2)}${ev.date.substring(2,4)}`;
            if (evKey >= dayKey) continue;
            if (t === 1) { lastLevel = this._codeToLevel(parseInt(ev.code,10)); break; }
            else if (t === 3) {
                const c = parseInt(ev.code,10);
                if (c === 1) { lastLevel = HOSChart.LEVELS.OFF; lastIsPC = true; }
                else if (c === 2) { lastLevel = HOSChart.LEVELS.ON; lastIsYM = true; }
                break;
            }
        }
        return { level: lastLevel, isPC: lastIsPC, isYM: lastIsYM };
    }

    _codeToLevel(code) {
        if (code === 1) return HOSChart.LEVELS.OFF;
        if (code === 2) return HOSChart.LEVELS.SB;
        if (code === 3) return HOSChart.LEVELS.D;
        if (code === 4) return HOSChart.LEVELS.ON;
        return HOSChart.LEVELS.OFF;
    }
    _levelToColorKey(lvl) { return HOSChart.LEVEL_LABELS[lvl]; }

    // ══════════════════════════════════════════════════════════════════
    //  STATUS LINE DRAWING (with hitbox registration)
    // ══════════════════════════════════════════════════════════════════

    _drawStatusLine(statusEvents, initial, dateStr) {
        const ctx = this.ctx;
        let curLevel = initial.level;
        let curPC    = initial.isPC;
        let curYM    = initial.isYM;
        let prevSec  = 0;
        let prevEv   = null;

        const active = statusEvents.filter(ev => ev.rs === '1');
        let lastType1Level = curLevel;

        const dayKey = `20${dateStr.substring(4,6)}${dateStr.substring(0,2)}${dateStr.substring(2,4)}`;
        for (let i = this.events.length - 1; i >= 0; i--) {
            const ev = this.events[i];
            if (ev.rs !== '1') continue;
            const t = parseInt(ev.type, 10);
            if (t !== 1) continue;
            if (!ev.date || ev.date.length < 6) continue;
            const evKey = `20${ev.date.substring(4,6)}${ev.date.substring(0,2)}${ev.date.substring(2,4)}`;
            if (evKey >= dayKey) continue;
            lastType1Level = this._codeToLevel(parseInt(ev.code,10));
            break;
        }

        // Collect violation segments for overlay pass
        const violationSegments = [];

        active.forEach(ev => {
            const sec = HOSChart.timeToSec(ev.time);
            const t   = parseInt(ev.type, 10);
            const c   = parseInt(ev.code, 10);

            // Check if the PREVIOUS segment was a DRIVING segment with violations
            if (prevEv && prevEv.violations && prevEv.violations.length > 0 && curLevel === HOSChart.LEVELS.D) {
                violationSegments.push({ fromSec: prevSec, toSec: sec, violations: prevEv.violations });
            }

            this._drawHSegment(prevSec, sec, curLevel, curPC, curYM);
            this._registerStatusHitbox(prevSec, sec, curLevel, curPC, curYM, prevEv);

            let newLevel = curLevel, newPC = false, newYM = false;
            if (t === 1) { newLevel = this._codeToLevel(c); lastType1Level = newLevel; }
            else if (t === 3) {
                if (c === 1)      { newLevel = HOSChart.LEVELS.OFF; newPC = true; }
                else if (c === 2) { newLevel = HOSChart.LEVELS.ON;  newYM = true; }
                else if (c === 0) { newLevel = lastType1Level; }
            }

            if (newLevel !== curLevel) this._drawVSegment(sec, curLevel, newLevel);

            curLevel = newLevel;
            curPC    = newPC;
            curYM    = newYM;
            prevSec  = sec;
            prevEv   = ev;
        });

        let endSec = 86400;
        const today = this._todayMMDDYY();
        if (dateStr === today) {
            const now = new Date();
            endSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        }

        // Check last segment for violations
        if (prevEv && prevEv.violations && prevEv.violations.length > 0 && curLevel === HOSChart.LEVELS.D) {
            violationSegments.push({ fromSec: prevSec, toSec: endSec, violations: prevEv.violations });
        }

        this._drawHSegment(prevSec, endSec, curLevel, curPC, curYM);
        this._registerStatusHitbox(prevSec, endSec, curLevel, curPC, curYM, prevEv);

        // ── Draw violation overlay (thick red line on Driving level) ─
        if (violationSegments.length > 0) {
            const y = this._levelY(HOSChart.LEVELS.D);
            ctx.save();
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 4.5;
            ctx.setLineDash([]);
            ctx.globalAlpha = 0.85;
            violationSegments.forEach(seg => {
                const x1 = this._timeX(seg.fromSec);
                const x2 = this._timeX(seg.toSec);
                ctx.beginPath();
                ctx.moveTo(x1, y);
                ctx.lineTo(x2, y);
                ctx.stroke();

                // Draw small warning triangles at the start of each violation segment
                ctx.fillStyle = '#dc2626';
                ctx.globalAlpha = 1;
                this._drawTriangle(x1 + 6, y - 10, 5);
                ctx.globalAlpha = 0.85;
            });

            // Draw a subtle red glow behind violation segments
            ctx.globalAlpha = 0.08;
            ctx.fillStyle = '#dc2626';
            violationSegments.forEach(seg => {
                const x1 = this._timeX(seg.fromSec);
                const x2 = this._timeX(seg.toSec);
                ctx.fillRect(x1, this.pad.top, x2 - x1, this.chartH);
            });
            ctx.restore();
        }

        // Inactive diamonds
        const inactive = statusEvents.filter(ev => ev.rs === '2');
        if (inactive.length > 0) {
            ctx.save(); ctx.globalAlpha = 0.25;
            inactive.forEach(ev => {
                const sec = HOSChart.timeToSec(ev.time);
                const t = parseInt(ev.type,10), c = parseInt(ev.code,10);
                let lvl = HOSChart.LEVELS.OFF;
                if (t === 1) lvl = this._codeToLevel(c);
                else if (t === 3) { if (c === 1) lvl = HOSChart.LEVELS.OFF; else if (c === 2) lvl = HOSChart.LEVELS.ON; }
                const x = this._timeX(sec), y = this._levelY(lvl);
                ctx.fillStyle = HOSChart.STATUS_COLORS[this._levelToColorKey(lvl)];
                ctx.beginPath();
                ctx.moveTo(x, y-6); ctx.lineTo(x+5, y); ctx.lineTo(x, y+6); ctx.lineTo(x-5, y);
                ctx.closePath(); ctx.fill();

                this.hitboxes.push({
                    x1: x-7, x2: x+7, y1: y-8, y2: y+8,
                    type: 'marker', ev, startSec: sec, endSec: sec,
                    level: lvl, isPC: false, isYM: false
                });
            });
            ctx.restore();
        }
    }

    _registerStatusHitbox(fromSec, toSec, level, isPC, isYM, ev) {
        if (toSec <= fromSec) return;
        const x1 = this._timeX(fromSec), x2 = this._timeX(toSec);
        const y  = this._levelY(level);
        const hitH = 14;
        this.hitboxes.push({
            x1, x2, y1: y - hitH, y2: y + hitH,
            type: 'status', ev,
            startSec: fromSec, endSec: toSec,
            level, isPC, isYM
        });
    }

    _drawHSegment(fromSec, toSec, level, isPC, isYM) {
        if (toSec <= fromSec) return;
        const ctx = this.ctx;
        const x1 = this._timeX(fromSec), x2 = this._timeX(toSec);
        const y = this._levelY(level);
        const colorKey = this._levelToColorKey(level);

        ctx.save();
        ctx.lineWidth   = 2.5;
        ctx.strokeStyle = HOSChart.STATUS_COLORS[colorKey];
        if (isPC || isYM) { ctx.setLineDash([6, 4]); ctx.lineWidth = 2; }
        else { ctx.setLineDash([]); }

        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();

        ctx.globalAlpha = 0.07;
        ctx.fillStyle   = HOSChart.STATUS_COLORS[colorKey];
        ctx.fillRect(x1, y, x2 - x1, this.pad.top + this.chartH - y);
        ctx.restore();
    }

    _drawVSegment(sec, fromLevel, toLevel) {
        const ctx = this.ctx;
        const x = this._timeX(sec), y1 = this._levelY(fromLevel), y2 = this._levelY(toLevel);
        ctx.save();
        ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
        ctx.restore();
    }

    // ══════════════════════════════════════════════════════════════════
    //  MARKER DRAWING (with hitbox registration)
    // ══════════════════════════════════════════════════════════════════

    _drawMarkers(markerEvents, dateStr) {
        const ctx = this.ctx;
        markerEvents.forEach(ev => {
            const sec = HOSChart.timeToSec(ev.time);
            const x   = this._timeX(sec);
            const t   = parseInt(ev.type, 10);
            const c   = parseInt(ev.code, 10);
            const inactive = ev.rs === '2';

            ctx.save();
            if (inactive) ctx.globalAlpha = 0.3;

            let markerY = this.pad.top + this.chartH + 18;
            const markerR = 7;

            // Virtual unloading from header (type = '99')
            if (ev.isVirtualUnloading) {
                this._drawUnloadingMark(x);
                markerY = this.pad.top + this.chartH + 18;
            } else {
                switch (t) {
                    case 2: {
                        const ly = this._guessCurrentLevelY(sec, dateStr);
                        this._drawDot(x, ly, '#22c55e', 3);
                        markerY = ly;
                        break;
                    }
                    case 4:
                        this._drawCertMark(x);
                        break;
                    case 5:
                        this._drawLoginLogout(x, c);
                        markerY = this.pad.top + this.chartH + 30;
                        break;
                    case 6:
                        this._drawPowerEvent(x, c);
                        break;
                    case 7:
                        this._drawMalfunctionDiag(x, c);
                        markerY = this.pad.top + this.chartH + 22;
                        break;
                    case 9:
                        this._drawFleetMark(x);
                        break;
                    default:
                        this._drawDot(x, this.pad.top + this.chartH, '#9ca3af', 2);
                        break;
                }
            }
            ctx.restore();

            this.hitboxes.push({
                x1: x - markerR, x2: x + markerR,
                y1: markerY - markerR, y2: markerY + markerR,
                type: 'marker', ev,
                startSec: sec, endSec: sec,
                level: -1, isPC: false, isYM: false
            });
        });
    }

    _guessCurrentLevelY(sec, dateStr) {
        let level = HOSChart.LEVELS.OFF;
        for (const ev of this.events) {
            if (ev.rs !== '1') continue;
            const t = parseInt(ev.type, 10);
            if (t !== 1 && t !== 3) continue;
            const evDK = ev.date ? `20${ev.date.substring(4,6)}${ev.date.substring(0,2)}${ev.date.substring(2,4)}` : '';
            const curDK = dateStr ? `20${dateStr.substring(4,6)}${dateStr.substring(0,2)}${dateStr.substring(2,4)}` : '';
            if (evDK > curDK) break;
            if (evDK === curDK && HOSChart.timeToSec(ev.time) > sec) break;
            if (t === 1) level = this._codeToLevel(parseInt(ev.code,10));
            else if (t === 3) { const c = parseInt(ev.code,10); if (c===1) level = HOSChart.LEVELS.OFF; else if (c===2) level = HOSChart.LEVELS.ON; }
        }
        return this._levelY(level);
    }

    // ── Marker draw helpers ──────────────────────────────────────────
    _drawDot(x, y, color, r) {
        this.ctx.fillStyle = color; this.ctx.beginPath(); this.ctx.arc(x, y, r, 0, Math.PI*2); this.ctx.fill();
    }
    _drawCertMark(x) {
        const ctx = this.ctx, y = this.pad.top + this.chartH + 18;
        ctx.fillStyle = '#3b82f6'; ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('✔', x, y);
    }
    _drawLoginLogout(x, code) {
        const ctx = this.ctx, y = this.pad.top + this.chartH + 30;
        ctx.fillStyle = code === 1 ? '#0d9488' : '#f97316';
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(code === 1 ? '→' : '←', x, y);
    }
    _drawPowerEvent(x, code) {
        const ctx = this.ctx, isPU = code === 1, color = isPU ? '#16a34a' : '#dc2626';
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = (ctx.globalAlpha||1)*0.4;
        ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(x, this.pad.top + this.chartH); ctx.lineTo(x, this.pad.top); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = color; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(isPU ? '⚡' : '⏻', x, this.pad.top + this.chartH + 18);
    }
    _drawMalfunctionDiag(x, code) {
        const ctx = this.ctx, baseY = this.pad.top + this.chartH + 18;
        ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (code === 1)      { ctx.fillStyle = '#dc2626'; this._drawTriangle(x, baseY, 6); ctx.fillText('M', x, baseY+12); }
        else if (code === 2) { ctx.fillStyle = '#16a34a'; ctx.beginPath(); ctx.arc(x,baseY,5,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#fff'; ctx.fillText('M',x,baseY); }
        else if (code === 3) { ctx.fillStyle = '#d97706'; this._drawTriangle(x, baseY, 6); ctx.fillText('D', x, baseY+12); }
        else if (code === 4) { ctx.fillStyle = '#65a30d'; ctx.beginPath(); ctx.arc(x,baseY,5,0,Math.PI*2); ctx.fill(); ctx.fillStyle='#fff'; ctx.fillText('D',x,baseY); }
    }
    _drawTriangle(x, y, s) {
        const ctx = this.ctx; ctx.beginPath();
        ctx.moveTo(x, y-s); ctx.lineTo(x+s, y+s*0.6); ctx.lineTo(x-s, y+s*0.6); ctx.closePath(); ctx.fill();
    }
    _drawFleetMark(x) {
        const ctx = this.ctx, y = this.pad.top + this.chartH + 18;
        ctx.fillStyle = '#9ca3af'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill();
    }

    /** Unloading marker — violet diamond with down-arrow */
    _drawUnloadingMark(x) {
        const ctx = this.ctx, y = this.pad.top + this.chartH + 18;
        const s = 7;
        // Violet diamond
        ctx.fillStyle = '#8b5cf6';
        ctx.beginPath();
        ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
        ctx.closePath(); ctx.fill();
        // Border
        ctx.strokeStyle = '#6d28d9'; ctx.lineWidth = 1; ctx.stroke();
        // White "U" letter
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 7px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('U', x, y);
    }

    // ── Formatting helpers ───────────────────────────────────────────
    _todayMMDDYY() {
        const d = new Date();
        return String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + String(d.getFullYear()).substring(2);
    }

    _secToHHMMSS(sec) {
        const s = Math.max(0, Math.min(86400, Math.round(sec)));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    }

    _formatDuration(sec) {
        const s = Math.max(0, Math.round(sec));
        const hh = Math.floor(s / 3600);
        const mm = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    }

    _statusLabel(level, isPC, isYM) {
        if (isPC) return 'Personal Conveyance (OFF)';
        if (isYM) return 'Yard Move (ON)';
        return HOSChart.LEVEL_NAMES[level] || 'Unknown';
    }

    _eventLabel(ev) {
        if (ev.isVirtualUnloading) return 'Unloading Record';
        const t = parseInt(ev.type, 10), c = parseInt(ev.code, 10);
        if (t === 1) {
            if (c === 1) return 'OFF DUTY';
            if (c === 2) return 'SLEEPER BERTH';
            if (c === 3) return 'DRIVING';
            if (c === 4) return 'ON DUTY';
        }
        if (t === 2) return 'Intermediate Log';
        if (t === 3) {
            if (c === 0) return 'Cleared (PC/YM)';
            if (c === 1) return 'Personal Conveyance';
            if (c === 2) return 'Yard Move';
        }
        if (t === 4) return 'Driver Certification';
        if (t === 5) return c === 1 ? 'ELD Login' : 'ELD Logout';
        if (t === 6) return c === 1 ? 'Engine Power-Up' : 'Engine Power-Down';
        if (t === 7) {
            if (c === 1) return 'Malfunction Logged';
            if (c === 2) return 'Malfunction Cleared';
            if (c === 3) return 'Data Diagnostic Logged';
            if (c === 4) return 'Data Diagnostic Cleared';
        }
        if (t === 9) return `Fleet Event (Code ${c})`;
        return `Type ${t}, Code ${c}`;
    }
}
