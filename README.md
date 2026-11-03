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

Gunakan URL `/exec` untuk menyimpan langsung ke spreadsheet. Setiap akun baru mendapat rumah sendiri; anggota dapat bergabung memakai kode undangan dari menu **Rumah & akun**. Transaksi dan iuran dibagikan dengan anggota rumah, sedangkan checklist iuran bersifat pribadi. Kata sandi disimpan sebagai HMAC hash.

## Firebase

Mode APK dan server lokal memakai Firebase Authentication (email/kata sandi) dan Cloud Firestore pada proyek `kasku-2f342`. Konfigurasi Web App di `www/firebase-config.js` adalah konfigurasi klien; jangan menaruh service-account JSON atau private key di aplikasi.

Database menggunakan lokasi Jakarta (`asia-southeast2`) dan dibuat dalam production mode. Aturan akses berada di `firestore.rules`; jangan mengubah database ke test mode atau menerbitkan aturan yang mengizinkan akses publik. Untuk menerapkan aturan dari root proyek, jalankan Firebase CLI dengan akun Google pemilik proyek lalu `firebase deploy --only firestore:rules`.

### Publikasikan web untuk teman

Firebase Hosting menyajikan aplikasi dari folder `www`; login dan data tetap menggunakan Firebase Authentication dan Cloud Firestore. Untuk menerbitkan web:

1. Pasang Firebase CLI dengan `npm install -g firebase-tools`.
2. Jalankan `firebase login` dengan akun Google pemilik proyek.
3. Dari folder proyek, jalankan `firebase deploy --only hosting`.
4. Bagikan `https://kasku-2f342.web.app` kepada teman. Mereka perlu membuat akun sendiri di aplikasi; data rumah hanya terlihat oleh anggota yang bergabung.

Jika login ditolak, pastikan Email/Password aktif di Firebase Authentication dan domain `kasku-2f342.web.app` diizinkan pada pengaturan Authorized domains. Jangan deploy aturan Firestore publik.

Firebase Auth dan Google Sheets adalah mode terpisah: halaman Apps Script tetap memakai spreadsheet, sedangkan APK dan server lokal memakai Firebase. Akun serta data lokal lama tidak otomatis dipindahkan ke Firebase; pengguna perlu membuat akun Firebase di aplikasi.

## Aplikasi Android

APK memakai halaman di `www/`. Setelah mengubah aplikasi, jalankan `npx cap copy android`, lalu dari folder `android` jalankan `.\gradlew.bat assembleDebug`. APK debug dibuat di `android/app/build/outputs/apk/debug/app-debug.apk`. Build membutuhkan JDK 21 dan Android SDK. APK membutuhkan koneksi internet untuk login dan sinkronisasi Firebase.
