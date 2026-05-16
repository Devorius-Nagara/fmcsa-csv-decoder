/**
 * HOSValidator — FMCSA Hours of Service rules engine (Property-Carrying, USA).
 *
 * Correctly implements the 2020 FMCSA Split Sleeper Berth update:
 *   • Any qualifying break (≥ 2 h OFF/SB) FREEZES the 14-hour shift clock.
 *   • Breaks < 2 h count against the 14-hour window normally.
 *   • When two qualifying breaks form a valid pair (sum ≥ 10 h, one ≥ 7 h SB),
 *     the 11 h and 14 h clocks are recalculated — only time BETWEEN the two
 *     breaks counts.
 *
 * Also implements:
 *   • 8 h / 30-Minute Break Rule
 *   • 70-Hour / 8-Day Cycle
 *   • 10-Hour Full Reset
 *   • 34-Hour Restart
 *   • Adverse Driving Conditions exception (11→13, 14→16)
 *   • 150 Air-Mile / 16-Hour Short-Haul exception (14→16)
 *
 * Tolerance: 0.05 h (~3 min) added to every limit check to avoid false
 * positives caused by floating-point arithmetic.
 */
class HOSValidator {

    // ══════════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════════

    /** MMDDYY + HHMMSS → epoch ms (or null) */
    static _toEpoch(dateStr, timeStr) {
        if (!dateStr || !timeStr || dateStr.length < 6 || timeStr.length < 6) return null;
        const mo = parseInt(dateStr.substring(0, 2), 10) - 1;
        const da = parseInt(dateStr.substring(2, 4), 10);
        const yr = 2000 + parseInt(dateStr.substring(4, 6), 10);
        const hh = parseInt(timeStr.substring(0, 2), 10);
        const mm = parseInt(timeStr.substring(2, 4), 10);
        const ss = parseInt(timeStr.substring(4, 6), 10);
        return new Date(yr, mo, da, hh, mm, ss).getTime();
    }

    /** ms → hours */
    static _msToH(ms) { return ms / 3_600_000; }
    /** hours → ms */
    static _hToMs(h)  { return h * 3_600_000; }

    /**
     * Classify an active Type 1 / Type 3 event into a duty status.
     * PC → OFF, YM → ON, Cleared (code 0) → null (caller resolves).
     */
    static _classifyStatus(ev) {
        const t = parseInt(ev.type, 10);
        const c = parseInt(ev.code, 10);
        if (t === 1) {
            if (c === 1) return 'OFF';
            if (c === 2) return 'SB';
            if (c === 3) return 'D';
            if (c === 4) return 'ON';
        }
        if (t === 3) {
            if (c === 1) return 'OFF';   // Personal Conveyance
            if (c === 2) return 'ON';    // Yard Move
            if (c === 0) return null;    // Cleared — resolve from last type-1
        }
        return null;
    }

    static _isOffGroup(s) { return s === 'OFF' || s === 'SB'; }

    /** Adverse-driving keyword scan */
    static _isAdverseTrigger(text) {
        if (!text) return false;
        return /adverse|weather|snow|ice|storm|flood|accident|delay|fog|hurricane/i.test(text);
    }

    /** Short-haul / 16-hour keyword scan */
    static _isShortHaulTrigger(text) {
        if (!text) return false;
        return /short.?haul|16.?hour|16.?hr|150.?air.?mile/i.test(text);
    }

    // ══════════════════════════════════════════════════════════════════
    //  MAIN VALIDATION ENGINE
    // ══════════════════════════════════════════════════════════════════

    /**
     * Walk unifiedList chronologically, simulate HOS clocks,
     * and populate ev.violations for every DRIVING event that is in breach.
     *
     * @param {Array}  unifiedList    — sorted by sortKey, enriched
     * @param {Object} annotationsMap — { seqId: commentText }
     * @returns {Array} same list, mutated
     */
    static validate(unifiedList, annotationsMap = {}) {

        // ── Initialise violations on ALL events ──────────────────────
        for (const ev of unifiedList) ev.violations = [];

        // ── Build a filtered list of active status-change events ─────
        // We iterate only Type 1 / Type 3, rs === '1'.
        // Each entry gets an epoch timestamp and resolved status.
        /** @type {Array<{idx:number, ev:object, epoch:number, status:string}>} */
        const timeline = [];
        let lastT1Status = 'OFF';

        for (let i = 0; i < unifiedList.length; i++) {
            const ev    = unifiedList[i];
            const epoch = HOSValidator._toEpoch(ev.date, ev.time);
            if (epoch === null) continue;
            if (ev.rs !== '1') continue;

            const t = parseInt(ev.type, 10);
            if (t !== 1 && t !== 3) continue;
            // Type 9 (fleet events / shipping / unloading) are transparent to HOS
            if (t === 9) continue;

            let status = HOSValidator._classifyStatus(ev);
            if (status === null) status = lastT1Status; // Cleared
            if (t === 1) lastT1Status = status;

            timeline.push({ idx: i, ev, epoch, status });
        }

        if (timeline.length === 0) return unifiedList;

        // ── Merge consecutive OFF/SB segments into unified rest blocks ─
        // A rest period like OFF(3h) → SB(5h) must be treated as one 8h
        // block. We build a higher-level "block" list where each block is
        // either a merged rest (with combined duration, SB sub-segment
        // tracking) or a single D/ON segment.
        /**
         * @typedef  {Object} Block
         * @property {string}  type       - 'REST' | 'D' | 'ON'
         * @property {number}  startEpoch
         * @property {number}  endEpoch
         * @property {number}  durH       - total hours
         * @property {boolean} hasSB7     - (REST only) contains ≥7 h pure SB sub-segment
         * @property {number}  maxSBsubH  - (REST only) longest continuous SB sub-segment hrs
         * @property {object}  ev         - the FIRST timeline entry's event (for REST, first OFF/SB)
         * @property {Array}   entries    - all timeline entries in this block
         */
        /** @type {Block[]} */
        const blocks = [];
        let bi = 0;
        while (bi < timeline.length) {
            const entry = timeline[bi];
            if (HOSValidator._isOffGroup(entry.status)) {
                // Collect consecutive OFF/SB entries
                const restEntries = [entry];
                let rEnd = bi + 1;
                while (rEnd < timeline.length && HOSValidator._isOffGroup(timeline[rEnd].status)) {
                    restEntries.push(timeline[rEnd]);
                    rEnd++;
                }
                // Compute total rest duration
                const lastEntry = restEntries[restEntries.length - 1];
                const afterRest = timeline[rEnd] || null;
                const restEndEpoch = afterRest ? afterRest.epoch : lastEntry.epoch;
                const totalDurH = HOSValidator._msToH(restEndEpoch - entry.epoch);

                // Find longest continuous SB sub-segment
                let maxSBsubH = 0;
                for (let ri = 0; ri < restEntries.length; ri++) {
                    if (restEntries[ri].status === 'SB') {
                        const sbEnd = (ri + 1 < restEntries.length)
                            ? restEntries[ri + 1].epoch
                            : restEndEpoch;
                        const sbH = HOSValidator._msToH(sbEnd - restEntries[ri].epoch);
                        if (sbH > maxSBsubH) maxSBsubH = sbH;
                    }
                }

                blocks.push({
                    type:       'REST',
                    startEpoch: entry.epoch,
                    endEpoch:   restEndEpoch,
                    durH:       totalDurH,
                    hasSB7:     maxSBsubH >= 7,
                    maxSBsubH,
                    ev:         entry.ev,
                    entries:    restEntries,
                });
                bi = rEnd;
            } else {
                // D or ON — single-entry block
                const nextEntry = timeline[bi + 1] || null;
                const endEp = nextEntry ? nextEntry.epoch : entry.epoch;
                blocks.push({
                    type:       entry.status, // 'D' or 'ON'
                    startEpoch: entry.epoch,
                    endEpoch:   endEp,
                    durH:       HOSValidator._msToH(endEp - entry.epoch),
                    hasSB7:     false,
                    maxSBsubH:  0,
                    ev:         entry.ev,
                    entries:    [entry],
                });
                bi++;
            }
        }

        // ── HOS clocks (all in HOURS for readability) ────────────────
        let drive11 = 0;            // accumulated driving hours since last reset
        let shift14 = 0;            // accumulated shift-window hours (excl. frozen breaks)
        let driveSinceBreak = 0;    // driving hours since last ≥30 min non-driving
        let nonDriveAccum = 0;      // running non-driving accumulator for 30-min rule (hours)

        // 70-hour / 8-day cycle — daily totals Map<dayKeyMs, hours>
        const dailyDuty = new Map();

        // ── Split Sleeper Berth state ────────────────────────────────
        /**
         * Each qualifying break (≥ 2 h in OFF/SB) is stored here with a
         * snapshot of the clocks AT THE END of that break.
         * isSB means the break contains a ≥7h pure SB sub-segment.
         *
         * @type {Array<{durH: number, isSB: boolean,
         *               driveAtEnd: number, shiftAtEnd: number}>}
         */
        let qualBreaks = [];

        // ── Exception flags ──────────────────────────────────────────
        let adverseActive       = false;
        let shortHaulActive     = false;
        let shortHaulUsedWeek   = false;

        // ── Scan all annotations once for shift-level exception flags ─
        for (const ev of unifiedList) {
            const c = annotationsMap[ev.seq] || '';
            if (HOSValidator._isAdverseTrigger(c)) adverseActive = true;
            if (HOSValidator._isShortHaulTrigger(c) && !shortHaulUsedWeek) shortHaulActive = true;
        }

        // ── Walk blocks ──────────────────────────────────────────────
        for (let blkI = 0; blkI < blocks.length; blkI++) {
            const blk = blocks[blkI];

            // ─── REST block (merged consecutive OFF/SB) ──────────────
            if (blk.type === 'REST') {
                const durH = blk.durH;

                // (a) Full reset: ≥ 10 hours
                if (durH >= 10) {
                    drive11 = 0;
                    shift14 = 0;
                    driveSinceBreak = 0;
                    nonDriveAccum = 0;
                    qualBreaks = [];
                    adverseActive = false;
                    shortHaulActive = false;

                    // 34-hour restart also clears 70 h cycle
                    if (durH >= 34) dailyDuty.clear();
                }
                // (b) Qualifying break: ≥ 2 hours → FREEZES 14 h clock
                else if (durH >= 2) {
                    // shift14 is NOT incremented (frozen!)

                    const breakInfo = {
                        durH,
                        isSB:       blk.hasSB7,
                        driveAtEnd: drive11,
                        shiftAtEnd: shift14,
                    };

                    // ── Try to form a Split Pair with a previous break ──
                    let paired = false;
                    if (qualBreaks.length > 0) {
                        const prev = qualBreaks[qualBreaks.length - 1];
                        const sumH = prev.durH + breakInfo.durH;
                        const hasLongSB = prev.isSB || breakInfo.isSB;

                        if (sumH >= 10 && hasLongSB) {
                            // ══ SPLIT PAIR FORMED ══
                            drive11 = breakInfo.driveAtEnd - prev.driveAtEnd;
                            shift14 = breakInfo.shiftAtEnd - prev.shiftAtEnd;

                            // Rolling chain: current break becomes base for next
                            qualBreaks = [{
                                durH:       breakInfo.durH,
                                isSB:       breakInfo.isSB,
                                driveAtEnd: drive11,
                                shiftAtEnd: shift14,
                            }];
                            paired = true;
                        }
                    }

                    if (!paired) {
                        qualBreaks.push(breakInfo);
                        if (qualBreaks.length > 2) qualBreaks.shift();
                    }

                    // 30-min break rule
                    if (durH >= 0.5) driveSinceBreak = 0;
                    nonDriveAccum += durH;
                }
                // (c) Short break: < 2 hours → 14h clock keeps ticking
                else {
                    shift14 += durH;
                    nonDriveAccum += durH;
                    if (nonDriveAccum >= 0.5) driveSinceBreak = 0;
                }
            }

            // ─── ON DUTY block ───────────────────────────────────────
            else if (blk.type === 'ON') {
                shift14 += blk.durH;

                if (blk.durH > 0) {
                    HOSValidator._addDailyDuty(dailyDuty, blk.startEpoch, blk.endEpoch);
                }

                nonDriveAccum += blk.durH;
                if (nonDriveAccum >= 0.5) driveSinceBreak = 0;
            }

            // ─── DRIVING block ───────────────────────────────────────
            else if (blk.type === 'D') {
                nonDriveAccum = 0;

                const TOL = 0.05;
                const driveLimit  = adverseActive ? 13 : 11;
                const shiftLimit  = (adverseActive || shortHaulActive) ? 16 : 14;
                const breakLimitH = 8;

                // Check violations BEFORE adding this segment
                if (drive11 >= driveLimit - TOL) {
                    blk.ev.violations.push(
                        adverseActive ? '13-Hour Limit (Adverse)' : '11-Hour Limit'
                    );
                }

                if (shift14 >= shiftLimit - TOL) {
                    if (shortHaulActive) {
                        blk.ev.violations.push('16-Hour Limit (Short-Haul)');
                        shortHaulUsedWeek = true;
                    } else if (adverseActive) {
                        blk.ev.violations.push('16-Hour Window (Adverse)');
                    } else {
                        blk.ev.violations.push('14-Hour Limit');
                    }
                }

                if (driveSinceBreak >= breakLimitH - TOL) {
                    blk.ev.violations.push('30-Minute Break');
                }

                const rolling70 = HOSValidator._calcRolling8Day(dailyDuty, blk.startEpoch);
                if (rolling70 >= 70 - TOL) {
                    blk.ev.violations.push('70-Hour/8-Day');
                }

                // Accumulate
                drive11         += blk.durH;
                shift14         += blk.durH;
                driveSinceBreak += blk.durH;

                if (blk.durH > 0) {
                    HOSValidator._addDailyDuty(dailyDuty, blk.startEpoch, blk.endEpoch);
                }
            }
        }

        return unifiedList;
    }

    // ══════════════════════════════════════════════════════════════════
    //  70-HOUR / 8-DAY HELPERS
    // ══════════════════════════════════════════════════════════════════

    /**
     * Add on-duty (or driving) time to daily accumulator.
     * Handles segments that span midnight.
     */
    static _addDailyDuty(map, startMs, endMs) {
        if (endMs <= startMs) return;
        let cur = startMs;
        while (cur < endMs) {
            const d = new Date(cur);
            d.setHours(0, 0, 0, 0);
            const dayKey  = d.getTime();
            const nextDay = dayKey + 86_400_000;
            const segEnd  = Math.min(endMs, nextDay);
            const durH    = HOSValidator._msToH(segEnd - cur);
            map.set(dayKey, (map.get(dayKey) || 0) + durH);
            cur = segEnd;
        }
    }

    /**
     * Rolling 8-day sum of on-duty + driving hours.
     */
    static _calcRolling8Day(map, nowMs) {
        const d = new Date(nowMs);
        d.setHours(0, 0, 0, 0);
        const todayKey = d.getTime();
        let total = 0;
        for (let i = 0; i < 8; i++) {
            total += map.get(todayKey - i * 86_400_000) || 0;
        }
        return total;
    }

    // ══════════════════════════════════════════════════════════════════
    //  UTILITY
    // ══════════════════════════════════════════════════════════════════

    /** Count violations across all events (for UI badge). */
    static countViolations(unifiedList) {
        let total = 0;
        const byType = {};
        for (const ev of unifiedList) {
            if (ev.violations && ev.violations.length > 0) {
                total += ev.violations.length;
                for (const v of ev.violations) {
                    byType[v] = (byType[v] || 0) + 1;
                }
            }
        }
        return { total, byType };
    }
}

