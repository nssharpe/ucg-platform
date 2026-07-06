/**
 * JSON API for Nationals Check-In Summary
 * Handles requests from WordPress frontend via doGet.
 */

const FORM_RELEASE_TIME = new Date('2026-01-17T18:00:00-05:00');
const SHEET_ID = '1nWOMbwX_1DfNPrlNLNGarFz4g0xDahhvuEo6cVw2HYc';

// ====== GLOBAL CONFIG ======
// The confirmation forms will be HIDDEN until this date/time.
// Currently set to: January 17, 2026 at 8:00 AM ET.
const FORM_OPEN_DATE = new Date("2026-01-17T08:00:00-05:00");

/**
 * Main API Router
 */
function doGet(e) {
  const params = e.parameter;
  const action = params.action;
  let result = {};
  try {
    switch (action) {
      case 'getMetadata':
        result = { 
          updatedAt: getUpdatedAtText_(),
          formIsActive: new Date() >= FORM_OPEN_DATE, // ONLY true IF current time is AFTER open date
          indCoaches: getIndependentCoaches_()
        };
        break;
      case 'getClubs':
        result = getClubs();
        break;
      case 'getClubSummary':
        result = getClubSummary(params.club);
        break;
      case 'hasClubConfirmed':
        result = hasClubConfirmed(params.club);
        break;
      case 'submitClubConfirmation':
        result = submitConfirmation(params.club, params.name, params.email);
        break;
      case 'getIndependentNames':
        result = getIndependentNames();
        break;
      case 'indCoaches':
        result = getIndependentCoaches_();
        break;
      case 'getIndependentSummary':
        result = getIndependentSummary(params.name);
        break;
      case 'hasIndependentConfirmed':
        result = hasIndependentConfirmed(params.name);
        break;
      case 'submitIndependentConfirmation':
        result = submitIndependentConfirmation(params.name, params.email);
        break;
      default:
        result = { error: 'Invalid action' };
    }
  } catch (err) {
    result = { error: err.toString() };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===================================================================
// CORE LOGIC (UNCHANGED FROM ORIGINAL)
// ===================================================================

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function getUpdatedAtText_() {
  try {
    const sh = getSpreadsheet_().getSheetByName('Club Emails');
    if (!sh) return '';
    const f1 = sh.getRange(1, 6).getDisplayValue(); 
    return f1 ? `${f1}` : '';
  } catch (e) {
    return '';
  }
}

function readSheetObjects_(sheetName) {
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 1) return [];

  let headerRow = 0;
  for (let i = 0; i < Math.min(values.length, 50); i++) {
    const row = values[i];
    const nonEmpty = row.some(c => c !== '' && c !== null);
    if (!nonEmpty) continue;
    const hasClubish = row.some(h => /club/i.test(String(h)));
    const hasNameish = row.some(h => /name/i.test(String(h)) || /athlete/i.test(String(h)));
    if (hasClubish || hasNameish || i === 0) { headerRow = i; break; }
  }

  const headers = values[headerRow].map(h => String(h).trim());
  const rows = values.slice(headerRow + 1).filter(r => r.some(c => c !== '' && c !== null));
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
}

function getClubs() {
  const sh = getSpreadsheet_().getSheetByName('Club Emails');
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(h => String(h).trim());
  let idx = headers.findIndex(h => /^club$/i.test(h) || /^club name$/i.test(h));
  if (idx === -1) idx = 0;
  const clubs = new Set();
  for (let r = 1; r < values.length; r++) {
    const name = String(values[r][idx] ?? '').trim();
    if (name) clubs.add(name);
  }
  return Array.from(clubs).sort((a, b) => a.localeCompare(b));
}

function readByClub_(sheetName, clubName) {
  const rows = readSheetObjects_(sheetName);
  if (!rows.length) return [];
  const clubCol = ('Club' in rows[0]) ? 'Club' : (Object.keys(rows[0]).find(h => /club/i.test(h)) || 'Club');
  return rows.filter(r => String(r[clubCol] || '').trim() === String(clubName).trim());
}

function valueOr(obj, keys, fallback = '') {
  for (const k of (Array.isArray(keys) ? keys : [keys])) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).length) return obj[k];
  }
  return fallback;
}

const LEVEL_MAP = {
  'silver': 'XS',
  'platinum': 'XP',
  'diamond': 'XD',
  'level 9': 'L9',
  'naigc open scoring': 'Open',
  'naigc developmental': 'Dev',
  'naigc intermediate': 'Int',
  'naigc advanced (gymact)': 'Adv'
};

function mapLevel_(raw) {
  if (!raw) return raw;
  const key = String(raw).trim().toLowerCase();
  return LEVEL_MAP[key] !== undefined ? LEVEL_MAP[key] : raw;
}

// Maps compound level strings like "Silver/Platinum" -> "XS/XP"
function mapLevelCompound_(raw) {
  if (!raw) return raw;
  return String(raw).split('/').map(part => mapLevel_(part.trim())).join('/');
}

function mapWagAthleteRow(row) {
  return {
    'Name': valueOr(row, ['Name','Athlete'], ''),
    'T-Shirt': valueOr(row, ['T-Shirt','T-Shirt Size'], ''),
    'Placement Category': valueOr(row, ['Placement Category','Category'], ''),
    'Level': mapLevel_(valueOr(row, ['Level'], '')),
    'VT': valueOr(row, ['VT'], ''),
    'UB': valueOr(row, ['UB'], ''),
    'BB': valueOr(row, ['BB'], ''),
    'FX': valueOr(row, ['FX'], ''),
    'AA': valueOr(row, ['AA'], '')
  };
}
function mapMagAthleteRow(row) {
  return {
    'Name': valueOr(row, ['Name','Athlete'], ''),
    'T-Shirt': valueOr(row, ['T-Shirt','T-Shirt Size'], ''),
    'Placement Category': valueOr(row, ['Placement Category','Category'], ''),
    'Level': mapLevel_(valueOr(row, ['Level'], '')),
    'FX': valueOr(row, ['FX'], ''),
    'PH': valueOr(row, ['PH'], ''),
    'SR': valueOr(row, ['SR'], ''),
    'VT': valueOr(row, ['VT'], ''),
    'PB': valueOr(row, ['PB'], ''),
    'HB': valueOr(row, ['HB'], ''),
    'AA': valueOr(row, ['AA'], '')
  };
}
function mapTeamSummaryRow(row) {
  return {
    'Level': mapLevel_(valueOr(row, ['Level'], '')),
    'Placement Category': valueOr(row, ['Placement Category','Category'], ''),
    'Team?': valueOr(row, ['Team?'], '')
  };
}
function mapTntAthleteRow(row) {
  const rawStudent = valueOr(row, ['Student Status','Student'], '');
  const truth = String(rawStudent).toLowerCase();
  const studentLabel = (truth === 'true' || truth === 'yes' || truth === 'y' || truth === '1') ? 'Student' : (truth === '' ? '' : 'Non-Student');
  return {
    'Name': valueOr(row, ['Name','Athlete'], ''),
    'T-Shirt': valueOr(row, ['T-Shirt','T-Shirt Size'], ''),
    'Student': studentLabel,
    'Indv Tramp': valueOr(row, ['Indv Tramp'], ''),
    'Double Mini': valueOr(row, ['Double Mini'], ''),
    'Pwr Tumb': valueOr(row, ['Pwr Tumb'], ''),
    'Sync Tramp': valueOr(row, ['Sync Tramp'], '')
  };
}
function mapMultiDiscRow(row) {
  return {
    'Name': valueOr(row, ['Name','Athlete'], ''),
    'Decathlon Level': mapLevelCompound_(valueOr(row, ['Decathlon Level'], '')),
    'Omnithon': valueOr(row, ['Omnithon','Omnithon?'], '')
  };
}
function mapCoachRow(row) {
  return { 'Coach Name': valueOr(row, ['Coach Name','Name'], '') };
}

function mapAddOnRow(row) {
  return {
    'Item Name': valueOr(row, ['Item Name'], ''),
    'Details': valueOr(row, ['Details'], ''),
    'Quantity': valueOr(row, ['Quantity'], '')
  };
}

function getClubSummary(clubName) {
  const wagRaw = readByClub_('WAG Athlete Data', clubName).map(mapWagAthleteRow);
  const wagTeamRaw = readByClub_('WAG Team Summary', clubName).map(mapTeamSummaryRow);
  const magRaw = readByClub_('MAG Athlete Data', clubName).map(mapMagAthleteRow);
  const magTeamRaw = readByClub_('MAG Team Summary', clubName).map(mapTeamSummaryRow);
  const tntRaw = readByClub_('TnT Athlete Data', clubName).map(mapTntAthleteRow);
  const multiRaw = readByClub_('Multiple Discipline Summary', clubName).map(mapMultiDiscRow);
  const coachRaw = readByClub_('Coach Summary', clubName).map(mapCoachRow);
  const sessRaw = readByClub_('Session Assignment Summary', clubName);
const addOnRaw = readByClub_('Check-In Totals', clubName).map(mapAddOnRow);
  const refundStats = getRefundStats_(clubName, true); //
  
  const tShirtItems = [];
  const banquetItems = [];
  const otherCheckInItems = [];
  
  for (const item of addOnRaw) {
    const itemNameLower = String(item['Item Name']).toLowerCase();
    const itemDetails = item['Details'] ?? ''; 
    
    if (itemNameLower.includes('t-shirt')) {
      // Logic to skip coach t-shirts if you previously chose to exclude them
      if (itemNameLower === 'coach t-shirt') continue; 

      let isTicket = (itemNameLower === 't-shirt tickets');
      let finalSize;
      if (isTicket) {
        finalSize = 'T-Shirt Tickets';
      } else {
        const isExtra = itemNameLower.includes('extra');
        // Extra t-shirts come without hyphen (e.g. "Adult S"), normalize to "Adult - S"
        let sizeStr = String(itemDetails).trim();
        if (isExtra) {
          // Insert hyphen if missing: "Adult S" -> "Adult - S"
          sizeStr = sizeStr.replace(/^(Adult)\s+(?!-)(\S+)$/, '$1 - $2');
          finalSize = 'EXTRA ' + sizeStr;
        } else {
          finalSize = 'Athlete ' + sizeStr;
        }
      }

      tShirtItems.push({ 
        'Size': finalSize, 
        'Quantity': item['Quantity'], 
        'isTicket': isTicket 
      });
    } else if (itemNameLower.includes('banquet')) {
      // Push to the dedicated banquet array [cite: 147]
      let currentQty = Number(item['Quantity']) || 0;
      let refunded = refundStats.refundedQTY;
      let originalQty = currentQty + refundStats.addBackToOriginal;
      let finalQty = originalQty - refunded;
      
      banquetItems.push({
        'Item Name': item['Item Name'],
        'Details': itemDetails,
        'Original QTY': String(originalQty),
        'QTY Refunded': String(refunded),
        'Final QTY': String(finalQty)
      });
    } else {
      // Standard items go to the "Other Items" array
      otherCheckInItems.push({
        'Item Name': item['Item Name'],
        'Details': itemDetails,
        'Quantity': item['Quantity']
      });
    }
  }
  
  // Sort t-shirts: Athlete sizes first (in size order), then EXTRA sizes (same order), then tickets
  const SIZE_ORDER = ['Adult - XS','Adult - S','Adult - M','Adult - L','Adult - XL','Adult - XXL','Adult - XXXL'];
  function getSortIndex_(sizeStr) {
    // Strip "Athlete " or "EXTRA " prefix to get the bare size
    const bare = String(sizeStr).replace(/^(Athlete |EXTRA )/, '');
    const idx = SIZE_ORDER.indexOf(bare);
    return idx === -1 ? 99 : idx;
  }
  tShirtItems.sort((a, b) => {
    const aTicket = a['isTicket'] ? 1 : 0;
    const bTicket = b['isTicket'] ? 1 : 0;
    if (aTicket !== bTicket) return aTicket - bTicket;
    const aExtra = String(a['Size']).startsWith('EXTRA') ? 1 : 0;
    const bExtra = String(b['Size']).startsWith('EXTRA') ? 1 : 0;
    if (aExtra !== bExtra) return aExtra - bExtra;
    return getSortIndex_(a['Size']) - getSortIndex_(b['Size']);
  });

  return {
    club: clubName,
    wagAthletes: wagRaw,
    wagTeams: wagTeamRaw,
    magAthletes: magRaw,
    magTeams: magTeamRaw,
    tntAthletes: tntRaw,
    multiDisc: multiRaw,
    sessionAssignment: sessRaw, 
    coaches: coachRaw,
    banquetTotals: banquetItems, // Add this new property to the return [cite: 153]
    checkInTotals: otherCheckInItems, 
    tShirtSummary: tShirtItems        
  };
}

function hasClubConfirmed(clubName) {
  if (!clubName) return false;
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName('Registration Confirmations');
  if (!sh) return false; 
  const values = sh.getRange(1, 2, sh.getLastRow() || 1, 1).getValues(); 
  return values.some(r => String(r[0]).trim() === String(clubName).trim());
}

function submitConfirmation(clubName, personName, email) {
  if (new Date() < FORM_RELEASE_TIME) throw new Error('Check-in confirmation is not yet open.');
  if (!personName || !email) throw new Error('Name and Email are required.');
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName('Registration Confirmations') || ss.insertSheet('Registration Confirmations');
  sh.appendRow([new Date(), clubName, personName, email]);
  return { ok: true };
}

function _findIndNameHeader_(headers) {
  if (!headers || !headers.length) return 'Name';
  let hit = headers.find(h => String(h).trim().toLowerCase() === 'name') || headers.find(h => String(h).trim().toLowerCase() === 'athlete');
  if (hit) return hit;
  hit = headers.find(h => String(h).toLowerCase().includes('athlete')) || headers.find(h => String(h).toLowerCase().includes('name'));
  return hit || 'Name';
}

function readByName_(sheetName, selectedName) {
  const rows = readSheetObjects_(sheetName);
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const targetName = String(selectedName).trim().toLowerCase();
  
  if (sheetName === 'Ind Check-In Totals') {
    const pHeader = headers.find(h => String(h).trim().toLowerCase() === 'purchaser') ||
                    headers.find(h => String(h).toLowerCase().includes('purchaser')) ||
                    _findIndNameHeader_(headers); 
     return rows.filter(r => String(r[pHeader] || '').trim().toLowerCase() === targetName);
  }
  
  const nameHeader = _findIndNameHeader_(headers); 
  return rows.filter(r => String(r[nameHeader] || '').trim().toLowerCase() === targetName);
}

function getIndependentNames() {
  const rows = readSheetObjects_('Ind Emails'); 
  if (!rows.length) return [];
  const nameHeader = _findIndNameHeader_(Object.keys(rows[0]));
  const set = new Set();
  rows.forEach(r => {
    const nm = String(r[nameHeader] ?? '').trim();
    if (nm) set.add(nm);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function getIndependentSummary(selectedName) {
  if (!selectedName) throw new Error('No name provided.');
  const pdRows = readByName_('Ind Emails', selectedName);
  const pdRow = (pdRows.length > 0) ? pdRows[0] : {};
  const pdHeaders = (pdRows.length > 0) ? Object.keys(pdRow) : [];
  const nameHeader = _findIndNameHeader_(pdHeaders);
  const teeHeader = pdHeaders.find(h => String(h).toLowerCase().includes('shirt')) || 'T-Shirt Size';

  const personalDetails = {
    columns: ['Name', 'T-Shirt Size'],
    rows: [[ pdRow[nameHeader] ?? selectedName, pdRow[teeHeader] ?? '' ]]
  };
  const mapRows = (rows, cols) => rows.map(r => cols.map(c => r[c] ?? ''));
  const mapRowsWithLevel = (rows, cols) => rows.map(r => cols.map(c => c === 'Level' || c === 'Decathlon Level' ? mapLevel_(r[c] ?? '') : (r[c] ?? '')));
  const mapMultiRows = (rows) => rows.map(r => [
    mapLevelCompound_(r['Decathlon Level'] ?? ''),
    r['Omnithon'] ?? r['Omnithon?'] ?? ''
  ]);

  const wagRows = readByName_('WAG Athlete Data', selectedName);
  const magRows = readByName_('MAG Athlete Data', selectedName);
  const tntRows = readByName_('TnT Athlete Data', selectedName);
  const multiRows = readByName_('Multiple Discipline Summary', selectedName);
  const sessionRows = readByName_('Ind Session Summary', selectedName);
  const addOnRows = readByName_('Ind Check-In Totals', selectedName);

  return {
    name: selectedName,
    personalDetails,
    wag: { columns: ['Level','Placement Category','VT','UB','BB','FX','AA'], rows: mapRowsWithLevel(wagRows, ['Level','Placement Category','VT','UB','BB','FX','AA']), empty: wagRows.length === 0 },
    mag: { columns: ['Level','Placement Category','FX','PH','SR','VT','PB','HB','AA'], rows: mapRowsWithLevel(magRows, ['Level','Placement Category','FX','PH','SR','VT','PB','HB','AA']), empty: magRows.length === 0 },
    tnt: { columns: ['Indv Tramp','Double Mini','Pwr Tumb','Sync Tramp'], rows: mapRows(tntRows, ['Indv Tramp','Double Mini','Pwr Tumb','Sync Tramp']), empty: tntRows.length === 0 },
    multi: { columns: ['Decathlon Level','Omnithon'], rows: mapMultiRows(multiRows), empty: multiRows.length === 0 },
    sessionAssignment: { columns: ['Discipline', 'Level', 'Assigned Session'], rows: mapRowsWithLevel(sessionRows, ['Discipline', 'Level', 'Assigned Session']), empty: sessionRows.length === 0 }, 
    checkInTotals: { columns: ['Item Name', 'Details', 'Quantity'], rows: mapRows(addOnRows, ['Item Name', 'Details', 'Quantity']), empty: addOnRows.length === 0 }, 
    indCoaches: getIndependentCoaches_()
  };
}

function hasIndependentConfirmed(name) {
  if (!name) return false;
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName('Ind Registration Confirmations');
  if (!sh) return false; 
  const values = sh.getRange(1, 2, sh.getLastRow() || 1, 1).getValues(); 
  const target = String(name).trim().toLowerCase();
  return values.some(r => String(r[0]).trim().toLowerCase() === target);
}

function submitIndependentConfirmation(name, email) {
  if (new Date() < FORM_RELEASE_TIME) throw new Error('Check-in confirmation is not yet open.');
  if (!name) throw new Error('Please select your name.');
  if (!email) throw new Error('Please enter an email.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet_(); 
    let sh = ss.getSheetByName('Ind Registration Confirmations') || ss.insertSheet('Ind Registration Confirmations');
    if (sh.getLastRow() === 0) sh.appendRow(['Timestamp', 'Name', 'Email']);
    sh.appendRow([new Date(), name, email]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function getRefundStats_(identifier, isClub) {
  const stats = { refundedQTY: 0, addBackToOriginal: 0 };
  try {
    const refundSs = SpreadsheetApp.openById("1kc9IQi7TdO7EeX0VkchVFLUywnjkF5XdRdwilNT2PDg");
    const sheet = refundSs.getSheets()[0];
    const data = sheet.getDataRange().getValues();
    data.forEach((r, index) => {
      if (index === 0) return; 
      const matchTarget = isClub ? String(r[3]) : String(r[6]); 
      const isMatch = matchTarget.trim().toLowerCase() === String(identifier).trim().toLowerCase();
      const isYes = String(r[9]).trim().toLowerCase() === "yes"; 
      const statusValue = String(r[17]).trim().toLowerCase();
      const isStatusRefunded = statusValue.includes("refunded banquet");
      if (isMatch && isYes) {
        stats.refundedQTY++; 
        if (isStatusRefunded) stats.addBackToOriginal++; 
      }
    });
  } catch (e) { console.error("Refund Sheet Error: " + e.message); }
  return stats;
}

function getIndependentCoaches_() {
  const indClubs = ["Independent Student Athlete", "Independent Community Athlete"];
  const coachRows = readSheetObjects_('Coach Summary');
  return coachRows.filter(r => {
    const c = valueOr(r, ['Club', 'Club Name']);
    return indClubs.includes(String(c).trim());
  }).map(r => ({ 'Coach Name': valueOr(r, ['Coach Name','Name']) }));
}
