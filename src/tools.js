// MCP tool definitions + dispatch. Each tool maps to one or two Five9 SOAP
// calls and returns plain JSON for the model.

import { Five9Client } from './five9.js';

export const TOOLS = [
  {
    name: 'check_connection',
    description: 'Verify that the Worker can authenticate to Five9. Returns the number of skills visible to the configured user. Run this first if other tools are failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (f9) => {
      const skills = await f9.getSkills('.*');
      return { ok: true, host: f9.host, adminVersion: f9.adminVersion, skillsVisible: skills.length };
    },
  },
  {
    name: 'list_campaigns',
    description: 'List Five9 campaigns (name, type, state, mode). Optional regex pattern filters by campaign name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on campaign name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getCampaigns(a.pattern || '.*'),
  },
  {
    name: 'control_campaign',
    description: 'Start, stop, or reset a Five9 campaign by exact name. Stopping a campaign halts dialing for it; reset re-enables dialed records.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'reset'] },
        campaign_name: { type: 'string', description: 'Exact campaign name' },
      },
      required: ['action', 'campaign_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.controlCampaign(a.action, a.campaign_name),
  },
  {
    name: 'list_dialing_lists',
    description: 'List Five9 outbound dialing lists with their record counts. Optional regex pattern filters by list name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on list name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getLists(a.pattern || '.*'),
  },
  {
    name: 'add_record_to_list',
    description: 'Add one record (lead) to a Five9 dialing list. "fields" maps Five9 contact field names to values, e.g. {"number1": "5551234567", "first_name": "Jane", "last_name": "Doe"}. number1 is the primary phone field. The import is processed asynchronously by Five9.',
    inputSchema: {
      type: 'object',
      properties: {
        list_name: { type: 'string', description: 'Exact dialing list name' },
        fields: {
          type: 'object',
          description: 'Contact field name → value. Must include at least one field; number1 is the standard primary phone field.',
          additionalProperties: { type: 'string' },
        },
        key_field: { type: 'string', description: 'Field used to match existing contacts (default: number1)' },
      },
      required: ['list_name', 'fields'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.addRecordToList(a.list_name, a.fields, a.key_field),
  },
  {
    name: 'search_contacts',
    description: 'Look up contact records in the Five9 CRM by exact field values, e.g. {"number1": "5551234567"} or {"last_name": "Doe"}. Returns matching records as field→value objects.',
    inputSchema: {
      type: 'object',
      properties: {
        criteria: {
          type: 'object',
          description: 'Contact field name → exact value to match. At least one entry required.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['criteria'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.searchContacts(a.criteria),
  },
  {
    name: 'list_users',
    description: 'List Five9 users (agents, supervisors, admins) with their general info. Optional regex pattern filters by username.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on username (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getUsers(a.pattern || '.*'),
  },
  {
    name: 'list_skills',
    description: 'List Five9 skills (routing queues). Optional regex pattern filters by skill name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on skill name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getSkills(a.pattern || '.*'),
  },
  {
    name: 'list_dispositions',
    description: 'List Five9 call dispositions and their settings. Optional regex pattern filters by disposition name.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'Java-style regex on disposition name (default ".*" = all)' } },
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getDispositions(a.pattern || '.*'),
  },
  {
    name: 'run_report',
    description: 'Start a Five9 report run by folder and report name (as shown in the Five9 reporting UI, e.g. folder "Call Log Reports", report "Call Log"). Returns an identifier to poll with get_report_result. Optional ISO-8601 start/end narrow the time range.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_name: { type: 'string', description: 'Report folder name in Five9' },
        report_name: { type: 'string', description: 'Report name within the folder' },
        start: { type: 'string', description: 'ISO-8601 start time, e.g. 2026-07-21T00:00:00.000Z (requires end)' },
        end: { type: 'string', description: 'ISO-8601 end time (requires start)' },
      },
      required: ['folder_name', 'report_name'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.runReport(a.folder_name, a.report_name, a.start, a.end),
  },
  {
    name: 'get_report_result',
    description: 'Fetch the result of a report started with run_report. Returns {ready: false} while Five9 is still generating it; when ready, returns the report as CSV text.',
    inputSchema: {
      type: 'object',
      properties: { identifier: { type: 'string', description: 'Identifier returned by run_report' } },
      required: ['identifier'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getReportResult(a.identifier),
  },
  {
    name: 'get_realtime_stats',
    description: 'Get real-time contact center statistics from the Five9 Statistics API. statistic_type picks the view: AgentState (who is on a call / ready / not ready right now), ACDStatus (queue depth and wait times per skill), CampaignState, InboundCampaignStatistics, OutboundCampaignStatistics, AgentStatistics (per-agent daily performance).',
    inputSchema: {
      type: 'object',
      properties: {
        statistic_type: {
          type: 'string',
          enum: ['AgentState', 'ACDStatus', 'CampaignState', 'InboundCampaignStatistics', 'OutboundCampaignStatistics', 'AgentStatistics'],
        },
      },
      required: ['statistic_type'],
      additionalProperties: false,
    },
    handler: (f9, a) => f9.getRealtimeStats(a.statistic_type),
  },
];

export function toolDefs() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(env, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const f9 = new Five9Client(env);
  return tool.handler(f9, args || {});
}
