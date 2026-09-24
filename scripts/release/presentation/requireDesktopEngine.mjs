import { desktopHostOfSource, requireDesktopEngine } from '../application/requireDesktopEngine.mjs';

const version = desktopHostOfSource();
const engines = requireDesktopEngine(version);
process.stdout.write(`@desklink/host@${version} and ${engines.join(', ')} are on npm.\n`);
