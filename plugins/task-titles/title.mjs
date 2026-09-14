const WRAPPER = /^(?:FIRSTMATE_OP\s*:|v\d+ launch-brief\s*:|you are (?:a|the) (?:crewmate|agent)\b|#\s*(?:AGENTS\.md|INSTRUCTIONS|environment_context)\b)/i;
const BOILERPLATE = /^(?:#\s*(?:Task|Rules|Setup|Definition of done|Firstmate spec|Current worker role contract|Current no-mistakes intent contract|Herdr isolation|Firstmate instruction inbox|Project memory)\b|##?\s*(?:Captain's intent|Captain intent authorized for --intent)\b|[-*]\s*(?:Do not|Never|Run |Use |Report |If you |Keep |Stay ))/i;
const TASK_VERB = /^(?:please\s+)?(?:can you\s+|could you\s+|i want (?:you to\s+)?|help me\s+)?(build|implement|create|add|fix|repair|debug|improve|update|refactor|remove|replace|migrate|design|write|make|investigate|test|ship|integrate|support|extract|rename|simplify|audit)\b/i;
const STOP = new Set(['a', 'an', 'the', 'for', 'in', 'on', 'of', 'to', 'with', 'and', 'or', 'from', 'using', 'that', 'which', 'after', 'before', 'by']);

function cleanLine(value) {
    return value.replace(/^[\s>*-]+/, '').replace(/[`*_\[\]{}]/g, '').replace(/\s+/g, ' ').trim();
}

function titleFromSentence(sentence) {
    const artifact = sentence.match(/\b(?:the\s+)?(?:first-class\s+)?([\p{L}\p{N}-]+(?:\s+[\p{L}\p{N}-]+){0,2}\s+(?:plugin|screen|page|flow|feature|bug))\b/iu);
    if (artifact && /^(?:build|implement|create|add|fix|repair|improve|update|design)\b/i.test(sentence)) {
        const verb = /^(\p{L}+)/u.exec(sentence)?.[1] ?? 'Build';
        const phrase = artifact[1].replace(/^(?:the|a|an|backend|frontend|first-class)\s+/i, '');
        const direct = `${verb} ${phrase}`;
        if (direct.length <= 60 && (direct.match(/\S+/g)?.length ?? 0) <= 6) return direct.charAt(0).toLocaleUpperCase() + direct.slice(1);
    }
    const words = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’+.-]*/gu) ?? [];
    if (words.length < 3) return undefined;
    const selected = words.slice(0, 6);
    while (selected.length > 2 && STOP.has(selected.at(-1).toLowerCase())) selected.pop();
    if (selected.length < 2) return undefined;
    const result = selected.join(' ').replace(/[-–—]$/u, '').trim();
    if (result.length > 60 || /\bpp_[a-z0-9]+\b|\bp:[a-z0-9]+\b/i.test(result)) return undefined;
    return result.charAt(0).toLocaleUpperCase() + result.slice(1);
}

/** Bounded, deterministic extraction. Unclear prose is rejected rather than slugged. */
export function titleCandidate(sample) {
    if (typeof sample !== 'string' || sample.trim() === '') return { confidence: 'ambiguous', reason: 'No task prompt yet.' };
    const text = sample.slice(0, 8192);
    const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
    let inCaptainIntent = false;
    const candidates = [];
    for (const line of lines) {
        if (/^#{1,3}\s*Captain(?:'s)? intent\b/i.test(line)) { inCaptainIntent = true; continue; }
        if (/^#{1,3}\s/.test(line) && !/^#{1,3}\s*Captain(?:'s)? intent\b/i.test(line)) inCaptainIntent = false;
        if (WRAPPER.test(line) || BOILERPLATE.test(line) || /^\[[^\]]+\]\s*$/.test(line)) continue;
        const sentence = line.replace(/^#+\s*/, '').split(/[.!?](?:\s|$)/u)[0]?.trim() ?? '';
        const match = TASK_VERB.exec(sentence);
        if (match) candidates.push({ sentence: sentence.slice(match[0].length - match[1].length), priority: inCaptainIntent ? 2 : 1 });
    }
    candidates.sort((a, b) => b.priority - a.priority);
    const title = candidates.map(({ sentence }) => titleFromSentence(sentence)).find(Boolean);
    return title ? { title, confidence: 'clear task', source: 'first task prompt' }
        : { confidence: 'ambiguous', reason: 'No clear task request in this prompt.' };
}

function textBlocks(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.filter((item) => item?.type === 'text' || item?.type === 'input_text')
        .map((item) => item.text).filter((text) => typeof text === 'string').join('\n');
}

/** Read only user messages; never infer from terminal output or tool messages. */
export function firstUserPrompt(kind, jsonl) {
    for (const line of jsonl.split('\n')) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        let prompt = '';
        if (kind === 'codex' && row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
            prompt = textBlocks(row.payload.content);
        } else if (kind === 'claude' && row.type === 'user' && row.isMeta !== true) {
            prompt = textBlocks(row.message?.content);
        } else if (kind === 'pi' && row.type === 'message' && row.message?.role === 'user') {
            prompt = textBlocks(row.message.content);
        }
        if (!prompt || /^(?:# AGENTS\.md|<INSTRUCTIONS>|<user_instructions>|<environment_context>|<command-|<local-command)/.test(prompt.trim())) continue;
        if (!titleCandidate(prompt).title) continue;
        return prompt;
    }
    return undefined;
}
