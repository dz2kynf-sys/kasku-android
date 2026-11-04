(function (global) {
  const config = global.KASKU_FIREBASE_CONFIG;
  const memberCharacters = ['🙂', '😎', '🦊', '🐼', '🐱', '🐸', '🦉', '🐻', '🐧', '🐨'];
  const defaultMemberCharacter = memberCharacters[0];
  const errorMessages = {
    'auth/email-already-in-use': 'Email ini sudah terdaftar. Silakan masuk.',
    'auth/invalid-credential': 'Email atau kata sandi tidak cocok.',
    'auth/invalid-email': 'Masukkan alamat email yang valid.',
    'auth/network-request-failed': 'Tidak dapat terhubung ke Firebase. Periksa koneksi internet.',
    'auth/operation-not-allowed': 'Login email dan kata sandi belum diaktifkan di Firebase.',
    'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi nanti.',
    'auth/weak-password': 'Kata sandi harus terdiri dari minimal 8 karakter.',
    'firestore/permission-denied': 'Akses Firestore ditolak. Periksa aturan keamanan Firebase.',
    'permission-denied': 'Akses Firestore ditolak. Periksa aturan keamanan Firebase.',
    'unavailable': 'Firebase sedang tidak tersedia. Periksa koneksi lalu coba lagi.'
  };
  let app = null;
  let auth = null;
  let db = null;
  let initializationError = null;
  let ready = Promise.resolve();

  if (config) {
    try {
      if (!global.firebase) throw new Error('Firebase SDK tidak termuat. Periksa koneksi internet.');
      app = global.firebase.apps.length ? global.firebase.app() : global.firebase.initializeApp(config);
      auth = app.auth();
      db = app.firestore();
      ready = auth.setPersistence(global.firebase.auth.Auth.Persistence.LOCAL)
        .then(() => new Promise(resolve => {
          let unsubscribe = () => {};
          unsubscribe = auth.onAuthStateChanged(
            () => { unsubscribe(); resolve(); },
            error => { initializationError = error; unsubscribe(); resolve(); }
          );
        }))
        .catch(error => { initializationError = error; });
    } catch (error) {
      initializationError = error;
    }
  }

  function toUserError(error) {
    if (error && error.code && errorMessages[error.code]) return new Error(errorMessages[error.code]);
    return error instanceof Error ? error : new Error('Terjadi kesalahan saat mengakses Firebase.');
  }

  async function ensureReady() {
    await ready;
    if (initializationError) throw toUserError(initializationError);
    if (!auth || !db) throw new Error('Firebase belum dikonfigurasi untuk aplikasi ini.');
  }

  async function requireUser(token) {
    await ensureReady();
    const user = auth.currentUser;
    if (!user || (token && token !== user.uid)) throw new Error('Sesi berakhir. Silakan masuk kembali.');
    return user;
  }

  function inviteCode() {
    if (!global.crypto || !global.crypto.getRandomValues) {
      throw new Error('Perangkat ini tidak mendukung pembuatan kode rumah yang aman.');
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(12);
    global.crypto.getRandomValues(bytes);
    return Array.from(bytes, value => alphabet[value & 31]).join('');
  }

  function addHouseholdWrites(batch, user, name, character) {
    const now = new Date().toISOString();
    const householdRef = db.collection('households').doc();
    const code = inviteCode();
    const membershipRef = db.collection('memberships').doc(householdRef.id + '_' + user.uid);

    batch.set(householdRef, {
      id: householdRef.id,
      name: name,
      inviteCode: code,
      createdBy: user.uid,
      createdAt: now
    });
    batch.set(membershipRef, {
      householdId: householdRef.id,
      userId: user.uid,
      name: user.displayName || user.name,
      email: user.email,
      role: 'owner',
      inviteCode: code,
      createdAt: now,
      character: character
    });
    batch.set(db.collection('inviteCodes').doc(code), {
      householdId: householdRef.id,
      createdBy: user.uid,
      createdAt: now
    });

    return { id: householdRef.id, name: name, inviteCode: code };
  }

  function validName(value, label, min, max) {
    const name = String(value || '').trim();
    if (name.length < min || name.length > max || /^[=+\-@]/.test(name)) {
      throw new Error(label + ' harus berisi ' + min + '–' + max + ' karakter yang valid.');
    }
    return name;
  }

  async function api(method, args) {
    try {
      await ensureReady();

      if (method === 'apiSignup') {
        const name = validName(args[0], 'Nama', 2, 60);
        const email = String(args[1] || '').trim().toLowerCase();
        const password = args[2];
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
          throw new Error('Masukkan alamat email yang valid.');
        }
        if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
          throw new Error('Kata sandi harus terdiri dari 8–128 karakter.');
        }

        const credential = await auth.createUserWithEmailAndPassword(email, password);
        const user = credential.user;
        const now = new Date().toISOString();
        const batch = db.batch();
        const household = addHouseholdWrites(batch, { uid: user.uid, name: name, email: user.email }, name + ' Rumah', defaultMemberCharacter);
        batch.set(db.collection('users').doc(user.uid), {
          name: name, email: user.email, createdAt: now, character: defaultMemberCharacter
        });
        try {
          await batch.commit();
        } catch (error) {
          try {
            await user.delete();
          } catch (cleanupError) {
            throw new Error('Akun Firebase telah dibuat, tetapi data awal gagal disimpan dan akun sementara tidak dapat dibersihkan. Hubungi admin Firebase.');
          }
          throw error;
        }
        global.localStorage.setItem('kasku_active_household_' + user.uid, household.id);
        return { token: user.uid, user: { name: name, email: user.email } };
      }

      if (method === 'apiLogin') {
        const email = String(args[0] || '').trim().toLowerCase();
        const credential = await auth.signInWithEmailAndPassword(email, String(args[1] || ''));
        const profile = await db.collection('users').doc(credential.user.uid).get();
        if (!profile.exists) {
          await auth.signOut();
          throw new Error('Profil akun Firebase tidak ditemukan. Buat akun KasKU baru atau hubungi admin.');
        }
        return {
          token: credential.user.uid,
          user: { name: profile.data().name, email: credential.user.email }
        };
      }

      if (method === 'apiLogout') {
        await auth.signOut();
        return { success: true };
      }

      const user = await requireUser(args[0]);
      const userRef = db.collection('users').doc(user.uid);

      if (method === 'apiGetData') {
        const profileSnapshot = await userRef.get();
        if (!profileSnapshot.exists) throw new Error('Profil akun Firebase tidak ditemukan. Silakan masuk kembali.');
        const profile = profileSnapshot.data();
        const membershipsSnapshot = await db.collection('memberships').where('userId', '==', user.uid).get();
        const memberships = membershipsSnapshot.docs.map(document => document.data());
        if (!memberships.length) {
          global.localStorage.removeItem('kasku_active_household_' + user.uid);
          const date = new Date();
          return {
            user: { id: user.uid, name: profile.name, email: user.email, character: profile.character || defaultMemberCharacter },
            household: null, households: [], members: [], month: date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0'),
            totals: { income: 0, expenses: 0, balance: 0 }, transactions: [], payments: []
          };
        }

        const savedHouseholdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        let householdId = memberships.some(item => item.householdId === savedHouseholdId)
          ? savedHouseholdId
          : memberships[0].householdId;
        global.localStorage.setItem('kasku_active_household_' + user.uid, householdId);
        const householdSnapshot = await db.collection('households').doc(householdId).get();
        if (!householdSnapshot.exists) throw new Error('Data rumah tidak ditemukan.');
        const household = householdSnapshot.data();

        const [transactionSnapshot, paymentSnapshot, checkSnapshot, memberSnapshot] = await Promise.all([
          db.collection('transactions').where('householdId', '==', householdId).get(),
          db.collection('payments').where('householdId', '==', householdId).get(),
          db.collection('households').doc(householdId).collection('checks').get(),
          db.collection('memberships').where('householdId', '==', householdId).get()
        ]);
        const monthDate = new Date();
        const month = monthDate.getFullYear() + '-' + String(monthDate.getMonth() + 1).padStart(2, '0');
        const members = memberSnapshot.docs.map(document => document.data());
        const memberNames = new Map(members.map(member => [member.userId, member.name]));
        const checks = checkSnapshot.docs.map(document => document.data());
        const paymentDocuments = paymentSnapshot.docs.map(document => ({
          id: document.id,
          data: document.data()
        }));
        const paymentsById = new Map(paymentDocuments.map(item => [item.id, item.data]));
        const transactions = transactionSnapshot.docs.map(document => Object.assign({ id: document.id }, document.data()));
        checks.filter(check => check.checked).forEach(check => {
          const payment = paymentsById.get(check.itemId);
          if (!payment) return;
          const amount = typeof check.amount === 'number' ? check.amount : Number(payment.amount);
          if (amount <= 0) return;
          const memberName = memberNames.get(check.userId) || 'Anggota';
          const date = String(check.updatedAt || '').slice(0, 10);
          transactions.push({
            id: 'payment-' + check.userId + '-' + check.itemId + '-' + check.month,
            userId: check.userId,
            householdId: householdId,
            createdBy: memberName,
            type: 'income',
            amount: amount,
            purpose: 'Iuran: ' + payment.name,
            date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : check.month + '-01',
            createdAt: check.updatedAt || '',
            paymentItemId: check.itemId,
            paymentMonth: check.month
          });
        });
        transactions.sort((a, b) => b.date.localeCompare(a.date));
        const payments = paymentDocuments
          .filter(document => document.data.active !== false)
          .map(document => {
            const itemChecks = checks.filter(check =>
              check.itemId === document.id && check.month === month && check.checked
            );
            const paidBy = Array.from(new Map(itemChecks.map(check => [
              check.userId,
              { userId: check.userId, name: memberNames.get(check.userId) || 'Anggota' }
            ])).values());
            return {
              id: document.id,
              name: document.data.name,
              amount: Number(document.data.amount),
              checked: itemChecks.some(check => check.userId === user.uid),
              paidBy: paidBy
            };
          });
        const income = transactions.reduce((sum, item) => item.type === 'income' ? sum + item.amount : sum, 0);
        const expenses = transactions.reduce((sum, item) => item.type === 'expense' ? sum + item.amount : sum, 0);
        const households = await Promise.all(memberships.map(async membership => {
          const snapshot = await db.collection('households').doc(membership.householdId).get();
          return snapshot.exists ? snapshot.data() : null;
        }));

        return {
          user: {
            id: user.uid, name: profile.name, email: user.email, character: profile.character || defaultMemberCharacter,
            role: members.find(member => member.userId === user.uid).role
          },
          household: { id: householdId, name: household.name, inviteCode: household.inviteCode },
          households: households.filter(Boolean).map(item => ({ id: item.id, name: item.name, inviteCode: item.inviteCode })),
          members: memberSnapshot.docs.map(document => {
            const member = document.data();
            return {
              userId: member.userId, name: member.name, email: member.email, role: member.role,
              character: memberCharacters.includes(member.character) ? member.character : defaultMemberCharacter
            };
          }),
          month: month,
          totals: { income: income, expenses: expenses, balance: income - expenses },
          transactions: transactions,
          payments: payments
        };
      }

      if (method === 'apiAddTransaction') {
        const type = args[1];
        const amount = Number(args[2]);
        const purpose = validName(args[3], 'Keterangan', 2, 160);
        const date = String(args[4] || '');
        const parsedDate = new Date(date + 'T00:00:00Z');
        if (type !== 'income' && type !== 'expense') throw new Error('Jenis transaksi tidak valid.');
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000000) {
          throw new Error('Nominal harus berupa jumlah EGP positif.');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
          throw new Error('Tanggal transaksi tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const transactionRef = db.collection('transactions').doc();
        await transactionRef.set({
          id: transactionRef.id, userId: user.uid, householdId: householdId,
          createdBy: user.displayName || user.email, type: type, amount: amount,
          purpose: purpose, date: date, createdAt: new Date().toISOString()
        });
        return { success: true };
      }

      if (method === 'apiUpdateTransaction') {
        const transactionId = String(args[1] || '');
        const type = args[2];
        const amount = Number(args[3]);
        const purpose = validName(args[4], 'Keterangan', 2, 160);
        const date = String(args[5] || '');
        const parsedDate = new Date(date + 'T00:00:00Z');
        if (!/^[\w-]{1,80}$/.test(transactionId)) throw new Error('Transaksi tidak valid.');
        if (type !== 'income' && type !== 'expense') throw new Error('Jenis transaksi tidak valid.');
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000000) {
          throw new Error('Nominal harus berupa jumlah EGP positif.');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
          throw new Error('Tanggal transaksi tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const transactionRef = db.collection('transactions').doc(transactionId);
        const transaction = await transactionRef.get();
        const membership = await db.collection('memberships').doc(householdId + '_' + user.uid).get();
        if (!transaction.exists || transaction.data().householdId !== householdId ||
            (transaction.data().userId !== user.uid && (!membership.exists || membership.data().role !== 'owner'))) {
          throw new Error('Transaksi tidak ditemukan atau tidak dapat diubah.');
        }
        await transactionRef.update({ type: type, amount: amount, purpose: purpose, date: date });
        return { success: true };
      }

      if (method === 'apiDeleteTransaction') {
        const transactionId = String(args[1] || '');
        if (!/^[\w-]{1,80}$/.test(transactionId)) throw new Error('Transaksi tidak valid.');
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const transactionRef = db.collection('transactions').doc(transactionId);
        const transaction = await transactionRef.get();
        const membership = await db.collection('memberships').doc(householdId + '_' + user.uid).get();
        if (!transaction.exists || transaction.data().householdId !== householdId ||
            (transaction.data().userId !== user.uid && (!membership.exists || membership.data().role !== 'owner'))) {
          throw new Error('Transaksi tidak ditemukan atau tidak dapat dihapus.');
        }
        await transactionRef.delete();
        return { success: true };
      }

      if (method === 'apiDeletePaymentTransaction') {
        const transactionId = String(args[1] || '');
        const payerId = String(args[2] || '');
        const itemId = String(args[3] || '');
        const month = String(args[4] || '');
        if (!/^[\w-]{1,80}$/.test(payerId) || !/^[\w-]{1,80}$/.test(itemId) ||
            !/^\d{4}-\d{2}$/.test(month) || transactionId !== 'payment-' + payerId + '-' + itemId + '-' + month) {
          throw new Error('Transaksi iuran tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const membership = await db.collection('memberships').doc(householdId + '_' + user.uid).get();
        if (!membership.exists || membership.data().role !== 'owner') {
          throw new Error('Hanya pemilik rumah yang dapat menghapus transaksi iuran.');
        }
        const checkRef = db.collection('households').doc(householdId).collection('checks')
          .doc(payerId + '_' + itemId + '_' + month);
        const check = await checkRef.get();
        if (!check.exists || check.data().householdId !== householdId || check.data().userId !== payerId ||
            check.data().itemId !== itemId || check.data().month !== month || !check.data().checked) {
          throw new Error('Transaksi iuran tidak ditemukan.');
        }
        await checkRef.delete();
        return { success: true };
      }

      if (method === 'apiUpdatePaymentTransaction') {
        const transactionId = String(args[1] || '');
        const payerId = String(args[2] || '');
        const itemId = String(args[3] || '');
        const month = String(args[4] || '');
        const amount = Number(args[5]);
        const date = String(args[6] || '');
        const parsedDate = new Date(date + 'T00:00:00Z');
        if (!/^[\w-]{1,80}$/.test(payerId) || !/^[\w-]{1,80}$/.test(itemId) ||
            !/^\d{4}-\d{2}$/.test(month) || transactionId !== 'payment-' + payerId + '-' + itemId + '-' + month) {
          throw new Error('Transaksi iuran tidak valid.');
        }
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000000000) {
          throw new Error('Nominal harus berupa jumlah EGP positif.');
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
          throw new Error('Tanggal transaksi tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const membership = await db.collection('memberships').doc(householdId + '_' + user.uid).get();
        if (!membership.exists || membership.data().role !== 'owner') {
          throw new Error('Hanya pemilik rumah yang dapat mengedit transaksi iuran.');
        }
        const checkRef = db.collection('households').doc(householdId).collection('checks')
          .doc(payerId + '_' + itemId + '_' + month);
        const check = await checkRef.get();
        if (!check.exists || check.data().householdId !== householdId || check.data().userId !== payerId ||
            check.data().itemId !== itemId || check.data().month !== month || !check.data().checked) {
          throw new Error('Transaksi iuran tidak ditemukan.');
        }
        await checkRef.update({ amount: amount, updatedAt: date + 'T12:00:00.000Z' });
        return { success: true };
      }

      if (method === 'apiTogglePayment') {
        const itemId = String(args[1] || '');
        const month = String(args[2] || '');
        if (!/^[\w-]{1,80}$/.test(itemId) || !/^\d{4}-\d{2}$/.test(month) || typeof args[3] !== 'boolean') {
          throw new Error('Data checklist tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const payment = await db.collection('payments').doc(itemId).get();
        if (!payment.exists || payment.data().householdId !== householdId || payment.data().active === false) {
          throw new Error('Item pembayaran tidak ditemukan.');
        }
        const checkRef = db.collection('households').doc(householdId)
          .collection('checks').doc(user.uid + '_' + itemId + '_' + month);
        await checkRef.set({
          userId: user.uid, itemId: itemId, householdId: householdId,
          month: month, checked: args[3], amount: Number(payment.data().amount),
          updatedAt: new Date().toISOString()
        });
        return { success: true };
      }

      if (method === 'apiAddPaymentItem') {
        const name = validName(args[1], 'Nama pembayaran', 2, 60);
        const amount = Number(args[2]);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000000) {
          throw new Error('Nominal pembayaran tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const paymentRef = db.collection('payments').doc();
        await paymentRef.set({
          id: paymentRef.id, name: name, amount: amount, active: true,
          createdAt: new Date().toISOString(), householdId: householdId, createdBy: user.uid
        });
        return { success: true };
      }

      if (method === 'apiUpdatePaymentItem') {
        const itemId = String(args[1] || '');
        const name = validName(args[2], 'Nama pembayaran', 2, 60);
        const amount = Number(args[3]);
        if (!/^[\w-]{1,80}$/.test(itemId)) throw new Error('Item pembayaran tidak valid.');
        if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000000) {
          throw new Error('Nominal pembayaran tidak valid.');
        }
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const paymentRef = db.collection('payments').doc(itemId);
        const payment = await paymentRef.get();
        if (!payment.exists || payment.data().householdId !== householdId || payment.data().active === false) {
          throw new Error('Item pembayaran tidak ditemukan.');
        }
        await paymentRef.update({ name: name, amount: amount });
        return { success: true };
      }

      if (method === 'apiDeletePaymentItem') {
        const itemId = String(args[1] || '');
        if (!/^[\w-]{1,80}$/.test(itemId)) throw new Error('Item pembayaran tidak valid.');
        const householdId = global.localStorage.getItem('kasku_active_household_' + user.uid);
        const paymentRef = db.collection('payments').doc(itemId);
        const payment = await paymentRef.get();
        if (!payment.exists || payment.data().householdId !== householdId || payment.data().active === false) {
          throw new Error('Item pembayaran tidak ditemukan.');
        }
        await paymentRef.update({ active: false });
        return { success: true };
      }

      if (method === 'apiSetCharacter') {
        const character = String(args[1] || '');
        if (!memberCharacters.includes(character)) throw new Error('Karakter tidak tersedia.');
        const memberships = await db.collection('memberships').where('userId', '==', user.uid).get();
        const batch = db.batch();
        batch.update(userRef, { character: character });
        memberships.docs.forEach(document => batch.update(document.ref, { character: character }));
        await batch.commit();
        return { success: true };
      }

      if (method === 'apiJoinHousehold') {
        const code = String(args[1] || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{12}$/.test(code)) throw new Error('Kode rumah harus terdiri dari 12 karakter.');
        const invite = await db.collection('inviteCodes').doc(code).get();
        if (!invite.exists) throw new Error('Kode rumah tidak ditemukan.');
        const householdId = invite.data().householdId;
        const membershipRef = db.collection('memberships').doc(householdId + '_' + user.uid);
        const existingMembership = await membershipRef.get();
        if (!existingMembership.exists) {
          const profile = await userRef.get();
          if (!profile.exists) throw new Error('Profil akun Firebase tidak ditemukan.');
          await membershipRef.set({
            householdId: householdId, userId: user.uid, name: profile.data().name,
            email: user.email, role: 'member', inviteCode: code, createdAt: new Date().toISOString(),
            character: memberCharacters.includes(profile.data().character) ? profile.data().character : defaultMemberCharacter
          });
        }
        global.localStorage.setItem('kasku_active_household_' + user.uid, householdId);
        return { success: true };
      }

      if (method === 'apiCreateHousehold') {
        const name = validName(args[1], 'Nama rumah', 2, 80);
        const profile = await userRef.get();
        if (!profile.exists) throw new Error('Profil akun Firebase tidak ditemukan.');
        const batch = db.batch();
        const household = addHouseholdWrites(batch, {
          uid: user.uid, name: profile.data().name, email: user.email
        }, name, memberCharacters.includes(profile.data().character) ? profile.data().character : defaultMemberCharacter);
        await batch.commit();
        global.localStorage.setItem('kasku_active_household_' + user.uid, household.id);
        return { success: true };
      }

      if (method === 'apiSwitchHousehold') {
        const targetId = String(args[1] || '');
        const membership = await db.collection('memberships').doc(targetId + '_' + user.uid).get();
        if (!membership.exists) throw new Error('Kamu bukan anggota rumah tersebut.');
        global.localStorage.setItem('kasku_active_household_' + user.uid, targetId);
        return { success: true };
      }

      if (method === 'apiLeaveHousehold') {
        const householdId = String(global.localStorage.getItem('kasku_active_household_' + user.uid) || '');
        const membershipRef = db.collection('memberships').doc(householdId + '_' + user.uid);
        const membership = await membershipRef.get();
        if (!membership.exists) throw new Error('Keanggotaan rumah tidak ditemukan.');
        if (membership.data().role === 'owner') throw new Error('Pemilik rumah tidak dapat keluar agar rumah tidak kehilangan pengelola.');
        await membershipRef.delete();
        const remaining = await db.collection('memberships').where('userId', '==', user.uid).get();
        if (remaining.empty) {
          global.localStorage.removeItem('kasku_active_household_' + user.uid);
        } else {
          global.localStorage.setItem('kasku_active_household_' + user.uid, remaining.docs[0].data().householdId);
        }
        return { success: true };
      }

      if (method === 'apiKickMember') {
        const householdId = String(global.localStorage.getItem('kasku_active_household_' + user.uid) || '');
        const targetId = String(args[1] || '');
        if (!targetId || targetId === user.uid) throw new Error('Anggota yang dipilih tidak valid.');
        const owner = await db.collection('memberships').doc(householdId + '_' + user.uid).get();
        if (!owner.exists || owner.data().role !== 'owner') throw new Error('Hanya pemilik rumah yang dapat mengeluarkan anggota.');
        const targetRef = db.collection('memberships').doc(householdId + '_' + targetId);
        const target = await targetRef.get();
        if (!target.exists || target.data().role !== 'member') throw new Error('Anggota tidak ditemukan atau tidak dapat dikeluarkan.');
        await targetRef.delete();
        return { success: true };
      }

      throw new Error('Aksi tidak dikenali.');
    } catch (error) {
      throw toUserError(error);
    }
  }

  global.KASKU_FIREBASE_API = { call: api };
})(window);
