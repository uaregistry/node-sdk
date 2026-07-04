'use strict';

const { parseXml } = require('./xml');
const { ConnectionError } = require('./errors');

// A parsed EPP response (or greeting). Wraps the raw XML with convenience accessors: the
// result code/message, transaction ids, the availability map for *:check, and generic
// value/values getters plus the underlying element tree for anything bespoke.
//
// Element lookups are namespace-agnostic (by local name), so a variation in the response's
// namespace prefixes never breaks a getter.

function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function nodeText(node) {
  return node ? node.text.trim() : '';
}

function directChild(node, local) {
  if (!node) return null;
  for (const child of node.children) {
    if (child.local === local) return child;
  }
  return null;
}

class Response {
  constructor(raw, root) {
    this._raw = raw;
    this._root = root;
  }

  static fromXml(xml) {
    const root = parseXml(xml);
    if (!root) throw new ConnectionError('Server returned malformed XML');
    return new Response(xml, root);
  }

  _all(local) {
    const out = [];
    for (const node of walk(this._root)) if (node.local === local) out.push(node);
    return out;
  }

  _first(local) {
    for (const node of walk(this._root)) if (node.local === local) return node;
    return null;
  }

  // --- result / trID ---------------------------------------------------------

  code() {
    const result = this._first('result');
    if (!result) return 0;
    const raw = result.attrs.code;
    return raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  }

  message() {
    const result = this._first('result');
    const msg = directChild(result, 'msg');
    return msg ? nodeText(msg) : null;
  }

  // The language of the result <msg> ("en", "uk", "ua" or "ru"), or null.
  messageLang() {
    const result = this._first('result');
    const msg = directChild(result, 'msg');
    return msg && msg.attrs.lang !== undefined ? msg.attrs.lang : null;
  }

  isSuccess() {
    const code = this.code();
    return code >= 1000 && code < 2000;
  }

  isPending() {
    return this.code() === 1001;
  }

  isGreeting() {
    return this._first('greeting') !== null;
  }

  clTRID() {
    const node = directChild(this._first('trID'), 'clTRID');
    return node ? nodeText(node) : null;
  }

  svTRID() {
    const node = directChild(this._first('trID'), 'svTRID');
    return node ? nodeText(node) : null;
  }

  // --- check / poll ----------------------------------------------------------

  // Availability map for a *:check response: name/id => is-available.
  availability() {
    const out = {};
    for (const node of walk(this._root)) {
      if (node.attrs.avail !== undefined) {
        out[node.text.trim()] = node.attrs.avail === '1' || node.attrs.avail === 'true';
      }
    }
    return out;
  }

  // Poll only: the queued message id to pass to poll.ack(), or null.
  messageId() {
    const msgq = this._first('msgQ');
    return msgq && msgq.attrs.id !== undefined ? msgq.attrs.id : null;
  }

  // Poll only: how many messages remain in the queue.
  messageCount() {
    const msgq = this._first('msgQ');
    if (!msgq || msgq.attrs.count === undefined) return 0;
    return /^\d+$/.test(msgq.attrs.count) ? parseInt(msgq.attrs.count, 10) : 0;
  }

  // Object status values from the `s` attribute (e.g. ['ok'] or ['clientHold', ...]).
  statuses() {
    return this._all('status').map((n) => n.attrs.s).filter((s) => s !== undefined);
  }

  // --- balance / prices / licence -------------------------------------------

  // Account figures from a balance:info response, or null when not a balance response.
  balance() {
    const limit = this.value('creditLimit');
    const avail = this.value('availableCredit');
    if (limit === null && avail === null) return null;
    return {
      creditLimit: limit || '',
      balance: this.value('balance') || '',
      availableCredit: avail || '',
    };
  }

  // Renewal/restore price hints from a domain:info response, keyed by operation.
  prices() {
    const out = {};
    for (const node of this._all('price')) {
      const op = node.attrs.operation;
      if (!op) continue;
      out[op] = { value: node.text.trim(), currency: node.attrs.currency || '' };
    }
    return out;
  }

  // The .ua trademark/licence number from a domain:info response, or null.
  license() {
    return this.value('license');
  }

  // RGP status values from a domain:info response (e.g. ['redemptionPeriod']).
  rgpStatus() {
    return this._all('rgpStatus').map((n) => n.attrs.s).filter((s) => s !== undefined);
  }

  // The transfer status from a transfer response or poll trnData (e.g. "pending"), or null.
  transferStatus() {
    return this.value('trStatus');
  }

  // --- DNSSEC ----------------------------------------------------------------

  // DNSSEC DS records from a domain:info response (secDNS:dsData).
  dsRecords() {
    return this._all('dsData').map((ds) => ({
      keyTag: parseInt(nodeText(directChild(ds, 'keyTag')) || '0', 10),
      alg: parseInt(nodeText(directChild(ds, 'alg')) || '0', 10),
      digestType: parseInt(nodeText(directChild(ds, 'digestType')) || '0', 10),
      digest: nodeText(directChild(ds, 'digest')),
    }));
  }

  // DNSSEC key records from a domain:info response (top-level secDNS:keyData).
  keyRecords() {
    const out = [];
    for (const inf of this._all('infData')) {
      for (const kd of inf.children) {
        if (kd.local !== 'keyData') continue;
        out.push({
          flags: parseInt(nodeText(directChild(kd, 'flags')) || '0', 10),
          protocol: parseInt(nodeText(directChild(kd, 'protocol')) || '0', 10),
          alg: parseInt(nodeText(directChild(kd, 'alg')) || '0', 10),
          pubKey: nodeText(directChild(kd, 'pubKey')),
        });
      }
    }
    return out;
  }

  // True when a domain:info response carries DNSSEC data (any DS or key records).
  isSigned() {
    return this.dsRecords().length > 0 || this.keyRecords().length > 0;
  }

  // --- diagnostics / greeting -----------------------------------------------

  // Extra diagnostic text from a failed command's <extValue><reason> elements.
  errorReasons() {
    const out = [];
    for (const ext of this._all('extValue')) {
      for (const node of walk(ext)) {
        if (node.local === 'reason') out.push(node.text.trim());
      }
    }
    return out;
  }

  // Greeting only: the object / extension services the server advertises.
  serviceObjUris() {
    return this._all('objURI').map((n) => n.text.trim());
  }

  serviceExtUris() {
    return this._all('extURI').map((n) => n.text.trim());
  }

  // --- generic getters -------------------------------------------------------

  // First element anywhere with this local name (namespace-agnostic), trimmed.
  value(local) {
    const node = this._first(local);
    return node ? nodeText(node) : null;
  }

  // Every element with this local name, trimmed.
  values(local) {
    return this._all(local).map((n) => n.text.trim());
  }

  // The <resData> element of the response, if present (for custom parsing).
  resData() {
    return this._first('resData');
  }

  raw() {
    return this._raw;
  }

  // The parsed element tree root, for anything bespoke.
  root() {
    return this._root;
  }
}

module.exports = { Response };
