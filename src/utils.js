import { getCurrentLocale } from '../../../../i18n.js';

/**
 * 서버의 sanitize-filename 과 같은 규칙으로 채팅 이름을 정리한다.
 * 서버는 저장할 때 `${이름}.jsonl` 을 이 규칙으로 바꾸므로, 클라이언트가 미리 맞춰 두지 않으면
 * 화면의 이름과 실제 파일 이름이 어긋난다.
 * @param {string} name
 * @returns {string} 정리된 이름. 쓸 수 있는 글자가 없으면 빈 문자열
 */
export function sanitizeChatName(name) {
    let result = String(name ?? '')
        .replace(/[/?<>\\:*|"]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x80-\x9f]/g, '')
        .trim()
        .replace(/[. ]+$/, '');

    if (/^\.+$/.test(result)) return '';
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(result)) return '';

    // 파일 이름 전체(이름 + .jsonl)가 255바이트를 넘으면 서버가 잘라 버린다
    const encoder = new TextEncoder();
    const maxBytes = 255 - '.jsonl'.length;
    while (encoder.encode(result).length > maxBytes) {
        result = [...result].slice(0, -1).join('');
    }
    return result.replace(/[. ]+$/, '');
}

/**
 * 같은 이름이 목록에 있는지. Windows 등 대소문자를 구분하지 않는 파일 시스템도 있어서 대소문자를 무시한다.
 * @param {string} name 정리된 이름
 * @param {string[]} names
 */
export function hasName(name, names) {
    const target = name.toLocaleLowerCase();
    return names.some(other => String(other).toLocaleLowerCase() === target);
}

/**
 * 미리보기용 평문. 채팅 메시지는 마크다운과 HTML 이 섞여 있어 그대로 보이면
 * `*웃는다*`, `<div …>` 같은 기호가 내용을 가린다. 표시용으로만 걷어내고 원본은 건드리지 않는다.
 *
 * HTML 은 DOMParser 로 글자만 꺼낸다(만든 문서는 화면에 붙지 않아 스크립트·이미지가 실행·로드되지 않는다).
 * @param {string} text
 * @returns {string} 한 줄로 합친 글자
 */
export function toPlainPreview(text) {
    if (!text) return '';
    let plain = String(text)
        // 생각(추론) 블록과 코드 블록 표시는 미리보기에 필요 없다
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
        .replace(/```[^\n]*\n?/g, '')
        // 이미지 ![설명](주소) 는 빼고, 링크 [글자](주소) 는 글자만
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<br\s*\/?>/gi, '\n');

    if (/<[a-z!/][^>]*>/i.test(plain)) {
        plain = new DOMParser().parseFromString(plain, 'text/html').body.textContent ?? '';
    }

    return plain
        // 줄 앞의 제목 #, 인용 >, 목록 기호
        .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gm, '')
        // 강조 기호(*, _, ~~, `) — 낱자 하나짜리 * 나 _ 도 대화체 서술 표시라 모두 뺀다
        .replace(/\*+|~~|`+/g, '')
        .replace(/(^|[\s(])_+|_+(?=[\s).,!?]|$)/gm, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 검색 낱말을 찾는 정규식(대소문자 무시). 낱말이 없으면 null
 * @param {string[]} words
 */
function wordsPattern(words) {
    const parts = words.filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // 긴 낱말부터: 'sera seraphina' 면 seraphina 전체를 한 번에 표시
    parts.sort((a, b) => b.length - a.length);
    return parts.length ? new RegExp(parts.join('|'), 'giu') : null;
}

/**
 * 찾은 글자를 <mark> 로 감싼 노드들. 사용자 데이터라 글자는 텍스트 노드로만 넣는다.
 * @param {string} text
 * @param {string[]} words
 * @returns {(string | HTMLElement)[]}
 */
export function highlightText(text, words) {
    const pattern = wordsPattern(words);
    if (!pattern || !text) return [text];

    /** @type {(string | HTMLElement)[]} */
    const nodes = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (index > last) nodes.push(text.slice(last, index));
        const mark = document.createElement('mark');
        mark.className = 'st-lobby-mark';
        mark.textContent = match[0];
        nodes.push(mark);
        last = index + match[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
}

/**
 * 찾은 글자가 앞쪽에 보이도록 자른 미리보기. 앞에 조금(before 글자) 남기고 '…'를 붙인다.
 * @param {string} text
 * @param {string[]} words
 * @param {number} [before]
 */
export function snippetAround(text, words, before = 20) {
    const pattern = wordsPattern(words);
    if (!pattern) return text;
    const index = text.search(new RegExp(pattern.source, 'iu'));
    if (index <= before) return text;
    // 잘린 낱말로 시작하지 않게, 찾은 글자 앞의 첫 띄어쓰기 다음부터. 띄어쓰기가 없으면 그냥 자른다
    let start = index - before;
    const space = text.slice(start, index).search(/\s/);
    if (space !== -1) start += space + 1;
    return `…${text.slice(start)}`;
}

/** @param {number} n */
const pad = n => String(n).padStart(2, '0');

/** @param {Date} date */
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * 목록 줄에 보일 짧은 날짜. 오늘이면 시각만, 올해면 월-일 시각, 그 전이면 연-월-일.
 * @param {number} time ms. 0 이면 빈 문자열
 * @param {Date} [now]
 */
export function formatShortDate(time, now = new Date()) {
    if (!time) return '';
    const date = new Date(time);
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (startOfDay(date) === startOfDay(now)) return clock;
    if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 날짜 묶음. 같은 묶음끼리 제목 하나 아래에 모은다.
 * @typedef {{ key: string, kind: 'today' | 'yesterday' | 'week' | 'month' | 'older' | 'unknown', time: number }} DateBucket
 * @param {number} time ms
 * @param {Date} [now]
 * @returns {DateBucket}
 */
export function getDateBucket(time, now = new Date()) {
    if (!time) return { key: 'unknown', kind: 'unknown', time: 0 };
    const date = new Date(time);
    const today = startOfDay(now);
    const day = startOfDay(date);
    const DAY = 24 * 60 * 60 * 1000;
    // 미래 시각(시계 차이)도 오늘로 본다
    if (day >= today) return { key: 'today', kind: 'today', time };
    if (day >= today - DAY) return { key: 'yesterday', kind: 'yesterday', time };
    if (day >= today - 6 * DAY) return { key: 'week', kind: 'week', time };
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return { key: 'month', kind: 'month', time };
    return { key: `${date.getFullYear()}-${date.getMonth()}`, kind: 'older', time };
}

/**
 * '2026년 9월' / 'September 2026' 처럼 ST 언어에 맞춘 연·월
 * @param {number} time
 */
export function formatMonth(time) {
    const locale = String(getCurrentLocale?.() ?? '') || undefined;
    try {
        return new Date(time).toLocaleDateString(locale, { year: 'numeric', month: 'long' });
    } catch {
        // ST 언어 코드가 브라우저에서 지원되지 않으면 브라우저 기본 언어로
        return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    }
}
