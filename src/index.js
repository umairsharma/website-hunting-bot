#!/usr/bin/env node
// Entry point: `node src/index.js` (add `--dry-run` to test without saving or posting to Discord).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './run.js';
import { buildMessages, sendMessages } from './discord.js';
import { applyRunInputs } from './inputs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

let config;
try {
  ({ default: config } = await import(pathToFileURL(path.join(root, 'config.js')).href));
} catch (err) {
  const line = String(err.stack || '').match(/config\.js:(\d+)/);
  const message = `config.js has a mistake${line ? ` near line ${line[1]}` : ''}: ${err.message}`;
  console.error(`❌ ${message}`);
  if (!dryRun && webhookUrl) {
    const text = `🎯 **Website Hunting Bot**\n❌ ${message}\nLook for a missing comma or quote mark.`;
    await sendMessages(webhookUrl, buildMessages(text, []));
  }
  process.exit(1);
}

// City / country / niche typed into the "Run workflow" form (manual runs only).
const { config: runConfig, label } = applyRunInputs(config);
if (label) console.log(`🖐️ ${label}`);
const summary = await run({ config: { ...runConfig, runLabel: label }, dataDir, dryRun, webhookUrl });
process.exitCode = summary.error ? 1 : 0;

// Rechecking earlier leads takes several runs (free search engines allow a few dozen searches each):
// tell the workflow to start the next one while there are leads left and this run got through some.
if (summary.recheckLeft > 0 && summary.checked > 0 && process.env.GITHUB_OUTPUT && !dryRun) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'continue=true\n');
}
