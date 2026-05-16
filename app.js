// --- ПАРСЕР ТА ОБРОБКА ДАНИХ (ВБУДОВАНИЙ) ---
class ELDParser {
    static parse(csvText) {
        const lines = csvText.split(/\r\n|\n|\r/);
        const result = {
            headerSegment: [], userList: [], cmvList: [], events: [],
            annotations: [], malfunctions: [], powerEvents: [], unidentified: [], unknown: [],
            annotationsMap: {}, drivers: [], trucks: [],
            // ── NEW: Shipping / Unloading data from Header ──
            shippingDoc: null,   // { docNumber, exempt }
            unloadingRecord: null // { date, time, lat, lon, tvm, teh }
        };
        let currentSection = 'headerSegment';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const lineUpper = line.toUpperCase();

            if (lineUpper.includes('ELD FILE HEADER SEGMENT')) { currentSection = 'headerSegment'; continue; }
            else if (lineUpper.includes('USER LIST')) { currentSection = 'userList'; continue; }
            else if (lineUpper.includes('CMV LIST')) { currentSection = 'cmvList'; continue; }
            else if (lineUpper.includes('ELD EVENT LIST')) { currentSection = 'events'; continue; }
            else if (lineUpper.includes('EVENT ANNOTATIONS OR COMMENTS')) { currentSection = 'annotations'; continue; }
            else if (lineUpper.includes('MALFUNCTIONS AND DATA DIAGNOSTIC')) { currentSection = 'malfunctions'; continue; }
            else if (lineUpper.includes('ENGINE POWER-UP AND SHUT DOWN')) { currentSection = 'powerEvents'; continue; }
            else if (lineUpper.includes('UNIDENTIFIED DRIVER PROFILE')) { currentSection = 'unidentified'; continue; }
            else if (lineUpper.includes('CERTIFICATION') || lineUpper.includes('LOGIN')) { currentSection = 'unknown'; continue; }

            const parsedLine = this.parseCSVLine(line);

            if (currentSection === 'unknown' && parsedLine.length >= 10) {
                const typeC = parseInt(parsedLine[3], 10);
                const codeC = parseInt(parsedLine[4], 10);
                if (!isNaN(typeC) && !isNaN(codeC) && typeC >= 1 && typeC <= 7) {
                    currentSection = 'events';
                }
            }

            if (result[currentSection]) {
                result[currentSection].push(parsedLine);
                if (currentSection === 'annotations' && parsedLine.length >= 3) {
                    const seqId = parsedLine[0];
                    const commentText = parsedLine[2];
                    if (seqId && commentText) result.annotationsMap[seqId] = commentText;
                }
            } else if (currentSection === 'unknown') {
                result.unknown.push(parsedLine);
            }
        }

        // ── Parse Shipping Line (headerSegment[4]) ───────────────────
        // Format: docNumber, exemptIndicator, [dataCheck]
        // Example: "11890,0,0E" → doc=11890, exempt field contains '0' (not E)
        if (result.headerSegment[4] && result.headerSegment[4].length >= 1) {
            const shipRow = result.headerSegment[4];
            const docNum = (shipRow[0] || '').trim();
            if (docNum && docNum !== '0' && docNum !== '') {
                // Check for Exempt indicator: scan fields for 'E' character
                // The exempt indicator is typically in field[1] or embedded
                let exempt = false;
                for (let f = 1; f < shipRow.length; f++) {
                    const val = (shipRow[f] || '').trim().toUpperCase();
                    if (val === 'E') { exempt = true; break; }
                    // "0E" pattern: last 2 chars of a field, hex checksum — don't confuse
                    // Only flag exempt if the standalone field is exactly 'E'
                }
                result.shippingDoc = { docNumber: docNum, exempt };
            }
        }

        // ── Parse Time/Place Unloading Line (headerSegment[5]) ───────
        // Format: MMDDYY, HHMMSS, lat, lon, TVM, TEH, dataCheck
        // Example: "022426,162743,46.25,-119.86,257983,6293.1,D2"
        if (result.headerSegment[5] && result.headerSegment[5].length >= 6) {
            const tpRow = result.headerSegment[5];
            const date = (tpRow[0] || '').trim();
            const time = (tpRow[1] || '').trim();
            if (date.length === 6 && time.length === 6 && /^\d{6}$/.test(date) && /^\d{6}$/.test(time)) {
                result.unloadingRecord = {
                    date, time,
                    lat: (tpRow[2] || '-').trim(),
                    lon: (tpRow[3] || '-').trim(),
                    tvm: (tpRow[4] || '-').trim(),
                    teh: (tpRow[5] || '-').trim()
                };
            }
        }

        // Drivers
        const headerDrivers = [];
        for (let i = 0; i < 2; i++) {
            const hRow = result.headerSegment[i];
            if (hRow && hRow.length >= 2 && hRow[0]) {
                headerDrivers.push({ lastName: hRow[0], firstName: hRow[1], id: hRow[2] || '', state: hRow[3] || '', lic: hRow[4] || '' });
            }
        }

        const driverIds = new Set();
        if (result.userList.length > 0) {
            result.userList.forEach(user => {
                let lastName = '', firstName = '';
                if (user.length >= 4 && /^\d+$/.test(user[0])) {
                    lastName = user[2] || ''; firstName = user[3] || '';
                } else if (user.length >= 3) {
                    lastName = user[1] || ''; firstName = user[2] || '';
                }
                if (lastName || firstName) {
                    let id = '', state = '', lic = '';
                    const matchedDriver = headerDrivers.find(d => d.lastName === lastName && d.firstName === firstName);
                    if (matchedDriver) { id = matchedDriver.id; state = matchedDriver.state; lic = matchedDriver.lic; }
                    const uniqueKey = `${lastName}_${firstName}_${id}`;
                    if (!driverIds.has(uniqueKey)) {
                        result.drivers.push([lastName, firstName, id, state, lic]);
                        driverIds.add(uniqueKey);
                    }
                }
            });
        } else {
            headerDrivers.forEach(d => {
                if (d.lastName || d.firstName) result.drivers.push([d.lastName, d.firstName, d.id, d.state, d.lic]);
            });
        }

        // Trucks
        const truckVins = new Set();
        let headerTrailer = '';
        if (result.headerSegment[2] && result.headerSegment[2].length >= 2 && result.headerSegment[2][0]) {
            const hTrk = result.headerSegment[2];
            const vin = hTrk[1] || '';
            headerTrailer = hTrk[2] || '';
            if (vin) { result.trucks.push([hTrk[0] || '', vin, headerTrailer]); truckVins.add(vin); }
        }

        if (result.cmvList.length > 0) {
            result.cmvList.forEach(truck => {
                let num = '', vin = '';
                if (truck.length >= 3 && /^\d+$/.test(truck[0])) {
                    num = truck[1] || ''; vin = truck[2] || '';
                } else if (truck.length >= 2) {
                    num = truck[0] || ''; vin = truck[1] || '';
                }
                if (vin && !truckVins.has(vin)) {
                    result.trucks.push([num, vin, headerTrailer]);
                    truckVins.add(vin);
                }
            });
        }

        return result;
    }

    static parseCSVLine(line) {
        const matches = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g);
        if (!matches) return [];
        return matches.map(m => {
            let val = m.startsWith(',') ? m.slice(1) : m;
            return val.replace(/^"|"$/g, '').replace(/""/g, '"').trim();
        });
    }

    /**
     * Extract active shipping document numbers from a Power Event row.
     * The shipping docs are in the second-to-last column (before the dataCheck hex).
     * Can be space-separated list like "1028174 1028175".
     */
    static extractShippingDocs(row) {
        if (!row || row.length < 4) return '';
        // The last field is dataCheck (2-char hex). The one before it is shipping docs.
        // Power Event format: seq, code, date, time, odo, eng, lat, lon, powerUnit, vin, trailer, shippingDocs, dataCheck
        // Index 11 is shipping docs (index 12 is dataCheck) for 13-field rows.
        const lastIdx = row.length - 1;
        const secondLast = row[lastIdx - 1] || '';
        // Validate: it should contain alphanumeric/space content (not coords or VIN patterns)
        if (/^[\d\s]+$/.test(secondLast.trim()) && secondLast.trim().length > 0) {
            return secondLast.trim();
        }
        // Fallback: check if any field looks like shipping docs
        // For shorter rows, try index 11
        if (row.length > 12) {
            const f11 = (row[11] || '').trim();
            if (/^[\d\s]+$/.test(f11) && f11.length > 0) return f11;
        }
        return '';
    }

    static enrichWithMetrics(unifiedList) {
        let currentBaseTvm = null;
        let currentBaseTeh = null;

        // Backward Pass для знаходження бази TVM (Тільки для активних подій)
        for (let i = 0; i < unifiedList.length; i++) {
            let ev = unifiedList[i];
            if (ev.source === 'Power Block' || ev.source === 'Malfunction') {
                if (ev.type === '6' && ev.code === '1') {
                    break;
                } else {
                    let refTvm = parseFloat(ev.odo);
                    let refTeh = parseFloat(ev.eng);
                    let prevEv = null;
                    for (let j = i - 1; j >= 0; j--) {
                        // Игнорируем Inactive события (rs=2) при поиске базиса
                        if (unifiedList[j].rs === '1' && (unifiedList[j].source === 'Main List' || unifiedList[j].source === 'Unidentified')) {
                            prevEv = unifiedList[j];
                            break;
                        }
                    }
                    if (prevEv && !isNaN(refTvm) && !isNaN(parseFloat(prevEv.odo))) {
                        currentBaseTvm = refTvm - parseFloat(prevEv.odo);
                    }
                    if (prevEv && !isNaN(refTeh) && !isNaN(parseFloat(prevEv.eng))) {
                        currentBaseTeh = refTeh - parseFloat(prevEv.eng);
                    }
                    break;
                }
            }
        }

        let prevTime = null;
        let prevAvm = null;

        unifiedList.forEach(ev => {
            // Virtual unloading has absolute TVM/TEH from header — skip enrichment
            // to avoid doubling (odo=257983 treated as AVM → tvm = base + 257983)
            if (ev.isVirtualUnloading) {
                ev.tvm = ev.headerTvm || '-';
                ev.teh = ev.headerTeh || '-';
                ev.avm = '-';
                ev.eeh = '-';
                ev.speed = '-';
                return;
            }

            const rawOdo = parseFloat(ev.odo);
            const rawEng = parseFloat(ev.eng);
            const isOdoValid = !isNaN(rawOdo);
            const isEngValid = !isNaN(rawEng);

            let currentTime = null;
            if (ev.date && ev.time && ev.date !== '-' && ev.time !== '-') {
                const mo = parseInt(ev.date.substring(0, 2), 10) - 1;
                const da = parseInt(ev.date.substring(2, 4), 10);
                const yr = 2000 + parseInt(ev.date.substring(4, 6), 10);
                const h = parseInt(ev.time.substring(0, 2), 10);
                const m = parseInt(ev.time.substring(2, 4), 10);
                const s = parseInt(ev.time.substring(4, 6), 10);
                currentTime = new Date(yr, mo, da, h, m, s).getTime();
            }

            let tvm = null, teh = null, avm = null, eeh = null;

            if (ev.source === 'Power Block' || ev.source === 'Malfunction') {
                if (isOdoValid) tvm = rawOdo;
                if (isEngValid) teh = rawEng;

                if (ev.type === '6' && ev.code === '1') {
                    if (tvm !== null) currentBaseTvm = tvm;
                    if (teh !== null) currentBaseTeh = teh;
                }

                if (tvm !== null && currentBaseTvm !== null) {
                    avm = Math.max(0, tvm - currentBaseTvm);
                }
                if (teh !== null && currentBaseTeh !== null) {
                    eeh = Math.max(0, teh - currentBaseTeh);
                }
            } else {
                if (isOdoValid) avm = rawOdo; // В 4 блоке колонка 7 это AVM
                if (isEngValid) eeh = rawEng; // В 4 блоке колонка 8 это EEH

                if (avm !== null && currentBaseTvm !== null) {
                    tvm = currentBaseTvm + avm;
                }
                if (eeh !== null && currentBaseTeh !== null) {
                    teh = currentBaseTeh + eeh;
                }
            }

            ev.tvm = tvm !== null ? tvm.toFixed(1) : '-';
            ev.teh = teh !== null ? teh.toFixed(1) : '-';
            ev.avm = avm !== null ? avm.toFixed(1) : '-';
            ev.eeh = eeh !== null ? eeh.toFixed(1) : '-';
            ev.speed = '-';

            // ИСПРАВЛЕННАЯ ЛОГИКА СКОРОСТИ
            // Считаем скорость ИСКЛЮЧИТЕЛЬНО по активным ивентам без malfunction
            // Используем AVM напрямую, чтобы избежать проблем с недостающим TVM
            if (ev.rs === '1' && ev.malfInd === '0') {
                if (currentTime !== null && avm !== null) {
                    if (prevTime !== null && prevAvm !== null && currentTime >= prevTime) {
                        const hoursDiff = (currentTime - prevTime) / (1000 * 60 * 60);
                        let milesDiff = avm - prevAvm;

                        if (milesDiff < 0) milesDiff = avm; // Если AVM обнулился после выключения двигателя

                        if (hoursDiff > 0.005) { // Минимальная разница во времени, чтобы избежать деления на микро-доли
                            const calcSpeed = milesDiff / hoursDiff;
                            if (calcSpeed > 0) {
                                ev.speed = calcSpeed.toFixed(1);
                            } else if (milesDiff <= 0.1) {
                                ev.speed = '0.0';
                            }
                        } else if (milesDiff <= 0.1) {
                            ev.speed = '0.0';
                        }
                    }
                    // Обновляем базу ТОЛЬКО для активных событий!
                    prevTime = currentTime;
                    prevAvm = avm;
                }
            }
        });

        return unifiedList;
    }
}

// --- ЛОГІКА РОЗШИФРОВКИ ---
function decodeEvent(typeStr, codeStr, mdc = null, ev = null) {
    const t = parseInt(typeStr, 10);
    const c = parseInt(codeStr, 10);

    // ── Virtual Unloading Record from Header ──
    if (ev && ev.isVirtualUnloading) {
        return '<span class="text-violet-800 font-bold bg-violet-100 px-2 py-0.5 rounded border border-violet-300 shadow-sm inline-flex items-center gap-1"><svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>UNLOADING RECORD</span>';
    }

    if (t === 1) {
        if (c === 1) return '<span class="text-gray-500 font-bold">OFF DUTY</span>';
        if (c === 2) return '<span class="text-indigo-600 font-bold">SLEEPER BERTH</span>';
        if (c === 3) return '<span class="text-green-600 font-bold">DRIVING</span>';
        if (c === 4) return '<span class="text-amber-600 font-bold">ON DUTY</span>';
    }
    if (t === 2) return '<span class="text-blue-500">Intermediate Log</span>';
    if (t === 3) {
        if (c === 0) return '<span class="text-gray-500 italic">Cleared (Special)</span>';
        if (c === 1) return '<span class="text-purple-700 font-bold bg-purple-100 px-2 py-0.5 rounded border border-purple-200 shadow-sm">PC / PU</span>';
        if (c === 2) return '<span class="text-orange-700 font-bold bg-orange-100 px-2 py-0.5 rounded border border-orange-200 shadow-sm">YM</span>';
    }
    if (t === 4) return '<span class="text-gray-400">Certification</span>';
    if (t === 5) {
        if (c === 1) return '<span class="text-teal-600">Login</span>';
        if (c === 2) return '<span class="text-teal-600">Logout</span>';
    }
    if (t === 6) {
        if (c === 1) return '<span class="text-blue-700 font-bold bg-blue-100 px-2 py-0.5 rounded border border-blue-200 shadow-sm">Power-Up</span>';
        if (c === 2 || c === 3) return '<span class="text-red-600 font-bold bg-red-100 px-2 py-0.5 rounded border border-red-200 shadow-sm">Power-Down</span>';
        if (c === 4) return '<span class="text-gray-600 font-semibold bg-gray-100 px-2 py-0.5 rounded border border-gray-200">Shut-Down Not Req.</span>';
    }

    if (t === 7) {
        const codeBadge = mdc ? `<span class="bg-white border border-gray-300 text-gray-800 px-1.5 py-0.5 rounded ml-1 font-mono text-[10px]">Code: ${mdc}</span>` : '';
        if (c === 1) return `<span class="text-red-700 font-bold bg-red-100 px-2 py-0.5 rounded border border-red-300 shadow-sm inline-flex items-center">Malfunction Logged ${codeBadge}</span>`;
        if (c === 2) return `<span class="text-emerald-700 font-bold bg-emerald-100 px-2 py-0.5 rounded border border-emerald-300 shadow-sm inline-flex items-center">Malfunction Cleared ${codeBadge}</span>`;
        if (c === 3) return `<span class="text-amber-700 font-bold bg-amber-100 px-2 py-0.5 rounded border border-amber-300 shadow-sm inline-flex items-center">Data Diagnostic Logged ${codeBadge}</span>`;
        if (c === 4) return `<span class="text-green-700 font-bold bg-green-100 px-2 py-0.5 rounded border border-green-300 shadow-sm inline-flex items-center">Data Diagnostic Cleared ${codeBadge}</span>`;
        return `<span class="text-gray-600 font-semibold">Unknown Type 7 (Code ${c}) ${codeBadge}</span>`;
    }

    if (t === 9) return `<span class="text-gray-500">Type 9 (Code ${c})</span>`;

    return `<span class="text-gray-400">Type ${t}, Code ${c}</span>`;
}

function decodeOrigin(originCode) {
    const code = parseInt(originCode, 10);
    if (code === 1) return '<span class="text-gray-500 flex items-center gap-1" title="Automatically recorded"><svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>Auto</span>';
    if (code === 2) return '<span class="text-blue-600 font-medium flex items-center gap-1" title="Edited by driver"><svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>Manual (Driver)</span>';
    if (code === 3) return '<span class="text-purple-600 font-medium flex items-center gap-1" title="Edited by admin/fleet manager"><svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>Fleet Tools</span>';
    if (code === 4) return '<span class="text-amber-600 font-medium flex items-center gap-1" title="Assumed from unidentified"><svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>Assumed</span>';
    return `<span class="text-gray-400">Unknown (${originCode})</span>`;
}

function formatTime(timeStr) {
    if(!timeStr || timeStr === '-' || timeStr.length < 6) return timeStr || '-';
    return timeStr.replace(/(.{2})(.{2})(.{2})/, "$1:$2:$3");
}
function formatDate(dateStr) {
    if(!dateStr || dateStr === '-' || dateStr.length < 6) return dateStr || '-';
    return dateStr.replace(/(.{2})(.{2})(.{2})/, "$1/$2/20$3");
}
function createSortKey(dateStr, timeStr) {
    if(!dateStr || !timeStr || dateStr.length < 6 || timeStr.length < 6) return 0;
    const mo = dateStr.substring(0, 2);
    const da = dateStr.substring(2, 4);
    const yr = dateStr.substring(4, 6);
    return parseInt(`20${yr}${mo}${da}${timeStr}`, 10);
}

document.getElementById('fileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const parsedData = ELDParser.parse(event.target.result);
        const h = parsedData.headerSegment;

        // Водії
        const driverContainer = document.getElementById('driverContainer');
        driverContainer.innerHTML = '';
        const driversToRender = parsedData.drivers || [];
        if (driversToRender.length === 0) {
            driverContainer.innerHTML = '<div class="text-sm text-gray-500 text-center py-2">Немає даних</div>';
        } else {
            driversToRender.forEach((drv, idx) => {
                const name = `${drv[1] || ''} ${drv[0] || ''}`.trim() || '-';
                const id = drv[2] || '-';
                const lic = (drv[4] || drv[3]) ? `${drv[4] || '-'} (${drv[3] || '-'})` : '-';
                let title = idx === 0 ? 'Основний водій' : `Ко-водій / Водій #${idx + 1}`;
                let color = idx === 0 ? 'text-blue-500' : 'text-purple-500';

                driverContainer.innerHTML += `
                        <dl class="space-y-2 text-sm ${idx > 0 ? 'mt-4 pt-4 border-t border-gray-100' : ''}">
                            <div class="text-xs font-bold ${color} uppercase tracking-wider mb-2">${title}</div>
                            <div class="flex justify-between border-b border-gray-50 pb-1">
                                <dt class="text-gray-500">ПІБ:</dt>
                                <dd class="font-medium text-gray-900">${name}</dd>
                            </div>
                            <div class="flex justify-between border-b border-gray-50 pb-1">
                                <dt class="text-gray-500">Driver ID:</dt>
                                <dd class="font-medium text-gray-900">${id}</dd>
                            </div>
                            <div class="flex justify-between pb-1">
                                <dt class="text-gray-500">Ліцензія (Штат):</dt>
                                <dd class="font-medium text-gray-900">${lic}</dd>
                            </div>
                        </dl>`;
            });
        }

        // Траки
        const truckContainer = document.getElementById('truckContainer');
        truckContainer.innerHTML = '';
        const trucksToRender = parsedData.trucks || [];
        if (trucksToRender.length === 0) {
            truckContainer.innerHTML = '<div class="text-sm text-gray-500 text-center py-2">Немає даних</div>';
        } else {
            trucksToRender.forEach((trk, idx) => {
                const num = trk[0] || '-';
                const vin = trk[1] || '-';
                const trailer = trk[2] || '-';

                truckContainer.innerHTML += `
                        <dl class="space-y-2 text-sm ${idx > 0 ? 'mt-4 pt-4 border-t border-gray-100' : ''}">
                            ${trucksToRender.length > 1 ? `<div class="text-xs font-bold text-indigo-500 uppercase tracking-wider mb-2">Трак #${idx + 1}</div>` : ''}
                            <div class="flex justify-between border-b border-gray-50 pb-1">
                                <dt class="text-gray-500">Power Unit №:</dt>
                                <dd class="font-medium text-gray-900">${num}</dd>
                            </div>
                            <div class="flex justify-between border-b border-gray-50 pb-1">
                                <dt class="text-gray-500">VIN (ECM):</dt>
                                <dd class="font-mono text-[11px] text-gray-800 mt-0.5">${vin}</dd>
                            </div>
                            ${trailer !== '-' && trailer !== '' ? `
                            <div class="flex justify-between pb-1">
                                <dt class="text-gray-500">Трейлер:</dt>
                                <dd class="font-medium text-gray-900">${trailer}</dd>
                            </div>` : ''}
                        </dl>`;
            });
        }

        if (h[3] && h[3].length >= 2) {
            document.getElementById('cmpDot').textContent = h[3][0] || '-';
            document.getElementById('cmpName').textContent = h[3][1] || '-';
        }

        // ── Display Shipping Doc info in Company card ─────────────────
        const shippingInfoEl = document.getElementById('shippingDocInfo');
        if (shippingInfoEl && parsedData.shippingDoc) {
            const sd = parsedData.shippingDoc;
            shippingInfoEl.innerHTML = `
                <div class="flex justify-between border-t border-gray-100 pt-2 mt-2">
                    <dt class="text-gray-500">Shipping Doc:</dt>
                    <dd class="font-mono font-bold text-blue-700">#${sd.docNumber}</dd>
                </div>
                <div class="flex justify-between">
                    <dt class="text-gray-500">Exempt:</dt>
                    <dd class="${sd.exempt ? 'text-yellow-700 font-bold' : 'text-gray-500'}">${sd.exempt ? 'Yes' : 'No'}</dd>
                </div>`;
        } else if (shippingInfoEl) {
            shippingInfoEl.innerHTML = '';
        }

        let unifiedList = [];

        // Main List (Event List Block 4)
        parsedData.events.forEach(row => {
            if(row.length < 6) return;
            unifiedList.push({
                source: 'Main List', sourceClass: '',
                seq: row[0] || '-', rs: row[1] || '1', origin: row[2] || '1', type: row[3], code: row[4], mdc: null,
                date: row[5], time: row[6], odo: row[7] || '-', eng: row[8] || '-', lat: row[9] || '-', lon: row[10] || '-',
                malfInd: row[14] || '0', diagInd: row[15] || '0',
                sortKey: createSortKey(row[5], row[6]),
                // Cargo tracking fields
                isVirtualUnloading: false, activeCargo: '', cargoPickups: [], cargoDrops: []
            });
        });

        // Power Events (Block 9) — with shipping doc extraction & PICKUP/DROP detection
        // Step 1: Build event objects with sortKey + extracted cargo (no PICKUP/DROP yet)
        const powerEvObjects = [];
        parsedData.powerEvents.forEach(row => {
            if(row.length < 4) return;
            const activeCargo = ELDParser.extractShippingDocs(row);
            powerEvObjects.push({
                source: 'Power Block', sourceClass: 'row-power',
                seq: row[0] || '-', rs: '1', origin: '1', type: '6', code: row[1], mdc: null,
                date: row[2], time: row[3], odo: row[4] || '-', eng: row[5] || '-', lat: row[6] || '-', lon: row[7] || '-',
                malfInd: '0', diagInd: '0',
                sortKey: createSortKey(row[2], row[3]),
                isVirtualUnloading: false, activeCargo, cargoPickups: [], cargoDrops: []
            });
        });

        // Step 2: Sort chronologically (oldest first) — CSV may list newest first!
        powerEvObjects.sort((a, b) => a.sortKey - b.sortKey);

        // Step 3: Walk in chronological order to detect PICKUP / DROP
        let prevPowerDocs = null;
        powerEvObjects.forEach(ev => {
            const currentDocs = new Set(ev.activeCargo.split(/\s+/).filter(Boolean));
            if (prevPowerDocs !== null) {
                currentDocs.forEach(doc => {
                    if (!prevPowerDocs.has(doc)) ev.cargoPickups.push(doc);
                });
                prevPowerDocs.forEach(doc => {
                    if (!currentDocs.has(doc)) ev.cargoDrops.push(doc);
                });
            }
            prevPowerDocs = currentDocs;
        });

        // Step 4: Add to unified list
        powerEvObjects.forEach(ev => unifiedList.push(ev));

        // ── Virtual Unloading Event from Header Segment ──────────────
        if (parsedData.unloadingRecord) {
            const ur = parsedData.unloadingRecord;
            const shipDoc = parsedData.shippingDoc;
            unifiedList.push({
                source: 'Header (Unloading)', sourceClass: 'row-unloading',
                seq: 'HDR-UL', rs: '1', origin: '1', type: '99', code: '0', mdc: null,
                date: ur.date, time: ur.time,
                odo: ur.tvm || '-', eng: ur.teh || '-',
                lat: ur.lat || '-', lon: ur.lon || '-',
                malfInd: '0', diagInd: '0',
                sortKey: createSortKey(ur.date, ur.time),
                // Mark as virtual unloading
                isVirtualUnloading: true,
                activeCargo: shipDoc ? shipDoc.docNumber : '',
                cargoPickups: [], cargoDrops: [],
                // Store raw header TVM/TEH for display
                headerTvm: ur.tvm || '-',
                headerTeh: ur.teh || '-',
                shippingExempt: shipDoc ? shipDoc.exempt : false
            });
        }

        // Unidentified (Block 10)
        parsedData.unidentified.forEach(row => {
            if(row.length < 6) return;
            unifiedList.push({
                source: 'Unidentified', sourceClass: 'row-unidentified',
                seq: row[0] || '-', rs: row[1] || '1', origin: row[2] || '1', type: row[3], code: row[4], mdc: null,
                date: row[5], time: row[6], odo: row[7] || '-', eng: row[8] || '-', lat: row[9] || '-', lon: row[10] || '-',
                malfInd: row[14] || '0', diagInd: row[15] || '0',
                sortKey: createSortKey(row[5], row[6]),
                isVirtualUnloading: false, activeCargo: '', cargoPickups: [], cargoDrops: []
            });
        });

        // Malfunctions (Block 7)
        parsedData.malfunctions.forEach(row => {
            if(row.length < 5) return;
            unifiedList.push({
                source: 'Malfunction', sourceClass: 'row-malfunction',
                seq: row[0] || '-', rs: '1', origin: '1', type: '7', code: row[1], mdc: row[2],
                date: row[3], time: row[4], odo: row[5] || '-', eng: row[6] || '-', lat: '-', lon: '-',
                malfInd: '0', diagInd: '0',
                sortKey: createSortKey(row[3], row[4]),
                isVirtualUnloading: false, activeCargo: '', cargoPickups: [], cargoDrops: []
            });
        });

        unifiedList.sort((a, b) => a.sortKey - b.sortKey);
        unifiedList = ELDParser.enrichWithMetrics(unifiedList);

        // ── HOS Violation validation ─────────────────────────────────
        HOSValidator.validate(unifiedList, parsedData.annotationsMap);

        // ── HOS Chart init ───────────────────────────────────────────
        const hosChart = new HOSChart('hosCanvas', unifiedList, parsedData.annotationsMap);

        function renderTableForDay(dateStr) {
            const filtered = dateStr
                ? unifiedList.filter(ev => ev.date === dateStr)
                : unifiedList;
            renderEventTable(filtered);
        }

        function updateRecapUI() {
            const r = hosChart.getRecapFormatted();
            document.getElementById('recapOFF').textContent   = r.OFF;
            document.getElementById('recapSB').textContent    = r.SB;
            document.getElementById('recapD').textContent     = r.D;
            document.getElementById('recapON').textContent    = r.ON;
            document.getElementById('recapTOTAL').textContent = r.TOTAL;
        }

        function updateChartUI() {
            document.getElementById('currentDayLabel').textContent = hosChart.currentDateFormatted();
            document.getElementById('prevDayBtn').disabled = !hosChart.hasPrev();
            document.getElementById('nextDayBtn').disabled = !hosChart.hasNext();
            updateRecapUI();
            const currentDateStr = hosChart.dates[hosChart.dateIdx];
            renderTableForDay(currentDateStr);
        }

        hosChart.render();
        updateChartUI();

        document.getElementById('prevDayBtn').addEventListener('click', () => {
            hosChart.prevDay();
            updateChartUI();
        });

        document.getElementById('nextDayBtn').addEventListener('click', () => {
            hosChart.nextDay();
            updateChartUI();
        });

        window.addEventListener('resize', () => { hosChart.render(); updateRecapUI(); });

        // ── Table rendering ──────────────────────────────────────────
        function renderEventTable(list) {
            const tbody = document.getElementById('eventBody');
            tbody.innerHTML = '';
            document.getElementById('totalCount').textContent = `Всього: ${list.length}`;

            // Count total violations (not events — one event can have multiple violations)
            const vCount = list.reduce((sum, ev) => sum + (ev.violations ? ev.violations.length : 0), 0);
            const vBadge = document.getElementById('violationCount');
            if (vCount > 0) {
                vBadge.textContent = `⚠ Порушень: ${vCount}`;
                vBadge.classList.remove('hidden');
            } else {
                vBadge.classList.add('hidden');
            }

            list.forEach(ev => { renderEventRow(ev, tbody); });
        }

        function renderEventRow(ev, tbody) {
            const isInactive = ev.rs === '2';
            const hasViolations = ev.violations && ev.violations.length > 0;
            const tr = document.createElement('tr');
            tr.className = `hover:bg-gray-50 transition-colors ${ev.sourceClass} ${isInactive ? 'row-inactive' : ''} ${hasViolations ? 'row-violation' : ''}`;

            const dateTimeStr = `${formatDate(ev.date)} <span class="text-gray-400 font-mono ml-2">${formatTime(ev.time)}</span>`;

            let decodedAction = decodeEvent(ev.type, ev.code, ev.mdc, ev);
            if (isInactive) {
                decodedAction += ' <span class="bg-gray-200 text-gray-600 text-[10px] px-1.5 py-0.5 rounded ml-2 uppercase font-bold border border-gray-300">Inactive</span>';
            }

            // Violation badges
            if (hasViolations) {
                ev.violations.forEach(v => {
                    decodedAction += ` <span class="bg-red-600 text-white text-[10px] px-1.5 py-0.5 rounded ml-1 uppercase font-bold shadow-sm">⚠ ${v}</span>`;
                });
            }

            if (ev.malfInd === '1' || ev.diagInd === '1') {
                decodedAction += ` <svg class="w-4 h-4 text-red-500 inline ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`;
            }

            const decodedOrigin = decodeOrigin(ev.origin);
            const rawComment = parsedData.annotationsMap[ev.seq];

            // ── Build comment HTML (with Cargo tracking info) ─────────
            let commentParts = [];
            if (rawComment) {
                commentParts.push(`<div class="flex items-start gap-1"><svg class="w-3.5 h-3.5 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg><span>${rawComment}</span></div>`);
            }

            // Active Cargo display for Power events
            if (ev.activeCargo && ev.source === 'Power Block') {
                commentParts.push(`<div class="text-[10px] text-gray-600 font-semibold bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 mt-0.5">📦 Cargo: <span class="font-mono text-gray-800">${ev.activeCargo}</span></div>`);
            }

            // PICKUP detected badges
            if (ev.cargoPickups && ev.cargoPickups.length > 0) {
                ev.cargoPickups.forEach(doc => {
                    commentParts.push(`<div class="text-[10px] text-emerald-800 font-bold bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-300 mt-0.5">⬆ PICKUP: <span class="font-mono">${doc}</span></div>`);
                });
            }

            // DROP detected badges
            if (ev.cargoDrops && ev.cargoDrops.length > 0) {
                ev.cargoDrops.forEach(doc => {
                    commentParts.push(`<div class="text-[10px] text-rose-800 font-bold bg-rose-50 px-1.5 py-0.5 rounded border border-rose-300 mt-0.5">⬇ DROP: <span class="font-mono">${doc}</span></div>`);
                });
            }

            // Virtual Unloading — show shipping doc info
            if (ev.isVirtualUnloading) {
                const docNum = ev.activeCargo || '-';
                commentParts.push(`<div class="text-[10px] text-violet-800 font-bold bg-violet-50 px-1.5 py-0.5 rounded border border-violet-300 mt-0.5">📄 Doc: #${docNum} | Exempt: ${ev.shippingExempt ? 'Yes' : 'No'}</div>`);
                if (ev.headerTvm && ev.headerTvm !== '-') {
                    commentParts.push(`<div class="text-[10px] text-gray-600 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200 mt-0.5">TVM: ${ev.headerTvm} | TEH: ${ev.headerTeh || '-'}</div>`);
                }
            }

            const commentHtml = commentParts.length > 0
                ? `<div class="text-gray-600 italic text-xs bg-white px-2 py-1 rounded border border-gray-200 shadow-sm flex flex-col gap-0.5 w-full min-w-[200px] max-w-[360px] whitespace-normal">${commentParts.join('')}</div>`
                : '<span class="text-gray-300">-</span>';

            let coords = '-';
            if (ev.lat !== '-' && ev.lon !== '-' && ev.lat && ev.lon) {
                coords = `<span class="font-mono text-[11px] text-gray-500">${ev.lat}, ${ev.lon}</span>`;
            }

            const avmHtml = ev.avm !== '-' ? `<div class="text-[10px] text-green-700 font-semibold bg-green-50 rounded px-1.5 mt-0.5 inline-block border border-green-200">AVM: +${ev.avm}</div>` : '';
            const eehHtml = ev.eeh !== '-' ? `<div class="text-[10px] text-blue-700 font-semibold bg-blue-50 rounded px-1.5 mt-0.5 inline-block border border-blue-200">EEH: +${ev.eeh}</div>` : '';

            let speedHtml = '<span class="text-gray-300">-</span>';
            if (ev.speed !== '-') {
                const speedNum = parseFloat(ev.speed);
                if (speedNum > 85) {
                    speedHtml = `<span class="font-bold text-red-600" title="Аномальна швидкість!">${ev.speed}</span> <span class="text-[10px] text-red-400 font-sans">mph</span>`;
                } else if (speedNum > 0) {
                    speedHtml = `<span class="font-bold text-gray-800">${ev.speed}</span> <span class="text-[10px] text-gray-400 font-sans">mph</span>`;
                } else {
                    speedHtml = `<span class="font-bold text-gray-500">${ev.speed}</span> <span class="text-[10px] text-gray-400 font-sans">mph</span>`;
                }
            }

            tr.innerHTML = `
                    <td class="px-4 py-3 text-gray-800 whitespace-nowrap">${dateTimeStr}</td>
                    <td class="px-4 py-3">${decodedAction}</td>
                    <td class="px-4 py-3">${decodedOrigin}</td>
                    <td class="px-4 py-3 font-mono text-gray-400 text-xs">${ev.seq}</td>
                    <td class="px-4 py-3">${commentHtml}</td>
                    <td class="px-4 py-3 text-right font-mono">
                        <div class="text-gray-800">${ev.tvm}</div>
                        ${avmHtml}
                    </td>
                    <td class="px-4 py-3 text-right font-mono">
                        <div class="text-gray-800">${ev.teh}</div>
                        ${eehHtml}
                    </td>
                    <td class="px-4 py-3 text-center font-mono">${speedHtml}</td>
                    <td class="px-4 py-3 tracking-wider">${coords}</td>
                `;
            tbody.appendChild(tr);
        }

        document.getElementById('dashboardContainer').classList.remove('hidden');
    };
    reader.readAsText(file);
});
