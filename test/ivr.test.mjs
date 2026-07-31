// IVR composer/validator/renderer + TTS audio pipeline tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { validateFlow, collectFlowRefs, composeIvrXml, flowToMermaid, scriptXmlToMermaid, speakXml, gzipBase64 } from '../src/ivr.js';
import { pcm24kToUlaw8k, ulawToWav, bytesToBase64 } from '../src/tts.js';
import { parseXml, toArray } from '../src/five9.js';

// A representative flow: greeting -> hours check -> menu -> transfers/voicemail.
const dentalFlow = {
  entry: 'greeting',
  nodes: {
    greeting: { type: 'play', prompt: { tts: 'Thanks for calling Bright Smile Dental.' }, next: 'hours' },
    hours: { type: 'hours', days: ['MON', 'TUE', 'WED', 'THU', 'FRI'], open: '08:00', close: '17:00', during_hours: 'main_menu', after_hours: 'after_hours_menu' },
    main_menu: {
      type: 'menu',
      prompt: { tts: 'Press 1 for scheduling, 2 for billing, 3 for emergencies.' },
      options: [
        { digit: 1, label: 'Scheduling', next: 'sched_xfer' },
        { digit: 2, label: 'Billing', next: 'billing_xfer' },
        { digit: 3, label: 'Emergency', next: 'emergency_xfer' },
      ],
    },
    after_hours_menu: {
      type: 'menu',
      prompt: { tts: 'We are closed. Press 3 for emergencies, or any other key to leave a message.' },
      options: [
        { digit: 3, label: 'Emergency', next: 'emergency_xfer' },
        { digit: 1, label: 'Voicemail', next: 'vm' },
      ],
    },
    sched_xfer: { type: 'skill_transfer', skills: ['Scheduling'], next: 'vm' },
    billing_xfer: { type: 'skill_transfer', skills: ['Billing'], next: 'vm' },
    emergency_xfer: { type: 'skill_transfer', skills: ['OnCall'], next: 'vm' },
    vm: { type: 'voicemail', skill: 'Scheduling' },
    bye: { type: 'hangup' },
  },
};

const resolvedFor = (flow) => {
  const refs = collectFlowRefs(flow);
  const skills = new Map(refs.skills.map((s, i) => [s.toLowerCase(), { id: 100 + i, name: s }]));
  const prompts = new Map(refs.prompts.map((p, i) => [p.toLowerCase(), { id: 200 + i, name: p }]));
  return { skills, prompts };
};

test('validateFlow accepts a sound flow (with an unreachable-node warning)', () => {
  const r = validateFlow(dentalFlow);
  assert.equal(r.ok, true, r.errors.join(' | '));
  assert.ok(r.warnings.some((w) => w.includes('bye')), 'expected unreachable warning for "bye"');
});

test('validateFlow catches broken graphs', () => {
  const badTarget = validateFlow({ entry: 'a', nodes: { a: { type: 'play', prompt: { tts: 'x' }, next: 'nope' } } });
  assert.equal(badTarget.ok, false);
  assert.ok(badTarget.errors.some((e) => e.includes('"nope"')));

  const dupDigit = validateFlow({
    entry: 'm',
    nodes: {
      m: { type: 'menu', prompt: { tts: 'x' }, options: [{ digit: 1, label: 'A', next: 'h' }, { digit: 1, label: 'B', next: 'h' }] },
      h: { type: 'hangup' },
    },
  });
  assert.equal(dupDigit.ok, false);
  assert.ok(dupDigit.errors.some((e) => e.includes('digit 1')));

  const splitDays = validateFlow({
    entry: 'h',
    nodes: {
      h: { type: 'hours', days: ['SAT', 'SUN'], open: '08:00', close: '17:00', during_hours: 'x', after_hours: 'x' },
      x: { type: 'hangup' },
    },
  });
  assert.equal(splitDays.ok, false, 'SAT+SUN wraps the week boundary and must be rejected');

  const reserved = validateFlow({
    entry: 'm',
    nodes: {
      m: { type: 'menu', prompt: { tts: 'x' }, options: [{ digit: 1, label: 'No Match', next: 'h' }] },
      h: { type: 'hangup' },
    },
  });
  assert.equal(reserved.ok, false);
});

test('collectFlowRefs finds every skill and prompt name', () => {
  const refs = collectFlowRefs(dentalFlow);
  assert.deepEqual(refs.skills.sort(), ['Billing', 'OnCall', 'Scheduling']);
  assert.deepEqual(refs.prompts, []);
});

test('composeIvrXml emits parseable designer-shaped XML', async () => {
  const { xml, moduleCount } = await composeIvrXml(dentalFlow, resolvedFor(dentalFlow));
  const doc = parseXml(xml);
  const modules = doc.ivrScript.modules;
  assert.ok(modules.incomingCall, 'incomingCall module missing');
  assert.equal(toArray(modules.menu).length, 2);
  assert.equal(toArray(modules.skillTransfer).length, 3);
  assert.ok(modules.voiceMailTransfer);
  assert.ok(modules.hangup, 'explicit hangup node missing');
  assert.ok(doc.ivrScript.modulesOnHangup.startOnHangup, 'on-hangup lane missing');
  assert.equal(moduleCount, 12); // incoming + 9 nodes + the on-hangup pair

  // Wiring: incomingCall points at the greeting play module.
  const play = toArray(modules.play)[0];
  assert.equal(modules.incomingCall.singleDescendant, play.moduleId);

  // Menus keep a No Match branch looping back to themselves.
  for (const menu of toArray(modules.menu)) {
    const noMatch = toArray(menu.data.branches.entry).find((e) => e.key === 'No Match');
    assert.equal(noMatch.value.desc, menu.moduleId);
    assert.ok(toArray(menu.ascendants).includes(menu.moduleId), 'menu must list itself as ascendant for the No Match loop');
  }

  // Explicit DTMF digits from the spec.
  const mainMenu = toArray(modules.menu).find((m) => m.moduleName.includes('main'));
  assert.deepEqual(toArray(mainMenu.data.items).map((i) => i.dtmf), ['DTMF_1', 'DTMF_2', 'DTMF_3']);

  // Skill ids resolved from the domain map.
  const st = toArray(modules.skillTransfer)[0];
  assert.match(String(st.data.listOfSkillsEx.extrnalObj.id), /^10\d$/);

  // Hours ifElse: weekday window MON(2)..FRI(6), 08:00 (480) .. 17:00 (1020).
  const ifElse = modules.ifElse;
  const conds = toArray(ifElse.data.conditions);
  assert.equal(conds.length, 4);
  assert.equal(conds[0].rightOperand.integerValue.value, '1'); // MORE_THAN 1 = day >= 2
  assert.equal(conds[1].rightOperand.integerValue.value, '7'); // LESS_THAN 7 = day <= 6
  assert.equal(conds[2].rightOperand.timeValue.minutes, '479'); // MORE_THAN 479 = time >= 480
  assert.equal(conds[3].rightOperand.timeValue.minutes, '1020'); // LESS_THAN 1020
});

test('inline TTS prompts round-trip through gzip to a speakElement', async () => {
  const { xml } = await composeIvrXml(dentalFlow, resolvedFor(dentalFlow));
  const doc = parseXml(xml);
  const play = toArray(doc.ivrScript.modules.play)[0];
  const blob = play.data.prompt.ttsPrompt.xml;
  const inner = gunzipSync(Buffer.from(blob, 'base64')).toString('utf8');
  assert.ok(inner.includes('<speakElement>'));
  assert.ok(inner.includes('Bright Smile Dental'));
});

test('file prompts resolve to domain prompt ids', async () => {
  const flow = {
    entry: 'p',
    nodes: {
      p: { type: 'play', prompt: { prompt_name: 'MainGreeting' }, next: 'h' },
      h: { type: 'hangup' },
    },
  };
  const { xml } = await composeIvrXml(flow, { skills: new Map(), prompts: new Map([['maingreeting', { id: 42, name: 'MainGreeting' }]]) });
  const doc = parseXml(xml);
  const fp = doc.ivrScript.modules.play.data.prompt.filePrompt.promptData.prompt;
  assert.equal(fp.id, '42');
  assert.equal(fp.name, 'MainGreeting');

  await assert.rejects(
    () => composeIvrXml(flow, { skills: new Map(), prompts: new Map() }),
    /Prompts not found/,
  );
});

test('speakXml escapes prompt text', () => {
  const xml = speakXml('Press 1 & say "hi" <now>');
  assert.ok(xml.includes('Press 1 &amp; say &quot;hi&quot; &lt;now&gt;'));
});

test('gzipBase64 output gunzips back to the input', async () => {
  const blob = await gzipBase64('hello five9');
  assert.equal(gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'), 'hello five9');
});

test('flowToMermaid draws nodes and labeled edges', () => {
  const mermaid = flowToMermaid(dentalFlow);
  assert.ok(mermaid.startsWith('flowchart TD'));
  assert.ok(mermaid.includes('1: Scheduling'));
  assert.ok(mermaid.includes('open'));
  assert.ok(mermaid.includes('queue timeout'));
});

test('scriptXmlToMermaid renders modules from real designer XML', () => {
  const xml = '<?xml version="1.0"?><ivrScript><modules>' +
    '<incomingCall><singleDescendant>BBB</singleDescendant><moduleName>IncomingCall1</moduleName><locationX>1</locationX><locationY>1</locationY><moduleId>AAA</moduleId><data/></incomingCall>' +
    '<menu><ascendants>AAA</ascendants><moduleName>MainMenu</moduleName><locationX>1</locationX><locationY>1</locationY><moduleId>BBB</moduleId>' +
    '<data><branches><entry><key>Sales</key><value><name>Sales</name><desc>CCC</desc></value></entry></branches></data></menu>' +
    '<hangup><ascendants>BBB</ascendants><moduleName>Bye</moduleName><locationX>1</locationX><locationY>1</locationY><moduleId>CCC</moduleId><data/></hangup>' +
    '</modules></ivrScript>';
  const mermaid = scriptXmlToMermaid(xml);
  assert.ok(mermaid.includes('MainMenu'));
  assert.ok(mermaid.includes('|"Sales"|'));
});

test('pcm24kToUlaw8k decimates 3:1 and encodes silence as 0xFF', () => {
  const pcm = new Uint8Array(2 * 300); // 300 zero samples at 24k
  const ulaw = pcm24kToUlaw8k(pcm);
  assert.equal(ulaw.length, 100);
  assert.ok([...ulaw].every((b) => b === 0xff), 'u-law encoded silence must be 0xFF');
});

test('ulawToWav writes a G.711 u-law WAV header', () => {
  const wav = ulawToWav(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE');
  assert.equal(v.getUint16(20, true), 7, 'format tag must be WAVE_FORMAT_MULAW');
  assert.equal(v.getUint32(24, true), 8000, 'sample rate must be 8kHz');
  assert.equal(v.getUint16(34, true), 8, 'bits per sample must be 8');
  assert.equal(String.fromCharCode(...wav.subarray(38, 42)), 'fact');
  assert.equal(String.fromCharCode(...wav.subarray(50, 54)), 'data');
  assert.equal(v.getUint32(54, true), 4);
});

test('bytesToBase64 handles large buffers', () => {
  const big = new Uint8Array(70000).fill(65);
  const b64 = bytesToBase64(big);
  assert.equal(Buffer.from(b64, 'base64').length, 70000);
});
