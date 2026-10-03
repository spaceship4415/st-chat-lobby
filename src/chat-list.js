import { getThumbnailUrl } from '../../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { getGroupAvatar, groups } from '../../../../group-chats.js';
import { Popup } from '../../../../popup.js';
import { deleteLobbyChat, getSiblingChatNames, isChatBusy, isOpenChat, openLobbyChat, renameLobbyChat } from './chat-actions.js';
import { EXTENSION_NAME, LOG_PREFIX, SORTS } from './constants.js';
import { chatKey, getAllChats, getChatOwners, getMatchedMessage, getOwnerChats, getOwnerOptions, ownerKey, searchOwnerChats } from './data-source.js';
import { tr } from './i18n.js';
import { askName } from './name-prompt.js';
import { getSettings, setSetting } from './settings.js';
import { formatMonth, formatShortDate, getDateBucket, hasName, highlightText, sanitizeChatName, snippetAround } from './utils.js';

/** @typedef {import('./data-source.js').LobbyChat} LobbyChat */
/** @typedef {'recent' | 'oldest' | 'name' | 'messages' | 'owner'} LobbySort */
/** @typedef {'owner' | 'name' | 'message' | 'content'} MatchPlace */
/** @typedef {{ key: string, title: string, chats: LobbyChat[] }} Section 제목이 빈 문자열이면 제목(접기) 없이 보인다 */
/**
 * @typedef {Object} ContentSearch
 * @property {string} query 이 검색어로 찾은 결과
 * @property {string[]} words
 * @property {'search' | 'snippet' | 'done' | 'stopped'} phase 캐릭터·그룹 검색 → 찾은 메시지 불러오기 → 끝(또는 중지)
 * @property {number} completed 검색을 마친 캐릭터·그룹 수 (snippet 단계에서는 찾은 메시지를 불러온 수)
 * @property {number} total
 * @property {number} failed 읽지 못한 캐릭터·그룹 수
 * @property {Map<string, LobbyChat>} results key → 찾은 채팅
 * @property {AbortController} controller
 */

/** 대화 내용 검색에서 동시에 검색할 캐릭터·그룹 수 */
const CONTENT_SEARCH_WORKERS = 3;
/** 찾은 메시지(채팅 파일 전체를 받아야 함)를 불러올 최대 채팅 수. 넘으면 나머지는 마지막 메시지를 보여 준다 */
const SNIPPET_LIMIT = 100;

/** 일괄 삭제 확인 창에 이름을 몇 개까지 보여 줄지 */
const CONFIRM_NAME_LIMIT = 5;

/**
 * 전체 채팅 목록. 시작 화면(최근 채팅 자리)과 마법봉 메뉴의 창이 같은 목록을 쓴다.
 *
 * 설정한 개수만큼만 불러오고(서버가 그만큼만 채팅 파일을 읽는다), 검색·필터·정렬은 불러온 채팅 안에서 한다.
 * 그래서 남은 채팅이 있으면 [더 불러오기]와, 검색 중이면 [모든 채팅에서 검색]을 보여 준다.
 *
 * @param {HTMLElement} container 목록을 넣을 곳
 * @param {object} [options]
 * @param {(text: string) => void} [options.onCount] 채팅 수 표시가 바뀔 때('50+', '128'). 불러오기 전에는 ''
 * @param {() => void} [options.beforeOpen] 채팅을 열기 직전(창을 닫는 데 쓴다)
 */
export async function createLobbyList(container, { onCount = () => { }, beforeOpen = () => { } } = {}) {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'templates/list');
    const template = document.createElement('template');
    template.innerHTML = html;
    const root = /** @type {HTMLElement} */ (template.content.querySelector('.st-lobby'));
    container.append(root);

    const find = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (root.querySelector(selector));
    const searchInput = /** @type {HTMLInputElement} */ (find('.st-lobby-search'));
    const ownerSelect = /** @type {HTMLSelectElement} */ (find('.st-lobby-owner-select'));
    const sortSelect = /** @type {HTMLSelectElement} */ (find('.st-lobby-sort'));
    const selectToggle = find('.st-lobby-select-toggle');
    const reloadButton = find('.st-lobby-reload');
    const selectBar = find('.st-lobby-select-bar');
    const selectAllInput = /** @type {HTMLInputElement} */ (find('.st-lobby-select-all input'));
    const selectedCount = find('.st-lobby-selected-count');
    const deleteSelectedButton = /** @type {HTMLButtonElement} */ (find('.st-lobby-delete-selected'));
    const selectDoneButton = find('.st-lobby-select-done');
    const note = find('.st-lobby-note');
    const list = find('.st-lobby-list');
    const footer = find('.st-lobby-footer');

    // ── 상태 ──
    /** @type {LobbyChat[] | null} null = 아직 불러온 적 없음 */
    let chats = null;
    let hasMore = false;
    let loading = false;
    let loadFailed = false;
    /** 지금 불러온 개수 기준(0 = 전부) */
    let loadedLimit = 0;
    /**
     * 검색·정렬용 전체 채팅. 둘러볼 때는 최근 N개만 보이지만, 검색하거나 최근 순이 아닌 정렬을 고르면
     * 자동으로 전부를 대상으로 한다('불러온 N개 안에서' 같은 개념을 사용자가 알 필요 없도록).
     * 한 번 받아 두고 다시 쓴다. null = 아직 안 받음
     * @type {LobbyChat[] | null}
     */
    let allChats = null;
    let allLoading = false;
    let allFailed = false;
    let allToken = 0;
    /** 늦게 도착한 응답을 버리기 위한 번호 */
    let loadToken = 0;
    let query = '';
    // 고른 캐릭터·그룹(ownerKey). '' = 모두. 기억하지 않는다 — 다음에 열었을 때 걸러진 채로 남아 있으면
    // 검색이 안 되는 것처럼 보인다
    let ownerFilter = '';
    /** @type {LobbyChat[] | null} 고른 캐릭터의 채팅 전부(개수 제한 없음). null = 불러오는 중 */
    let ownerChats = null;
    let ownerFailed = false;
    let ownerToken = 0;
    /** @type {LobbySort} */
    let sort = /** @type {LobbySort} */ (getSettings().sort);
    let selecting = false;
    /** @type {Set<string>} 선택한 채팅의 key */
    const selected = new Set();
    /** 이름 바꾸기·삭제 처리 중(겹쳐 실행하지 않도록) */
    let managing = false;
    /** @type {Set<string>} 접은 묶음의 key. 이 목록이 떠 있는 동안만 기억한다 */
    const collapsed = new Set();
    /**
     * 대화 내용 검색(별도 버튼). 서버가 채팅 파일을 끝까지 읽어 느리므로 누를 때만 돌린다.
     * 검색어가 바뀌면 멈추고 버린다(결과가 그 검색어 기준이라서).
     * @type {ContentSearch | null}
     */
    let content = null;

    const loadStep = () => getSettings().loadCount;
    /** 다시 불러올 때 쓸 개수: 지금까지 불러온 만큼(전부 불러왔으면 계속 전부) */
    const currentLimit = () => (chats && loadedLimit === 0) ? 0 : Math.max(loadedLimit, loadStep());

    // ── 불러오기 ──
    /** @param {number} limit 0 = 전부 */
    const load = async (limit) => {
        const token = ++loadToken;
        loading = true;
        loadFailed = false;
        renderFooter();
        try {
            const result = await getAllChats(limit);
            if (token !== loadToken) return;
            chats = result.chats;
            hasMore = result.hasMore;
            loadedLimit = limit;
            // 사라진 채팅은 선택에서도 뺀다
            const keys = new Set(chats.map(chat => chat.key));
            for (const key of [...selected]) if (!keys.has(key)) selected.delete(key);
        } catch (error) {
            if (token !== loadToken) return;
            console.error(LOG_PREFIX, 'failed to load chats', error);
            loadFailed = true;
        } finally {
            if (token === loadToken) {
                loading = false;
                renderAll();
            }
        }
    };

    const loadMore = () => {
        const step = loadStep();
        if (!step) return load(0);
        // 지금 불러온 것보다 한 단계 더
        return load(Math.max(loadedLimit, chats?.length ?? 0) + step);
    };

    // ── 캐릭터 고르기 ──
    const fillOwnerOptions = () => {
        const options = getOwnerOptions();
        ownerSelect.replaceChildren(
            new Option(tr('owner_all', 'All characters'), ''),
            ...options.map(owner => new Option(owner.label, owner.key)),
        );
        // 고른 캐릭터가 사라졌으면(삭제 등) 모두로
        if (ownerFilter && !options.some(owner => owner.key === ownerFilter)) setOwner('');
        ownerSelect.value = ownerFilter;
    };

    /** 고른 캐릭터의 채팅을 전부 불러온다(그 캐릭터 채팅 파일만 읽어서 가볍다) */
    const loadOwner = async () => {
        const token = ++ownerToken;
        const owner = getOwnerOptions().find(option => option.key === ownerFilter);
        if (!owner) return;
        ownerChats = null;
        ownerFailed = false;
        renderAll();
        try {
            const result = await getOwnerChats(owner);
            if (token !== ownerToken) return;
            ownerChats = result;
        } catch (error) {
            if (token !== ownerToken) return;
            console.error(LOG_PREFIX, 'failed to load the chats of', owner, error);
            ownerFailed = true;
        }
        renderAll();
    };

    /** @param {string} key ownerKey, '' = 모두 */
    const setOwner = (key) => {
        ownerFilter = key;
        ownerSelect.value = key;
        ownerChats = null;
        ownerFailed = false;
        ownerToken++;
        // 다른 범위에서 고른 채팅·찾은 결과는 버린다(안 보이는 채팅을 지우거나 엉뚱한 결과를 보이지 않도록)
        selected.clear();
        if (content) content.controller.abort();
        content = null;
        if (key) void loadOwner();
        else renderAll();
    };

    /**
     * 전체 채팅이 필요한지: 검색 중이거나, 일부만으로는 틀린 결과가 나오는 정렬(오래된·이름·메시지 수).
     * 최근 순·캐릭터별은 둘러보기라 최근 채팅 + 더 불러오기로 충분하다(정렬은 기억되므로, 열 때마다 전부 받지 않도록).
     * 캐릭터를 골랐으면 그 캐릭터의 채팅이 이미 전부 있다
     */
    const needsAll = () => !ownerFilter && (!!query.trim() || ['oldest', 'name', 'messages'].includes(sort));

    /** 필요하면 전체 채팅을 받아 둔다. 최근 목록이 이미 전부면 그대로 쓴다 */
    const ensureAll = () => {
        if (!needsAll() || allChats || allLoading || allFailed) return;
        if (chats && !hasMore) {
            allChats = chats;
            return;
        }
        const token = ++allToken;
        allLoading = true;
        getAllChats(0)
            .then((result) => {
                if (token !== allToken) return;
                allChats = result.chats;
            })
            .catch((error) => {
                if (token !== allToken) return;
                console.error(LOG_PREFIX, 'failed to load all chats', error);
                allFailed = true;
            })
            .finally(() => {
                if (token !== allToken) return;
                allLoading = false;
                renderAll();
            });
    };

    /** 전체 채팅을 버리고 다음에 필요할 때 다시 받는다(새로 고침) */
    const resetAll = () => {
        allToken++;
        allChats = null;
        allLoading = false;
        allFailed = false;
    };

    /**
     * 지금 목록의 바탕: 캐릭터를 골랐으면 그 캐릭터의 채팅 전부, 검색·정렬 중이면 전체 채팅(받는 동안은 최근 채팅),
     * 아니면 최근 채팅
     */
    const getBase = () => {
        if (ownerFilter) return ownerChats;
        if (needsAll()) return allChats ?? chats;
        return chats;
    };

    // ── 보이는 목록 ──
    /** @param {LobbyChat} chat */
    const matchesFilter = chat => !ownerFilter || ownerKey(chat) === ownerFilter;

    /** 검색 낱말(소문자). 검색하지 않으면 빈 배열 */
    const getWords = () => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

    /**
     * 어디에서 찾았는지. 여러 낱말이면 모두 들어 있어야 하고(어느 칸에 있든), 가장 앞쪽 칸으로 본다:
     * 모든 낱말이 캐릭터·그룹 이름에 있으면 'owner', 이름들(주인·채팅)만으로 되면 'name', 마지막 메시지가 필요하면 'message'.
     * @param {LobbyChat} chat
     * @param {string[]} words
     * @returns {MatchPlace | null} 맞지 않으면 null
     */
    const getMatchPlace = (chat, words) => {
        const owner = chat.ownerName.toLocaleLowerCase();
        const name = chat.fileName.toLocaleLowerCase();
        const preview = chat.preview.toLocaleLowerCase();
        if (!words.every(word => owner.includes(word) || name.includes(word) || preview.includes(word))) return null;
        if (words.every(word => owner.includes(word))) return 'owner';
        if (words.every(word => owner.includes(word) || name.includes(word))) return 'name';
        return 'message';
    };

    /** 대화 내용 검색 결과가 지금 검색어 것인지 */
    const contentFor = () => (content && content.query === query.trim() ? content : null);

    /**
     * 찾은 곳. 이름·마지막 메시지에서 못 찾았어도 대화 내용 검색에서 찾았으면 'content'
     * @param {LobbyChat} chat
     * @param {string[]} words
     * @returns {MatchPlace | null}
     */
    const getPlace = (chat, words) => getMatchPlace(chat, words) ?? (contentFor()?.results.has(chat.key) ? 'content' : null);

    /** @param {LobbyChat} chat */
    const matchesQuery = (chat) => {
        const words = getWords();
        return !words.length || getPlace(chat, words) !== null;
    };

    /**
     * 목록에 놓일 채팅: 바탕(불러온 채팅 또는 고른 캐릭터의 채팅) + 대화 내용 검색에서 찾은, 바탕에 없는 채팅
     * @returns {LobbyChat[]}
     */
    const getCandidates = () => {
        const base = getBase();
        if (!base) return [];
        const found = contentFor()?.results;
        if (!found?.size) return base;
        const loaded = new Set(base.map(chat => chat.key));
        return [...base, ...[...found.values()].filter(chat => !loaded.has(chat.key))];
    };

    /** @param {LobbyChat} chat */
    const matches = chat => matchesFilter(chat) && matchesQuery(chat);

    const compareName = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

    /**
     * 고른 정렬 순서로 늘어놓는다(제목 없이). 원본(최근 순)은 그대로 둔다
     * @param {LobbyChat[]} list
     */
    const sortChats = (list) => {
        switch (sort) {
            case 'oldest': return [...list].sort((a, b) => a.lastTime - b.lastTime);
            case 'name': return [...list].sort((a, b) => compareName(a.fileName, b.fileName) || compareName(a.ownerName, b.ownerName));
            case 'messages': return [...list].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime);
            // 캐릭터별: 이름 순, 같은 주인 안에서는 최근 순(정렬은 안정적이라 원래 순서가 남는다)
            case 'owner': return [...list].sort((a, b) => compareName(a.ownerName, b.ownerName) || b.lastTime - a.lastTime);
            // 대화 내용 검색 결과가 뒤에 붙어 오므로 최근 순도 다시 정렬한다
            default: return [...list].sort((a, b) => b.lastTime - a.lastTime);
        }
    };

    /** @returns {Section[]} */
    const getSections = () => {
        if (!getBase()) return [];
        const visible = getCandidates().filter(matches);

        // 검색 중에는 날짜·캐릭터 대신 '어디에서 찾았는지'로 묶는다. 묶음 안은 고른 정렬 순서
        const words = getWords();
        if (words.length) {
            /** @type {Record<MatchPlace, LobbyChat[]>} */
            const byPlace = { owner: [], name: [], message: [], content: [] };
            for (const chat of sortChats(visible)) {
                byPlace[getPlace(chat, words) ?? 'message'].push(chat);
            }
            /** @type {[MatchPlace, string][]} */
            const titles = [
                ['owner', tr('found_owner', 'Character / group name')],
                ['name', tr('found_name', 'Chat name')],
                ['message', tr('found_message', 'Last message')],
                ['content', tr('found_content', 'Conversation')],
            ];
            return titles
                .filter(([place]) => byPlace[place].length)
                .map(([place, title]) => ({ key: `found:${place}`, title, chats: byPlace[place] }));
        }

        switch (sort) {
            case 'name':
            case 'messages':
                return [{ key: '', title: '', chats: sortChats(visible) }];
            case 'owner': {
                /** @type {Map<string, Section>} */
                const byOwner = new Map();
                for (const chat of visible) {
                    const ownerKey = chat.groupId ? `g:${chat.groupId}` : `c:${chat.avatar}`;
                    if (!byOwner.has(ownerKey)) byOwner.set(ownerKey, { key: `owner:${ownerKey}`, title: chat.ownerName, chats: [] });
                    byOwner.get(ownerKey).chats.push(chat);
                }
                // 묶음 안은 최근 순(원본 순서), 묶음은 이름 순
                return [...byOwner.values()].sort((a, b) => compareName(a.title, b.title));
            }
            default: {
                // 'recent' 또는 'oldest'
                const ordered = sortChats(visible);
                /** @type {Section[]} */
                const sections = [];
                const now = new Date();
                let lastKey = null;
                for (const chat of ordered) {
                    const bucket = getDateBucket(chat.lastTime, now);
                    if (bucket.key !== lastKey) {
                        sections.push({ key: `date:${bucket.key}`, title: getBucketTitle(bucket), chats: [] });
                        lastKey = bucket.key;
                    }
                    sections[sections.length - 1].chats.push(chat);
                }
                return sections;
            }
        }
    };

    /** 펼쳐진 묶음의 채팅(화면에 보이는 것). 접은 묶음의 채팅은 '모두 선택'에 들어가지 않는다 */
    const getVisibleChats = () => getSections()
        .filter(section => !section.key || !collapsed.has(section.key))
        .flatMap(section => section.chats);

    // ── 그리기 ──
    const renderAll = () => {
        ensureAll();
        renderList();
        renderFooter();
        renderNote();
        renderSelectBar();
        // 전체 개수를 알 때만 보여 준다('50+' 같은 표시는 뜻이 모호하다)
        const total = allChats?.length ?? (chats && !hasMore ? chats.length : null);
        onCount(total === null ? '' : String(total));
    };

    const renderList = () => {
        list.replaceChildren();

        const base = getBase();
        if (ownerFilter && !base) {
            const message = ownerFailed
                ? createMessage(tr('owner_load_failed', 'Could not load the chats of this character.'))
                : createMessage(tr('owner_loading', 'Loading the chats of this character…'));
            if (!ownerFailed) message.prepend(createIcon('fa-spinner fa-spin'), ' ');
            list.append(message);
            if (ownerFailed) list.append(createFooterButton('fa-rotate-right', tr('retry', 'Try again'), () => void loadOwner()));
            return;
        }
        if (!base) {
            if (loadFailed) list.append(createMessage(tr('load_failed', 'Could not load the chats.')));
            return;
        }
        if (base.length === 0) {
            list.append(createMessage(ownerFilter ? tr('owner_empty', 'This character has no chats yet.') : tr('empty', 'No chats yet.')));
            return;
        }

        // 대화 내용 검색 카드(시작 버튼 → 진행 → 결과)는 검색 결과 맨 위에 둔다.
        // 맨 아래에 두면 휴대폰에서 결과를 끝까지 내려야 보여서 있는지도 모르고, 진행 상황도 안 보인다
        if (query.trim()) list.append(createContentCard());

        const sections = getSections();
        if (sections.length === 0) {
            // 고른 캐릭터 때문에 숨은 결과가 있으면 '없음'이 아니라 그렇다고 알려 주고 바로 풀 수 있게 한다
            // (다른 캐릭터의 채팅은 최근 것만 불러와 있어 0개여도 실제로는 있을 수 있으므로, 버튼은 항상 둔다)
            if (ownerFilter && query.trim()) {
                const ownerName = ownerSelect.selectedOptions[0]?.textContent ?? '';
                const hidden = (chats ?? []).filter(chat => !matchesFilter(chat) && matchesQuery(chat)).length;
                const text = hidden
                    ? tr('owner_hidden', 'No matches in {0}. {1} found in other chats.').replace('{1}', String(hidden))
                    : tr('owner_none', 'No matches in {0}.');
                list.append(
                    createMessage(text.replace('{0}', ownerName)),
                    createFooterButton('fa-users', tr('owner_show_all', 'Search all characters'), () => setOwner('')),
                );
                return;
            }
            list.append(createMessage(query.trim()
                ? tr('search_empty', 'No chats match your search.')
                : tr('filter_empty', 'No chats to show.')));
            return;
        }

        for (const section of sections) {
            const isCollapsed = !!section.key && collapsed.has(section.key);
            if (section.title) list.append(createHeading(section, isCollapsed));
            // 접은 묶음은 줄을 아예 만들지 않는다(채팅이 많을 때 그리는 양도 준다)
            if (isCollapsed) continue;
            for (const chat of section.chats) {
                list.append(createItem(chat));
            }
        }
    };

    /**
     * 묶음 제목. 누르면 접고 편다. 스크롤해도 위에 붙어 있어서, 긴 묶음을 내려가다가도 바로 접을 수 있다.
     * @param {Section} section
     * @param {boolean} isCollapsed
     */
    const createHeading = (section, isCollapsed) => {
        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'st-lobby-heading';
        heading.dataset.section = section.key;
        heading.setAttribute('aria-expanded', String(!isCollapsed));
        heading.classList.toggle('st-lobby-heading-collapsed', isCollapsed);
        heading.title = isCollapsed ? tr('section_expand', 'Expand') : tr('section_collapse', 'Collapse');

        const title = document.createElement('span');
        title.className = 'st-lobby-heading-title';
        title.textContent = section.title;
        const count = document.createElement('span');
        count.className = 'st-lobby-heading-count';
        count.textContent = `(${section.chats.length})`;
        heading.append(createIcon('fa-chevron-down st-lobby-heading-icon'), title, count);

        heading.addEventListener('click', () => {
            if (collapsed.has(section.key)) collapsed.delete(section.key);
            else collapsed.add(section.key);
            renderList();
            renderSelectBar();
            // 위에 붙은 제목을 눌러 접었으면 그 아래 줄들이 사라지며 제목이 화면 밖으로 밀려난다. 다시 보이게 한다
            const next = [...list.querySelectorAll('.st-lobby-heading')].find(el => /** @type {HTMLElement} */ (el).dataset.section === section.key);
            next?.scrollIntoView({ block: 'nearest' });
        });
        return heading;
    };

    const renderFooter = () => {
        footer.replaceChildren();
        // 캐릭터를 골랐으면 그 캐릭터의 채팅은 이미 전부 있다(더 불러오기·모든 채팅에서 검색이 필요 없다)
        if (ownerFilter) return;
        if (loading) {
            const message = createMessage(chats ? tr('loading_more', 'Loading more chats…') : tr('loading', 'Loading chats…'));
            message.prepend(createIcon('fa-spinner fa-spin'), ' ');
            footer.append(message);
            return;
        }
        if (loadFailed) {
            if (chats) footer.append(createMessage(tr('load_failed', 'Could not load the chats.')));
            footer.append(createFooterButton('fa-rotate-right', tr('retry', 'Try again'), () => load(currentLimit())));
            return;
        }
        // 더 불러오기는 최근 순으로 둘러볼 때만. 검색·다른 정렬은 이미 전체가 대상이다
        if (hasMore && !needsAll()) {
            const step = loadStep();
            footer.append(createFooterButton('fa-angles-down',
                step ? tr('load_more', 'Load {0} more').replace('{0}', String(step)) : tr('load_all', 'Load all chats'),
                () => loadMore()));
        }
        // 대화 내용 검색 카드는 목록 맨 위(renderList)에 있다
    };

    /** 대화 내용 검색 카드: 시작 버튼 → 진행(막대·멈추기) → 결과 요약 */
    const createContentCard = () => {
        const state = contentFor();
        if (!state) {
            return createCard({
                icon: 'fa-comments',
                title: tr('content_search', 'Search conversations too'),
                sub: tr('content_search_sub', 'Every message of every chat · may take a while'),
                onClick: () => void startContentSearch(),
            });
        }

        const found = state.results.size;
        const foundText = tr('content_found', '{0} found').replace('{0}', String(found));
        if (state.phase === 'search' || state.phase === 'snippet') {
            const step = state.phase === 'search'
                ? tr('content_searching', 'Searching conversations…')
                : tr('content_snippets', 'Loading matched messages…');
            return createCard({
                icon: 'fa-spinner fa-spin',
                title: step,
                sub: `${state.completed} / ${state.total} · ${foundText}`,
                progress: state.total ? state.completed / state.total : 0,
                action: { label: tr('content_stop', 'Stop'), onClick: () => stopContentSearch() },
                tone: 'running',
            });
        }

        const parts = [foundText];
        if (state.failed) parts.push(tr('content_failed', '{0} could not be read').replace('{0}', String(state.failed)));
        const stopped = state.phase === 'stopped';
        return createCard({
            icon: stopped ? 'fa-circle-pause' : 'fa-circle-check',
            title: stopped ? tr('content_stopped', 'Conversation search stopped') : tr('content_done', 'Conversation search finished'),
            sub: parts.join(' · '),
            action: (stopped || state.failed) ? { label: tr('content_again', 'Search again'), onClick: () => void startContentSearch() } : undefined,
            tone: 'done',
        });
    };

    // ── 대화 내용 검색 ──
    /** 찾는 동안 결과가 하나씩 들어오므로 모아서 다시 그린다 */
    let renderTimer = 0;
    const scheduleRender = () => {
        if (renderTimer) return;
        renderTimer = window.setTimeout(() => {
            renderTimer = 0;
            renderAll();
        }, 200);
    };

    const stopContentSearch = () => {
        if (!content) return;
        content.controller.abort();
        if (content.phase === 'search' || content.phase === 'snippet') content.phase = 'stopped';
        renderAll();
    };

    /** 검색어가 바뀌면 지난 대화 내용 검색은 멈추고 버린다 */
    const dropStaleContentSearch = () => {
        if (content && content.query !== query.trim()) {
            content.controller.abort();
            content = null;
        }
    };

    const startContentSearch = async () => {
        const words = getWords();
        if (!words.length) return;
        if (content) content.controller.abort();

        // 캐릭터를 골랐으면 그 캐릭터만 검색한다(훨씬 빠르다)
        const owners = getChatOwners().filter(owner => !ownerFilter || ownerKey(owner) === ownerFilter);
        /** @type {ContentSearch} */
        const state = {
            query: query.trim(),
            words,
            phase: 'search',
            completed: 0,
            total: owners.length,
            failed: 0,
            results: new Map(),
            controller: new AbortController(),
        };
        content = state;
        const { signal } = state.controller;
        // 목록이 화면에서 사라졌으면(시작 화면이 닫힘) 더 할 필요가 없다
        const alive = () => content === state && !signal.aborted && root.isConnected;
        renderAll();

        // 1) 캐릭터·그룹마다 서버 검색. 몇 개씩 동시에
        const queue = [...owners];
        const searchWorker = async () => {
            while (queue.length && alive()) {
                const owner = /** @type {import('./data-source.js').ChatOwner} */ (queue.shift());
                try {
                    const found = await searchOwnerChats(owner, state.query, signal);
                    if (!alive()) return;
                    for (const chat of found) state.results.set(chat.key, chat);
                } catch (error) {
                    if (!alive()) return;
                    console.warn(LOG_PREFIX, 'conversation search failed for', owner, error);
                    state.failed++;
                }
                state.completed++;
                scheduleRender();
            }
        };
        await Promise.all(Array.from({ length: CONTENT_SEARCH_WORKERS }, searchWorker));
        if (!alive()) {
            if (!root.isConnected) state.controller.abort();
            return;
        }

        // 2) 이름·마지막 메시지로는 못 찾은 채팅만 '찾은 메시지'를 불러온다(채팅 파일 전체를 받아야 해서)
        const needSnippet = sortChats([...state.results.values()].filter(chat => getMatchPlace(chat, words) === null)).slice(0, SNIPPET_LIMIT);
        state.phase = 'snippet';
        state.completed = 0;
        state.total = needSnippet.length;
        renderAll();
        const snippetQueue = [...needSnippet];
        const snippetWorker = async () => {
            while (snippetQueue.length && alive()) {
                const chat = /** @type {LobbyChat} */ (snippetQueue.shift());
                try {
                    chat.snippet = await getMatchedMessage(chat, words, signal);
                } catch (error) {
                    if (!alive()) return;
                    console.warn(LOG_PREFIX, 'failed to load the matched message', chat, error);
                    chat.snippet = '';
                }
                state.completed++;
                scheduleRender();
            }
        };
        await Promise.all([snippetWorker(), snippetWorker()]);
        if (!alive()) return;
        state.phase = 'done';
        renderAll();
    };

    /** 전체 채팅을 받는 중이거나 못 받았을 때만 한 줄 안내(그동안은 최근 채팅으로 보여 준다) */
    const renderNote = () => {
        note.replaceChildren();
        const waiting = needsAll() && !allChats;
        note.hidden = !waiting || (!allLoading && !allFailed);
        if (note.hidden) return;
        if (allLoading) {
            note.append(createIcon('fa-spinner fa-spin'), ' ', query.trim()
                ? tr('all_loading_search', 'Searching all chats…')
                : tr('all_loading_sort', 'Loading all chats to sort…'));
            return;
        }
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'st-lobby-note-retry';
        retry.textContent = tr('retry', 'Try again');
        retry.addEventListener('click', () => {
            allFailed = false;
            renderAll();
        });
        note.append(tr('all_failed', 'Could not load all chats; showing recent ones only.'), ' ', retry);
    };

    const getSelectableVisible = () => getVisibleChats().filter(chat => !isOpenChat(chat));

    const renderSelectBar = () => {
        selectBar.hidden = !selecting;
        selectToggle.classList.toggle('active', selecting);
        selectToggle.setAttribute('aria-pressed', String(selecting));
        root.classList.toggle('st-lobby-selecting', selecting);
        if (!selecting) return;

        const selectable = getSelectableVisible();
        const selectedVisible = selectable.filter(chat => selected.has(chat.key)).length;
        selectAllInput.checked = selectable.length > 0 && selectedVisible === selectable.length;
        selectAllInput.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
        selectAllInput.disabled = selectable.length === 0;
        selectedCount.textContent = tr('selected_count', '{0} selected').replace('{0}', String(selected.size));
        deleteSelectedButton.disabled = selected.size === 0 || managing;
    };

    /** @param {string} icon @param {string} label @param {() => void} onClick */
    const createFooterButton = (icon, label, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button st-lobby-footer-button';
        button.append(createIcon(icon), ' ', label);
        button.addEventListener('click', onClick);
        return button;
    };

    /** @param {LobbyChat} chat */
    const createItem = (chat) => {
        const open = isOpenChat(chat);
        const item = document.createElement('div');
        item.className = 'st-lobby-item';
        item.setAttribute('role', 'listitem');
        item.classList.toggle('st-lobby-item-open', open);
        item.classList.toggle('st-lobby-item-selected', selected.has(chat.key));

        // 줄의 왼쪽 전체가 누르는 곳(모바일 터치 대상). 선택 모드에서는 선택, 아니면 채팅 열기
        const main = document.createElement('div');
        main.className = 'st-lobby-main';
        main.tabIndex = 0;
        main.setAttribute('role', 'button');

        if (selecting) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'st-lobby-check';
            checkbox.checked = selected.has(chat.key);
            checkbox.disabled = open;
            checkbox.tabIndex = -1;
            checkbox.setAttribute('aria-hidden', 'true');
            main.append(checkbox);
            main.setAttribute('aria-pressed', String(checkbox.checked));
        }

        main.append(createAvatar(chat));

        const body = document.createElement('div');
        body.className = 'st-lobby-body';

        const top = document.createElement('div');
        top.className = 'st-lobby-top';
        const owner = document.createElement('span');
        owner.className = 'st-lobby-owner';
        if (chat.groupId) owner.append(createIcon('fa-users st-lobby-group-icon'), ' ');
        // 검색 중이면 찾은 글자를 표시한다
        const words = getWords();
        owner.append(...highlightText(chat.ownerName, words));
        top.append(owner);
        if (open) {
            const badge = document.createElement('span');
            badge.className = 'st-lobby-badge';
            badge.textContent = tr('open_badge', 'Open now');
            top.append(badge);
        }
        const date = document.createElement('span');
        date.className = 'st-lobby-date';
        date.textContent = formatShortDate(chat.lastTime);
        top.append(date);

        // 채팅 이름은 한 줄(넘치면 …). 메시지 수는 같은 줄 오른쪽
        const nameRow = document.createElement('div');
        nameRow.className = 'st-lobby-name-row';
        const name = document.createElement('span');
        name.className = 'st-lobby-name';
        name.append(...highlightText(chat.fileName, words));
        const count = document.createElement('span');
        count.className = 'st-lobby-count';
        count.title = tr('message_count', '{0} messages').replace('{0}', String(chat.count));
        count.append(createIcon('fa-comment'), ` ${chat.count}`);
        nameRow.append(name, count);

        const preview = document.createElement('div');
        preview.className = 'st-lobby-preview';
        const place = words.length ? getPlace(chat, words) : null;
        // 대화 내용에서 찾았으면 찾은 메시지를 보여 준다(불러온 채팅이면 결과 쪽 객체에 들어 있다)
        const snippet = place === 'content' ? contentFor()?.results.get(chat.key)?.snippet : undefined;
        if (place === 'content' && snippet) {
            preview.append(...highlightText(snippetAround(snippet, words), words));
        } else if (place === 'content' && snippet === undefined && ['search', 'snippet'].includes(contentFor()?.phase ?? '')) {
            preview.textContent = tr('snippet_loading', 'Loading the matched message…');
            preview.classList.add('st-lobby-preview-empty');
        } else if (chat.preview) {
            // 미리보기는 한 줄만 보이므로, 마지막 메시지에서 찾았으면 찾은 글자 근처부터 보여 준다
            const fromMessage = place === 'message';
            preview.append(...highlightText(fromMessage ? snippetAround(chat.preview, words) : chat.preview, words));
        } else {
            preview.textContent = tr('preview_empty', '(No messages)');
            preview.classList.add('st-lobby-preview-empty');
        }

        body.append(top, nameRow, preview);
        main.append(body);
        main.title = `${chat.ownerName} – ${chat.fileName}`;

        const activate = () => {
            if (selecting) {
                if (open) {
                    toastr.info(tr('delete_open', 'The chat that is open right now cannot be deleted.'));
                    return;
                }
                if (selected.has(chat.key)) selected.delete(chat.key);
                else selected.add(chat.key);
                const checkbox = /** @type {HTMLInputElement | null} */ (main.querySelector('.st-lobby-check'));
                if (checkbox) checkbox.checked = selected.has(chat.key);
                main.setAttribute('aria-pressed', String(selected.has(chat.key)));
                item.classList.toggle('st-lobby-item-selected', selected.has(chat.key));
                renderSelectBar();
                return;
            }
            void openChat(chat);
        };
        main.addEventListener('click', activate);
        main.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            activate();
        });

        const row = document.createElement('div');
        row.className = 'st-lobby-row-main';
        row.append(main);
        item.append(row);

        // 이름 바꾸기·삭제는 '⋯' 뒤에 둔다. 늘 보이면 줄마다 폭을 차지해 이름이 여러 줄로 접히고,
        // 휴대폰에서 스크롤하다 삭제를 잘못 누르기 쉽다
        if (!selecting) {
            const menuOpen = menuKey === chat.key;
            const more = createActionButton('fa-ellipsis-vertical', tr('more_actions', 'More'), () => toggleMenu(chat.key));
            more.classList.add('st-lobby-more');
            more.setAttribute('aria-expanded', String(menuOpen));
            row.append(more);
            if (menuOpen) item.append(createItemMenu(chat, open));
        }
        return item;
    };

    /** 열린 '⋯' 메뉴의 채팅 key. 한 번에 하나만 */
    let menuKey = '';

    /** @param {string} key */
    const toggleMenu = (key) => {
        menuKey = menuKey === key ? '' : key;
        renderList();
    };

    /**
     * 줄 아래에 펼쳐지는 메뉴: 채팅 정보 한 줄 + [이름 바꾸기] [삭제]
     * @param {LobbyChat} chat
     * @param {boolean} open 지금 열린 채팅(삭제 불가)
     */
    const createItemMenu = (chat, open) => {
        const menu = document.createElement('div');
        menu.className = 'st-lobby-menu';

        const info = document.createElement('div');
        info.className = 'st-lobby-menu-info';
        info.textContent = [chat.fileName, tr('message_count', '{0} messages').replace('{0}', String(chat.count)), chat.size].filter(Boolean).join(' · ');

        const buttons = document.createElement('div');
        buttons.className = 'st-lobby-menu-buttons';
        const renameButton = createFooterButton('fa-pen', tr('rename_title', 'Rename chat'), () => {
            menuKey = '';
            void renameChat(chat);
        });
        const deleteButton = createFooterButton('fa-trash-can', tr('delete', 'Delete'), () => {
            if (open) {
                // 막아 두되 누르면 이유를 알려 준다(휴대폰에서는 비활성 버튼의 설명을 볼 수 없다)
                toastr.info(tr('delete_open', 'The chat that is open right now cannot be deleted.'));
                return;
            }
            menuKey = '';
            void deleteChat(chat);
        });
        deleteButton.classList.add('st-lobby-delete');
        if (open) deleteButton.setAttribute('aria-disabled', 'true');
        buttons.append(renameButton, deleteButton);

        menu.append(info, buttons);
        return menu;
    };

    // ── 동작 ──
    /** @param {LobbyChat} chat */
    const openChat = async (chat) => {
        if (managing) return;
        if (isOpenChat(chat)) {
            beforeOpen();
            return;
        }
        if (isChatBusy()) {
            toastr.info(tr('busy', 'Please wait until the reply is finished and the chat is saved.'));
            return;
        }
        beforeOpen();
        await openLobbyChat(chat);
    };

    /** @param {LobbyChat} chat */
    const renameChat = async (chat) => {
        if (managing) return;
        if (isOpenChat(chat) && isChatBusy()) {
            toastr.info(tr('busy', 'Please wait until the reply is finished and the chat is saved.'));
            return;
        }
        const input = await askName({
            title: tr('rename_title', 'Rename chat'),
            text: tr('rename_text', 'Enter a new name for this chat.'),
            defaultName: chat.fileName,
            okButton: tr('rename_ok', 'Rename'),
        });
        if (!input) return;
        const name = sanitizeChatName(input);
        if (!name) {
            toastr.warning(tr('name_required', 'Enter a chat name.'));
            return;
        }
        if (name === chat.fileName) return;

        managing = true;
        try {
            // 대소문자만 바꾸는 것도 Windows 에서는 같은 파일이라 서버가 거절한다. 미리 같은 이름으로 막는다
            const others = (await getSiblingChatNames(chat)).filter(other => other !== chat.fileName);
            if (hasName(name, others) || name.toLocaleLowerCase() === chat.fileName.toLocaleLowerCase()) {
                toastr.warning(tr('name_duplicate', 'A chat with this name already exists.'));
                return;
            }
            const oldKey = chat.key;
            const actual = await renameLobbyChat(chat, name);
            // 같은 채팅이 최근 채팅·고른 캐릭터의 채팅·대화 내용 검색 결과에 따로 들어 있을 수 있다. 모두 새 이름으로
            const copies = [...(chats ?? []), ...(allChats ?? []), ...(ownerChats ?? []), ...(content ? content.results.values() : [])]
                .filter(other => other.key === oldKey);
            for (const copy of new Set([chat, ...copies])) {
                copy.fileName = actual;
                copy.key = chatKey(copy);
            }
            if (content?.results.has(oldKey)) {
                const result = /** @type {LobbyChat} */ (content.results.get(oldKey));
                content.results.delete(oldKey);
                content.results.set(result.key, result);
            }
            if (selected.delete(oldKey)) selected.add(chat.key);
            toastr.success(tr('renamed', 'Chat renamed.'), actual);
        } catch (error) {
            console.error(LOG_PREFIX, 'failed to rename chat', error);
            toastr.error(tr('rename_failed', 'Could not rename the chat.'));
        } finally {
            managing = false;
            renderAll();
        }
    };

    /**
     * 같은 캐릭터의 남는 채팅 이름(최근 순). 마지막으로 연 채팅을 지웠을 때 옮겨 갈 곳
     * @param {LobbyChat} chat
     * @param {Set<string>} removing 함께 지우는 채팅 key
     */
    const remainingSiblings = (chat, removing) => (
        // 그 캐릭터를 골라 두었으면 채팅이 전부 있으니 그쪽이 정확하다
        ownerFilter && ownerChats && ownerFilter === ownerKey(chat) ? ownerChats : (chats ?? []))
        .filter(other => !other.groupId && other.avatar === chat.avatar && !removing.has(other.key))
        .map(other => other.fileName);

    /**
     * 지운 채팅을 목록·대화 내용 검색 결과·선택에서 뺀다
     * @param {LobbyChat} chat
     */
    const forgetChat = (chat) => {
        // 최근 목록이 곧 전체일 때는 같은 배열을 쓰므로 함께 바꾼다
        const sameList = allChats === chats;
        if (chats) chats = chats.filter(other => other.key !== chat.key);
        if (allChats) allChats = sameList ? chats : allChats.filter(other => other.key !== chat.key);
        if (ownerChats) ownerChats = ownerChats.filter(other => other.key !== chat.key);
        content?.results.delete(chat.key);
        selected.delete(chat.key);
    };

    /** @param {LobbyChat} chat */
    const deleteChat = async (chat) => {
        if (managing) return;
        if (isOpenChat(chat)) {
            toastr.info(tr('delete_open', 'The chat that is open right now cannot be deleted.'));
            return;
        }

        const body = document.createElement('div');
        const nameLine = document.createElement('div');
        nameLine.className = 'st-lobby-confirm-name';
        nameLine.textContent = chat.fileName;
        const metaLine = document.createElement('div');
        metaLine.textContent = [chat.ownerName, formatShortDate(chat.lastTime), tr('message_count', '{0} messages').replace('{0}', String(chat.count))].filter(Boolean).join(' · ');
        const warning = document.createElement('p');
        warning.className = 'st-lobby-confirm-warning';
        warning.textContent = tr('delete_warning', 'The chat file will be deleted. This cannot be undone.');
        body.append(nameLine, metaLine, warning);

        const confirmed = await Popup.show.confirm(tr('delete_title', 'Delete this chat?'), body.outerHTML, {
            okButton: tr('delete', 'Delete'),
            cancelButton: tr('cancel', 'Cancel'),
        });
        if (!confirmed || !getCandidates().includes(chat)) return;

        managing = true;
        try {
            await deleteLobbyChat(chat, remainingSiblings(chat, new Set([chat.key])));
            forgetChat(chat);
            toastr.success(tr('deleted', 'Chat deleted.'), chat.fileName);
        } catch (error) {
            console.error(LOG_PREFIX, 'failed to delete chat', error);
            toastr.error(tr('delete_failed', 'Could not delete the chat.'));
        } finally {
            managing = false;
            renderAll();
        }
    };

    const deleteSelected = async () => {
        if (managing || !chats) return;
        const targets = getCandidates().filter(chat => selected.has(chat.key) && !isOpenChat(chat));
        if (!targets.length) return;
        if (isChatBusy()) {
            toastr.info(tr('busy', 'Please wait until the reply is finished and the chat is saved.'));
            return;
        }

        const body = document.createElement('div');
        const names = document.createElement('ul');
        names.className = 'st-lobby-confirm-list';
        for (const chat of targets.slice(0, CONFIRM_NAME_LIMIT)) {
            const li = document.createElement('li');
            li.textContent = `${chat.ownerName} – ${chat.fileName}`;
            names.append(li);
        }
        body.append(names);
        if (targets.length > CONFIRM_NAME_LIMIT) {
            const more = document.createElement('div');
            more.textContent = tr('and_more', 'and {0} more').replace('{0}', String(targets.length - CONFIRM_NAME_LIMIT));
            body.append(more);
        }
        const warning = document.createElement('p');
        warning.className = 'st-lobby-confirm-warning';
        warning.textContent = tr('delete_many_warning', 'These chat files will be deleted. This cannot be undone.');
        body.append(warning);

        const confirmed = await Popup.show.confirm(
            tr('delete_many_title', 'Delete {0} chats?').replace('{0}', String(targets.length)),
            body.outerHTML,
            { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') },
        );
        if (!confirmed) return;

        managing = true;
        root.classList.add('st-lobby-busy');
        const label = deleteSelectedButton.querySelector('span');
        const originalLabel = label?.textContent ?? '';
        const removing = new Set(targets.map(chat => chat.key));
        let done = 0;
        let failed = 0;
        try {
            // 하나씩 지운다(그룹 정보 저장이 겹치지 않도록)
            for (const chat of targets) {
                if (label) label.textContent = `${done + failed + 1}/${targets.length}`;
                try {
                    if (isOpenChat(chat)) throw new Error('open chat');
                    await deleteLobbyChat(chat, remainingSiblings(chat, removing));
                    forgetChat(chat);
                    done++;
                } catch (error) {
                    console.error(LOG_PREFIX, 'failed to delete chat', chat, error);
                    failed++;
                }
            }
        } finally {
            managing = false;
            root.classList.remove('st-lobby-busy');
            if (label) label.textContent = originalLabel;
            renderAll();
        }
        if (failed) {
            toastr.warning(tr('delete_many_partial', 'Deleted {0}, failed {1}.').replace('{0}', String(done)).replace('{1}', String(failed)));
        } else {
            toastr.success(tr('delete_many_done', 'Deleted {0} chats.').replace('{0}', String(done)));
        }
        if (!selected.size) setSelecting(false);
    };

    /** @param {boolean} value */
    const setSelecting = (value) => {
        selecting = value;
        if (!selecting) selected.clear();
        renderAll();
    };

    // ── 입력 연결 ──
    fillOwnerOptions();
    sortSelect.value = SORTS.includes(sort) ? sort : 'recent';

    let searchTimer = 0;
    searchInput.addEventListener('input', () => {
        // 글자마다 다시 그리지 않도록 잠깐 기다린다(휴대폰에서 목록이 길 때)
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
            query = searchInput.value;
            dropStaleContentSearch();
            renderAll();
        }, 150);
    });
    searchInput.addEventListener('keydown', (event) => {
        // Enter 는 키보드 닫기(한글 조합 중의 Enter 는 글자 확정)
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        searchInput.blur();
    });
    ownerSelect.addEventListener('change', () => {
        if (managing) {
            ownerSelect.value = ownerFilter;
            return;
        }
        setOwner(ownerSelect.value);
    });
    sortSelect.addEventListener('change', () => {
        sort = /** @type {LobbySort} */ (sortSelect.value);
        if (getSettings().sort !== sort) setSetting('sort', sort);
        renderAll();
    });
    reloadButton.addEventListener('click', () => {
        if (managing) return;
        // 그사이 캐릭터가 추가·삭제됐을 수 있다
        fillOwnerOptions();
        resetAll();
        void load(currentLimit());
        if (ownerFilter) void loadOwner();
    });
    selectToggle.addEventListener('click', () => {
        if (managing) return;
        setSelecting(!selecting);
    });
    selectDoneButton.addEventListener('click', () => {
        if (managing) return;
        setSelecting(false);
    });
    selectAllInput.addEventListener('change', () => {
        const selectable = getSelectableVisible();
        if (selectAllInput.checked) {
            for (const chat of selectable) selected.add(chat.key);
        } else {
            for (const chat of selectable) selected.delete(chat.key);
        }
        renderAll();
    });
    deleteSelectedButton.addEventListener('click', () => void deleteSelected());

    renderAll();
    await load(loadStep());

    return {
        root,
        /** 다시 불러온다(지금 불러온 개수 그대로) */
        refresh: () => load(currentLimit()),
    };
}

/**
 * @param {import('./utils.js').DateBucket} bucket
 */
function getBucketTitle(bucket) {
    switch (bucket.kind) {
        case 'today': return tr('date_today', 'Today');
        case 'yesterday': return tr('date_yesterday', 'Yesterday');
        case 'week': return tr('date_week', 'This week');
        case 'month': return tr('date_month', 'This month');
        case 'older': return formatMonth(bucket.time);
        default: return tr('date_unknown', 'Unknown date');
    }
}

/** @param {import('./data-source.js').LobbyChat} chat */
function createAvatar(chat) {
    if (chat.groupId) {
        const group = groups.find(g => g.id === chat.groupId);
        const avatar = getGroupAvatar(group)?.[0];
        if (avatar instanceof HTMLElement) {
            avatar.classList.add('st-lobby-avatar');
            avatar.querySelectorAll('img').forEach(img => { img.loading = 'lazy'; });
            return avatar;
        }
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'avatar st-lobby-avatar';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = chat.avatar ? getThumbnailUrl('avatar', chat.avatar) : 'img/five.png';
    wrapper.append(img);
    return wrapper;
}

/**
 * 목록 아래의 카드(검색 넓히기·대화 내용 검색 진행). onClick 이 있으면 카드 전체가 버튼이다.
 * @param {object} options
 * @param {string} options.icon Font Awesome 아이콘 클래스
 * @param {string} options.title
 * @param {string} [options.sub] 아래 작은 줄
 * @param {() => void} [options.onClick] 카드를 눌렀을 때
 * @param {{ label: string, onClick: () => void }} [options.action] 오른쪽 작은 버튼(멈추기·다시 검색)
 * @param {number} [options.progress] 0~1. 있으면 아래에 진행 막대
 * @param {'idle' | 'running' | 'done'} [options.tone]
 */
function createCard({ icon, title, sub = '', onClick, action, progress, tone = 'idle' }) {
    const card = document.createElement(onClick ? 'button' : 'div');
    card.className = `st-lobby-card st-lobby-card-${tone}`;
    if (card instanceof HTMLButtonElement) {
        card.type = 'button';
        card.addEventListener('click', onClick);
    }

    const badge = document.createElement('span');
    badge.className = 'st-lobby-card-icon';
    badge.append(createIcon(icon));

    const text = document.createElement('span');
    text.className = 'st-lobby-card-text';
    const titleLine = document.createElement('span');
    titleLine.className = 'st-lobby-card-title';
    titleLine.textContent = title;
    text.append(titleLine);
    if (sub) {
        const subLine = document.createElement('span');
        subLine.className = 'st-lobby-card-sub';
        subLine.textContent = sub;
        text.append(subLine);
    }
    card.append(badge, text);

    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button st-lobby-card-action';
        button.textContent = action.label;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            action.onClick();
        });
        card.append(button);
    } else if (onClick) {
        card.append(createIcon('fa-chevron-right st-lobby-card-chevron'));
    }

    if (typeof progress === 'number') {
        const bar = document.createElement('span');
        bar.className = 'st-lobby-card-progress';
        bar.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
        card.append(bar);
    }
    return card;
}

/** @param {string} text */
function createMessage(text) {
    const div = document.createElement('div');
    div.className = 'st-lobby-message';
    div.textContent = text;
    return div;
}

/** @param {string} classes Font Awesome 아이콘 클래스 */
function createIcon(classes) {
    const i = document.createElement('i');
    i.className = `fa-solid ${classes}`;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

/**
 * @param {string} icon Font Awesome 아이콘 클래스
 * @param {string} title
 * @param {() => void} onClick
 */
function createActionButton(icon, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button st-lobby-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(createIcon(icon));
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
    return button;
}
