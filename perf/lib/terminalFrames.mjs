import { StringDecoder } from 'node:string_decoder';

export function countTerminalFrames(onFrame) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    return (chunk) => {
        pending += decoder.write(Buffer.from(chunk));
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            if (JSON.parse(line).type === 'terminal.frame') onFrame();
        }
    };
}
