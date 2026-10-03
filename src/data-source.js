import { characters, getRequestHeaders } from '../../../../../script.js';
import { groups } from '../../../../group-chats.js';
import { timestampToMoment } from '../../../../utils.js';
import { getPinnedEntries, getPinnedKeys, isPinned } from './pins.js';
import { toPlainPreview } from './utils.js';

/**
 * 목록 한 줄. 캐릭터는 배열 번호가 아니라 아바타 파일 이름으로 가리킨다
 * (캐릭터가 추가·삭제되면 번호가 바뀌기 때문).
 * @typedef {Object} LobbyChat
 * @property {string} key 목록 안의 고유 키
 * @property {string} avatar 캐릭터 채팅이면 캐릭터 아바타 파일 이름, 아니면 ''
 * @property {string} groupId 그룹 채팅이면 그룹 id, 아니면 ''
 * @property {string} ownerName 캐릭터·그룹 이름
 * @property {string} fileName 확장자 없는 채팅 이름
 * @property {number} lastTime 마지막 메시지 시각(ms). 알 수 없으면 0
 * @property {string} preview 마지막 메시지 평문
 * @property {number} count 메시지 수
 * @property {string} size 파일 크기(사람이 읽는 형식)
 * @property {string} [persona] 이 채팅에 고정된 페르소나(아바타 id). 없거나 모르면 ''
 * @property {boolean} [contentMatch] 대화 내용 검색(서버)에서 찾은 채팅
 * @property {string} [snippet] 대화 내용 검색에서 찾은 메시지(평문). 아직 모르면 없음
 */

/**
 * 대화 내용 검색의 단위: 캐릭터 하나 또는 그룹 하나.
 * @typedef {{ avatar: string, groupId: string, name: string }} ChatOwner
 */

/**
 * @param {LobbyChat} chat
 */
export function chatKey(chat) {
    return chat.groupId ? `g:${chat.groupId}/${chat.fileName}` : `c:${chat.avatar}/${chat.fileName}`;
}

/**
 * 채팅 정보(첫 줄)의 고정 페르소나
 * @param {any} item 서버 응답 한 줄(metadata: true 일 때 chat_metadata 가 있다)
 * @returns {string}
 */
function getChatPersona(item) {
    const persona = item?.chat_metadata?.persona;
    return typeof persona === 'string' ? persona : '';
}

/**
 * 모든 캐릭터·그룹의 채팅을 최근 순으로 가져온다.
 *
 * ST 첫 화면의 '최근 채팅'과 같은 서버 API 를 쓴다. 서버는 채팅 파일을 수정 시각 순으로 늘어놓은 뒤
 * 앞에서 `max` 개만 열어 메시지 수·마지막 메시지를 읽는다. 나머지는 수정 시각만 보므로,
 * 개수를 제한하면 채팅이 많아도 빨리 끝난다.
 * 남은 채팅이 있는지 알기 위해 하나 더(limit + 1) 요청한다. 서버가 전체 개수는 알려 주지 않는다.
 * @param {number} limit 가져올 개수. 0 이면 전부
 * @returns {Promise<{ chats: LobbyChat[], hasMore: boolean }>}
 */
export async function getAllChats(limit) {
    // 고정한 채팅은 서버가 개수 제한과 상관없이 맨 앞에 더 넣어 준다(오래된 채팅도 '고정' 묶음에 보이도록)
    const pinned = getPinnedEntries();
    // metadata: 채팅 정보(첫 줄)도 받는다. 고정 페르소나를 보여 주려고 — 첫 줄만 읽어서 비용은 거의 없다
    const body = limit > 0 ? { max: limit + 1, pinned, metadata: true } : { pinned, metadata: true };
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data)) return { chats: [], hasMore: false };

    // 맨 앞의 고정 채팅은 개수에서 뺀다(서버도 max 에 고정 수를 더해 준다)
    const pinnedKeys = getPinnedKeys();
    const pinnedCount = data.filter(item => typeof item?.file_name === 'string'
        && isPinned({ groupId: item.group ?? '', avatar: item.avatar ?? '', fileName: item.file_name.replace(/\.jsonl$/, '') }, pinnedKeys)).length;
    const hasMore = limit > 0 && data.length > limit + pinnedCount;
    const items = hasMore ? data.slice(0, limit + pinnedCount) : data;

    /** @type {LobbyChat[]} */
    const chats = [];
    for (const item of items) {
        if (typeof item?.file_name !== 'string') continue;
        const groupId = typeof item.group === 'string' ? item.group : '';
        const avatar = !groupId && typeof item.avatar === 'string' ? item.avatar : '';
        // ST 첫 화면처럼 주인(캐릭터·그룹)이 없는 채팅(채팅 폴더 바로 아래 파일 등)은 뺀다
        const owner = groupId ? groups.find(g => g.id === groupId) : characters.find(c => c.avatar === avatar);
        if (!owner) continue;

        const moment = timestampToMoment(item.last_mes);
        /** @type {LobbyChat} */
        const chat = {
            key: '',
            avatar,
            groupId,
            ownerName: String(owner.name ?? ''),
            fileName: item.file_name.replace(/\.jsonl$/, ''),
            lastTime: moment.isValid() ? moment.valueOf() : 0,
            preview: Number(item.chat_items) > 0 && typeof item.mes === 'string' ? toPlainPreview(item.mes) : '',
            count: Number(item.chat_items) || 0,
            size: typeof item.file_size === 'string' ? item.file_size : '',
            persona: getChatPersona(item),
        };
        chat.key = chatKey(chat);
        chats.push(chat);
    }

    chats.sort((a, b) => b.lastTime - a.lastTime || b.fileName.localeCompare(a.fileName));
    return { chats, hasMore };
}

/**
 * 대화 내용 검색 대상(모든 캐릭터와 그룹)
 * @returns {ChatOwner[]}
 */
export function getChatOwners() {
    return [
        ...characters.map(c => ({ avatar: String(c.avatar ?? ''), groupId: '', name: String(c.name ?? '') })).filter(o => o.avatar),
        ...groups.filter(g => Array.isArray(g.chats) && g.chats.length).map(g => ({ avatar: '', groupId: String(g.id), name: String(g.name ?? '') })),
    ];
}

/**
 * 캐릭터·그룹을 가리키는 키('c:아바타' / 'g:그룹id'). 캐릭터 고르기 칸의 값
 * @param {{ avatar: string, groupId: string }} owner
 */
export function ownerKey(owner) {
    return owner.groupId ? `g:${owner.groupId}` : `c:${owner.avatar}`;
}

/**
 * 캐릭터 고르기 칸의 선택지: 모든 캐릭터와 그룹(채팅이 없어도), 이름 순.
 * 같은 이름이 여럿이면(카드 복사 등) 아바타 파일 이름을 붙여 구분한다.
 * @returns {(ChatOwner & { key: string, label: string })[]}
 */
export function getOwnerOptions() {
    const owners = [
        ...characters.map(c => ({ avatar: String(c.avatar ?? ''), groupId: '', name: String(c.name ?? '') })).filter(o => o.avatar),
        ...groups.map(g => ({ avatar: '', groupId: String(g.id), name: String(g.name ?? '') })),
    ];
    const nameCount = new Map();
    for (const owner of owners) nameCount.set(owner.name, (nameCount.get(owner.name) ?? 0) + 1);
    return owners
        .map(owner => {
            let label = owner.name;
            if (nameCount.get(owner.name) > 1 && owner.avatar) label += ` (${owner.avatar.replace(/\.png$/i, '')})`;
            // 그룹은 이름 앞에 표시(네이티브 select 라 아이콘을 넣을 수 없다)
            if (owner.groupId) label = `👥 ${label}`;
            return { ...owner, key: ownerKey(owner), label };
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.label.localeCompare(b.label));
}

/**
 * 한 캐릭터·그룹의 채팅 전부(개수 제한 없음, 최근 순). 캐릭터를 골랐을 때 쓴다.
 * 그 캐릭터의 채팅 파일만 읽으므로 전체를 불러오는 것보다 훨씬 가볍다.
 * @param {ChatOwner} owner
 * @returns {Promise<LobbyChat[]>}
 */
export async function getOwnerChats(owner) {
    // 캐릭터는 채팅 목록 API, 그룹은 검색 API(검색어 없음 = 전부)로 메시지 수·마지막 메시지까지 받는다
    const response = await fetch(owner.groupId ? '/api/chats/search' : '/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(owner.groupId ? { query: '', group_id: owner.groupId } : { avatar_url: owner.avatar, metadata: true }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // 채팅 폴더가 없으면 { error: true } = 채팅 없음
    if (!Array.isArray(data)) return [];

    return data
        .filter(item => typeof item?.file_name === 'string')
        .map(item => {
            const moment = timestampToMoment(item.last_mes);
            const count = Number(owner.groupId ? item.message_count : item.chat_items) || 0;
            const lastMessage = owner.groupId ? item.preview_message : item.mes;
            /** @type {LobbyChat} */
            const chat = {
                key: '',
                avatar: owner.groupId ? '' : owner.avatar,
                groupId: owner.groupId,
                ownerName: owner.name,
                fileName: item.file_name.replace(/\.jsonl$/, ''),
                lastTime: moment.isValid() ? moment.valueOf() : 0,
                preview: count > 0 && typeof lastMessage === 'string' ? toPlainPreview(lastMessage) : '',
                count,
                size: typeof item.file_size === 'string' ? item.file_size : '',
                // 그룹은 검색 API 를 써서 채팅 정보를 받을 수 없다
                persona: getChatPersona(item),
            };
            chat.key = chatKey(chat);
            return chat;
        })
        .sort((a, b) => b.lastTime - a.lastTime || b.fileName.localeCompare(a.fileName));
}

/**
 * 한 캐릭터·그룹의 채팅을 대화 내용까지 검색한다(서버가 채팅 파일을 끝까지 읽는다 — 느리다).
 * 서버 규칙: 낱말이 모두 어느 메시지에든(서로 다른 메시지여도) 있거나 채팅 이름에 있으면 맞음. 대소문자 무시.
 * 어느 메시지에서 찾았는지는 알려 주지 않는다(getMatchedMessage 로 따로 찾는다).
 * @param {ChatOwner} owner
 * @param {string} query
 * @param {AbortSignal} [signal]
 * @returns {Promise<LobbyChat[]>}
 */
export async function searchOwnerChats(owner, query, signal) {
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(owner.groupId ? { query, group_id: owner.groupId } : { query, avatar_url: owner.avatar }),
        signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data
        .filter(item => typeof item?.file_name === 'string')
        .map(item => {
            const moment = timestampToMoment(item.last_mes);
            const count = Number(item.message_count) || 0;
            /** @type {LobbyChat} */
            const chat = {
                key: '',
                avatar: owner.groupId ? '' : owner.avatar,
                groupId: owner.groupId,
                ownerName: owner.name,
                fileName: item.file_name.replace(/\.jsonl$/, ''),
                lastTime: moment.isValid() ? moment.valueOf() : 0,
                preview: count > 0 && typeof item.preview_message === 'string' ? toPlainPreview(item.preview_message) : '',
                count,
                size: typeof item.file_size === 'string' ? item.file_size : '',
                contentMatch: true,
            };
            chat.key = chatKey(chat);
            return chat;
        });
}

/**
 * 대화 내용 검색에서 찾은 채팅의 '찾은 메시지'(평문). 채팅 파일 전체를 받으므로 찾은 채팅에만 쓴다.
 * 모든 낱말이 든 첫 메시지, 없으면(낱말이 여러 메시지에 흩어진 경우) 낱말이 가장 많이 든 메시지.
 * @param {LobbyChat} chat
 * @param {string[]} words 소문자 낱말
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} 못 찾으면 ''
 */
export async function getMatchedMessage(chat, words, signal) {
    const response = await fetch(chat.groupId ? '/api/chats/group/get' : '/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(chat.groupId
            ? { id: chat.fileName }
            : { ch_name: chat.ownerName, file_name: chat.fileName, avatar_url: chat.avatar }),
        signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) return '';

    let best = '';
    let bestScore = 0;
    // 첫 줄은 채팅 정보(헤더)
    for (const message of data.slice(1)) {
        const text = typeof message?.mes === 'string' ? message.mes : '';
        if (!text) continue;
        const lower = text.toLocaleLowerCase();
        const score = words.filter(word => lower.includes(word)).length;
        if (score > bestScore) {
            best = text;
            bestScore = score;
            if (score === words.length) break;
        }
    }
    return best ? toPlainPreview(best) : '';
}

/**
 * 캐릭터의 채팅 이름 목록(파일을 열지 않아 빠르다). 채팅 폴더가 없으면 빈 배열.
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
export async function getCharacterChatNames(avatar) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: true }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // 채팅 폴더가 없으면 서버는 { error: true } 를 돌려준다 = 채팅 없음
    if (!Array.isArray(data)) return [];
    return data.map(item => String(item?.file_id ?? '')).filter(Boolean);
}

/**
 * 캐릭터의 가장 최근 채팅 이름. 없으면 ''.
 * 마지막으로 연 채팅을 지웠을 때 옮겨 갈 곳을 찾는 데 쓴다(목록에 그 캐릭터의 다른 채팅이 안 불러와져 있을 때).
 * @param {string} avatar
 */
export async function getLatestCharacterChat(avatar) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) return '';

    let latest = '';
    let latestTime = -Infinity;
    for (const item of data) {
        if (typeof item?.file_name !== 'string') continue;
        const moment = timestampToMoment(item.last_mes);
        const time = moment.isValid() ? moment.valueOf() : 0;
        if (time > latestTime) {
            latestTime = time;
            latest = item.file_name.replace(/\.jsonl$/, '');
        }
    }
    return latest;
}
