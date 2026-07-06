/**
 * UNIFIED JSON API BACKEND
 * Handles both Club Summary and Independent Athlete Summary
 */

const SHEET_ID = '102KU3i8rlOs8ON9qQQpeyNGVhwMNVab6wtt5G1kz6yc';

// ====== GLOBAL CONFIG ======
// Set the date when the confirmation forms become visible
const FORM_OPEN_DATE = new Date("2026-02-17T08:00:00-05:00");

// ====== ROUTER ======

function doGet(e) {
  const params = e.parameter;
  const action = params.action;
  
  let result = {};
  try {
    switch (action) {
      case 'getInitData':
        result = {
          updatedText: getUpdatedAtText_(),
          clubs: getClubsList_(),
          names: getIndNamesList_(),
          indCoaches: getIndCoachesList_()
        };
        break;
        
      case 'getClubSummary':
        result = getClubSummaryData_(params.club);
        break;
      case 'submitClubConfirmation':
        // Updated to include agreement status
        result = submitClubConf_(params.club, params.name, params.email, params.agreement);
        break;

      case 'getIndSummary':
        result = getIndSummaryData_(params.name);
        break;
      case 'submitIndConfirmation':
        // Updated to include agreement status
        result = submitIndConf_(params.name, params.email, params.agreement);
        break;
      case 'submitIndSessionRequest':
        result = saveIndSessionRequest_(params.name, params.day, params.session, params.notes);
        break;

      default:
        result = { error: 'Invalid action' };
    }
  } catch (err) {
    result = { error: err.message, stack: err.stack };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== SHARED HELPERS ======

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function getUpdatedAtText_() {
  try {
    const sh = getSpreadsheet_().getSheetByName('Club Emails');
    return sh ? sh.getRange(1, 4).getDisplayValue() : '';
  } catch (e) { return ''; }
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
    if (!row.some(c => c !== '' && c !== null)) continue;
    if (row.some(h => /club/i.test(String(h)) || /name/i.test(String(h)) || /athlete/i.test(String(h))) || i === 0) {
      headerRow = i;
      break;
    }
  }

  const headers = values[headerRow].map(h => String(h).trim());
  const rows = values.slice(headerRow + 1).filter(r => r.some(c => c !== '' && c !== null));
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = r[i]);
    return obj;
  });
}

function valueOr(obj, keys, fallback = '') {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const k of keyList) {
    const foundKey = Object.keys(obj).find(ok => ok.toLowerCase() === k.toLowerCase());
    if (foundKey && obj[foundKey] !== undefined && String(obj[foundKey]).length > 0) {
      return obj[foundKey];
    }
  }
  return fallback;
}

// ====== CLUB LOGIC ======

function getClubsList_() {
  const rows = readSheetObjects_('Club Emails');
  const clubs = new Set();
  rows.forEach(r => {
    const c = valueOr(r, ['Club', 'Club Name']);
    if (c) clubs.add(c);
  });
  return Array.from(clubs).sort((a, b) => a.localeCompare(b));
}

function getClubSummaryData_(clubName) {
  const byClub = (sheet) => readSheetObjects_(sheet).filter(r => {
    const c = valueOr(r, ['Club', 'Club Name']);
    return String(c).trim() === String(clubName).trim();
  });

  const mapWag = r => ({
    'Name': valueOr(r, ['Name','Athlete']),
    'T-Shirt': valueOr(r, ['T-Shirt','T-Shirt Size']),
    'Placement Category': valueOr(r, ['Placement Category','Category']),
    'Level': valueOr(r, ['Level']),
    'VT': valueOr(r, 'VT'), 'UB': valueOr(r, 'UB'), 'BB': valueOr(r, 'BB'), 'FX': valueOr(r, 'FX'), 'AA': valueOr(r, 'AA')
  });

  const mapMag = r => ({
    'Name': valueOr(r, ['Name','Athlete']),
    'T-Shirt': valueOr(r, ['T-Shirt','T-Shirt Size']),
    'Placement Category': valueOr(r, ['Placement Category','Category']),
    'Level': valueOr(r, ['Level']),
    'FX': valueOr(r, 'FX'), 'PH': valueOr(r, 'PH'), 'SR': valueOr(r, 'SR'), 'VT': valueOr(r, 'VT'), 
    'PB': valueOr(r, 'PB'), 'HB': valueOr(r, 'HB'), 'AA': valueOr(r, 'AA')
  });

  const mapTeam = r => ({
    'Level': valueOr(r, 'Level'),
    'Placement Category': valueOr(r, ['Placement Category','Category']),
    'Team?': valueOr(r, 'Team?')
  });

  const mapTnt = r => {
    const rawS = valueOr(r, ['Student Status','Student']);
    const isS = ['true','yes','y','1'].includes(String(rawS).toLowerCase());
    return {
      'Name': valueOr(r, ['Name','Athlete']),
      'T-Shirt': valueOr(r, ['T-Shirt','T-Shirt Size']),
      'Student': isS ? 'Student' : (rawS === '' ? '' : 'Non-Student'),
      'Indv Tramp': valueOr(r, 'Indv Tramp'),
      'Double Mini': valueOr(r, 'Double Mini'),
      'Pwr Tumb': valueOr(r, 'Pwr Tumb'),
      'Sync Tramp': valueOr(r, 'Sync Tramp')
    };
  };

  const mapMulti = r => ({
    'Name': valueOr(r, ['Name','Athlete']),
    'Decathlon Level': valueOr(r, 'Decathlon Level'),
    'Omnithon': valueOr(r, 'Omnithon')
  });

  const refundStats = getRefundStats_(clubName, true);
  const mapAddon = r => {
    const itemName = valueOr(r, 'Item Name');
    const isBanquet = itemName.toLowerCase().includes('banquet');
    
    let currentQty = Number(valueOr(r, ['Quantity', 'Original QTY'])) || 0;
    const refunded = isBanquet ? refundStats.refundedQTY : 0;
    
    // Original = Current in sheet + only those marked "Refunded" in the refund sheet
    let originalQty = isBanquet ? (currentQty + refundStats.addBackToOriginal) : currentQty;
    let finalQty = originalQty - refunded;
    
    return {
      'Item Name': itemName,
      'Details': valueOr(r, 'Details'),
      'Original QTY': String(originalQty),
      'QTY Refunded': String(refunded),
      'Final QTY': String(finalQty)
    };
  };

  const mapCoach = r => ({
    'Coach Name': valueOr(r, ['Coach Name','Name']),
  });

  return {
    club: clubName,
    wagAthletes: byClub('WAG Athlete Data').map(mapWag),
    wagTeams: byClub('WAG Team Summary').map(mapTeam),
    magAthletes: byClub('MAG Athlete Data').map(mapMag),
    magTeams: byClub('MAG Team Summary').map(mapTeam),
    tntAthletes: byClub('TnT Athlete Data').map(mapTnt),
    multiDisc: byClub('Multiple Discipline Summary').map(mapMulti),
    sessionReq: byClub('Session Request Summary'), 
    coaches: byClub('Coach Summary').map(mapCoach),
    addOns: byClub('Add-On Summary').map(mapAddon),
    confirmed: checkClubConf_(clubName)
  };
}

function checkClubConf_(clubName) {
  const sh = getSpreadsheet_().getSheetByName('Registration Confirmations');
  if (!sh) return false;
  const data = sh.getDataRange().getValues();
  return data.some(r => String(r[1]).trim().toLowerCase() === String(clubName).trim().toLowerCase());
}

function submitClubConf_(club, name, email, agreement) {
  if (!club || !name || !email || !agreement) throw new Error("Missing fields");
  const ss = getSpreadsheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let sh = ss.getSheetByName('Registration Confirmations');
    if (!sh) { 
      sh = ss.insertSheet('Registration Confirmations'); 
      sh.appendRow(['Timestamp','Club','Name','Email','Status']); // Added status header
    }
    sh.appendRow([new Date(), club, name, email, agreement]);
  } finally { lock.releaseLock(); }
  return { success: true };
}

// ====== INDEPENDENT ATHLETE LOGIC ======

function getIndNamesList_() {
  const rows = readSheetObjects_('Ind Emails');
  const names = new Set();
  rows.forEach(r => {
    const n = valueOr(r, ['Name','Athlete']);
    if (n) names.add(n);
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function getIndSummaryData_(name) {
  const byName = (sheet, colOverride) => {
    const rows = readSheetObjects_(sheet);
    return rows.filter(r => {
      const target = colOverride ? valueOr(r, colOverride) : valueOr(r, ['Name','Athlete']);
      return String(target).trim().toLowerCase() === String(name).trim().toLowerCase();
    });
  };

  const pRows = byName('Ind Emails');
  const personalDetails = {
    columns: ['Name', 'T-Shirt Size'],
    rows: pRows.length ?
      [[ valueOr(pRows[0], ['Name','Athlete']), valueOr(pRows[0], ['T-Shirt Size','T-Shirt']) ]] : [[name, '']]
  };

  const wagCols = ['Level','Placement Category','VT','UB','BB','FX','AA'];
  const wagRaw = byName('WAG Athlete Data');
  const wag = {
    columns: wagCols,
    rows: wagRaw.map(r => wagCols.map(c => valueOr(r, c))),
    empty: wagRaw.length === 0
  };
  const magCols = ['Level','Placement Category','FX','PH','SR','VT','PB','HB','AA'];
  const magRaw = byName('MAG Athlete Data');
  const mag = {
    columns: magCols,
    rows: magRaw.map(r => magCols.map(c => valueOr(r, c))),
    empty: magRaw.length === 0
  };
  const tntCols = ['Indv Tramp','Double Mini','Pwr Tumb','Sync Tramp'];
  const tntRaw = byName('TnT Athlete Data');
  const tnt = {
    columns: tntCols,
    rows: tntRaw.map(r => tntCols.map(c => valueOr(r, c))),
    empty: tntRaw.length === 0
  };
  const mCols = ['Decathlon Level','Omnithon'];
  const mRaw = byName('Multiple Discipline Summary');
  const multi = {
    columns: mCols,
    rows: mRaw.map(r => mCols.map(c => valueOr(r, c))),
    empty: mRaw.length === 0
  };
  const refundStats = getRefundStats_(name, false);
  const addCols = ['Item Name', 'Details', 'Original QTY', 'QTY Refunded', 'Final QTY'];
  const addRaw = byName('Add-On Ind', ['Purchaser', 'Name']);
  
  const addOn = {
    columns: addCols,
    rows: addRaw.map(r => {
      const itemName = valueOr(r, 'Item Name');
      const isBanquet = itemName.toLowerCase().includes('banquet');
      let currentQty = Number(valueOr(r, ['Quantity', 'Original QTY'])) || 0;
      
      const refunded = isBanquet ? refundStats.refundedQTY : 0;
      let originalQty = isBanquet ? (currentQty + refundStats.addBackToOriginal) : currentQty;
      let finalQty = originalQty - refunded;
      
      return [itemName, valueOr(r, 'Details'), String(originalQty), String(refunded), String(finalQty)];
    }),
    empty: addRaw.length === 0
  };
  
  const indClubs = ["Independent Student Athlete", "Independent Community Athlete"];
  const coachRows = readSheetObjects_('Coach Summary');
  const indCoaches = coachRows.filter(r => {
    const c = valueOr(r, ['Club', 'Club Name']);
    return indClubs.includes(String(c).trim());
  }).map(r => ({
    'Coach Name': valueOr(r, ['Coach Name','Name']),
  }));

  const sessionRaw = byName('Independent Session Request');
  const sessionRequest = {
    hasRequest: sessionRaw.length > 0,
    data: sessionRaw.length ? {
      day: valueOr(sessionRaw[0], 'Preferred Day'),
      session: valueOr(sessionRaw[0], '1st Session Available'),
      notes: valueOr(sessionRaw[0], 'Notes')
    } : null
  };

  return {
    name: name,
    personalDetails, wag, mag, tnt, multi, addOn,
    sessionRequest, // Add this line
    indCoaches: indCoaches,
    confirmed: checkIndConf_(name)
  };
}

function checkIndConf_(name) {
  const sh = getSpreadsheet_().getSheetByName('Ind Registration Confirmations');
  if (!sh) return false;
  const data = sh.getDataRange().getValues();
  return data.some(r => String(r[1]).trim().toLowerCase() === String(name).trim().toLowerCase());
}

function submitIndConf_(name, email, agreement) {
  if (!name || !email || !agreement) throw new Error("Missing fields");
  const ss = getSpreadsheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let sh = ss.getSheetByName('Ind Registration Confirmations');
    if (!sh) { 
      sh = ss.insertSheet('Ind Registration Confirmations'); 
      sh.appendRow(['Timestamp','Name','Email','Status']); // Added status header
    }
    sh.appendRow([new Date(), name, email, agreement]);
  } finally { lock.releaseLock(); }
  return { success: true };
}

function getIndCoachesList_() {
  const indClubs = ["Independent Student Athlete", "Independent Community Athlete"];
  const coachRows = readSheetObjects_('Coach Summary');
  return coachRows.filter(r => {
    const c = valueOr(r, ['Club', 'Club Name']);
    return indClubs.includes(String(c).trim());
  }).map(r => ({
    'Coach Name': valueOr(r, ['Coach Name','Name'])
  }));
}

function saveIndSessionRequest_(name, day, session, notes) {
  const ss = getSpreadsheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let sh = ss.getSheetByName('Independent Session Request');
    if (!sh) {
      sh = ss.insertSheet('Independent Session Request');
      sh.appendRow(['Name', 'Preferred Day', '1st Session Available', 'Notes']);
    }
    const data = sh.getDataRange().getValues();
    let rowIndex = data.findIndex(r => String(r[0]).trim().toLowerCase() === String(name).trim().toLowerCase());
    
    if (rowIndex > -1) {
      // Update existing row (rowIndex is 0-based, API is 1-based)
      sh.getRange(rowIndex + 1, 2, 1, 3).setValues([[day, session, notes]]);
    } else {
      // Append new row
      sh.appendRow([name, day, session, notes]);
    }
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}
function getRefundCount_(identifier, isClub) {
  try {
    const refundSs = SpreadsheetApp.openById("1kc9IQi7TdO7EeX0VkchVFLUywnjkF5XdRdwilNT2PDg");
    const sheet = refundSs.getSheets()[0]; // Assumes first sheet
    const data = sheet.getDataRange().getValues();
    
    // Column D (index 3) is Club Name, Column G (index 6) is Athlete Name, Column J (index 9) is Refund status
    return data.filter(r => {
      const matchTarget = isClub ? String(r[3]) : String(r[6]);
      return matchTarget.trim().toLowerCase() === String(identifier).trim().toLowerCase() && 
             String(r[9]).trim().toLowerCase() === "yes";
    }).length;
  } catch (e) {
    return 0;
  }
}

function getRefundData_(identifier, isClub) {
  const dataMap = { count: 0, hasRefundedStatus: false };
  try {
    const refundSs = SpreadsheetApp.openById("1kc9IQi7TdO7EeX0VkchVFLUywnjkF5XdRdwilNT2PDg");
    const sheet = refundSs.getSheets()[0];
    const data = sheet.getDataRange().getValues();
    
    // Column D (3): Club, Column G (6): Name, Column J (9): Refund Yes/No, Column R (17): Status
    data.forEach(r => {
      const matchTarget = isClub ? String(r[3]) : String(r[6]);
      if (matchTarget.trim().toLowerCase() === String(identifier).trim().toLowerCase()) {
        if (String(r[9]).trim().toLowerCase() === "yes") {
          dataMap.count++;
        }
        if (String(r[17]).trim().toLowerCase().includes("refunded banquet")) {
          dataMap.hasRefundedStatus = true;
        }
      }
    });
  } catch (e) { console.error(e); }
  return dataMap;
}
function getRefundStats_(identifier, isClub) {
  const stats = { refundedQTY: 0, addBackToOriginal: 0 };
  try {
    const refundSs = SpreadsheetApp.openById("1kc9IQi7TdO7EeX0VkchVFLUywnjkF5XdRdwilNT2PDg");
    const sheet = refundSs.getSheets()[0];
    const data = sheet.getDataRange().getValues();
    
    data.forEach((r, index) => {
      if (index === 0) return; // Skip header 
      
      const matchTarget = isClub ? String(r[3]) : String(r[6]); // Column D or G 
      const isMatch = matchTarget.trim().toLowerCase() === String(identifier).trim().toLowerCase();
      const isYes = String(r[9]).trim().toLowerCase() === "yes"; // Column J 
      
      // Column R (index 17) is the Status column 
      const statusValue = String(r[17]).trim().toLowerCase();
      
      // This will match "refunded 2/18, refunded banquet" from your image
      const isStatusRefunded = statusValue.includes("refunded banquet");

      if (isMatch && isYes) {
        stats.refundedQTY++; // Found a valid refund row 
        if (isStatusRefunded) {
          stats.addBackToOriginal++; // Specifically add back to Original QTY 
        }
      }
    });
  } catch (e) { console.error("Refund Sheet Error: " + e.message); }
  return stats;
}
