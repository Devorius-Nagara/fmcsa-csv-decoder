const fs = require('fs');
const csv = fs.readFileSync('org_242_Chita7661022426-9NRKQBTFO.csv', 'utf-8');

const lines = csv.split(/\r\n|\n|\r/);
let section = 'headerSegment';
const result = { headerSegment: [], powerEvents: [] };
for (const line of lines) {
  const l = line.trim();
  if (!l) continue;
  const u = l.toUpperCase();
  if (u.includes('ELD FILE HEADER')) { section = 'headerSegment'; continue; }
  if (u.includes('USER LIST')) { section = 'skip'; continue; }
  if (u.includes('ENGINE POWER-UP')) { section = 'powerEvents'; continue; }
  if (u.includes('UNIDENTIFIED') || u.includes('END OF')) { section = 'skip'; continue; }
  if (['CMV LIST','ELD EVENT','ANNOTATIONS','MALFUNCTIONS','CERTIFICATION','LOGIN'].some(k => u.includes(k))) { section = 'skip'; continue; }
  const cols = l.split(',');
  if (section === 'headerSegment') result.headerSegment.push(cols);
  if (section === 'powerEvents') result.powerEvents.push(cols);
}

console.log('=== HEADER ROWS ===');
result.headerSegment.forEach((r,i) => console.log('Row', i, ':', JSON.stringify(r.slice(0,6))));

console.log('\n=== Shipping Line (Row 4) ===');
const shipRow = result.headerSegment[4];
console.log('Raw:', JSON.stringify(shipRow));
console.log('DocNum:', shipRow[0], '| Exempt field:', shipRow[1]);

console.log('\n=== Time/Place Line (Row 5) ===');
const tpRow = result.headerSegment[5];
console.log('Raw:', JSON.stringify(tpRow));
console.log('Date:', tpRow[0], 'Time:', tpRow[1], 'Lat:', tpRow[2], 'Lon:', tpRow[3], 'TVM:', tpRow[4], 'AVM:', tpRow[5]);

console.log('\n=== Power Events Shipping Docs (second-to-last column) ===');
result.powerEvents.forEach(row => {
  const lastIdx = row.length - 1;
  const secondLast = (row[lastIdx - 1] || '').trim();
  console.log('Seq:', row[0], '| Code:', row[1], '| Docs:', secondLast, '| RowLen:', row.length);
});

// Test PICKUP/DROP detection
console.log('\n=== PICKUP/DROP Detection ===');
let prevDocs = null;
result.powerEvents.forEach(row => {
  const lastIdx = row.length - 1;
  const secondLast = (row[lastIdx - 1] || '').trim();
  const currentDocs = new Set(secondLast.split(/\s+/).filter(Boolean));

  let pickups = [], drops = [];
  if (prevDocs !== null) {
    currentDocs.forEach(d => { if (!prevDocs.has(d)) pickups.push(d); });
    prevDocs.forEach(d => { if (!currentDocs.has(d)) drops.push(d); });
  }

  if (pickups.length > 0 || drops.length > 0) {
    console.log('At seq', row[0], '('+row[2]+' '+row[3]+'):',
      pickups.length > 0 ? 'PICKUP: ' + pickups.join(', ') : '',
      drops.length > 0 ? 'DROP: ' + drops.join(', ') : '');
  }
  prevDocs = currentDocs;
});

