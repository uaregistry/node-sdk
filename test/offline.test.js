'use strict';

// Offline self-test: exercises frame building and response parsing with a fake in-memory
// transport — no server, no network. Run: node test/offline.test.js

const { Client, Config, Response, Namespaces } = require('..');
const { CommandError, AuthError, ConfigError } = require('..');
const { parseXml } = require('../src/xml');

let passed = 0;
let failed = 0;
function check(label, ok) {
  console.log((ok ? '  ok  ' : ' FAIL ') + label);
  if (ok) passed += 1; else failed += 1;
}

class FakeTransport {
  constructor() { this.written = []; this.queue = []; this._open = false; }
  async open() { this._open = true; }
  isOpen() { return this._open; }
  async writeFrame(xml) { this.written.push(xml); }
  async readFrame() {
    if (!this.queue.length) throw new Error('FakeTransport: no queued response');
    return this.queue.shift();
  }
  close() { this._open = false; }
}

const GREETING = '<?xml version="1.0" encoding="UTF-8"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><greeting>'
  + '<svID>UARegistry EPP</svID><svDate>2026-07-04T00:00:00Z</svDate><svcMenu><version>1.0</version>'
  + '<lang>en</lang><lang>uk</lang>'
  + '<objURI>urn:ietf:params:xml:ns:contact-1.0</objURI><objURI>urn:ietf:params:xml:ns:domain-1.0</objURI>'
  + '<objURI>urn:ietf:params:xml:ns:host-1.0</objURI>'
  + '<svcExtension><extURI>urn:ietf:params:xml:ns:secDNS-1.1</extURI><extURI>urn:ietf:params:xml:ns:rgp-1.0</extURI>'
  + '<extURI>http://uaregistry.com/epp/uaregistry-1.0</extURI><extURI>http://uaregistry.com/epp/balance-1.0</extURI>'
  + '</svcExtension></svcMenu></greeting></epp>';

function OK(code = 1000, msg = 'ok', lang = 'en') {
  return '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
    + `<result code="${code}"><msg lang="${lang}">${msg}</msg></result>`
    + '<trID><clTRID>C1</clTRID><svTRID>UA-1</svTRID></trID></response></epp>';
}

function makeClient(responses) {
  const fake = new FakeTransport();
  fake.queue = responses.slice();
  const client = new Client(new Config({ host: 'epp.example', clid: 'UAR0001', password: 'secret' }), fake);
  return { client, fake };
}

// --- request-frame inspection helpers (namespace-agnostic) ---
function* walk(node) { yield node; for (const c of node.children) yield* walk(c); }
function allLocal(root, name) { return [...walk(root)].filter((n) => n.local === name); }
function firstLocal(root, name) { for (const n of walk(root)) if (n.local === name) return n; return null; }
function textOf(root, name) { const n = firstLocal(root, name); return n ? n.text : null; }
function parse(xml) { return parseXml(xml); }

async function main() {
  // ------------------------------------------------------------------ session
  console.log('session: connect + login (services from greeting)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    const greeting = await client.connect();
    check('greeting parsed', greeting.isGreeting());
    check('greeting objURIs', greeting.serviceObjUris().includes('urn:ietf:params:xml:ns:domain-1.0'));
    await client.login();
    const lf = parse(fake.written[0]);
    check('login clID', textOf(lf, 'clID') === 'UAR0001');
    check('login pw', textOf(lf, 'pw') === 'secret');
    check('login version 1.0', textOf(lf, 'version') === '1.0');
    check('login advertises domain objURI', allLocal(lf, 'objURI').some((e) => e.text === Namespaces.DOMAIN));
    check('login advertises balance extURI', allLocal(lf, 'extURI').some((e) => e.text === Namespaces.UAREG_BALANCE));
    check('login omits the epp base URI', allLocal(lf, 'objURI').every((e) => e.text !== Namespaces.EPP));
  }

  console.log('session: password rotation via newPW');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.login('new-secret-1');
    check('login carries newPW', textOf(parse(fake.written[0]), 'newPW') === 'new-secret-1');
  }

  console.log('clTRID format: prefix-timestamp-pid-counter');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();
    await client.domain.check(['a.com.ua']);
    await client.domain.check(['b.com.ua']);
    const t1 = firstLocal(parse(fake.written[0]), 'clTRID').text;
    const t2 = firstLocal(parse(fake.written[1]), 'clTRID').text;
    check('clTRID shape UAR-SDK-<ts>-<pid>-0001', /^UAR-SDK-\d{14}-\d+-0001$/.test(t1));
    check('clTRID counter increments', t2.endsWith('-0002'));
    check('clTRID pid stable across a session', t1.split('-').slice(-2)[0] === t2.split('-').slice(-2)[0]);
  }

  // ------------------------------------------------------------------- domain
  console.log('domain: check / info / create');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.domain.check(['x.com.ua', 'y.com.ua']);
    const dc = parse(fake.written[0]);
    check('domain:check has 2 names', allLocal(dc, 'name').length === 2);
    check('domain:check carries the domain prefix + xmlns',
      [...walk(dc)].some((e) => e.name === 'domain:check') && fake.written[0].includes(`xmlns:domain="${Namespaces.DOMAIN}"`));

    await client.domain.info('x.com.ua', 'authpw', 'all');
    const di = parse(fake.written[1]);
    check('domain:info hosts attr', firstLocal(di, 'name').attrs.hosts === 'all');
    check('domain:info authInfo pw', textOf(di, 'pw') === 'authpw');

    await client.domain.create('x.com.ua', {
      years: 1, registrant: 'REG1', contacts: { admin: 'ADM1', tech: 'TEC1' },
      nameservers: ['ns1.x.ua', 'ns2.x.ua'], authInfo: 'secret1', license: 'TM-1',
      secDNS: { dsData: [{ keyTag: 12345, alg: 8, digestType: 2, digest: 'AB'.repeat(32) }] },
    });
    const cr = parse(fake.written[2]);
    check('create period unit=y', firstLocal(cr, 'period').attrs.unit === 'y');
    check('create 2 hostObj', allLocal(cr, 'hostObj').length === 2);
    check('create 2 contacts', allLocal(cr, 'contact').length === 2);
    check('create authInfo pw', textOf(cr, 'pw') === 'secret1');
    check('create secDNS keyTag', textOf(cr, 'keyTag') === '12345');
    check('create uareg license', textOf(cr, 'license') === 'TM-1');
  }

  console.log('domain: create without authInfo still emits an empty <pw/>');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.domain.create('noauth.com.ua', { years: 1, registrant: 'REG1', contacts: { admin: 'A1', tech: 'T1' }, nameservers: ['ns1.x.ua'] });
    const pw = firstLocal(parse(fake.written[0]), 'pw');
    check('authInfo-less create has a <pw> element', pw !== null);
    check('authInfo-less create <pw> is empty', (pw.text || '') === '');
  }

  console.log('domain: create with empty secDNS emits no childless secDNS:create');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.domain.create('nosec.com.ua', { years: 1, registrant: 'REG1', contacts: { admin: 'A1', tech: 'T1' }, nameservers: ['ns1.x.ua'], secDNS: {} });
    const secCreate = [...walk(parse(fake.written[0]))].filter((e) => e.name === 'secDNS:create');
    check('empty secDNS -> no secDNS:create', secCreate.length === 0);
  }

  console.log('domain: update deltas + secDNS + restore');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();
    await client.domain.update('x.com.ua', {
      add: { ns: ['ns3.x.ua'], statuses: ['clientHold'] },
      rem: { statuses: ['clientHold'] },
      chg: { registrant: 'REG9', authInfo: 'newpw12345' },
      secDNS: { add: { dsData: [{ keyTag: 22, alg: 8, digestType: 2, digest: 'bb'.repeat(32) }] }, remAll: true, maxSigLife: 1209600 },
    });
    const up = parse(fake.written[0]);
    check('update add block present', firstLocal(up, 'add') !== null);
    check('update chg registrant', textOf(up, 'registrant') === 'REG9');
    check('update secDNS rem all=true', [...walk(up)].some((e) => e.local === 'all' && e.text === 'true'));
    check('update secDNS add keyTag=22', textOf(up, 'keyTag') === '22');
    check('update secDNS maxSigLife', textOf(up, 'maxSigLife') === '1209600');

    await client.domain.restore('x.com.ua');
    check('restore rgp op=request', firstLocal(parse(fake.written[1]), 'restore').attrs.op === 'request');
  }

  console.log('domain: renew / delete / transfer');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.domain.renew('x.com.ua', '2027-01-15', 2);
    const rn = parse(fake.written[0]);
    check('renew curExpDate', textOf(rn, 'curExpDate') === '2027-01-15');
    check('renew period 2', textOf(rn, 'period') === '2');
    await client.domain.delete('x.com.ua');
    check('delete has name', textOf(parse(fake.written[1]), 'name') === 'x.com.ua');
    await client.domain.transfer('request', 'x.com.ua', 'pw', 1);
    const tr = parse(fake.written[2]);
    check('transfer op=request', firstLocal(tr, 'transfer').attrs.op === 'request');
    check('transfer authInfo pw', textOf(tr, 'pw') === 'pw');
  }

  // ------------------------------------------------------------------ contact
  console.log('contact: create (int+loc postalInfo + disclose)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.create('CID1', {
      postalInfos: [
        { type: 'int', name: 'Test Person', street: ['1 A St'], city: 'Kyiv', cc: 'UA' },
        { type: 'loc', name: 'Тест Особа', city: 'Київ', cc: 'UA' },
      ],
      email: 'a@b.ua', authInfo: 'pw', disclose: { flag: false, addr: ['int'], voice: true, email: true },
    });
    const cc = parse(fake.written[0]);
    check('contact 2 postalInfo blocks', allLocal(cc, 'postalInfo').length === 2);
    check('contact int name', [...walk(cc)].some((e) => e.local === 'name' && e.text === 'Test Person'));
    check('contact loc Cyrillic name preserved', [...walk(cc)].some((e) => e.local === 'name' && e.text === 'Тест Особа'));
    check('contact disclose flag=0', firstLocal(cc, 'disclose').attrs.flag === '0');
  }

  console.log('contact: create without email throws TypeError');
  {
    const { client } = makeClient([GREETING]);
    await client.connect();
    let threw = false;
    try { await client.contact.create('CID2', { name: 'X', city: 'Kyiv', cc: 'UA' }); } catch (e) { threw = e instanceof TypeError; }
    check('empty email throws TypeError', threw);
  }

  console.log('contact: update collapses multiple statuses into one add/rem block');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.update('CID1', {
      addStatuses: ['clientUpdateProhibited', 'clientDeleteProhibited'],
      remStatuses: ['clientTransferProhibited'],
      chg: { email: 'new@b.ua' },
    });
    const cu = parse(fake.written[0]);
    check('contact update single add block', allLocal(cu, 'add').length === 1);
    check('contact update 2 statuses in add', allLocal(cu, 'status').filter((e) => ['clientUpdateProhibited', 'clientDeleteProhibited'].includes(e.attrs.s)).length === 2);
    check('contact update chg email', [...walk(cu)].some((e) => e.local === 'email' && e.text === 'new@b.ua'));
  }

  console.log('contact: check / info / delete / transfer');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK(), OK()]);
    await client.connect();
    await client.contact.check(['C1', 'C2']);
    check('contact:check 2 ids', allLocal(parse(fake.written[0]), 'id').length === 2);
    await client.contact.info('C1', 'pw');
    check('contact:info authInfo', textOf(parse(fake.written[1]), 'pw') === 'pw');
    await client.contact.delete('C1');
    check('contact:delete id', textOf(parse(fake.written[2]), 'id') === 'C1');
    await client.contact.transfer('request', 'C1', 'pw');
    check('contact:transfer op', firstLocal(parse(fake.written[3]), 'transfer').attrs.op === 'request');
  }

  // --------------------------------------------------------------------- host
  console.log('host: create v4+v6 auto-detect / update / delete-force');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.host.create('ns1.x.ua', ['192.0.2.1', '2001:db8::1']);
    const addrs = allLocal(parse(fake.written[0]), 'addr');
    check('host v4 detected', addrs.some((a) => a.text === '192.0.2.1' && a.attrs.ip === 'v4'));
    check('host v6 detected', addrs.some((a) => a.text === '2001:db8::1' && a.attrs.ip === 'v6'));
    await client.host.update('ns1.x.ua', { addAddresses: ['192.0.2.9'], remStatuses: ['clientUpdateProhibited'], newName: 'ns2.x.ua' });
    const hu = parse(fake.written[1]);
    check('host update add block', firstLocal(hu, 'add') !== null);
    check('host update chg new name', [...walk(hu)].some((e) => e.local === 'name' && e.text === 'ns2.x.ua'));
    await client.host.delete('ns1.x.ua', true);
    check('host delete force uareg:deleteNS', firstLocal(parse(fake.written[2]), 'deleteNS') !== null);
  }

  // -------------------------------------------------------------- poll+balance
  console.log('poll: request / ack   +   balance: info');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.poll.request();
    check('poll op=req', firstLocal(parse(fake.written[0]), 'poll').attrs.op === 'req');
    await client.poll.ack('42');
    const pa = parse(fake.written[1]);
    check('poll op=ack', firstLocal(pa, 'poll').attrs.op === 'ack');
    check('poll msgID', firstLocal(pa, 'poll').attrs.msgID === '42');
    await client.balance();
    check('balance:info element in balance-1.0 ns', [...walk(parse(fake.written[2]))].some((e) => e.name === 'balance:info'));
  }

  // ------------------------------------------------------------------ escaping
  console.log('frame: XML escaping (special chars + Cyrillic, single-escaped)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.create('C&<1', { name: 'A & B <Ltd>', city: 'Львів', cc: 'UA', email: 'a"b@x.ua' });
    const raw = fake.written[0];
    check('ampersand escaped once', raw.includes('&amp;') && !raw.includes('&amp;amp;'));
    check('angle brackets escaped', raw.includes('&lt;Ltd&gt;'));
    check('Cyrillic preserved', raw.includes('Львів'));
    check('escaped id round-trips', textOf(parse(raw), 'id') === 'C&<1');
  }

  // ------------------------------------------------------------------ response
  console.log('response: code / message / lang / trIDs');
  {
    const r = Response.fromXml(OK(1000, 'Команду виконано успішно', 'uk'));
    check('code 1000', r.code() === 1000);
    check('isSuccess', r.isSuccess());
    check('message text', r.message() === 'Команду виконано успішно');
    check('messageLang uk', r.messageLang() === 'uk');
    check('svTRID', r.svTRID() === 'UA-1');
    check('clTRID', r.clTRID() === 'C1');
  }

  console.log('response: availability (domain:check)');
  {
    const availXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:chkData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:cd><domain:name avail="1">free.com.ua</domain:name></domain:cd>'
      + '<domain:cd><domain:name avail="0">taken.com.ua</domain:name></domain:cd>'
      + '</domain:chkData></resData><trID><svTRID>UA-2</svTRID></trID></response></epp>';
    const av = Response.fromXml(availXml).availability();
    check('avail free=true', av['free.com.ua'] === true);
    check('avail taken=false', av['taken.com.ua'] === false);
  }

  console.log('response: balance / prices / licence / statuses');
  {
    const infoXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:infData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:name>x.com.ua</domain:name><domain:status s="ok"/>'
      + '<domain:exDate>2027-01-01T00:00:00Z</domain:exDate></domain:infData></resData>'
      + '<extension><uareg:infData xmlns:uareg="http://uaregistry.com/epp/uaregistry-1.0">'
      + '<uareg:license>TM-777</uareg:license>'
      + '<uareg:priceData><uareg:price operation="renewal" currency="UAH">180.00</uareg:price></uareg:priceData>'
      + '</uareg:infData></extension><trID><svTRID>UA-3</svTRID></trID></response></epp>';
    const ri = Response.fromXml(infoXml);
    check('value exDate', ri.value('exDate') === '2027-01-01T00:00:00Z');
    check('statuses ok', JSON.stringify(ri.statuses()) === JSON.stringify(['ok']));
    check('license', ri.license() === 'TM-777');
    check('prices renewal value', ri.prices().renewal && ri.prices().renewal.value === '180.00');
    check('prices renewal currency', ri.prices().renewal.currency === 'UAH');

    const balXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<balance:infData xmlns:balance="http://uaregistry.com/epp/balance-1.0">'
      + '<balance:creditLimit>1000.00</balance:creditLimit><balance:balance>250.50</balance:balance>'
      + '<balance:availableCredit>1250.50</balance:availableCredit></balance:infData></resData>'
      + '<trID><svTRID>UA-4</svTRID></trID></response></epp>';
    const b = Response.fromXml(balXml).balance();
    check('balance creditLimit', b.creditLimit === '1000.00');
    check('balance availableCredit', b.availableCredit === '1250.50');
    check('non-balance response -> balance null', Response.fromXml(OK()).balance() === null);
  }

  console.log('response: secDNS read-back (nested keyData not leaked into keyRecords)');
  {
    const secXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result>'
      + '<extension><secDNS:infData xmlns:secDNS="urn:ietf:params:xml:ns:secDNS-1.1">'
      + '<secDNS:dsData><secDNS:keyTag>12345</secDNS:keyTag><secDNS:alg>13</secDNS:alg>'
      + '<secDNS:digestType>2</secDNS:digestType><secDNS:digest>ABCDEF0123</secDNS:digest>'
      + '<secDNS:keyData><secDNS:flags>256</secDNS:flags><secDNS:protocol>3</secDNS:protocol>'
      + '<secDNS:alg>13</secDNS:alg><secDNS:pubKey>nested</secDNS:pubKey></secDNS:keyData></secDNS:dsData>'
      + '<secDNS:keyData><secDNS:flags>257</secDNS:flags><secDNS:protocol>3</secDNS:protocol>'
      + '<secDNS:alg>13</secDNS:alg><secDNS:pubKey>toplevel</secDNS:pubKey></secDNS:keyData>'
      + '</secDNS:infData></extension><trID><svTRID>UA-5</svTRID></trID></response></epp>';
    const rs = Response.fromXml(secXml);
    check('dsRecords count 1', rs.dsRecords().length === 1);
    check('dsRecords keyTag', rs.dsRecords()[0].keyTag === 12345);
    check('keyRecords only top-level', rs.keyRecords().length === 1 && rs.keyRecords()[0].pubKey === 'toplevel');
    check('isSigned', rs.isSigned() === true);
  }

  console.log('response: poll id/count/text + trStatus + errorReasons');
  {
    const pollXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1301"><msg>ack to dequeue</msg></result>'
      + '<msgQ count="3" id="42"><qDate>2026-07-04T00:00:00Z</qDate><msg lang="uk">Домен x.com.ua продовжено</msg></msgQ>'
      + '<resData><domain:trnData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:name>x.com.ua</domain:name><domain:trStatus>pending</domain:trStatus></domain:trnData></resData>'
      + '<trID><svTRID>UA-6</svTRID></trID></response></epp>';
    const rp = Response.fromXml(pollXml);
    check('poll messageId', rp.messageId() === '42');
    check('poll messageCount', rp.messageCount() === 3);
    check('poll message is the result msg, not the queue msg', rp.message() === 'ack to dequeue');
    check('transferStatus pending', rp.transferStatus() === 'pending');

    const errXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="2306"><msg>policy</msg><extValue><value/><reason>bad NS count</reason></extValue></result>'
      + '<trID><svTRID>UA-7</svTRID></trID></response></epp>';
    const re = Response.fromXml(errXml);
    check('code 2306', re.code() === 2306);
    check('not success', !re.isSuccess());
    check('errorReasons', JSON.stringify(re.errorReasons()) === JSON.stringify(['bad NS count']));
  }

  // ------------------------------------------------------- errors + guards
  console.log('errors: CommandError on >=2000, silenced by throwOnFailure(false)');
  {
    const { client } = makeClient([GREETING, OK(2302, 'exists')]);
    await client.connect();
    let threw = false;
    try {
      await client.domain.create('dup.com.ua', { years: 1, registrant: 'R', contacts: { admin: 'A', tech: 'T' }, nameservers: ['ns1.x.ua'] });
    } catch (e) { threw = e instanceof CommandError && e.eppCode === 2302; }
    check('2302 throws CommandError', threw);
  }
  {
    const { client } = makeClient([GREETING, OK(2303, 'nope')]);
    await client.connect();
    client.throwOnFailure(false);
    const resp = await client.domain.info('missing.com.ua');
    check('throwOnFailure(false) returns response', resp.code() === 2303);
  }

  console.log('errors: login failure throws AuthError');
  {
    const { client } = makeClient([GREETING, OK(2200, 'bad login')]);
    await client.connect();
    let threw = false;
    try { await client.login(); } catch (e) { threw = e instanceof AuthError && e.eppCode === 2200; }
    check('login 2200 throws AuthError', threw);
  }

  console.log('config guards: empty host / password fail fast');
  {
    const c = new Client(new Config({ host: '', clid: 'x', password: 'y' }), new FakeTransport());
    let threw = false;
    try { await c.connect(); } catch (e) { threw = e instanceof ConfigError; }
    check('empty host -> ConfigError', threw);

    const { client, fake } = makeClient([GREETING]);
    await client.connect();
    client._config.password = '';
    let threw2 = false;
    try { await client.login(); } catch (e) { threw2 = e instanceof ConfigError; }
    check('empty password -> ConfigError', threw2);
    check('no login frame sent on config failure', fake.written.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
