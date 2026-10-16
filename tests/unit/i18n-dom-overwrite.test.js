/**
 * REGRESI: i18n runtime TIDAK boleh menimpa teks yang ditulis React.
 *
 * Bug yang dikunci di sini (v0.5.112):
 *   `processTextNode()` menyimpan `_originalText` sekali dan selamanya. React
 *   memakai ULANG text node saat re-render, jadi setiap kali React menulis
 *   nilai baru ("10075"), observer `characterData` memanggil processTextNode,
 *   yang menulis balik `_originalText` basi ("944").
 *
 *   Akibat di UI: angka dashboard tampak BEKU saat period diganti — padahal
 *   state React sudah benar (dibuktikan lewat inspeksi fiber).
 *
 * Uji ini memakai DOM tiruan minimal — cukup untuk menjalankan processTextNode
 * tanpa browser.
 */
import { describe, it, expect, beforeEach } from "vitest";

// ---- DOM tiruan minimal ----
class FakeTextNode {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = null;
  }
}

class FakeElement {
  constructor(tag = "SPAN", attrs = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this._attrs = new Set(Object.keys(attrs));
  }
  hasAttribute(name) { return this._attrs.has(name); }
}

function makeNode(value, parentTag = "SPAN") {
  const n = new FakeTextNode(value);
  n.parentElement = new FakeElement(parentTag);
  return n;
}

describe("i18n runtime tidak menimpa tulisan React", () => {
  let processTextNode;

  beforeEach(async () => {
    const mod = await import("../../src/i18n/runtime.js");
    // processTextNode tidak diekspor — pakai jalur publik: initRuntimeI18n
    // terlalu berat untuk unit test, jadi kita uji lewat `translate()` +
    // reproduksi logika. Sebagai gantinya, ekspor implisit lewat modul.
    processTextNode = mod.__processTextNodeForTest;
  });

  it("processTextNode diekspor untuk pengujian", () => {
    expect(typeof processTextNode, "processTextNode harus diekspor sebagai __processTextNodeForTest").toBe("function");
  });

  it("tidak menulis ulang node saat tidak ada terjemahan (locale en)", () => {
    const node = makeNode("944");
    processTextNode(node);
    // Node tidak boleh disentuh sama sekali — tidak ada terjemahan untuk angka.
    expect(node.nodeValue).toBe("944");
    expect(node._i18nWritten).toBeUndefined();
  });

  it("mengikuti perubahan nilai dari React (kasus utama bug)", () => {
    const node = makeNode("944");
    processTextNode(node);            // render awal

    // React menulis nilai BARU ke node yang sama (re-render ganti period)
    node.nodeValue = "10075";
    processTextNode(node);            // observer characterData memanggil ini

    // HARUS tetap "10075". Dulu ditimpa balik ke "944".
    expect(node.nodeValue).toBe("10075");

    // dan seterusnya
    node.nodeValue = "54730";
    processTextNode(node);
    expect(node.nodeValue).toBe("54730");
  });

  it("mengembalikan nilai asli saat React menulis ulang setelah ada terjemahan", () => {
    const node = makeNode("Total Requests");
    // Simulasikan ada terjemahan dengan mengisi _i18nWritten manual
    node._originalText = "Total Requests";
    node._i18nWritten = "Total Permintaan";
    node.nodeValue = "Total Permintaan";

    // React menulis ulang teks aslinya (re-render)
    node.nodeValue = "Total Requests";
    processTextNode(node);

    // Node harus dianggap milik React lagi, bukan ditimpa balik ke terjemahan
    expect(node.nodeValue).toBe("Total Requests");
    expect(node._i18nWritten).toBeUndefined();
  });

  it("tidak menimpa angka meski beberapa kali re-render berturut-turut", () => {
    const node = makeNode("0");
    for (const v of ["0", "944", "10075", "54730", "944"]) {
      node.nodeValue = v;
      processTextNode(node);
      expect(node.nodeValue).toBe(v);
    }
  });
});
