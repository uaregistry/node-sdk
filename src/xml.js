'use strict';

// Minimal, dependency-free XML helpers for EPP.
//
// escapeText / escapeAttr produce correctly-escaped node/attribute values (never
// string-concatenated raw). parseXml turns a well-formed EPP response into a small element
// tree {name, prefix, local, attrs, children, text} — enough to read result codes, resData
// and extensions by local name. It handles the XML prolog, comments, CDATA, self-closing
// tags, quoted attributes and character/entity references.

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref) => {
    if (ref[0] === '#') {
      const code = (ref[1] === 'x' || ref[1] === 'X')
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : match;
  });
}

function makeNode(name) {
  const idx = name.indexOf(':');
  return {
    name,
    prefix: idx >= 0 ? name.slice(0, idx) : '',
    local: idx >= 0 ? name.slice(idx + 1) : name,
    attrs: {},
    children: [],
    text: '',
  };
}

const ATTR_RE = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseTag(content) {
  content = content.trim();
  let k = 0;
  while (k < content.length && !/\s/.test(content[k])) k++;
  const node = makeNode(content.slice(0, k));
  const attrStr = content.slice(k);
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    const val = m[3] !== undefined ? m[3] : m[4];
    node.attrs[m[1]] = decodeEntities(val);
  }
  return node;
}

function parseXml(xml) {
  const len = xml.length;
  const stack = [];
  let root = null;
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i && stack.length) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt));
    }

    if (xml.startsWith('<?', lt)) { i = xml.indexOf('?>', lt) + 2; continue; }
    if (xml.startsWith('<!--', lt)) { i = xml.indexOf('-->', lt) + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      if (stack.length) stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) { i = xml.indexOf('>', lt) + 1; continue; }

    // Find the tag's closing '>' while respecting quoted attribute values.
    let j = lt + 1;
    let quote = null;
    while (j < len) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }

    if (xml[lt + 1] === '/') {
      stack.pop();
      i = j + 1;
      continue;
    }

    let content = xml.slice(lt + 1, j);
    let selfClose = false;
    if (content.endsWith('/')) {
      selfClose = true;
      content = content.slice(0, -1);
    }
    const node = parseTag(content);
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    if (!selfClose) stack.push(node);
    i = j + 1;
  }

  return root;
}

module.exports = { escapeText, escapeAttr, decodeEntities, parseXml };
