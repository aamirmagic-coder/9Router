// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

// known-fails.txt memakai path relatif dari akar repo ("tests/unit/x.test.js").
// Jalur CI lama men-split "/app/" (workdir Docker). Di mesin biasa path itu
// tidak ada, jadi split() mengembalikan undefined dan semua entri dianggap
// regresi. Normalisasi: ambil dari "tests/" pertama, apa pun bentuk absolutnya
// (Windows backslash, drive letter, maupun /app/ di CI).
function relTestPath(absPath) {
  const p = String(absPath).replace(/\\/g, "/");
  const i = p.lastIndexOf("/tests/");
  if (i !== -1) return p.slice(i + 1);
  if (p.startsWith("tests/")) return p;
  const j = p.indexOf("tests/");
  if (j !== -1) return p.slice(j);
  return p;
}

const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => relTestPath(f.name) + " :: " + a.fullName)
);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
