#!/usr/bin/env node
import { selectedProvider } from './provider.mjs';

const { start } = await import(`./providers/${selectedProvider().id}.mjs`);
await start();
