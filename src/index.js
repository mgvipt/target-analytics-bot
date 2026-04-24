import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createMetaClient } from './meta-api.js';
import { campaignTools, handleCampaignTool } from './tools/campaigns.js';
import { adsetTools, handleAdsetTool } from './tools/adsets.js';
import { adTools, handleAdTool } from './tools/ads.js';
import { insightTools, handleInsightTool } from './tools/insights.js';
import { contentTools, handleContentTool } from './tools/content.js';

// Load .env if present
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envPath = resolve(__dirname, '../.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env not found, use existing env vars
}

const config = {
  accessToken: process.env.META_ACCESS_TOKEN,
  adAccountId: process.env.META_AD_ACCOUNT_ID,
  pageId: process.env.META_PAGE_ID,
  igAccountId: process.env.META_IG_ACCOUNT_ID,
  apiVersion: process.env.META_API_VERSION || 'v21.0',
};

if (!config.accessToken || !config.adAccountId) {
  process.stderr.write('ERROR: META_ACCESS_TOKEN and META_AD_ACCOUNT_ID are required.\n');
  process.stderr.write('Copy .env.example to .env and fill in your credentials.\n');
  process.exit(1);
}

const api = createMetaClient(config);

const ALL_TOOLS = [
  ...campaignTools,
  ...adsetTools,
  ...adTools,
  ...insightTools,
  ...contentTools,
];

const CAMPAIGN_TOOL_NAMES = new Set(campaignTools.map(t => t.name));
const ADSET_TOOL_NAMES = new Set(adsetTools.map(t => t.name));
const AD_TOOL_NAMES = new Set(adTools.map(t => t.name));
const INSIGHT_TOOL_NAMES = new Set(insightTools.map(t => t.name));
const CONTENT_TOOL_NAMES = new Set(contentTools.map(t => t.name));

const server = new Server(
  { name: 'meta-ads-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (CAMPAIGN_TOOL_NAMES.has(name)) return await handleCampaignTool(name, args, api);
    if (ADSET_TOOL_NAMES.has(name)) return await handleAdsetTool(name, args, api);
    if (AD_TOOL_NAMES.has(name)) return await handleAdTool(name, args, api);
    if (INSIGHT_TOOL_NAMES.has(name)) return await handleInsightTool(name, args, api);
    if (CONTENT_TOOL_NAMES.has(name)) return await handleContentTool(name, args, api);

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (err) {
    const message = err?.response?.data
      ? JSON.stringify(err.response.data, null, 2)
      : err.message;
    return {
      content: [{ type: 'text', text: `Error in ${name}:\n${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('Meta Ads MCP server started.\n');
