import { getThumbnailUrl } from '../../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { getGroupAvatar, groups } from '../../../../group-chats.js';
import { Popup } from '../../../../popup.js';
import { deleteLobbyChat, getSiblingChatNames, isChatBusy, isOpenChat, openLobbyChat, renameLobbyChat } from './chat-actions.js';
import { EXTENSION_NAME, FILTERS, LOG_PREFIX, SORTS } from './constants.js';
import { chatKey, getAllChats, getChatOwners, getMatchedMessage, searchOwnerChats } from './data-source.js';
import { tr } from './i18n.js';
import { askName } from './name-prompt.js';
import { getSettings, setSetting } from './settings.js';
import { formatMonth, formatShortDate, getDateBucket, hasName, highlightText, sanitizeChatName, snippetAround } from './utils.js';

/** @typedef {import('./data-source.js').LobbyChat} LobbyChat */
/** @typedef {'recent' | 'oldest' | 'name' | 'messages' | 'owner'} LobbySort */
/** @typedef {'all' | 'character' | 'group'} LobbyFilter */
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
    const filterSelect = /** @type {HTMLSelectElement} */ (find('.st-lobby-filter'));
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
    /** 늦게 도착한 응답을 버리기 위한 번호 */
    let loadToken = 0;
    let query = '';
    // 보기(캐릭터/그룹)는 기억하지 않는다. 다음에 열었을 때 걸러진 채로 남아 있으면 검색이 안 되는 것처럼 보인다
    /** @type {LobbyFilter} */
    let filter = 'all';
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

    // ── 보이는 목록 ──
    /** @param {LobbyChat} chat */
    const matchesFilter = (chat) => {
        if (filter === 'character') return !chat.groupId;
        if (filter === 'group') return !!chat.groupId;
        return true;
    };

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
     * 목록에 놓일 채팅: 불러온 채팅 + 대화 내용 검색에서 찾은, 아직 안 불러온 채팅
     * @returns {LobbyChat[]}
     */
    const getCandidates = () => {
        if (!chats) return [];
        const found = contentFor()?.results;
        if (!found?.size) return chats;
        const loaded = new Set(chats.map(chat => chat.key));
        return [...chats, ...[...found.values()].filter(chat => !loaded.has(chat.key))];
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
        if (!chats) return [];
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
        renderList();
        renderFooter();
        renderNote();
        renderSelectBar();
        onCount(chats ? `${chats.length}${hasMore ? '+' : ''}` : '');
    };

    const renderList = () => {
        list.replaceChildren();

        if (!chats) {
            if (loadFailed) list.append(createMessage(tr('load_failed', 'Could not load the chats.')));
            return;
        }
        if (chats.length === 0) {
            list.append(createMessage(tr('empty', 'No chats yet.')));
            return;
        }

        const sections = getSections();
        if (sections.length === 0) {
            // 보기(캐릭터/그룹) 때문에 숨은 결과가 있으면 '없음'이 아니라 그렇다고 알려 주고 바로 풀 수 있게 한다
            const hiddenByFilter = filter !== 'all' ? getCandidates().filter(matchesQuery).length : 0;
            if (hiddenByFilter) {
                const kind = filter === 'group' ? tr('filter_group_noun', 'group chats') : tr('filter_character_noun', 'character chats');
                list.append(
                    createMessage(tr('filter_hidden', 'No {0} here. {1} found in other chats.').replace('{0}', kind).replace('{1}', String(hiddenByFilter))),
                    createFooterButton('fa-filter-circle-xmark', tr('show_all', 'Show all'), () => {
                        filter = 'all';
                        filterSelect.value = 'all';
                        renderAll();
                    }),
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
        if (hasMore) {
            const step = loadStep();
            footer.append(createFooterButton('fa-angles-down',
                step ? tr('load_more', 'Load {0} more').replace('{0}', String(step)) : tr('load_all', 'Load all chats'),
                () => loadMore()));
            if (query.trim()) {
                footer.append(
                    createFooterButton('fa-magnifying-glass', tr('search_all', 'Search all chats'), () => load(0)),
                    createHint(tr('search_all_hint', 'Loads every chat. This can take a while if you have many.')),
                );
            }
        }
        if (query.trim()) renderContentFooter();
    };

    /** 대화 내용 검색 버튼·진행 상황 */
    const renderContentFooter = () => {
        const state = contentFor();
        if (!state) {
            footer.append(
                createFooterButton('fa-file-lines', tr('content_search', 'Search conversations too'), () => void startContentSearch()),
                createHint(tr('content_search_hint', 'Reads every chat file to the end, so it can take a while. You can stop it anytime.')),
            );
            return;
        }

        const found = state.results.size;
        if (state.phase === 'search' || state.phase === 'snippet') {
            const text = state.phase === 'search'
                ? tr('content_searching', 'Searching conversations… {0}/{1}')
                : tr('content_snippets', 'Loading matched messages… {0}/{1}');
            const message = createMessage(text.replace('{0}', String(state.completed)).replace('{1}', String(state.total)));
            message.prepend(createIcon('fa-spinner fa-spin'), ' ');
            footer.append(message, createFooterButton('fa-stop', tr('content_stop', 'Stop'), () => stopContentSearch()));
            return;
        }

        const summary = state.phase === 'stopped'
            ? tr('content_stopped', 'Stopped. Found {0} chats so far.')
            : tr('content_done', 'Conversation search finished. Found {0} chats.');
        footer.append(createMessage(summary.replace('{0}', String(found))));
        if (state.failed) {
            footer.append(createHint(tr('content_failed', 'Could not read {0} characters/groups.').replace('{0}', String(state.failed))));
        }
        if (state.phase === 'stopped' || state.failed) {
            footer.append(createFooterButton('fa-rotate-right', tr('content_again', 'Search again'), () => void startContentSearch()));
        }
    };

    /** @param {string} text */
    const createHint = (text) => {
        const hint = document.createElement('small');
        hint.className = 'st-lobby-footer-hint';
        hint.textContent = text;
        return hint;
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

        const owners = getChatOwners();
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

    /** 불러온 일부만으로 검색·정렬하고 있다는 안내 */
    const renderNote = () => {
        const partial = !!chats && hasMore && (!!query.trim() || filter !== 'all' || sort !== 'recent');
        note.hidden = !partial;
        note.textContent = partial
            ? tr('partial_note', 'Showing only the {0} most recent chats loaded so far.').replace('{0}', String(chats.length))
            : '';
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
        const date = document.createElement('span');
        date.className = 'st-lobby-date';
        date.textContent = formatShortDate(chat.lastTime);
        top.append(owner, date);

        const name = document.createElement('div');
        name.className = 'st-lobby-name';
        name.append(...highlightText(chat.fileName, words));

        const preview = document.createElement('div');
        preview.className = 'st-lobby-preview';
        const place = words.length ? getPlace(chat, words) : null;
        // 대화 내용에서 찾았으면 찾은 메시지를 보여 준다(불러온 채팅이면 결과 쪽 객체에 들어 있다)
        const snippet = place === 'content' ? contentFor()?.results.get(chat.key)?.snippet : undefined;
        if (place === 'content' && snippet) {
            preview.append(...highlightText(snippetAround(snippet, words), words));
        } else if (place === 'content' && snippet === undefined && contentFor()?.phase === 'snippet') {
            preview.textContent = tr('snippet_loading', 'Loading the matched message…');
            preview.classList.add('st-lobby-preview-empty');
        } else if (chat.preview) {
            // 미리보기는 두 줄만 보이므로, 마지막 메시지에서 찾았으면 찾은 글자 근처부터 보여 준다
            const fromMessage = place === 'message';
            preview.append(...highlightText(fromMessage ? snippetAround(chat.preview, words) : chat.preview, words));
        } else {
            preview.textContent = tr('preview_empty', '(No messages)');
            preview.classList.add('st-lobby-preview-empty');
        }

        const meta = document.createElement('div');
        meta.className = 'st-lobby-meta';
        meta.textContent = [tr('message_count', '{0} messages').replace('{0}', String(chat.count)), chat.size].filter(Boolean).join(' · ');
        if (open) {
            const badge = document.createElement('span');
            badge.className = 'st-lobby-badge';
            badge.textContent = tr('open_badge', 'Open now');
            meta.append(' ', badge);
        }

        body.append(top, name, preview, meta);
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

        item.append(main);

        if (!selecting) {
            const actions = document.createElement('div');
            actions.className = 'st-lobby-actions';
            const renameButton = createActionButton('fa-pen', tr('rename_title', 'Rename chat'), () => renameChat(chat));
            const deleteButton = createActionButton('fa-trash-can', tr('delete_button', 'Delete chat'), () => deleteChat(chat));
            deleteButton.classList.add('st-lobby-delete');
            if (open) {
                // 막아 두되 누르면 이유를 알려 준다(휴대폰에서는 비활성 버튼의 설명을 볼 수 없다)
                deleteButton.setAttribute('aria-disabled', 'true');
                deleteButton.title = tr('delete_open', 'The chat that is open right now cannot be deleted.');
            }
            actions.append(renameButton, deleteButton);
            item.append(actions);
        }
        return item;
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
            chat.fileName = actual;
            chat.key = chatKey(chat);
            if (selected.delete(oldKey)) selected.add(chat.key);
            // 대화 내용 검색 결과에도 같은 채팅이 따로 들어 있을 수 있다
            const result = content?.results.get(oldKey);
            if (content && result) {
                content.results.delete(oldKey);
                result.fileName = actual;
                result.key = chat.key;
                content.results.set(chat.key, result);
            }
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
    const remainingSiblings = (chat, removing) => (chats ?? [])
        .filter(other => !other.groupId && other.avatar === chat.avatar && !removing.has(other.key))
        .map(other => other.fileName);

    /**
     * 지운 채팅을 목록·대화 내용 검색 결과·선택에서 뺀다
     * @param {LobbyChat} chat
     */
    const forgetChat = (chat) => {
        chats = (chats ?? []).filter(other => other.key !== chat.key);
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
    filterSelect.value = FILTERS.includes(filter) ? filter : 'all';
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
    filterSelect.addEventListener('change', () => {
        filter = /** @type {LobbyFilter} */ (filterSelect.value);
        renderAll();
    });
    sortSelect.addEventListener('change', () => {
        sort = /** @type {LobbySort} */ (sortSelect.value);
        if (getSettings().sort !== sort) setSetting('sort', sort);
        renderAll();
    });
    reloadButton.addEventListener('click', () => {
        if (managing) return;
        void load(currentLimit());
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
