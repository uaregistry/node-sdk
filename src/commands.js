'use strict';

const net = require('net');
const ns = require('./namespaces');

// Object command handlers (domain / contact / host / poll). Reached through the Client
// resource getters: client.domain, client.contact, client.host, client.poll. Every method
// returns a Promise<Response>. Nested options use the RFC field names in camelCase, e.g.
// { authInfo, secDNS: { dsData: [{ keyTag, alg, digestType, digest }] } }.

const D = ns.DOMAIN;
const C = ns.CONTACT;
const H = ns.HOST;

function ipVersion(ip) {
  return net.isIPv6(ip) ? 'v6' : 'v4';
}

function appendSecDnsRecords(frame, parent, spec) {
  for (const rec of spec.dsData || []) {
    const ds = frame.ns(parent, ns.SECDNS, 'secDNS:dsData');
    frame.ns(ds, ns.SECDNS, 'secDNS:keyTag', String(parseInt(rec.keyTag || 0, 10)));
    frame.ns(ds, ns.SECDNS, 'secDNS:alg', String(parseInt(rec.alg || 0, 10)));
    frame.ns(ds, ns.SECDNS, 'secDNS:digestType', String(parseInt(rec.digestType || 0, 10)));
    frame.ns(ds, ns.SECDNS, 'secDNS:digest', String(rec.digest || ''));
  }
  for (const rec of spec.keyData || []) {
    const kd = frame.ns(parent, ns.SECDNS, 'secDNS:keyData');
    frame.ns(kd, ns.SECDNS, 'secDNS:flags', String(parseInt(rec.flags != null ? rec.flags : 257, 10)));
    frame.ns(kd, ns.SECDNS, 'secDNS:protocol', String(parseInt(rec.protocol != null ? rec.protocol : 3, 10)));
    frame.ns(kd, ns.SECDNS, 'secDNS:alg', String(parseInt(rec.alg || 0, 10)));
    frame.ns(kd, ns.SECDNS, 'secDNS:pubKey', String(rec.pubKey || ''));
  }
}

function appendPostalInfo(frame, parent, pi) {
  const block = frame.ns(parent, C, 'contact:postalInfo', null, { type: pi.type || 'int' });
  frame.ns(block, C, 'contact:name', pi.name || '');
  if (pi.org) frame.ns(block, C, 'contact:org', pi.org);
  const addr = frame.ns(block, C, 'contact:addr');
  for (const line of pi.street || []) frame.ns(addr, C, 'contact:street', line);
  frame.ns(addr, C, 'contact:city', pi.city || '');
  if (pi.sp) frame.ns(addr, C, 'contact:sp', pi.sp);
  if (pi.pc) frame.ns(addr, C, 'contact:pc', pi.pc);
  frame.ns(addr, C, 'contact:cc', pi.cc || '');
}

function appendDisclose(frame, parent, disclose) {
  const flag = disclose.flag ? '1' : '0';
  const disc = frame.ns(parent, C, 'contact:disclose', null, { flag });
  for (const field of ['name', 'org', 'addr']) {
    if (disclose[field] === undefined) continue;
    for (const type of disclose[field]) frame.ns(disc, C, `contact:${field}`, null, { type });
  }
  for (const field of ['voice', 'fax', 'email']) {
    if (disclose[field]) frame.ns(disc, C, `contact:${field}`);
  }
}

class Domain {
  constructor(client) { this._client = client; }

  check(names) {
    const frame = this._client.frame();
    const check = frame.ns(frame.verb('check'), D, 'domain:check');
    for (const name of names) frame.ns(check, D, 'domain:name', name);
    return this._client.request(frame);
  }

  info(name, authInfo = null, hosts = 'all') {
    const frame = this._client.frame();
    const info = frame.ns(frame.verb('info'), D, 'domain:info');
    frame.ns(info, D, 'domain:name', name, { hosts });
    if (authInfo !== null) {
      const ai = frame.ns(info, D, 'domain:authInfo');
      frame.ns(ai, D, 'domain:pw', authInfo);
    }
    return this._client.request(frame);
  }

  create(name, opts = {}) {
    const frame = this._client.frame();
    const create = frame.ns(frame.verb('create'), D, 'domain:create');
    frame.ns(create, D, 'domain:name', name);
    if (opts.years != null) frame.ns(create, D, 'domain:period', String(parseInt(opts.years, 10)), { unit: 'y' });
    if (opts.nameservers && opts.nameservers.length) {
      const nsEl = frame.ns(create, D, 'domain:ns');
      for (const host of opts.nameservers) frame.ns(nsEl, D, 'domain:hostObj', host);
    }
    if (opts.registrant != null) frame.ns(create, D, 'domain:registrant', opts.registrant);
    for (const [type, handle] of Object.entries(opts.contacts || {})) {
      frame.ns(create, D, 'domain:contact', handle, { type });
    }
    // authInfo is MANDATORY on domain:create (RFC 5731). Always emit it — with the caller's
    // transfer secret, or an empty <pw/> (pwType allows minLength 0) so the registry applies
    // its per-zone authInfo policy.
    const ai = frame.ns(create, D, 'domain:authInfo');
    frame.ns(ai, D, 'domain:pw', opts.authInfo || '');

    const secDNS = opts.secDNS;
    // secDNS:create requires at least one dsData or keyData record (RFC 5910); an empty or
    // keyless object must not emit a childless <secDNS:create/>, which is invalid.
    const hasSecDns = secDNS && ((secDNS.dsData && secDNS.dsData.length) || (secDNS.keyData && secDNS.keyData.length));
    if (hasSecDns || opts.license != null) {
      const ext = frame.extension();
      if (hasSecDns) {
        const secCreate = frame.ns(ext, ns.SECDNS, 'secDNS:create');
        if (secDNS.maxSigLife != null) frame.ns(secCreate, ns.SECDNS, 'secDNS:maxSigLife', String(parseInt(secDNS.maxSigLife, 10)));
        appendSecDnsRecords(frame, secCreate, secDNS);
      }
      if (opts.license != null) {
        const u = frame.ns(ext, ns.UAREG_EXT, 'uareg:create');
        frame.ns(u, ns.UAREG_EXT, 'uareg:license', opts.license);
      }
    }
    return this._client.request(frame);
  }

  update(name, opts = {}) {
    const frame = this._client.frame();
    const update = frame.ns(frame.verb('update'), D, 'domain:update');
    frame.ns(update, D, 'domain:name', name);

    for (const op of ['add', 'rem']) {
      const spec = opts[op];
      if (!spec) continue;
      const block = frame.ns(update, D, `domain:${op}`);
      if (spec.ns && spec.ns.length) {
        const nsEl = frame.ns(block, D, 'domain:ns');
        for (const host of spec.ns) frame.ns(nsEl, D, 'domain:hostObj', host);
      }
      for (const [type, handle] of Object.entries(spec.contacts || {})) {
        frame.ns(block, D, 'domain:contact', handle, { type });
      }
      for (const status of spec.statuses || []) frame.ns(block, D, 'domain:status', null, { s: status });
    }

    if (opts.chg) {
      const block = frame.ns(update, D, 'domain:chg');
      if (opts.chg.registrant !== undefined) frame.ns(block, D, 'domain:registrant', opts.chg.registrant);
      if (opts.chg.authInfo !== undefined) {
        const ai = frame.ns(block, D, 'domain:authInfo');
        frame.ns(ai, D, 'domain:pw', opts.chg.authInfo);
      }
    }

    if (opts.restore) {
      const rgp = frame.ns(frame.extension(), ns.RGP, 'rgp:update');
      frame.ns(rgp, ns.RGP, 'rgp:restore', null, { op: 'request' });
    }
    if (opts.license != null) {
      const u = frame.ns(frame.extension(), ns.UAREG_EXT, 'uareg:update');
      frame.ns(u, ns.UAREG_EXT, 'uareg:license', opts.license);
    }

    // DNSSEC delta (RFC 5910): rem (specific or all), add, chg maxSigLife.
    const secDNS = opts.secDNS;
    if (secDNS && typeof secDNS === 'object') {
      const secUpdate = frame.ns(frame.extension(), ns.SECDNS, 'secDNS:update');
      if (secDNS.remAll) {
        const rem = frame.ns(secUpdate, ns.SECDNS, 'secDNS:rem');
        frame.ns(rem, ns.SECDNS, 'secDNS:all', 'true');
      } else if (secDNS.rem) {
        const rem = frame.ns(secUpdate, ns.SECDNS, 'secDNS:rem');
        appendSecDnsRecords(frame, rem, secDNS.rem);
      }
      if (secDNS.add) {
        const add = frame.ns(secUpdate, ns.SECDNS, 'secDNS:add');
        appendSecDnsRecords(frame, add, secDNS.add);
      }
      if (secDNS.maxSigLife != null) {
        const chg = frame.ns(secUpdate, ns.SECDNS, 'secDNS:chg');
        frame.ns(chg, ns.SECDNS, 'secDNS:maxSigLife', String(parseInt(secDNS.maxSigLife, 10)));
      }
    }
    return this._client.request(frame);
  }

  renew(name, curExpDate, years = 1) {
    const frame = this._client.frame();
    const renew = frame.ns(frame.verb('renew'), D, 'domain:renew');
    frame.ns(renew, D, 'domain:name', name);
    frame.ns(renew, D, 'domain:curExpDate', curExpDate);
    frame.ns(renew, D, 'domain:period', String(parseInt(years, 10)), { unit: 'y' });
    return this._client.request(frame);
  }

  delete(name) {
    const frame = this._client.frame();
    const del = frame.ns(frame.verb('delete'), D, 'domain:delete');
    frame.ns(del, D, 'domain:name', name);
    return this._client.request(frame);
  }

  // Restore a redemption-period domain (rgp:restore op="request").
  restore(name) {
    return this.update(name, { restore: true });
  }

  // op is one of request|approve|reject|cancel|query.
  transfer(op, name, authInfo = null, years = null) {
    const frame = this._client.frame();
    const transfer = frame.verb('transfer');
    transfer.attrs.op = op;
    const d = frame.ns(transfer, D, 'domain:transfer');
    frame.ns(d, D, 'domain:name', name);
    if (years !== null) frame.ns(d, D, 'domain:period', String(parseInt(years, 10)), { unit: 'y' });
    if (authInfo !== null) {
      const ai = frame.ns(d, D, 'domain:authInfo');
      frame.ns(ai, D, 'domain:pw', authInfo);
    }
    return this._client.request(frame);
  }
}

class Contact {
  constructor(client) { this._client = client; }

  check(ids) {
    const frame = this._client.frame();
    const check = frame.ns(frame.verb('check'), C, 'contact:check');
    for (const id of ids) frame.ns(check, C, 'contact:id', id);
    return this._client.request(frame);
  }

  info(id, authInfo = null) {
    const frame = this._client.frame();
    const info = frame.ns(frame.verb('info'), C, 'contact:info');
    frame.ns(info, C, 'contact:id', id);
    if (authInfo !== null) {
      const ai = frame.ns(info, C, 'contact:authInfo');
      frame.ns(ai, C, 'contact:pw', authInfo);
    }
    return this._client.request(frame);
  }

  create(id, opts = {}) {
    const frame = this._client.frame();
    const c = frame.ns(frame.verb('create'), C, 'contact:create');
    frame.ns(c, C, 'contact:id', id);

    if (opts.postalInfos && opts.postalInfos.length) {
      for (const pi of opts.postalInfos) appendPostalInfo(frame, c, pi);
    } else {
      appendPostalInfo(frame, c, {
        name: opts.name, org: opts.org, street: opts.street, city: opts.city,
        sp: opts.sp, pc: opts.pc, cc: opts.cc, type: opts.type || 'int',
      });
    }
    if (opts.voice) frame.ns(c, C, 'contact:voice', opts.voice);
    if (opts.fax) frame.ns(c, C, 'contact:fax', opts.fax);
    if (!opts.email) {
      // RFC 5733 requires a contact email (emailType minLength 1). Fail fast client-side.
      throw new TypeError("contact.create() requires a non-empty 'email'");
    }
    frame.ns(c, C, 'contact:email', opts.email);
    const ai = frame.ns(c, C, 'contact:authInfo');
    frame.ns(ai, C, 'contact:pw', opts.authInfo || '');
    if (opts.disclose) appendDisclose(frame, c, opts.disclose);
    return this._client.request(frame);
  }

  update(id, opts = {}) {
    const frame = this._client.frame();
    const update = frame.ns(frame.verb('update'), C, 'contact:update');
    frame.ns(update, C, 'contact:id', id);
    // contact:updateType allows a SINGLE add/rem block (each holding up to 7 statuses); emit
    // the wrapper once and append every status into it.
    if (opts.addStatuses && opts.addStatuses.length) {
      const add = frame.ns(update, C, 'contact:add');
      for (const status of opts.addStatuses) frame.ns(add, C, 'contact:status', null, { s: status });
    }
    if (opts.remStatuses && opts.remStatuses.length) {
      const rem = frame.ns(update, C, 'contact:rem');
      for (const status of opts.remStatuses) frame.ns(rem, C, 'contact:status', null, { s: status });
    }
    if (opts.chg) {
      const block = frame.ns(update, C, 'contact:chg');
      // RFC 5733 chg order: postalInfo*, voice?, fax?, email?, authInfo?, disclose?
      let pis = opts.chg.postalInfos;
      if (!pis && opts.chg.postalInfo) pis = [opts.chg.postalInfo];
      for (const pi of pis || []) appendPostalInfo(frame, block, pi);
      if (opts.chg.voice !== undefined) frame.ns(block, C, 'contact:voice', opts.chg.voice);
      if (opts.chg.fax !== undefined) frame.ns(block, C, 'contact:fax', opts.chg.fax);
      if (opts.chg.email !== undefined) frame.ns(block, C, 'contact:email', opts.chg.email);
      if (opts.chg.authInfo !== undefined) {
        const ai = frame.ns(block, C, 'contact:authInfo');
        frame.ns(ai, C, 'contact:pw', opts.chg.authInfo);
      }
      if (opts.chg.disclose) appendDisclose(frame, block, opts.chg.disclose);
    }
    return this._client.request(frame);
  }

  delete(id) {
    const frame = this._client.frame();
    const del = frame.ns(frame.verb('delete'), C, 'contact:delete');
    frame.ns(del, C, 'contact:id', id);
    return this._client.request(frame);
  }

  transfer(op, id, authInfo = null) {
    const frame = this._client.frame();
    const transfer = frame.verb('transfer');
    transfer.attrs.op = op;
    const c = frame.ns(transfer, C, 'contact:transfer');
    frame.ns(c, C, 'contact:id', id);
    if (authInfo !== null) {
      const ai = frame.ns(c, C, 'contact:authInfo');
      frame.ns(ai, C, 'contact:pw', authInfo);
    }
    return this._client.request(frame);
  }
}

class Host {
  constructor(client) { this._client = client; }

  check(names) {
    const frame = this._client.frame();
    const check = frame.ns(frame.verb('check'), H, 'host:check');
    for (const name of names) frame.ns(check, H, 'host:name', name);
    return this._client.request(frame);
  }

  info(name) {
    const frame = this._client.frame();
    const info = frame.ns(frame.verb('info'), H, 'host:info');
    frame.ns(info, H, 'host:name', name);
    return this._client.request(frame);
  }

  // addresses: IPv4 or IPv6 literals; the version is auto-detected.
  create(name, addresses = []) {
    const frame = this._client.frame();
    const create = frame.ns(frame.verb('create'), H, 'host:create');
    frame.ns(create, H, 'host:name', name);
    for (const ip of addresses) frame.ns(create, H, 'host:addr', ip, { ip: ipVersion(ip) });
    return this._client.request(frame);
  }

  update(name, opts = {}) {
    const frame = this._client.frame();
    const update = frame.ns(frame.verb('update'), H, 'host:update');
    frame.ns(update, H, 'host:name', name);
    const groups = [
      ['add', opts.addAddresses, opts.addStatuses],
      ['rem', opts.remAddresses, opts.remStatuses],
    ];
    for (const [op, addrs, statuses] of groups) {
      const a = addrs || [];
      const s = statuses || [];
      if (a.length === 0 && s.length === 0) continue;
      const block = frame.ns(update, H, `host:${op}`);
      for (const ip of a) frame.ns(block, H, 'host:addr', ip, { ip: ipVersion(ip) });
      for (const status of s) frame.ns(block, H, 'host:status', null, { s: status });
    }
    if (opts.newName) {
      const chg = frame.ns(update, H, 'host:chg');
      frame.ns(chg, H, 'host:name', opts.newName);
    }
    return this._client.request(frame);
  }

  delete(name, force = false) {
    const frame = this._client.frame();
    const del = frame.ns(frame.verb('delete'), H, 'host:delete');
    frame.ns(del, H, 'host:name', name);
    if (force) {
      // UARegistry native: detach the host from every domain before deleting it.
      const u = frame.ns(frame.extension(), ns.UAREG_EXT, 'uareg:delete');
      frame.ns(u, ns.UAREG_EXT, 'uareg:deleteNS', null, { confirm: 'yes' });
    }
    return this._client.request(frame);
  }
}

class Poll {
  constructor(client) { this._client = client; }

  // Request the next service message (1301 with a message, 1300 when empty).
  request() {
    const frame = this._client.frame();
    frame.verb('poll').attrs.op = 'req';
    return this._client.request(frame);
  }

  ack(messageId) {
    const frame = this._client.frame();
    const poll = frame.verb('poll');
    poll.attrs.op = 'ack';
    poll.attrs.msgID = String(messageId);
    return this._client.request(frame);
  }
}

module.exports = { Domain, Contact, Host, Poll };
