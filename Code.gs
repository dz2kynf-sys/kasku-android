const SHEETS = {
  households: { name: 'Households', headers: ['id', 'name', 'inviteCode', 'createdAt'] },
  memberships: { name: 'HouseholdMembers', headers: ['householdId', 'userId', 'role', 'createdAt', 'character'] },
  users: { name: 'Users', headers: ['id', 'name', 'email', 'salt', 'passwordHash', 'createdAt'] },
  transactions: { name: 'Transactions', headers: ['id', 'userId', 'type', 'amount', 'purpose', 'date', 'createdAt', 'householdId'] },
  payments: { name: 'PaymentItems', headers: ['id', 'name', 'amount', 'active', 'createdAt', 'householdId'] },
  checks: { name: 'PaymentChecks', headers: ['userId', 'itemId', 'month', 'checked', 'updatedAt', 'householdId', 'amount'] }
};
const MEMBER_CHARACTERS = ['🙂', '😎', '🦊', '🐼', '🐱', '🐸', '🦉', '🐻', '🐧', '🐨'];
const DEFAULT_MEMBER_CHARACTER = MEMBER_CHARACTERS[0];

function doGet() {
  ensureDatabase_();
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('KasKU — Catatan kas bersama')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function setup() {
  const spreadsheet = ensureDatabase_();
  Logger.log('Spreadsheet KasKU: ' + spreadsheet.getUrl());
  return { name: spreadsheet.getName(), url: spreadsheet.getUrl() };
}

function apiSignup(name, email, password) {
  const displayName = validateText_(name, 'Nama', 2, 60);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    throw new Error('Masukkan alamat email yang valid.');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('Kata sandi harus terdiri dari 8–128 karakter.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let user;
  let householdId;
  try {
    const sheet = getSheet_('users');
    const rows = sheet.getDataRange().getValues();
    if (rows.slice(1).some(row => String(row[2]).toLowerCase() === normalizedEmail)) {
      throw new Error('Email ini sudah terdaftar. Silakan masuk.');
    }

    const salt = Utilities.getUuid().replace(/-/g, '');
    user = {
      id: Utilities.getUuid(),
      name: displayName,
      email: normalizedEmail,
      salt: salt,
      passwordHash: hashPassword_(password, salt),
      createdAt: new Date().toISOString()
    };
    sheet.appendRow([user.id, user.name, user.email, user.salt, user.passwordHash, user.createdAt]);
    householdId = createHousehold_(user.name + ' Rumah', user.id, DEFAULT_MEMBER_CHARACTER);
  } finally {
    lock.releaseLock();
  }
  return createSession_(user, householdId);
}

function apiLogin(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || typeof password !== 'string') {
    throw new Error('Email dan kata sandi wajib diisi.');
  }
  const rows = getSheet_('users').getDataRange().getValues();
  const row = rows.slice(1).find(item => String(item[2]).toLowerCase() === normalizedEmail);
  if (!row || !constantTimeEquals_(hashPassword_(password, String(row[3])), String(row[4]))) {
    throw new Error('Email atau kata sandi tidak cocok.');
  }
  return createSession_({ id: String(row[0]), name: String(row[1]), email: String(row[2]) });
}

function apiGetData(token) {
  const user = requireSession_(token);
  const membershipsForUser = getHouseSheetData_('memberships')
    .filter(row => String(row[1]) === user.id);
  if (!membershipsForUser.length) {
    const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
    return {
      user: { id: user.id, name: user.name, email: user.email, character: DEFAULT_MEMBER_CHARACTER },
      household: null, households: [], members: [], month: month,
      totals: { income: 0, expenses: 0, balance: 0 }, transactions: [], payments: []
    };
  }
  const household = requireHousehold_(token, user);
  const householdId = household.id;
  const userRows = getSheet_('users').getDataRange().getValues().slice(1);
  const usersById = new Map(userRows.map(row => [String(row[0]), row]));
  const transactionRows = getSheet_('transactions').getDataRange().getValues().slice(1);
  const transactions = transactionRows
    .filter(row => String(row[7]) === householdId)
    .map(row => ({
      id: String(row[0]),
      userId: String(row[1]),
      type: String(row[2]),
      amount: Number(row[3]),
      purpose: String(row[4]),
      date: String(row[5]),
      createdBy: usersById.has(String(row[1])) ? String(usersById.get(String(row[1]))[1]) : ''
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const paymentRows = getSheet_('payments').getDataRange().getValues().slice(1);
  const checkRows = getSheet_('checks').getDataRange().getValues().slice(1);
  const householdMembers = getHouseSheetData_('memberships')
    .filter(row => String(row[0]) === householdId);
  const members = householdMembers.map(row => {
    const member = usersById.get(String(row[1]));
    return member ? {
      userId: String(row[1]), name: String(member[1]), email: String(member[2]), role: String(row[2]),
      character: validMemberCharacter_(row[4]) ? String(row[4]) : DEFAULT_MEMBER_CHARACTER
    } : null;
  }).filter(Boolean);
  const currentMembership = householdMembers.find(row => String(row[1]) === user.id);
  const households = getHouseSheetData_('memberships')
    .filter(row => String(row[1]) === user.id)
    .map(row => getHousehold_(String(row[0])))
    .filter(Boolean);
  const paymentRowsForHousehold = paymentRows
    .filter(row => String(row[5]) === householdId);
  const month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  const checksForHousehold = checkRows.filter(row => String(row[5]) === householdId &&
    (row[3] === true || String(row[3]).toLowerCase() === 'true'));
  const paymentsById = new Map(paymentRowsForHousehold.map(row => [String(row[0]), row]));
  const paidBy = new Map();
  checksForHousehold.filter(row => String(row[2]) === month).forEach(row => {
    const payers = paidBy.get(String(row[1])) || [];
    if (payers.some(payer => payer.userId === String(row[0]))) return;
    const member = usersById.get(String(row[0]));
    payers.push({ userId: String(row[0]), name: member ? String(member[1]) : 'Anggota' });
    paidBy.set(String(row[1]), payers);
  });
  checksForHousehold.forEach(row => {
    const payment = paymentsById.get(String(row[1]));
    if (!payment) return;
    const amount = Number(row[6] !== undefined && row[6] !== '' ? row[6] : payment[2]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    const date = String(row[4] || '').slice(0, 10);
    transactions.push({
      id: 'payment-' + String(row[0]) + '-' + String(row[1]) + '-' + String(row[2]),
      userId: String(row[0]),
      paymentItemId: String(row[1]),
      paymentMonth: String(row[2]),
      type: 'income',
      amount: amount,
      purpose: 'Iuran: ' + String(payment[1]),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : String(row[2]) + '-01',
      createdBy: usersById.has(String(row[0])) ? String(usersById.get(String(row[0]))[1]) : 'Anggota'
    });
  });
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  const payments = paymentRowsForHousehold
    .filter(row => row[0] && row[3] !== false && String(row[3]).toLowerCase() !== 'false')
    .map(row => ({
      id: String(row[0]),
      name: String(row[1]),
      amount: Number(row[2]),
      checked: checksForHousehold.some(check => String(check[0]) === user.id &&
        String(check[1]) === String(row[0]) && String(check[2]) === month),
      paidBy: paidBy.get(String(row[0])) || []
    }));

  const income = transactions.reduce((sum, item) => item.type === 'income' ? sum + item.amount : sum, 0);
  const expenses = transactions.reduce((sum, item) => item.type === 'expense' ? sum + item.amount : sum, 0);
  return {
    user: {
      id: user.id, name: user.name, email: user.email,
      character: currentMembership && validMemberCharacter_(currentMembership[4])
        ? String(currentMembership[4]) : DEFAULT_MEMBER_CHARACTER,
      role: currentMembership ? String(currentMembership[2]) : ''
    },
    household: household,
    households: households,
    members: members,
    month: month,
    totals: { income: income, expenses: expenses, balance: income - expenses },
    transactions: transactions,
    payments: payments
  };
}

function apiAddTransaction(token, type, amount, purpose, date) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  if (type !== 'income' && type !== 'expense') throw new Error('Jenis transaksi tidak valid.');
  const numericAmount = Number(amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0 || numericAmount > 1000000000000) {
    throw new Error('Nominal harus berupa jumlah EGP positif.');
  }
  const description = validateText_(purpose, 'Keterangan', 2, 160);
  const transactionDate = String(date || '');
  const parsedDate = new Date(transactionDate + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== transactionDate) {
    throw new Error('Tanggal transaksi tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_('transactions').appendRow([
      Utilities.getUuid(), user.id, type, numericAmount, description, transactionDate, new Date().toISOString(), household.id
    ]);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiUpdateTransaction(token, transactionId, type, amount, purpose, date) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(transactionId || '');
  if (!/^[\w-]{1,80}$/.test(targetId)) throw new Error('Transaksi tidak valid.');
  if (type !== 'income' && type !== 'expense') throw new Error('Jenis transaksi tidak valid.');
  const numericAmount = Number(amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0 || numericAmount > 1000000000000) {
    throw new Error('Nominal harus berupa jumlah EGP positif.');
  }
  const description = validateText_(purpose, 'Keterangan', 2, 160);
  const transactionDate = String(date || '');
  const parsedDate = new Date(transactionDate + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== transactionDate) {
    throw new Error('Tanggal transaksi tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('transactions');
    const rows = sheet.getDataRange().getValues();
    const canManageAll = isHouseholdOwner_(household.id, user.id);
    const index = rows.findIndex((row, i) => i > 0 && String(row[0]) === targetId &&
      (String(row[1]) === user.id || canManageAll) &&
      String(row[7]) === household.id);
    if (index < 1) throw new Error('Transaksi tidak ditemukan atau bukan milik akun ini.');
    sheet.getRange(index + 1, 3, 1, 4).setValues([[
      type, numericAmount, description, transactionDate
    ]]);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiDeleteTransaction(token, transactionId) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(transactionId || '');
  if (!/^[\w-]{1,80}$/.test(targetId)) throw new Error('Transaksi tidak valid.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('transactions');
    const rows = sheet.getDataRange().getValues();
    const canManageAll = isHouseholdOwner_(household.id, user.id);
    const index = rows.findIndex((row, i) => i > 0 && String(row[0]) === targetId &&
      (String(row[1]) === user.id || canManageAll) &&
      String(row[7]) === household.id);
    if (index < 1) throw new Error('Transaksi tidak ditemukan atau bukan milik akun ini.');
    sheet.deleteRow(index + 1);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiTogglePayment(token, itemId, month, checked) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const paymentId = String(itemId || '');
  const targetMonth = String(month || '');
  if (!/^[\w-]{1,80}$/.test(paymentId) || !/^\d{4}-\d{2}$/.test(targetMonth)) {
    throw new Error('Data checklist tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const items = getSheet_('payments').getDataRange().getValues().slice(1);
    const payment = items.find(row => String(row[0]) === paymentId && String(row[5]) === household.id &&
      row[3] !== false && String(row[3]).toLowerCase() !== 'false');
    if (!payment) throw new Error('Item pembayaran tidak ditemukan.');
    const sheet = getSheet_('checks');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 &&
      String(row[0]) === user.id && String(row[1]) === paymentId &&
      String(row[2]) === targetMonth && String(row[5]) === household.id);
    const values = [
      user.id, paymentId, targetMonth, Boolean(checked), new Date().toISOString(), household.id, Number(payment[2])
    ];
    if (index >= 1) {
      sheet.getRange(index + 1, 1, 1, values.length).setValues([values]);
    } else {
      sheet.appendRow(values);
    }
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiUpdatePaymentTransaction(token, transactionId, payerId, itemId, month, amount, date) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(transactionId || '');
  const targetPayerId = String(payerId || '');
  const paymentId = String(itemId || '');
  const targetMonth = String(month || '');
  const numericAmount = Number(amount);
  const transactionDate = String(date || '');
  const parsedDate = new Date(transactionDate + 'T12:00:00Z');
  if (!/^[\w-]{1,80}$/.test(targetPayerId) || !/^[\w-]{1,80}$/.test(paymentId) ||
      !/^\d{4}-\d{2}$/.test(targetMonth) ||
      targetId !== 'payment-' + targetPayerId + '-' + paymentId + '-' + targetMonth) {
    throw new Error('Transaksi iuran tidak valid.');
  }
  if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0 || numericAmount > 1000000000000) {
    throw new Error('Nominal harus berupa jumlah EGP positif.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== transactionDate) {
    throw new Error('Tanggal transaksi tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!isHouseholdOwner_(household.id, user.id)) {
      throw new Error('Hanya pemilik rumah yang dapat mengedit transaksi iuran.');
    }
    const sheet = getSheet_('checks');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 &&
      String(row[0]) === targetPayerId && String(row[1]) === paymentId &&
      String(row[2]) === targetMonth && String(row[5]) === household.id &&
      (row[3] === true || String(row[3]).toLowerCase() === 'true'));
    if (index < 1) throw new Error('Transaksi iuran tidak ditemukan.');
    sheet.getRange(index + 1, 5).setValue(transactionDate + 'T12:00:00.000Z');
    sheet.getRange(index + 1, 7).setValue(numericAmount);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiDeletePaymentTransaction(token, transactionId, payerId, itemId, month) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(transactionId || '');
  const targetPayerId = String(payerId || '');
  const paymentId = String(itemId || '');
  const targetMonth = String(month || '');
  if (!/^[\w-]{1,80}$/.test(targetPayerId) || !/^[\w-]{1,80}$/.test(paymentId) ||
      !/^\d{4}-\d{2}$/.test(targetMonth) ||
      targetId !== 'payment-' + targetPayerId + '-' + paymentId + '-' + targetMonth) {
    throw new Error('Transaksi iuran tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!isHouseholdOwner_(household.id, user.id)) {
      throw new Error('Hanya pemilik rumah yang dapat menghapus transaksi iuran.');
    }
    const sheet = getSheet_('checks');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 &&
      String(row[0]) === targetPayerId && String(row[1]) === paymentId &&
      String(row[2]) === targetMonth && String(row[5]) === household.id &&
      (row[3] === true || String(row[3]).toLowerCase() === 'true'));
    if (index < 1) throw new Error('Transaksi iuran tidak ditemukan.');
    sheet.deleteRow(index + 1);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiAddPaymentItem(token, name, amount) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const title = validateText_(name, 'Nama pembayaran', 2, 60);
  const numericAmount = Number(amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount < 0 || numericAmount > 1000000000000) {
    throw new Error('Nominal pembayaran tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_('payments').appendRow([
      Utilities.getUuid(), title, numericAmount, true, new Date().toISOString(), household.id
    ]);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiUpdatePaymentItem(token, paymentId, name, amount) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(paymentId || '');
  if (!/^[\w-]{1,80}$/.test(targetId)) throw new Error('Item pembayaran tidak valid.');
  const title = validateText_(name, 'Nama pembayaran', 2, 60);
  const numericAmount = Number(amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount < 0 || numericAmount > 1000000000000) {
    throw new Error('Nominal pembayaran tidak valid.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('payments');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 && String(row[0]) === targetId &&
      String(row[5]) === household.id && row[3] !== false && String(row[3]).toLowerCase() !== 'false');
    if (index < 1) throw new Error('Item pembayaran tidak ditemukan.');
    sheet.getRange(index + 1, 2, 1, 2).setValues([[title, numericAmount]]);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiDeletePaymentItem(token, paymentId) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(paymentId || '');
  if (!targetId || targetId.length > 80) throw new Error('Item pembayaran tidak valid.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('payments');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 && String(row[0]) === targetId &&
      String(row[5]) === household.id && row[3] !== false && String(row[3]).toLowerCase() !== 'false');
    if (index < 1) throw new Error('Item pembayaran tidak ditemukan.');
    sheet.getRange(index + 1, 4).setValue(false);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiSetCharacter(token, character) {
  const user = requireSession_(token);
  requireHousehold_(token, user);
  const selected = String(character || '');
  if (!validMemberCharacter_(selected)) throw new Error('Karakter tidak tersedia.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('memberships');
    const rows = sheet.getDataRange().getValues();
    let updated = false;
    rows.forEach((row, index) => {
      if (index > 0 && String(row[1]) === user.id) {
        sheet.getRange(index + 1, 5).setValue(selected);
        updated = true;
      }
    });
    if (!updated) throw new Error('Keanggotaan rumah tidak ditemukan.');
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiJoinHousehold(token, inviteCode) {
  const user = requireSession_(token);
  const code = String(inviteCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(code)) throw new Error('Kode rumah harus terdiri dari 12 karakter.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const householdRows = getSheet_('households').getDataRange().getValues().slice(1);
    const household = householdRows.find(row => String(row[2]).toUpperCase() === code);
    if (!household) throw new Error('Kode rumah tidak ditemukan.');
    const householdId = String(household[0]);
    const memberSheet = getSheet_('memberships');
    const memberRows = memberSheet.getDataRange().getValues();
    const isMember = memberRows.slice(1).some(row =>
      String(row[0]) === householdId && String(row[1]) === user.id);
    if (!isMember) {
      memberSheet.appendRow([householdId, user.id, 'member', new Date().toISOString(), getUserCharacter_(user.id)]);
    }
    setSessionHousehold_(token, user, householdId);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiCreateHousehold(token, name) {
  const user = requireSession_(token);
  const householdName = validateText_(name, 'Nama rumah', 2, 80);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let householdId;
  try {
    householdId = createHousehold_(householdName, user.id, getUserCharacter_(user.id));
    setSessionHousehold_(token, user, householdId);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiSwitchHousehold(token, householdId) {
  const user = requireSession_(token);
  const targetId = String(householdId || '');
  const isMember = getHouseSheetData_('memberships').some(row =>
    String(row[0]) === targetId && String(row[1]) === user.id);
  if (!isMember || !getHousehold_(targetId)) throw new Error('Kamu bukan anggota rumah tersebut.');
  setSessionHousehold_(token, user, targetId);
  return { success: true };
}

function apiLeaveHousehold(token) {
  const user = requireSession_(token);
  const householdId = String(user.activeHouseholdId || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_('memberships');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 &&
      String(row[0]) === householdId && String(row[1]) === user.id);
    if (index < 1) throw new Error('Keanggotaan rumah tidak ditemukan.');
    if (String(rows[index][2]) === 'owner') {
      throw new Error('Pemilik rumah tidak dapat keluar agar rumah tidak kehilangan pengelola.');
    }
    sheet.deleteRow(index + 1);
    const remaining = getHouseSheetData_('memberships').find(row => String(row[1]) === user.id);
    setSessionHousehold_(token, user, remaining ? String(remaining[0]) : '');
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiKickMember(token, targetUserId) {
  const user = requireSession_(token);
  const household = requireHousehold_(token, user);
  const targetId = String(targetUserId || '');
  if (!targetId || targetId === user.id) throw new Error('Anggota yang dipilih tidak valid.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!isHouseholdOwner_(household.id, user.id)) {
      throw new Error('Hanya pemilik rumah yang dapat mengeluarkan anggota.');
    }
    const sheet = getSheet_('memberships');
    const rows = sheet.getDataRange().getValues();
    const index = rows.findIndex((row, i) => i > 0 &&
      String(row[0]) === household.id && String(row[1]) === targetId && String(row[2]) === 'member');
    if (index < 1) throw new Error('Anggota tidak ditemukan atau tidak dapat dikeluarkan.');
    sheet.deleteRow(index + 1);
  } finally {
    lock.releaseLock();
  }
  return { success: true };
}

function apiLogout(token) {
  if (token) CacheService.getScriptCache().remove('session:' + String(token));
  return { success: true };
}

function ensureDatabase_() {
  const properties = PropertiesService.getScriptProperties();
  let id = properties.getProperty('KASKU_SPREADSHEET_ID');
  let spreadsheet;
  if (id) {
    spreadsheet = SpreadsheetApp.openById(id);
  } else {
    spreadsheet = SpreadsheetApp.create('KasKU — Data Keuangan');
    properties.setProperty('KASKU_SPREADSHEET_ID', spreadsheet.getId());
  }

  const existing = spreadsheet.getSheets();
  Object.keys(SHEETS).forEach((key, index) => {
    const definition = SHEETS[key];
    let sheet = spreadsheet.getSheetByName(definition.name);
    if (!sheet) {
      sheet = index === 0 && existing.length === 1 && existing[0].getLastRow() === 0
        ? existing[0].setName(definition.name)
        : spreadsheet.insertSheet(definition.name);
    }
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, definition.headers.length).setValues([definition.headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, definition.headers.length).setFontWeight('bold');
    } else {
      const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
        .map(value => String(value));
      const missingHeaders = definition.headers.filter(header => currentHeaders.indexOf(header) === -1);
      if (missingHeaders.length) {
        sheet.getRange(1, currentHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
      }
    }
  });

  migrateLegacyData_(spreadsheet);
  return spreadsheet;
}

function getSheet_(key) {
  const definition = SHEETS[key];
  if (!definition) throw new Error('Data tidak tersedia.');
  return ensureDatabase_().getSheetByName(definition.name);
}

function createSession_(user, householdId) {
  const memberships = getHouseSheetData_('memberships').filter(row => String(row[1]) === user.id);
  const activeHouseholdId = householdId || (memberships.length ? String(memberships[0][0]) : '');
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('session:' + token, JSON.stringify({
    id: user.id, name: user.name, email: user.email, activeHouseholdId: activeHouseholdId
  }), 21600);
  return { token: token, user: { name: user.name, email: user.email } };
}

function requireSession_(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 100) {
    throw new Error('Sesi berakhir. Silakan masuk kembali.');
  }
  const value = CacheService.getScriptCache().get('session:' + token);
  if (!value) throw new Error('Sesi berakhir. Silakan masuk kembali.');
  return JSON.parse(value);
}

function requireHousehold_(token, user) {
  const memberships = getHouseSheetData_('memberships').filter(row => String(row[1]) === user.id);
  let householdId = String(user.activeHouseholdId || '');
  if (!memberships.some(row => String(row[0]) === householdId)) {
    if (!memberships.length) throw new Error('Akun ini belum tergabung ke rumah mana pun.');
    householdId = String(memberships[0][0]);
    setSessionHousehold_(token, user, householdId);
  }
  const household = getHousehold_(householdId);
  if (!household) throw new Error('Data rumah tidak ditemukan.');
  return household;
}

function setSessionHousehold_(token, user, householdId) {
  user.activeHouseholdId = householdId;
  CacheService.getScriptCache().put('session:' + String(token), JSON.stringify(user), 21600);
}

function createHousehold_(name, userId, character) {
  const spreadsheet = ensureDatabase_();
  const householdId = Utilities.getUuid();
  const code = createInviteCode_(spreadsheet);
  const now = new Date().toISOString();
  spreadsheet.getSheetByName(SHEETS.households.name).appendRow([householdId, name, code, now]);
  spreadsheet.getSheetByName(SHEETS.memberships.name).appendRow([
    householdId, userId, 'owner', now, validMemberCharacter_(character) ? character : DEFAULT_MEMBER_CHARACTER
  ]);
  return householdId;
}

function getUserCharacter_(userId) {
  const membership = getHouseSheetData_('memberships').find(row => String(row[1]) === userId);
  return membership && validMemberCharacter_(membership[4]) ? String(membership[4]) : DEFAULT_MEMBER_CHARACTER;
}

function validMemberCharacter_(character) {
  return MEMBER_CHARACTERS.indexOf(String(character || '')) !== -1;
}

function createInviteCode_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHEETS.households.name);
  const usedCodes = new Set(sheet.getDataRange().getValues().slice(1).map(row => String(row[2])));
  let code;
  do {
    code = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
  } while (usedCodes.has(code));
  return code;
}

function getHouseSheetData_(key) {
  return getSheet_(key).getDataRange().getValues().slice(1);
}

function getHousehold_(householdId) {
  const row = getHouseSheetData_('households').find(item => String(item[0]) === householdId);
  return row ? { id: String(row[0]), name: String(row[1]), inviteCode: String(row[2]) } : null;
}

function isHouseholdOwner_(householdId, userId) {
  return getHouseSheetData_('memberships').some(row =>
    String(row[0]) === householdId && String(row[1]) === userId && String(row[2]) === 'owner'
  );
}

function migrateLegacyData_(spreadsheet) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('KASKU_SCHEMA_VERSION') === '2') return;

  const householdSheet = spreadsheet.getSheetByName(SHEETS.households.name);
  const memberSheet = spreadsheet.getSheetByName(SHEETS.memberships.name);
  const userRows = spreadsheet.getSheetByName(SHEETS.users.name).getDataRange().getValues().slice(1);
  const householdRows = householdSheet.getDataRange().getValues().slice(1);
  const memberRows = memberSheet.getDataRange().getValues().slice(1);
  const usedCodes = new Set(householdRows.map(row => String(row[2])));
  const houseByUser = new Map();
  memberRows.forEach(row => {
    if (!houseByUser.has(String(row[1]))) houseByUser.set(String(row[1]), String(row[0]));
  });

  userRows.forEach(row => {
    const userId = String(row[0]);
    if (houseByUser.has(userId)) return;
    const householdId = Utilities.getUuid();
    let code;
    do {
      code = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    } while (usedCodes.has(code));
    usedCodes.add(code);
    const now = new Date().toISOString();
    householdSheet.appendRow([householdId, String(row[1]) + ' Rumah', code, now]);
    memberSheet.appendRow([householdId, userId, 'owner', now, DEFAULT_MEMBER_CHARACTER]);
    houseByUser.set(userId, householdId);
  });

  const transactionSheet = spreadsheet.getSheetByName(SHEETS.transactions.name);
  if (transactionSheet.getLastRow() > 1) {
    const rows = transactionSheet.getRange(2, 1, transactionSheet.getLastRow() - 1, 8).getValues();
    let changed = false;
    rows.forEach(row => {
      if (!row[7]) {
        row[7] = houseByUser.get(String(row[1])) || '';
        changed = true;
      }
    });
    if (changed) transactionSheet.getRange(2, 8, rows.length, 1).setValues(rows.map(row => [row[7]]));
  }

  const checkSheet = spreadsheet.getSheetByName(SHEETS.checks.name);
  if (checkSheet.getLastRow() > 1) {
    const rows = checkSheet.getRange(2, 1, checkSheet.getLastRow() - 1, 6).getValues();
    let changed = false;
    rows.forEach(row => {
      if (!row[5]) {
        row[5] = houseByUser.get(String(row[0])) || '';
        changed = true;
      }
    });
    if (changed) checkSheet.getRange(2, 6, rows.length, 1).setValues(rows.map(row => [row[5]]));
  }

  const paymentSheet = spreadsheet.getSheetByName(SHEETS.payments.name);
  const houses = householdSheet.getDataRange().getValues().slice(1)
    .map(row => String(row[0])).filter(Boolean);
  const payments = paymentSheet.getDataRange().getValues().slice(1);
  const paymentKeys = new Set(payments.filter(row => row[5]).map(row => String(row[0]) + '|' + String(row[5])));
  const copies = [];
  payments.filter(row => !row[5] && row[0]).forEach(row => {
    houses.forEach(householdId => {
      const key = String(row[0]) + '|' + householdId;
      if (paymentKeys.has(key)) return;
      paymentKeys.add(key);
      copies.push([row[0], row[1], row[2], row[3], row[4], householdId]);
    });
  });
  if (copies.length) {
    paymentSheet.getRange(paymentSheet.getLastRow() + 1, 1, copies.length, 6).setValues(copies);
  }

  properties.setProperty('KASKU_SCHEMA_VERSION', '2');
}

function hashPassword_(password, salt) {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('KASKU_PASSWORD_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    properties.setProperty('KASKU_PASSWORD_SECRET', secret);
  }
  const bytes = Utilities.computeHmacSha256Signature(String(password), salt + secret);
  return Utilities.base64Encode(bytes);
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function validateText_(value, label, minLength, maxLength) {
  const text = String(value || '').trim();
  if (text.length < minLength || text.length > maxLength || /^[=+\-@]/.test(text)) {
    throw new Error(label + ' harus berisi ' + minLength + '–' + maxLength + ' karakter yang valid.');
  }
  return text;
}
