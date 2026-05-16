/**
 * Оновлений модуль для парсингу специфічних CSV файлів ELD.
 * Розбиває файл на блоки і безпечно їх обробляє.
 */
export class ELDParser {
    static parse(csvText) {
        const lines = csvText.split(/\r\n|\n|\r/);

        const result = {
            headerSegment: [],
            userList: [],      // Блок 2: User List (для кількох водіїв)
            cmvList: [],       // Блок 3: CMV List (для кількох траків)
            events: [],        // Блок 4: ELD Event List
            annotations: [],   // Блок 5: ELD Event Annotations or Comments
            malfunctions: [],  // Блок 7: Malfunctions and Data Diagnostic Events
            powerEvents: [],   // Блок 9: CMV Engine Power-Up and Shut Down Activity
            unidentified: [],  // Блок 10: Unidentified Driver Profile Records
            unknown: [],
            annotationsMap: {},// Словник для швидкого пошуку коментаря: { "SeqID": "Текст коментаря" }
            drivers: [],       // Нормалізований масив водіїв
            trucks: []         // Нормалізований масив траків
        };

        let currentSection = 'headerSegment';

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const lineUpper = line.toUpperCase();

            // Визначення секцій (регістронезалежне, для підтримки різних форматів провайдерів)
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

            // Якщо ми не знайшли текстовий заголовок, спробуємо вгадати по структурі
            if (currentSection === 'unknown' && parsedLine.length >= 10) {
                const typeC = parseInt(parsedLine[3], 10);
                const codeC = parseInt(parsedLine[4], 10);
                if (!isNaN(typeC) && !isNaN(codeC) && typeC >= 1 && typeC <= 9) {
                    currentSection = 'events';
                }
            }

            // Додаємо дані у відповідну секцію
            if (result[currentSection]) {
                result[currentSection].push(parsedLine);

                // Якщо це коментар (Блок 5), відразу додаємо його у словник по Seq ID
                if (currentSection === 'annotations' && parsedLine.length >= 3) {
                    const seqId = parsedLine[0];
                    // У стандарті FMCSA коментар знаходиться на 3-й позиції (індекс 2)
                    const commentText = parsedLine[2];

                    if (seqId && commentText) {
                        result.annotationsMap[seqId] = commentText;
                    }
                }
            } else if (currentSection === 'unknown') {
                result.unknown.push(parsedLine);
            }
        }

        // Додаткова фільтрація, якщо Power Events потрапили в загальний список
        if (result.powerEvents.length === 0 && result.events.length > 0) {
            const actualEvents = [];
            result.events.forEach(row => {
                if (row[1] && ['1', '2', '3', '4'].includes(row[1]) && row[3] && row[3].length === 6) {
                    result.powerEvents.push(row);
                } else {
                    actualEvents.push(row);
                }
            });
            result.events = actualEvents;
        }

        // --- НОВА ЛОГІКА ЗБОРУ ВОДІЇВ ТА ТРАКІВ ---

        // 1. Спочатку збираємо інформацію з Header Segment (де є Driver ID та License)
        const headerDrivers = [];
        for (let i = 0; i < 2; i++) {
            const hRow = result.headerSegment[i];
            if (hRow && hRow.length >= 2 && hRow[0]) {
                headerDrivers.push({
                    lastName: hRow[0],
                    firstName: hRow[1],
                    id: hRow[2] || '',
                    state: hRow[3] || '',
                    lic: hRow[4] || ''
                });
            }
        }

        result.drivers = [];
        const driverIds = new Set();

        // 2. Обробляємо User List та метчимо з Header Segment
        if (result.userList && result.userList.length > 0) {
            result.userList.forEach(user => {
                let lastName = '';
                let firstName = '';

                // В FMCSA User List: Order Number(0), User Type(1), Last Name(2), First Name(3)
                if (user.length >= 4 && /^\d+$/.test(user[0])) {
                    lastName = user[2] || '';
                    firstName = user[3] || '';
                } else if (user.length >= 3) {
                    // Якщо номеру немає, індекси зсуваються
                    lastName = user[1] || '';
                    firstName = user[2] || '';
                }

                if (lastName || firstName) {
                    let id = '';
                    let state = '';
                    let lic = '';

                    // Шукаємо деталі водія у розпарсеному Header Segment
                    const matchedDriver = headerDrivers.find(d => d.lastName === lastName && d.firstName === firstName);
                    if (matchedDriver) {
                        id = matchedDriver.id;
                        state = matchedDriver.state;
                        lic = matchedDriver.lic;
                    }

                    const uniqueKey = `${lastName}_${firstName}_${id}`;
                    if (!driverIds.has(uniqueKey)) {
                        result.drivers.push([lastName, firstName, id, state, lic]);
                        driverIds.add(uniqueKey);
                    }
                }
            });
        } else {
            // Фолбек: якщо User List порожній, виводимо водіїв із шапки
            headerDrivers.forEach(d => {
                if (d.lastName || d.firstName) {
                    result.drivers.push([d.lastName, d.firstName, d.id, d.state, d.lic]);
                }
            });
        }

        // Збір траків
        const truckVins = new Set();
        let headerTrailer = '';

        // Трак із шапки
        if (result.headerSegment[2] && result.headerSegment[2].length >= 2 && result.headerSegment[2][0]) {
            const hTrk = result.headerSegment[2];
            const vin = hTrk[1] || '';
            headerTrailer = hTrk[2] || ''; // Трейлер зазвичай вказується тільки в шапці

            if (vin) {
                result.trucks.push([hTrk[0] || '', vin, headerTrailer]);
                truckVins.add(vin);
            }
        }

        // Траки з CMV List
        if (result.cmvList && result.cmvList.length > 0) {
            result.cmvList.forEach(truck => {
                let num = '';
                let vin = '';
                // Формат: Order Number(0), CMV Power Unit Number(1), CMV VIN(2)
                if (truck.length >= 3 && /^\d+$/.test(truck[0])) {
                    num = truck[1] || '';
                    vin = truck[2] || '';
                } else if (truck.length >= 2) {
                    num = truck[0] || '';
                    vin = truck[1] || '';
                }

                if (vin && !truckVins.has(vin)) {
                    result.trucks.push([num, vin, headerTrailer]);
                    truckVins.add(vin);
                }
            });
        }

        // --- ВИВІД ДЛЯ ДЕБАГІНГУ ---
        console.group("=== ELD PARSER DEBUG INFO ===");
        console.log("Raw Header Segment:", result.headerSegment);
        console.log("Raw User List:", result.userList);
        console.log("👥 Processed Drivers:", result.drivers);
        console.log("🚛 Processed Trucks:", result.trucks);
        console.log("📅 Events count:", result.events.length);
        console.log("⚡ Power events count:", result.powerEvents.length);
        console.log("🔧 Malfunctions count:", result.malfunctions.length);
        console.log("📦 Full parsed object:", result);
        console.groupEnd();

        return result;
    }

    static parseCSVLine(line) {
        const matches = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g);
        if (!matches) return [];

        return matches.map(m => {
            let val = m.startsWith(',') ? m.slice(1) : m;
            val = val.replace(/^"|"$/g, '').replace(/""/g, '"');
            return val.trim();
        });
    }

    /**
     * Постобробка: Точне обчислення TVM, AVM, TEH, EEH та Швидкості
     * @param {Array} unifiedList - Відсортований хронологічно масив подій
     */
    static enrichWithMetrics(unifiedList) {
        let currentBaseTvm = null;
        let currentBaseTeh = null;

        // Зворотне дедукування (Backward Pass):
        // Знаходимо першу базову точку для сесій, що почалися до генерації логу
        for (let i = 0; i < unifiedList.length; i++) {
            let ev = unifiedList[i];
            if (ev.source === 'Power Block' || ev.source === 'Malfunction') {
                if (ev.type === '6' && ev.code === '1') {
                    // Якщо перша знайдена абсолютна точка це Power-Up, все супер
                    break;
                } else {
                    // Якщо це Power-Down або Malfunction, віднімаємо AVM попередньої події
                    let refTvm = parseFloat(ev.odo);
                    let refTeh = parseFloat(ev.eng);

                    let prevEv = null;
                    for (let j = i - 1; j >= 0; j--) {
                        if (unifiedList[j].source === 'Main List' || unifiedList[j].source === 'Unidentified') {
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
        let prevTvm = null;

        unifiedList.forEach(ev => {
            const rawOdo = parseFloat(ev.odo);
            const rawEng = parseFloat(ev.eng);
            const isOdoValid = !isNaN(rawOdo);
            const isEngValid = !isNaN(rawEng);

            // Конвертуємо час події для швидкості
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

            let tvm = null;
            let teh = null;
            let avm = null;
            let eeh = null;

            // Блок 9 (Power) та Блок 7 (Malfunction) містять абсолютні показники (TVM / TEH)
            if (ev.source === 'Power Block' || ev.source === 'Malfunction') {
                if (isOdoValid) tvm = rawOdo;
                if (isEngValid) teh = rawEng;

                // Power Up (Code 1) починає нову сесію
                if (ev.type === '6' && ev.code === '1') {
                    if (tvm !== null) currentBaseTvm = tvm;
                    if (teh !== null) currentBaseTeh = teh;
                }

                // AVM - це різниця від початку сесії
                if (tvm !== null && currentBaseTvm !== null) {
                    avm = Math.max(0, tvm - currentBaseTvm);
                }
                if (teh !== null && currentBaseTeh !== null) {
                    eeh = Math.max(0, teh - currentBaseTeh);
                }
            }
            // Блок 4 (Event List) та Блок 10 містять приріст (AVM / EEH)
            else {
                if (isOdoValid) avm = rawOdo;
                if (isEngValid) eeh = rawEng;

                // Загальний пробіг - це база (останній Power Up або дедукована база) + AVM
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

            // Розрахунок середньої швидкості за абсолютним TVM
            ev.speed = '-';
            if (currentTime !== null && tvm !== null) {
                if (prevTime !== null && prevTvm !== null && currentTime >= prevTime) {
                    const hoursDiff = (currentTime - prevTime) / (1000 * 60 * 60);
                    const milesDiff = tvm - prevTvm;

                    if (hoursDiff > 0.005 && milesDiff > 0) {
                        ev.speed = (milesDiff / hoursDiff).toFixed(1);
                    } else if (milesDiff <= 0.1) {
                        ev.speed = '0.0'; // Стоїть на місці
                    }
                }
                prevTime = currentTime;
                prevTvm = tvm;
            }
        });

        return unifiedList;
    }
}