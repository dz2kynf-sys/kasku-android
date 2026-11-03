# KasKU

KasKU menyediakan pencatatan uang masuk/keluar, ringkasan, dan checklist iuran rumah. Beberapa akun dapat bergabung ke rumah yang sama menggunakan kode undangan.
Semua nominal ditampilkan dalam pound Mesir (EGP).

## Jalankan langsung di komputer

1. Pastikan Node.js terpasang.
2. Jalankan `node server.js`, lalu buka `http://127.0.0.1:4173`.
3. Buat akun dan mulai mencatat. Bagikan kode rumah dari menu **Rumah & akun** agar akun lain bisa bergabung.

Server lokal dan APK menggunakan Firebase untuk akun, transaksi, iuran, dan data rumah. Membuka `www/index.html` langsung sebagai file memakai penyimpanan lokal browser. Firebase dan Google Sheets adalah mode terpisah.

## Menyiapkan Google Apps Script

1. Buat proyek di [Google Apps Script](https://script.google.com/).
2. Salin `Code.gs` ke file script `Code.gs`. Buat file HTML bernama `index`, lalu salin isi `www/index.html`.
3. Jalankan `setup` satu kali dan berikan izin. Fungsi ini membuat spreadsheet beserta tab yang diperlukan; tautannya muncul di **Execution log**.
4. Pilih **Deploy → New deployment → Web app**. Pilih **Execute as: Me** dan atur akses sesuai kebutuhan (akses **Anyone** memungkinkan pengguna membuat akun). Bagikan URL deployment yang berakhiran `/exec`.
5. Untuk menerapkan perubahan kode, buka **Deploy → Manage deployments → Edit**, pilih versi baru, lalu deploy.

Gunakan URL `/exec` untuk menyimpan langsung ke spreadsheet. Setiap akun baru mendapat rumah sendiri; anggota dapat bergabung memakai kode undangan dari menu **Rumah & akun**. Transaksi, daftar iuran, dan nama anggota yang sudah membayar dibagikan dengan anggota rumah. Setiap anggota menandai pembayaran miliknya sendiri; iuran yang lunas dicatat sebagai pemasukan ke saldo rumah. Kata sandi disimpan sebagai HMAC hash.

## Firebase

Mode APK dan server lokal memakai Firebase Authentication (email/kata sandi) dan Cloud Firestore pada proyek `kasku-mesir-free-2026`. Konfigurasi Web App di `www/firebase-config.js` adalah konfigurasi klien; jangan menaruh service-account JSON atau private key di aplikasi.

Target lokasi database baru adalah Doha (`me-central1`); Firestore tidak menyediakan region di Mesir. Lokasi database Firestore tidak dapat diubah setelah database dibuat. Sebelum membuat database, login dengan akun Google pemilik proyek dan periksa database yang sudah ada:

```sh
firebase login
firebase firestore:databases:list --project kasku-mesir-free-2026
```

Jika belum ada database default, buat database production di Doha:

```sh
firebase firestore:databases:create "(default)" --location me-central1 --project kasku-mesir-free-2026
```

Jika database default sudah ada, gunakan lokasi yang ada; jangan membuat database lain tanpa mengubah konfigurasi aplikasi. Aturan akses berada di `firestore.rules`; jangan mengubah database ke test mode atau menerbitkan aturan yang mengizinkan akses publik. Untuk menerapkan aturan dari root proyek, jalankan `firebase deploy --only firestore:rules --project kasku-mesir-free-2026`.

### Publikasikan web untuk teman

Firebase Hosting menyajikan aplikasi dari folder `www`; login dan data tetap menggunakan Firebase Authentication dan Cloud Firestore. Untuk menerbitkan web:

1. Pasang Firebase CLI dengan `npm install -g firebase-tools`.
2. Jalankan `firebase login` dengan akun Google pemilik proyek.
3. Dari folder proyek, jalankan `firebase deploy --only hosting --project kasku-mesir-free-2026`.
4. Bagikan `https://kasku-mesir-free-2026.web.app` kepada teman. Mereka perlu membuat akun sendiri di aplikasi; data rumah hanya terlihat oleh anggota yang bergabung.

Jika login ditolak, pastikan Email/Password aktif di Firebase Authentication dan domain `kasku-mesir-free-2026.web.app` diizinkan pada pengaturan Authorized domains. Jangan deploy aturan Firestore publik.

Status pembayaran iuran terlihat oleh seluruh anggota rumah. Setiap anggota menandai pembayaran sendiri; nominal yang ditandai lunas masuk ke saldo sebagai pemasukan dan tampil di riwayat transaksi. Data diperbarui saat membuka halaman atau kembali ke tab aplikasi.

Firebase Auth dan Google Sheets adalah mode terpisah: halaman Apps Script tetap memakai spreadsheet, sedangkan APK dan server lokal memakai Firebase. Akun serta data lokal lama tidak otomatis dipindahkan ke Firebase; pengguna perlu membuat akun Firebase di aplikasi.

## Aplikasi Android

APK memakai halaman di `www/`. Setelah mengubah aplikasi, jalankan `npx cap copy android`, lalu dari folder `android` jalankan `.\gradlew.bat assembleDebug`. APK debug dibuat di `android/app/build/outputs/apk/debug/app-debug.apk`. Build membutuhkan JDK 21 dan Android SDK. APK membutuhkan koneksi internet untuk login dan sinkronisasi Firebase.
