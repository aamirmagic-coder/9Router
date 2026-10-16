import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,

  // `eslint-config-next` tidak mengaktifkan `no-undef` (asumsinya bundler yang
  // menangkapnya). Asumsi itu salah: sebuah nama bebas di dalam komponen —
  // `valueFormat` dipakai di `LayerBody` tapi didefinisikan di `UsageStack` —
  // lolos dari build Next DAN dari lint, lalu meledak jadi
  // `ReferenceError` saat halamannya dibuka di browser.
  //
  // Diaktifkan untuk area yang sudah bersih (terverifikasi 0 pelanggaran).
  // `src` secara keseluruhan masih punya pelanggaran lama, jadi aturannya belum
  // bisa dipasang global tanpa membanjiri laporan.
  {
    files: ["src/shared/**/*.{js,jsx}", "src/app/**/usage/**/*.{js,jsx}"],
    rules: { "no-undef": "error" },
  },

  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
