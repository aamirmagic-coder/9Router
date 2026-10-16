"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  
  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    console.error("Failed to load translations:", err);
    translationMap = {};
  }
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  return translationMap[trimmed] || text;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Process text node
function processTextNode(node) {
  const current = node.nodeValue;
  if (!current || !current.trim()) return;

  // Skip if parent is script, style, code, or structural elements
  const parent = node.parentElement;
  if (!parent) return;

  // Skip if parent or any ancestor has data-i18n-skip attribute
  let element = parent;
  while (element) {
    if (element.hasAttribute && element.hasAttribute('data-i18n-skip')) {
      return;
    }
    element = element.parentElement;
  }

  const tagName = parent.tagName?.toLowerCase();

  // Skip elements that don't allow text nodes
  const skipTags = [
    "script", "style", "code", "pre",
    "colgroup", "table", "thead", "tbody", "tfoot", "tr",
    "select", "datalist", "optgroup"
  ];

  if (skipTags.includes(tagName)) return;

  // React memakai ULANG text node saat re-render — hanya `nodeValue` yang
  // berubah, node-nya tetap sama. Jadi `_originalText` TIDAK boleh dianggap
  // permanen: kalau nilai saat ini bukan yang terakhir KITA tulis, berarti
  // React baru menulisnya, dan nilai itu adalah sumber kebenaran yang baru.
  if (node._i18nWritten !== undefined && node.nodeValue !== node._i18nWritten) {
    node._originalText = node.nodeValue;
    node._i18nWritten = undefined;
  }

  if (node._originalText === undefined) {
    node._originalText = node.nodeValue;
  }

  const original = node._originalText;
  const translated = translate(original);

  if (translated === original) {
    // Tidak ada terjemahan untuk teks ini → node milik React, JANGAN disentuh.
    //
    // Ini penyebab angka dashboard "beku": angka tidak punya terjemahan, tapi
    // dulu tetap ditulis ulang dari `_originalText` yang basi — sehingga nilai
    // baru hasil render React ("10075") langsung ditimpa balik ke nilai
    // pertama ("944") setiap kali period diganti.
    //
    // Pengecualian: kalau KITA yang pernah menulis terjemahan ke node ini
    // (mis. locale kembali ke "en" sehingga `translate()` mengembalikan teks
    // apa adanya), pulihkan teks aslinya.
    if (node._i18nWritten !== undefined && node.nodeValue !== original) {
      node.nodeValue = original;
      node._i18nWritten = undefined;
    }
    return;
  }

  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node.nodeValue = translated;
  }
  // Catat apa yang KITA tulis, agar bisa dibedakan dari tulisan React.
  node._i18nWritten = translated;
}

// Process all text nodes in element
function processElement(element) {
  if (!element) return;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  const nodesToProcess = [];
  
  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }
  
  // Process collected nodes
  nodesToProcess.forEach(processTextNode);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Process existing DOM
  processElement(document.body);
  
  // Pantau node BARU dan penulisan ulang teks di tempat.
  //
  // React memakai ulang text node saat re-render — hanya `nodeValue` yang
  // berubah, sehingga yang muncul adalah mutasi `characterData` TANPA event
  // `childList`. Mengamati `childList` saja membuat label yang diperbarui
  // setelah render awal tidak pernah diterjemahkan.
  //
  // Sumber: upstream decolua/9router 910db749.
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "characterData") {
        processTextNode(mutation.target);
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// Diekspor HANYA untuk pengujian. `processTextNode` sengaja tidak dipakai di
// luar modul ini, tapi bug "angka dashboard beku" (v0.5.112) hidup di sini dan
// tidak bisa dijangkau lewat API publik tanpa browser sungguhan.
export const __processTextNodeForTest = processTextNode;

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
