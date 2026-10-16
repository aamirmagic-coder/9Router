const fs = require('fs');

// 1. Clean glob.js debug logs if present
const globFile = 'node_modules/next/dist/compiled/glob/glob.js';
if (fs.existsSync(globFile)) {
  let g = fs.readFileSync(globFile, 'utf8');
  if (g.includes('DEBUG_GLOB:')) {
    g = g.replace('function glob(t,e,r){console.error("DEBUG_GLOB:", t, e); console.trace("DEBUG_TRACE");', 'function glob(t,e,r){');
    fs.writeFileSync(globFile, g);
  }
}

// 2. Patch @vercel/nft to:
// a. Skip globbing asset directories outside project root (e.g. C:\Users\... when project is on D:\...)
// b. Do not emit files outside this.base (prevents cross-drive invalid paths like D:\...\C:\... in .open-next)
const nftFile = 'node_modules/next/dist/compiled/@vercel/nft/index.js';
if (fs.existsSync(nftFile)) {
  let c = fs.readFileSync(nftFile, 'utf8');
  
  // Patch emitAssetDirectory
  const target1 = 'if(!r.analysis.emitGlobs)return;';
  const patchMarker1 = '_rel.startsWith("..")';
  if (!c.includes(patchMarker1)) {
    const replacement1 = 'if(!r.analysis.emitGlobs)return;const _rel=a.default.relative(r.base,e);if(_rel.startsWith("..")||a.default.isAbsolute(_rel))return;';
    c = c.replace(target1, replacement1);
  }

  // Patch emitFile to not emit files outside this.base
  const target2 = 'e=(0,c.relative)(this.base,e);if(r){';
  const patchMarker2 = 'if(e.startsWith("..")||(0,c.isAbsolute)(e))return false;';
  if (!c.includes(patchMarker2)) {
    const replacement2 = 'e=(0,c.relative)(this.base,e);if(e.startsWith("..")||(0,c.isAbsolute)(e))return false;if(r){';
    c = c.replace(target2, replacement2);
  }

  fs.writeFileSync(nftFile, c);
  console.log('[patch-nft] Successfully patched @vercel/nft');
}

// 3. Patch @opennextjs copyTracedFiles to defensively skip invalid destination paths (e.g. cross-drive C: on Windows)
const copyTracedFile = 'node_modules/@opennextjs/cloudflare/node_modules/@opennextjs/aws/dist/build/copyTracedFiles.js';
if (fs.existsSync(copyTracedFile)) {
  let cf = fs.readFileSync(copyTracedFile, 'utf8');
  const target3 = 'tracedFiles.push(to);\n        mkdirSync(path.dirname(to), { recursive: true });';
  const patchMarker3 = 'to.lastIndexOf(":") > 1';
  if (!cf.includes(patchMarker3)) {
    const replacement3 = `if (to.lastIndexOf(":") > 1 || !existsSync(from)) return;\n        tracedFiles.push(to);\n        mkdirSync(path.dirname(to), { recursive: true });`;
    cf = cf.replace(target3, replacement3);
    fs.writeFileSync(copyTracedFile, cf);
    console.log('[patch-nft] Successfully patched copyTracedFiles');
  }
}
