#!/usr/bin/env node
import { handleStatus } from './runtime.mjs';

let event;
try { event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? 'null'); } catch { event = null; }
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
if (event && configDir) await handleStatus({ event, configDir });
