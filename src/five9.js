// Five9 SOAP client — Configuration (admin) + Statistics (supervisor) Web Services.
// Zero dependencies: envelopes are built as strings, responses parsed with a
// minimal well-formed-XML parser (Workers have no DOMParser).

const NS = {
  admin: 'http://service.admin.ws.five9.com/',
  supervisor: 'http://service.supervisor.ws.five9.com/',
};

export function escapeXml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Parses well-formed XML into plain objects. Namespaces and attributes are
// dropped; repeated sibling elements become arrays; leaf elements become
// decoded strings. SOAP responses are regular enough that this is all we need.
export function parseXml(xml) {
  xml = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

  const root = { children: {}, text: '' };
  const stack = [root];
  const re = /<([^>]+)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      const tag = m[1].trim();
      if (tag.startsWith('/')) { if (stack.length > 1) stack.pop(); continue; }
      const selfClosing = tag.endsWith('/');
      const name = tag.replace(/\/$/, '').split(/[\s/]/)[0].replace(/^.*:/, '');
      const node = { children: {}, text: '' };
      const parent = stack[stack.length - 1];
      const existing = parent.children[name];
      if (existing === undefined) parent.children[name] = node;
      else if (Array.isArray(existing)) existing.push(node);
      else parent.children[name] = [existing, node];
      if (!selfClosing) stack.push(node);
    } else if (m[2].trim()) {
      stack[stack.length - 1].text += m[2];
    }
  }
  return simplify(root);
}

function simplify(node) {
  const keys = Object.keys(node.children);
  if (!keys.length) return decodeEntities(node.text.trim());
  const out = {};
  for (const k of keys) {
    const v = node.children[k];
    out[k] = Array.isArray(v) ? v.map(simplify) : simplify(v);
  }
  return out;
}

export function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

export class Five9Error extends Error {}

export class Five9Client {
  constructor(env) {
    if (!env.FIVE9_USERNAME || !env.FIVE9_PASSWORD) {
      throw new Five9Error('FIVE9_USERNAME / FIVE9_PASSWORD secrets are not configured on this Worker.');
    }
    this.auth = 'Basic ' + btoa(`${env.FIVE9_USERNAME}:${env.FIVE9_PASSWORD}`);
    this.host = env.FIVE9_API_HOST || 'api.five9.com';
    this.adminVersion = env.FIVE9_ADMIN_VERSION || 'v13';
    this.supervisorVersion = env.FIVE9_SUPERVISOR_VERSION || 'v13';
  }

  async soap(service, method, innerXml = '') {
    const isAdmin = service === 'admin';
    const url = isAdmin
      ? `https://${this.host}/wsadmin/${this.adminVersion}/AdminWebService`
      : `https://${this.host}/wssupervisor/${this.supervisorVersion}/SupervisorWebService`;
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="${NS[service]}">` +
      `<soapenv:Header/><soapenv:Body><ser:${method}>${innerXml}</ser:${method}></soapenv:Body></soapenv:Envelope>`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '', Authorization: this.auth },
      body: envelope,
    });
    const text = await res.text();

    let parsed;
    try { parsed = parseXml(text); } catch { parsed = null; }
    const body = parsed?.Envelope?.Body;

    const fault = body?.Fault;
    if (fault) {
      throw new Five9Error(`Five9 SOAP fault on ${method}: ${fault.faultstring || JSON.stringify(fault)}`);
    }
    if (!res.ok) {
      throw new Five9Error(`Five9 HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);
    }
    if (!body) {
      throw new Five9Error(`Unexpected Five9 response on ${method}: ${text.slice(0, 300)}`);
    }
    const response = body[`${method}Response`];
    return response === undefined ? body : response;
  }

  admin(method, innerXml) { return this.soap('admin', method, innerXml); }
  supervisor(method, innerXml) { return this.soap('supervisor', method, innerXml); }

  // ---- Config (admin) API ----

  async getCampaigns(pattern = '.*') {
    const r = await this.admin('getCampaigns', `<campaignNamePattern>${escapeXml(pattern)}</campaignNamePattern>`);
    return toArray(r.return);
  }

  async controlCampaign(action, campaignName) {
    const methods = { start: 'startCampaign', stop: 'stopCampaign', reset: 'resetCampaign' };
    const method = methods[action];
    if (!method) throw new Five9Error(`Unknown campaign action "${action}" — use start, stop, or reset.`);
    await this.admin(method, `<campaignName>${escapeXml(campaignName)}</campaignName>`);
    return { ok: true, action, campaign: campaignName };
  }

  async getLists(pattern = '.*') {
    const r = await this.admin('getListsInfo', `<listNamePattern>${escapeXml(pattern)}</listNamePattern>`);
    return toArray(r.return);
  }

  // Adds a single record to a dialing list via addToListCsv (async import on
  // the Five9 side — returns an import identifier, not a synchronous result).
  async addRecordToList(listName, fields, keyField) {
    const names = Object.keys(fields || {});
    if (!names.length) throw new Five9Error('fields must contain at least one field (e.g. {"number1": "5551234567"}).');
    const key = keyField || (names.includes('number1') ? 'number1' : names[0]);
    const mappings = names.map((n, i) =>
      `<fieldsMapping><columnNumber>${i + 1}</columnNumber><fieldName>${escapeXml(n)}</fieldName>` +
      `<key>${n === key}</key></fieldsMapping>`).join('');
    const csvLine = names.map((n) => {
      const v = String(fields[n] ?? '');
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',');
    const r = await this.admin('addToListCsv',
      `<listName>${escapeXml(listName)}</listName>` +
      `<listUpdateSettings>${mappings}<separator>,</separator><skipHeaderLine>false</skipHeaderLine></listUpdateSettings>` +
      `<csvData>${escapeXml(csvLine)}</csvData>`);
    return { submitted: true, list: listName, keyField: key, importIdentifier: r.return ?? null,
      note: 'Five9 processes list imports asynchronously; the record may take a moment to appear.' };
  }

  async searchContacts(criteria) {
    const entries = Object.entries(criteria || {});
    if (!entries.length) throw new Five9Error('criteria must contain at least one field (e.g. {"number1": "5551234567"}).');
    const crit = entries.map(([f, v]) =>
      `<criteria><field>${escapeXml(f)}</field><value>${escapeXml(v)}</value></criteria>`).join('');
    const r = await this.admin('getContactRecords', `<lookupCriteria>${crit}</lookupCriteria>`);
    const ret = r.return || {};
    const fields = toArray(ret.fields);
    const records = toArray(ret.records).map((rec) => {
      const values = toArray(rec.values);
      const obj = {};
      fields.forEach((f, i) => { obj[f] = values[i] ?? ''; });
      return obj;
    });
    return { fields, count: records.length, records };
  }

  async getUsers(pattern = '.*') {
    const r = await this.admin('getUsersGeneralInfo', `<userNamePattern>${escapeXml(pattern)}</userNamePattern>`);
    return toArray(r.return);
  }

  async getSkills(pattern = '.*') {
    const r = await this.admin('getSkills', `<skillNamePattern>${escapeXml(pattern)}</skillNamePattern>`);
    return toArray(r.return);
  }

  async getDispositions(pattern = '.*') {
    const r = await this.admin('getDispositions', `<dispositionNamePattern>${escapeXml(pattern)}</dispositionNamePattern>`);
    return toArray(r.return);
  }

  async runReport(folderName, reportName, start, end) {
    // JAXB-generated schema orders ReportTimeCriteria children as <end>, <start>.
    const criteria = start && end
      ? `<criteria><time><end>${escapeXml(end)}</end><start>${escapeXml(start)}</start></time></criteria>`
      : '';
    const r = await this.admin('runReport',
      `<folderName>${escapeXml(folderName)}</folderName><reportName>${escapeXml(reportName)}</reportName>${criteria}`);
    return { identifier: r.return, note: 'Poll get_report_result with this identifier until the CSV is ready.' };
  }

  async getReportResult(identifier) {
    const running = await this.admin('isReportRunning',
      `<identifier>${escapeXml(identifier)}</identifier><timeout>5</timeout>`);
    if (String(running.return) === 'true') {
      return { ready: false, note: 'Report is still running — call get_report_result again shortly.' };
    }
    const r = await this.admin('getReportResultCsv', `<identifier>${escapeXml(identifier)}</identifier>`);
    return { ready: true, csv: r.return ?? '' };
  }

  // ---- Statistics (supervisor) API ----

  async getRealtimeStats(statisticType) {
    await this.supervisor('setSessionParameters',
      `<viewSettings><forceLogoutSession>true</forceLogoutSession><rollingPeriod>Minutes30</rollingPeriod>` +
      `<statisticsRange>CurrentDay</statisticsRange><shiftStart>0</shiftStart><timeZone>0</timeZone></viewSettings>`);
    const r = await this.supervisor('getStatistics', `<statisticType>${escapeXml(statisticType)}</statisticType>`);
    const ret = r.return || {};
    const columns = toArray(ret.columns?.values?.data);
    const rows = toArray(ret.rows).map((row) => {
      const values = toArray(row.values?.data);
      const obj = {};
      columns.forEach((c, i) => { obj[c] = values[i] ?? ''; });
      return obj;
    });
    return { statisticType, timestamp: ret.timestamp ?? null, columns, count: rows.length, rows };
  }
}
