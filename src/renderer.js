// ===== Renderer — TipTap WYSIWYG Mink Editor =====
import './styles/app.css';
import './styles/editor.css';
import { Editor, Extension, InputRule, getMarkRange, markPasteRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import { Highlight } from '@tiptap/extension-highlight';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { common, createLowlight } from 'lowlight';
import { htmlToMarkdown, markdownToHtml } from './markdown.js';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// ===== Lowlight Setup =====
const lowlight = createLowlight(common);

// ===== Search Plugin =====
const searchPluginKey = new PluginKey('searchHighlight');

const SearchHighlight = Extension.create({
    name: 'searchHighlight',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: searchPluginKey,
                state: {
                    init() { return { matches: [], activeIndex: -1 }; },
                    apply(tr, prev) {
                        const meta = tr.getMeta(searchPluginKey);
                        if (meta) return meta;
                        if (tr.docChanged && prev.matches.length > 0) {
                            return {
                                matches: prev.matches.map(m => ({
                                    from: tr.mapping.map(m.from),
                                    to: tr.mapping.map(m.to),
                                })).filter(m => m.from < m.to),
                                activeIndex: prev.activeIndex,
                            };
                        }
                        return prev;
                    },
                },
                props: {
                    decorations(state) {
                        const { matches, activeIndex } = this.getState(state);
                        if (!matches || matches.length === 0) return DecorationSet.empty;
                        const decos = matches.map((m, i) =>
                            Decoration.inline(m.from, m.to, {
                                class: i === activeIndex ? 'search-highlight-active' : 'search-highlight',
                            })
                        );
                        return DecorationSet.create(state.doc, decos);
                    },
                },
            }),
        ];
    },
});

// ===== Typora-Style Inline Syntax Editing =====
const inlineBoldStarInputRegex = /(?<!\*)\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*)$/;
const inlineBoldStarPasteRegex = /(?<!\*)\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*)/g;
const inlineBoldUnderscoreInputRegex = /(?<!_)__(?!\s+__)((?:[^_]+))__(?!\s+__)$/;
const inlineBoldUnderscorePasteRegex = /(?<!_)__(?!\s+__)((?:[^_]+))__(?!\s+__)/g;
const inlineItalicStarInputRegex = /(?<!\*)\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*)$/;
const inlineItalicStarPasteRegex = /(?<!\*)\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*)/g;
const inlineItalicUnderscoreInputRegex = /(?<!_)_(?!\s+_)((?:[^_]+))_(?!\s+_)$/;
const inlineItalicUnderscorePasteRegex = /(?<!_)_(?!\s+_)((?:[^_]+))_(?!\s+_)/g;

let _activeInlineReveal = null;
let _syncingInlineReveal = false;
let _inlineRevealJustExpanded = false;
let _inlineRevealLastKeyEvent = null;
let _inlineRevealSuppressNextSelectionExpand = false;
const inlineRevealSyncMetaKey = 'inlineRevealSync';

function findActiveMarkRange(state, markName) {
    const { selection } = state;
    if (!selection.empty) return null;

    const tryAt = ($resolvedPos) => {
        const direct = $resolvedPos.marks().find(m => m.type.name === markName);
        const fromRight = ($resolvedPos.nodeAfter?.marks || []).find(m => m.type.name === markName);
        const fromLeft = ($resolvedPos.nodeBefore?.marks || []).find(m => m.type.name === markName);
        const mark = direct || fromRight || fromLeft;
        if (!mark) return null;
        const range = getMarkRange($resolvedPos, mark.type, mark.attrs);
        if (!range) return null;
        return range;
    };

    let range = tryAt(selection.$from);
    if (!range && selection.from > 1) {
        // Back off one char for boundary resolution only.
        range = tryAt(state.doc.resolve(selection.from - 1));
    }
    if (!range) return null;

    // Candidate must be within mark edges (left/right edge included).
    if (selection.from < range.from || selection.from > range.to) return null;
    return range;
}

function getRevealSyntax(markName) {
    if (markName === 'bold') return '**';
    if (markName === 'italic') return '*';
    return '';
}

function findRevealCandidate(state) {
    for (const markName of ['bold', 'italic']) {
        const range = findActiveMarkRange(state, markName);
        if (!range) continue;
        const markType = state.schema.marks[markName];
        if (!markType) continue;
        return { markName, range, markType, syntax: getRevealSyntax(markName) };
    }
    return null;
}

function findRevealCandidateRightOutside(state) {
    const { selection, schema } = state;
    if (!selection.empty) return null;
    const pos = selection.from;
    if (pos <= 1) return null;
    const $pos = state.doc.resolve(pos - 1);

    for (const markName of ['bold', 'italic']) {
        const markType = schema.marks[markName];
        if (!markType) continue;
        const mark =
            $pos.marks().find(m => m.type.name === markName) ||
            ($pos.nodeAfter?.marks || []).find(m => m.type.name === markName) ||
            ($pos.nodeBefore?.marks || []).find(m => m.type.name === markName);
        if (!mark) continue;
        const range = getMarkRange($pos, mark.type, mark.attrs);
        if (!range) continue;
        if (pos === range.to + 1) {
            return { markName, range, markType, syntax: getRevealSyntax(markName) };
        }
    }
    return null;
}

function createTyporaRevealInputRule(type, syntax, find, markName) {
    return new InputRule({
        find,
        handler: ({ state, range, match }) => {
            const innerText = match[1];
            const fullMatch = match[0] || '';
            if (!innerText) return;
            const innerOffset = fullMatch.indexOf(innerText);
            if (innerOffset < 0) return;

            const tr = state.tr;
            const textStart = range.from + innerOffset;
            const textEnd = textStart + innerText.length;

            if (textEnd < range.to) tr.delete(textEnd, range.to);
            if (textStart > range.from) tr.delete(range.from, textStart);

            const markFrom = range.from;
            const markTo = markFrom + innerText.length;
            const boldType = state.schema.marks.bold;
            const italicType = state.schema.marks.italic;
            if (markName === 'bold' && italicType) tr.removeMark(markFrom, markTo, italicType);
            if (markName === 'italic' && boldType) tr.removeMark(markFrom, markTo, boldType);
            tr.addMark(markFrom, markTo, type.create());
            tr.removeStoredMark(type);
            tr.setStoredMarks([]);

            tr.insertText(syntax, markTo);
            tr.insertText(syntax, markFrom);
            tr.removeMark(markFrom, markFrom + syntax.length, type);
            tr.removeMark(markTo + syntax.length, markTo + syntax.length * 2, type);

            const caret = markTo + syntax.length * 2;
            tr.setSelection(TextSelection.create(tr.doc, caret));
            tr.setMeta(inlineRevealSyncMetaKey, true);

            _activeInlineReveal = {
                markName,
                syntax,
                start: markFrom,
                end: markTo + syntax.length * 2,
                semantic: markName,
                leftLen: syntax.length,
                rightLen: syntax.length,
            };
            _inlineRevealJustExpanded = true;
            _syncingInlineReveal = true;
            return tr;
        },
    });
}

function expandInlineReveal(ed, candidate) {
    if (!candidate || !candidate.syntax) return;
    const { markName, range, markType, syntax } = candidate;
    const len = syntax.length;
    const oldPos = ed.state.selection.from;
    const doc = ed.state.doc;

    // If delimiters already exist around the range (e.g. state recovered after edits),
    // do not insert again to avoid duplicated asterisks.
    const hasLeft = range.from >= len && doc.textBetween(range.from - len, range.from, '\n', '\n') === syntax;
    const hasRight = doc.textBetween(range.to, range.to + len, '\n', '\n') === syntax;
    if (hasLeft && hasRight) {
        _activeInlineReveal = {
            markName,
            syntax,
            start: range.from - len,
            end: range.to + len,
        };
        return;
    }

    // Set active state before dispatch to avoid re-entrant onUpdate/onSelectionUpdate
    // reading a stale "not expanded" status.
    _activeInlineReveal = {
        markName,
        syntax,
        start: range.from,
        end: range.to + 2 * len,
        semantic: markName,
        leftLen: len,
        rightLen: len,
    };
    _inlineRevealJustExpanded = true;

    const tr = ed.state.tr;
    const boldType = ed.state.schema.marks.bold;
    const italicType = ed.state.schema.marks.italic;

    tr.insertText(syntax, range.to);
    tr.insertText(syntax, range.from);

    if (markName === 'bold' && italicType) tr.removeMark(range.from, range.to, italicType);
    if (markName === 'italic' && boldType) tr.removeMark(range.from, range.to, boldType);

    // Delimiters should remain plain text.
    tr.removeMark(range.from, range.from + len, markType);
    tr.removeMark(range.to + len, range.to + 2 * len, markType);

    const clampedPos = Math.max(range.from, Math.min(oldPos, range.to));
    let newPos = clampedPos + len;
    // At right edge, Typora keeps caret after the closing delimiter.
    if (oldPos === range.to) {
        newPos = range.to + 2 * len;
    } else if (oldPos > range.to) {
        // Keep stable relative caret position for right-outside fallback
        // (common when trailing plain text is deleted).
        newPos = tr.mapping.map(oldPos, 1);
    }
    tr.setSelection(TextSelection.create(tr.doc, newPos));
    tr.setMeta(inlineRevealSyncMetaKey, true);

    _syncingInlineReveal = true;
    ed.view.dispatch(tr);
    _syncingInlineReveal = false;
}

function collapseInlineReveal(ed) {
    if (!_activeInlineReveal) return;
    const { markName, syntax, start, end } = _activeInlineReveal;
    const len = syntax.length;
    const state = ed.state;
    const markerChar = syntax[0];
    let revealStart = start;
    let revealEnd = end;

    // Boundaries can drift by one char after marker edits; absorb nearby markers
    // so collapse always parses a complete inline fragment.
    let absorbLeft = 0;
    while (absorbLeft < len && revealStart > 1) {
        const ch = state.doc.textBetween(revealStart - 1, revealStart, '\n', '\n');
        if (ch !== markerChar) break;
        revealStart -= 1;
        absorbLeft += 1;
    }
    let absorbRight = 0;
    while (absorbRight < len && revealEnd < state.doc.content.size) {
        const ch = state.doc.textBetween(revealEnd, revealEnd + 1, '\n', '\n');
        if (ch !== markerChar) break;
        revealEnd += 1;
        absorbRight += 1;
    }

    const segment = state.doc.textBetween(revealStart, revealEnd, '\n', '\n');
    const oldPos = state.selection.from;

    let parsedType = null;
    let parsedInner = null;
    if (markName === 'bold') {
        const m = segment.match(/^\*\*([\s\S]+)\*\*$/) || segment.match(/^__([\s\S]+)__$/);
        if (m) {
            parsedType = 'bold';
            parsedInner = m[1];
        }
        if (!parsedType) {
            const mi = segment.match(/^\*([\s\S]+)\*$/) || segment.match(/^_([\s\S]+)_$/);
            if (mi) {
                parsedType = 'italic';
                parsedInner = mi[1];
            }
        }
        if (!parsedType) {
            if (segment.startsWith('**') && segment.endsWith('*') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(2, -1);
            } else if (segment.startsWith('*') && segment.endsWith('**') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(1, -2);
            } else if (segment.startsWith('__') && segment.endsWith('_') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(2, -1);
            } else if (segment.startsWith('_') && segment.endsWith('__') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(1, -2);
            }
        }
    } else if (markName === 'italic') {
        const m = segment.match(/^\*([\s\S]+)\*$/) || segment.match(/^_([\s\S]+)_$/);
        if (m) {
            parsedType = 'italic';
            parsedInner = m[1];
        }
        if (!parsedType) {
            const mb = segment.match(/^\*\*([\s\S]+)\*\*$/) || segment.match(/^__([\s\S]+)__$/);
            if (mb) {
                parsedType = 'bold';
                parsedInner = mb[1];
            }
        }
    }

    const tr = state.tr;
    tr.delete(revealStart, revealEnd);

    let insertedLen = 0;
    if (parsedType && parsedInner !== null) {
        const markType = state.schema.marks[parsedType];
        const boldType = state.schema.marks.bold;
        const italicType = state.schema.marks.italic;
        if (parsedInner.length > 0 && markType) {
            tr.insertText(parsedInner, revealStart);
            if (parsedType === 'bold' && italicType) tr.removeMark(revealStart, revealStart + parsedInner.length, italicType);
            if (parsedType === 'italic' && boldType) tr.removeMark(revealStart, revealStart + parsedInner.length, boldType);
            tr.addMark(revealStart, revealStart + parsedInner.length, markType.create());
            insertedLen = parsedInner.length;
        }
    } else {
        tr.insertText(segment, revealStart);
        insertedLen = segment.length;
    }

    let newPos = oldPos;
    if (oldPos > revealEnd) {
        newPos = oldPos - (revealEnd - revealStart) + insertedLen;
    } else if (oldPos >= revealStart) {
        if (parsedType && parsedInner !== null) {
            newPos = revealStart + Math.max(0, Math.min((oldPos - revealStart) - len, insertedLen));
        } else {
            newPos = revealStart + Math.max(0, Math.min(oldPos - revealStart, insertedLen));
        }
    }
    tr.setSelection(TextSelection.create(tr.doc, Math.max(1, Math.min(newPos, tr.doc.content.size))));
    tr.setMeta(inlineRevealSyncMetaKey, true);

    _syncingInlineReveal = true;
    ed.view.dispatch(tr);
    _syncingInlineReveal = false;
    _activeInlineReveal = null;
    _inlineRevealJustExpanded = false;
}

function reconcileActiveBoldRevealMarks(ed) {
    if (!_activeInlineReveal || _activeInlineReveal.markName !== 'bold') return false;
    const { start, end } = _activeInlineReveal;
    const state = ed.state;
    const segment = state.doc.textBetween(start, end, '\n', '\n');

    let target = null;
    let leftLen = 0;
    let rightLen = 0;
    if ((segment.startsWith('**') && segment.endsWith('**') && segment.length >= 4) ||
        (segment.startsWith('__') && segment.endsWith('__') && segment.length >= 4)) {
        target = 'bold';
        leftLen = 2; rightLen = 2;
    } else if ((segment.startsWith('*') && segment.endsWith('*') && segment.length >= 2) ||
        (segment.startsWith('_') && segment.endsWith('_') && segment.length >= 2)) {
        target = 'italic';
        leftLen = 1; rightLen = 1;
    } else if (segment.startsWith('**') && segment.endsWith('*') && segment.length >= 3) {
        target = 'italic';
        leftLen = 2; rightLen = 1;
    } else if (segment.startsWith('*') && segment.endsWith('**') && segment.length >= 3) {
        target = 'italic';
        leftLen = 1; rightLen = 2;
    } else if (segment.startsWith('__') && segment.endsWith('_') && segment.length >= 3) {
        target = 'italic';
        leftLen = 2; rightLen = 1;
    } else if (segment.startsWith('_') && segment.endsWith('__') && segment.length >= 3) {
        target = 'italic';
        leftLen = 1; rightLen = 2;
    } else {
        return false;
    }

    if (
        _activeInlineReveal.semantic === target &&
        _activeInlineReveal.leftLen === leftLen &&
        _activeInlineReveal.rightLen === rightLen
    ) {
        return false;
    }

    const innerFrom = start + leftLen;
    const innerTo = end - rightLen;
    if (innerFrom > innerTo) return false;

    const boldType = state.schema.marks.bold;
    const italicType = state.schema.marks.italic;
    const targetType = target === 'bold' ? boldType : italicType;
    if (!targetType) return false;

    const tr = state.tr;
    if (boldType) tr.removeMark(start, end, boldType);
    if (italicType) tr.removeMark(start, end, italicType);
    if (innerFrom < innerTo) {
        tr.addMark(innerFrom, innerTo, targetType.create());
    }
    tr.setMeta(inlineRevealSyncMetaKey, true);

    _activeInlineReveal.semantic = target;
    _activeInlineReveal.leftLen = leftLen;
    _activeInlineReveal.rightLen = rightLen;
    _syncingInlineReveal = true;
    ed.view.dispatch(tr);
    _syncingInlineReveal = false;
    return true;
}

function syncInlineReveal(ed, transaction = null) {
    if (!ed) return;
    if (_syncingInlineReveal) {
        if (transaction?.getMeta?.(inlineRevealSyncMetaKey)) {
            _syncingInlineReveal = false;
        }
        return;
    }
    if (isSourceMode) return;
    if (transaction?.getMeta?.(inlineRevealSyncMetaKey)) return;
    if (transaction?.docChanged) {
        _inlineRevealSuppressNextSelectionExpand = true;
    }
    if (_activeInlineReveal && transaction?.docChanged) {
        _activeInlineReveal.start = transaction.mapping.map(_activeInlineReveal.start, -1);
        _activeInlineReveal.end = transaction.mapping.map(_activeInlineReveal.end, -1);
        if (_activeInlineReveal.end < _activeInlineReveal.start) {
            _activeInlineReveal.end = _activeInlineReveal.start;
        }
        if (reconcileActiveBoldRevealMarks(ed)) return;
    }

    const { selection } = ed.state;
    if (!transaction && _inlineRevealLastKeyEvent) {
        const key = _inlineRevealLastKeyEvent.key;
        const recent = (Date.now() - _inlineRevealLastKeyEvent.at) < 220;
        const isTypingOrDelete = key.length === 1 || key === 'Backspace' || key === 'Delete';
        if (recent && isTypingOrDelete) return;
    }
    if (_activeInlineReveal) {
        if (_inlineRevealJustExpanded) {
            const pos = selection.empty ? selection.from : -1;
            const stillInside = selection.empty && pos >= _activeInlineReveal.start && pos <= _activeInlineReveal.end;
            _inlineRevealJustExpanded = false;
            if (stillInside) return;
        }
        if (!selection.empty) {
            collapseInlineReveal(ed);
            return;
        }

        const pos = selection.from;
        if (pos < _activeInlineReveal.start || pos > _activeInlineReveal.end) {
            collapseInlineReveal(ed);
            return;
        }
        return;
    }

    if (!selection.empty) return;
    if (!transaction && _inlineRevealSuppressNextSelectionExpand) {
        _inlineRevealSuppressNextSelectionExpand = false;
        return;
    }

    const recentDelete =
        _inlineRevealLastKeyEvent &&
        (Date.now() - _inlineRevealLastKeyEvent.at) < 220 &&
        (_inlineRevealLastKeyEvent.key === 'Backspace' || _inlineRevealLastKeyEvent.key === 'Delete');

    let candidate = findRevealCandidate(ed.state);
    if (!candidate && transaction?.docChanged && recentDelete) {
        candidate = findRevealCandidateRightOutside(ed.state);
    }
    if (candidate) {
        _inlineRevealSuppressNextSelectionExpand = false;
        expandInlineReveal(ed, candidate);
    }
}

function handleInlineRevealKeyDown(ed, event) {
    if (!_activeInlineReveal) return false;
    if (!ed || isSourceMode) return false;
    const { selection, doc } = ed.state;
    if (!selection.empty) return false;
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false;

    const markerChar = _activeInlineReveal.syntax[0];
    const pos = selection.from;

    if (event.key === 'Backspace' && pos > 1) {
        const ch = doc.textBetween(pos - 1, pos, '\n', '\n');
        if (ch === markerChar) {
            const tr = ed.state.tr;
            tr.delete(pos - 1, pos);
            tr.setSelection(TextSelection.create(tr.doc, pos - 1));
            ed.view.dispatch(tr);
            event.preventDefault();
            return true;
        }
    }

    if (event.key === 'Delete') {
        const ch = doc.textBetween(pos, pos + 1, '\n', '\n');
        if (ch === markerChar) {
            const tr = ed.state.tr;
            tr.delete(pos, pos + 1);
            tr.setSelection(TextSelection.create(tr.doc, pos));
            ed.view.dispatch(tr);
            event.preventDefault();
            return true;
        }
    }

    return false;
}

const TyporaBold = Bold.extend({
    inclusive: false,
    addInputRules() {
        return [
            createTyporaRevealInputRule(this.type, '**', inlineBoldStarInputRegex, 'bold'),
            createTyporaRevealInputRule(this.type, '**', inlineBoldUnderscoreInputRegex, 'bold'),
        ];
    },
    addPasteRules() {
        return [
            markPasteRule({
                find: inlineBoldStarPasteRegex,
                type: this.type,
            }),
            markPasteRule({
                find: inlineBoldUnderscorePasteRegex,
                type: this.type,
            }),
        ];
    },
});

const TyporaItalic = Italic.extend({
    inclusive: false,
    addInputRules() {
        return [
            createTyporaRevealInputRule(this.type, '*', inlineItalicStarInputRegex, 'italic'),
            createTyporaRevealInputRule(this.type, '_', inlineItalicUnderscoreInputRegex, 'italic'),
        ];
    },
    addPasteRules() {
        return [
            markPasteRule({
                find: inlineItalicStarPasteRegex,
                type: this.type,
            }),
            markPasteRule({
                find: inlineItalicUnderscorePasteRegex,
                type: this.type,
            }),
        ];
    },
});

// ===== WYSIWYG Thick Cursor Overlay =====
let _wysiwygComposing = false;

function updateEditorCursor() {
    const cursorEl = document.getElementById('editor-cursor');
    if (cursorEl) cursorEl.classList.add('hidden');
}

// ===== Editor Instance =====
let editor = null;
let isSourceMode = false;
let suppressModified = false;

function initEditor() {
    editor = new Editor({
        element: document.getElementById('editor'),
        extensions: [
            StarterKit.configure({
                codeBlock: false, // Use CodeBlockLowlight instead
                horizontalRule: false, // Use custom
                link: false, // Use separately configured Link
                bold: false, // Use custom bold input rules
                italic: false, // Use custom italic input rules
            }),
            TyporaBold,
            TyporaItalic,
            CodeBlockLowlight.configure({ lowlight }),
            HorizontalRule,
            TaskList,
            TaskItem.configure({ nested: true }),
            Table.configure({ resizable: true }),
            TableRow,
            TableCell,
            TableHeader,
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { class: 'editor-link' },
            }),
            Image.configure({ inline: true }),
            Placeholder.configure({ placeholder: '开始写作…' }),
            Typography,
            Highlight,
            SearchHighlight,

        ],
        content: '<p></p>',
        autofocus: true,
        editorProps: {
            attributes: {
                class: 'mink-editor',
                spellcheck: 'false',
            },
            handleDOMEvents: {
                compositionstart: (view) => {
                    _wysiwygComposing = true;
                    view.dom.classList.add('is-composing');
                    updateEditorCursor();
                    return false;
                },
                compositionend: (view) => {
                    _wysiwygComposing = false;
                    view.dom.classList.remove('is-composing');
                    setTimeout(() => updateEditorCursor(), 20);
                    return false;
                },
                focus: () => {
                    updateEditorCursor();
                    requestAnimationFrame(updateEditorCursor);
                    return false;
                },
                blur: () => {
                    if (_activeInlineReveal) collapseInlineReveal(editor);
                    updateEditorCursor();
                    return false;
                },
            },
        },
        onUpdate: ({ editor: ed, transaction }) => {
            syncInlineReveal(ed, transaction);
            if (suppressModified) return;
            if (window.electronAPI) window.electronAPI.contentModified();
            updateStats(ed);
            updateOutline(ed);
        },
        onSelectionUpdate: () => {
            syncInlineReveal(editor);
            updateStats(editor);
            updateEditorCursor();
        },
    });

    // Expose getMarkdown for main process save
    window.__getMarkdown = () => {
        if (isSourceMode) {
            return document.getElementById('source-editor').value;
        }
        return htmlToMarkdown(editor.getHTML());
    };

    updateStats(editor);
}

// ===== Stats =====
function updateStats(ed) {
    const text = ed.getText();
    const charCount = text.length;
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const wordCount = chineseChars + englishWords;
    const lineCount = text.split('\n').length;

    document.getElementById('status-words').textContent = `${wordCount} 字`;
    document.getElementById('status-chars').textContent = `${charCount} 字符`;
    document.getElementById('status-lines').textContent = `${lineCount} 行`;
}

// ===== Outline =====
function updateOutline(ed) {
    const panel = document.getElementById('outline-panel');
    const json = ed.getJSON();
    const headings = [];

    function walkNodes(nodes) {
        if (!nodes) return;
        for (const node of nodes) {
            if (node.type === 'heading' && node.content) {
                const text = node.content.map(c => c.text || '').join('');
                headings.push({ level: node.attrs.level, text });
            }
            if (node.content) walkNodes(node.content);
        }
    }
    walkNodes(json.content);

    panel.innerHTML = headings.length === 0
        ? '<p class="outline-empty">无标题</p>'
        : headings.map(h => `<div class="outline-item outline-h${h.level}" data-text="${h.text}">${h.text}</div>`).join('');

    // Click to scroll to heading
    panel.querySelectorAll('.outline-item').forEach(item => {
        item.addEventListener('click', () => {
            const text = item.dataset.text;
            // Find the heading node and scroll to it
            const dom = document.querySelector('.mink-editor');
            const headingEls = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
            for (const el of headingEls) {
                if (el.textContent === text) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    break;
                }
            }
        });
    });
}

// ===== Sidebar =====
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const tabs = document.querySelectorAll('.sidebar-tab');
    const panels = document.querySelectorAll('.sidebar-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab === 'files' ? 'file-tree' : 'outline-panel').classList.add('active');
        });
    });

    // Toggle sidebar
    document.getElementById('btn-sidebar').addEventListener('click', toggleSidebar);

    // New file button
    document.getElementById('btn-new-file').addEventListener('click', async () => {
        if (window.electronAPI) {
            const result = await window.electronAPI.createFileInFolder();
            if (result && result.error) alert(result.error);
        }
    });

    // Close context menu on click elsewhere
    document.addEventListener('click', () => {
        const existing = document.getElementById('ctx-menu');
        if (existing) existing.remove();
    });
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('hidden');
}

function showContextMenu(e, item) {
    e.preventDefault();
    e.stopPropagation();
    const existing = document.getElementById('ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.className = 'context-menu';
    menu.innerHTML = `
        <div class="ctx-item" data-action="rename">重命名</div>
        <div class="ctx-item" data-action="delete">删除</div>
    `;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    menu.querySelector('[data-action="rename"]').addEventListener('click', async () => {
        menu.remove();
        const newName = prompt('输入新文件名:', item.name);
        if (!newName || newName === item.name) return;
        const fileName = newName.endsWith('.md') ? newName : newName + '.md';
        if (window.electronAPI) {
            const result = await window.electronAPI.renameFile(item.path, fileName);
            if (result.error) alert(result.error);
        }
    });

    menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        menu.remove();
        if (window.electronAPI) {
            await window.electronAPI.deleteFile(item.path);
        }
    });
}

function renderFileTree(tree, container, level = 0) {
    container.innerHTML = '';
    if (!tree || tree.length === 0) {
        container.innerHTML = '<p class="tree-empty">打开文件夹以查看文件</p>';
        return;
    }

    const ul = document.createElement('ul');
    ul.className = 'file-tree-list';

    for (const item of tree) {
        const li = document.createElement('li');
        li.style.paddingLeft = `${level * 16 + 8}px`;

        if (item.isDir) {
            li.className = 'tree-folder';
            li.innerHTML = `<span class="folder-icon">▶</span> ${item.name}`;
            const childContainer = document.createElement('div');
            childContainer.className = 'tree-children hidden';
            renderFileTree(item.children, childContainer, level + 1);
            li.appendChild(childContainer);

            li.addEventListener('click', (e) => {
                e.stopPropagation();
                childContainer.classList.toggle('hidden');
                li.querySelector('.folder-icon').textContent = childContainer.classList.contains('hidden') ? '▶' : '▼';
            });
        } else {
            li.className = 'tree-file';
            li.innerHTML = `📄 ${item.name}`;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                window.electronAPI.openFileFromPath(item.path);
            });
            // Right-click context menu
            li.addEventListener('contextmenu', (e) => showContextMenu(e, item));
        }

        ul.appendChild(li);
    }

    container.appendChild(ul);
}

// ===== Source Mode =====
function toggleSourceMode() {
    if (!isSourceMode && _activeInlineReveal) {
        collapseInlineReveal(editor);
    }
    isSourceMode = !isSourceMode;
    const editorEl = document.getElementById('editor');
    const sourceContainer = document.getElementById('source-container');
    const sourceEl = document.getElementById('source-editor');
    const btn = document.getElementById('btn-source');

    if (isSourceMode) {
        // Hide editor cursor
        const editorCursorEl = document.getElementById('editor-cursor');
        if (editorCursorEl) editorCursorEl.classList.add('hidden');
        // Get text before cursor in WYSIWYG
        const cursorPos = editor.state.selection.from;
        const textBefore = editor.state.doc.textBetween(0, cursorPos, '\n', '\n');

        const md = htmlToMarkdown(editor.getHTML());
        sourceEl.value = md;
        editorEl.classList.add('hidden');
        sourceContainer.classList.remove('hidden');

        // Calculate cursor position in markdown
        let targetPos = 0;
        if (textBefore.length > 0) {
            const approxRatio = cursorPos / Math.max(1, editor.state.doc.content.size);
            const approxMdPos = Math.round(approxRatio * md.length);
            for (let len = Math.min(30, textBefore.length); len >= 3; len--) {
                const search = textBefore.slice(-len);
                let bestIdx = -1, bestDist = Infinity;
                let idx = md.indexOf(search);
                while (idx !== -1) {
                    const dist = Math.abs(idx + search.length - approxMdPos);
                    if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
                    idx = md.indexOf(search, idx + 1);
                }
                if (bestIdx !== -1) { targetPos = bestIdx + search.length; break; }
            }
        }
        sourceEl.selectionStart = sourceEl.selectionEnd = targetPos;
        sourceEl.classList.add('hide-caret');
        sourceEl.focus();
        btn.classList.add('active');
        updateLineNumbers();
        requestAnimationFrame(updateSourceLineHighlight);
    } else {
        const caretPos = sourceEl.selectionStart;
        const md = sourceEl.value;
        const mdBefore = md.substring(0, caretPos);
        const plainBefore = mdBefore
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/\*\*|__|~~|`/g, '')
            .replace(/^>\s*/gm, '')
            .replace(/^[-*+]\s+/gm, '')
            .replace(/^\d+\.\s+/gm, '')
            .replace(/^---+$/gm, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

        const html = markdownToHtml(md);
        suppressModified = true;
        editor.commands.setContent(html);
        suppressModified = false;
        sourceContainer.classList.add('hidden');
        editorEl.classList.remove('hidden');

        // Search for text near cursor in editor
        const fullText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
        let pos = 1;
        if (plainBefore.length > 0) {
            const approxRatio = md.length > 0 ? caretPos / md.length : 0;
            for (let len = Math.min(30, plainBefore.length); len >= 3; len--) {
                const search = plainBefore.slice(-len);
                let bestIdx = -1;
                let bestDist = Infinity;
                let idx = fullText.indexOf(search);
                while (idx !== -1) {
                    const endPos = idx + search.length;
                    const approxTextPos = Math.round(approxRatio * fullText.length);
                    const dist = Math.abs(endPos - approxTextPos);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = idx;
                    }
                    idx = fullText.indexOf(search, idx + 1);
                }
                if (bestIdx !== -1) {
                    const targetTextEnd = bestIdx + search.length;
                    let textCount = 0;
                    let pmPos = 1;
                    editor.state.doc.descendants((node, nodePos) => {
                        if (textCount >= targetTextEnd) return false;
                        if (node.isText) {
                            const start = textCount;
                            const end = textCount + node.text.length;
                            if (targetTextEnd >= start && targetTextEnd <= end) {
                                pmPos = nodePos + (targetTextEnd - start);
                                textCount = targetTextEnd;
                                return false;
                            }
                            textCount += node.text.length;
                        } else if (node.isBlock && node.type.name !== 'doc') {
                            textCount++;
                        }
                        return true;
                    });
                    pos = pmPos;
                    break;
                }
            }
        }
        try {
            editor.commands.focus();
            editor.commands.setTextSelection(Math.min(pos, editor.state.doc.content.size));
        } catch {
            editor.commands.focus('start');
        }
        btn.classList.remove('active');
        document.getElementById('source-line-highlight').classList.add('hidden');
        document.getElementById('source-cursor').classList.add('hidden');
    }
}

// ===== Line Numbers =====
function updateLineNumbers() {
    const sourceEl = document.getElementById('source-editor');
    const gutterEl = document.getElementById('source-line-numbers');
    if (!gutterEl || !sourceEl) return;
    const lines = sourceEl.value.split('\n');
    const nums = lines.map((_, i) => `<div>${i + 1}</div>`).join('');
    gutterEl.innerHTML = nums;
}

// ===== Mirror div technique for textarea caret coordinates =====
let _mirrorDiv = null;
const _mirrorProps = [
    'direction', 'boxSizing', 'width', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontSizeAdjust', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
    'tabSize', 'MozTabSize', 'whiteSpace', 'wordWrap', 'wordBreak',
];

function getCaretCoordinates(textarea, pos) {
    if (!_mirrorDiv) {
        _mirrorDiv = document.createElement('div');
        _mirrorDiv.id = 'source-mirror';
        _mirrorDiv.style.position = 'absolute';
        _mirrorDiv.style.visibility = 'hidden';
        _mirrorDiv.style.overflow = 'hidden';
        _mirrorDiv.style.pointerEvents = 'none';
        _mirrorDiv.style.top = '0';
        _mirrorDiv.style.left = '-9999px';
        document.body.appendChild(_mirrorDiv);
    }
    const style = getComputedStyle(textarea);
    _mirrorProps.forEach(p => { _mirrorDiv.style[p] = style[p]; });
    _mirrorDiv.style.whiteSpace = 'pre-wrap';
    _mirrorDiv.style.wordWrap = 'break-word';

    // Strip padding from mirror div — we add it back to coordinates
    // This avoids box-model confusion between textarea and mirror div
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    _mirrorDiv.style.padding = '0';
    _mirrorDiv.style.boxSizing = 'content-box';
    _mirrorDiv.style.width = (textarea.clientWidth - paddingLeft - paddingRight) + 'px';
    _mirrorDiv.style.height = 'auto';

    const text = textarea.value.substring(0, pos !== undefined ? pos : textarea.selectionStart);
    _mirrorDiv.textContent = text;

    const span = document.createElement('span');
    span.textContent = '\u200b';
    _mirrorDiv.appendChild(span);

    const rawTop = span.offsetTop;
    const rawLeft = span.offsetLeft;

    // Measure baseline offset: the browser vertically centers inline content
    // within line-height, so span.offsetTop is non-zero even at position 0.
    // Subtract this baseline so coordinates align with the textarea's text start.
    _mirrorDiv.textContent = '';
    const baseSpan = document.createElement('span');
    baseSpan.textContent = '\u200b';
    _mirrorDiv.appendChild(baseSpan);
    const baselineOffset = baseSpan.offsetTop;

    return {
        top: rawTop - baselineOffset + paddingTop,
        left: rawLeft + paddingLeft,
        height: parseInt(style.lineHeight),
    };
}

// ===== Source Editor Events =====
let _isComposing = false;
const _sourceEl = document.getElementById('source-editor');

_sourceEl.addEventListener('compositionstart', () => {
    _isComposing = true;
    _sourceEl.classList.remove('hide-caret');
    const cursorEl = document.getElementById('source-cursor');
    if (cursorEl) cursorEl.classList.add('hidden');
});
_sourceEl.addEventListener('compositionend', () => {
    _isComposing = false;
    _sourceEl.classList.add('hide-caret');
    requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('input', () => {
    if (window.electronAPI) window.electronAPI.contentModified();
    updateLineNumbers();
    if (!_isComposing) requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('click', () => requestAnimationFrame(updateSourceLineHighlight));
_sourceEl.addEventListener('keyup', () => {
    if (!_isComposing) requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('keydown', () => {
    if (!_isComposing) requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('scroll', () => {
    // Sync line numbers scroll with textarea
    const gutterEl = document.getElementById('source-line-numbers');
    if (gutterEl) gutterEl.scrollTop = _sourceEl.scrollTop;
    requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('focus', () => requestAnimationFrame(updateSourceLineHighlight));
_sourceEl.addEventListener('blur', () => {
    const cursorEl = document.getElementById('source-cursor');
    if (cursorEl) cursorEl.classList.add('hidden');
});

function updateSourceLineHighlight() {
    const sourceEl = document.getElementById('source-editor');
    const wrapEl = document.getElementById('source-editor-wrap');
    const highlightEl = document.getElementById('source-line-highlight');
    const cursorEl = document.getElementById('source-cursor');
    if (!isSourceMode || !sourceEl || !highlightEl || _isComposing) {
        return;
    }

    highlightEl.classList.remove('hidden');
    cursorEl.classList.remove('hidden');

    const style = getComputedStyle(sourceEl);
    const lineHeight = parseFloat(style.lineHeight);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const caretPos = sourceEl.selectionStart;
    const text = sourceEl.value;

    // Find paragraph boundaries (previous and next \n)
    let paraStart = text.lastIndexOf('\n', caretPos - 1) + 1;
    let paraEnd = text.indexOf('\n', caretPos);
    if (paraEnd === -1) paraEnd = text.length;

    // Get pixel coordinates for paragraph start and caret
    // getCaretCoordinates returns positions relative to mirror div (includes padding)
    const paraStartCoords = getCaretCoordinates(sourceEl, paraStart);
    const paraEndCoords = getCaretCoordinates(sourceEl, paraEnd);
    const caretCoords = getCaretCoordinates(sourceEl, caretPos);

    // The textarea and highlight/cursor share the same parent (source-editor-wrap)
    // Mirror div coords include padding, so subtract scrollTop to get wrap-relative position
    const paraTopPx = paraStartCoords.top - sourceEl.scrollTop;
    const paraBottomPx = paraEndCoords.top + lineHeight - sourceEl.scrollTop;
    const paraHeight = paraBottomPx - paraTopPx;

    // Clip to visible area
    const visibleHeight = sourceEl.clientHeight;
    if (paraTopPx + paraHeight < 0 || paraTopPx > visibleHeight) {
        highlightEl.style.opacity = '0';
    } else {
        highlightEl.style.opacity = '1';
    }

    highlightEl.style.top = `${paraTopPx}px`;
    highlightEl.style.height = `${paraHeight}px`;

    // Thick cursor position — center vertically within line
    const cursorTopPx = caretCoords.top - sourceEl.scrollTop;
    if (cursorTopPx < 0 || cursorTopPx > visibleHeight) {
        cursorEl.style.opacity = '0';
    } else {
        cursorEl.style.opacity = '1';
    }
    const fontSize = parseFloat(style.fontSize) || 16;
    const cursorHeight = fontSize * 1.2;
    const verticalOffset = (lineHeight - cursorHeight) / 2;
    cursorEl.style.top = `${cursorTopPx + verticalOffset}px`;
    cursorEl.style.left = `${caretCoords.left}px`;
    cursorEl.style.height = `${cursorHeight}px`;
}

// ===== Theme =====
let currentTheme = localStorage.getItem('mink-theme') || 'light';

function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('btn-theme').textContent = theme === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('mink-theme', theme);
}

document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
});

document.getElementById('btn-source').addEventListener('click', toggleSourceMode);

// ===== IPC Handlers =====
const api = window.electronAPI;
if (api) {
    api.onFileNew(() => {
        if (isSourceMode) toggleSourceMode();
        suppressModified = true;
        editor.commands.setContent('<p></p>');
        suppressModified = false;
        editor.commands.focus();
    });

    api.onFileOpened((data) => {
        const html = markdownToHtml(data.content);
        if (isSourceMode) {
            document.getElementById('source-editor').value = data.content;
        } else {
            suppressModified = true;
            editor.commands.setContent(html);
            suppressModified = false;
            editor.commands.focus('start');
        }
        updateStats(editor);
        updateOutline(editor);
    });

    api.onFileSaved(() => {
        // Could show a subtle save indicator
    });

    api.onFolderOpened((data) => {
        const sidebar = document.getElementById('sidebar');
        if (sidebar.classList.contains('hidden')) {
            sidebar.classList.remove('hidden');
        }
        // Switch to files tab
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
        document.querySelector('[data-tab="files"]').classList.add('active');
        document.getElementById('file-tree').classList.add('active');

        renderFileTree(data.tree, document.getElementById('file-tree'));
    });

    api.onTitleChanged((data) => {
        document.getElementById('titlebar-text').textContent =
            `${data.name}${data.isModified ? ' •' : ''}`;
    });

    // ===== Menu Commands =====
    api.onMenuCommand((data) => {
        const { command } = data;

        switch (command) {
            case 'heading':
                editor.chain().focus().toggleHeading({ level: data.level }).run();
                break;
            case 'heading-increase': {
                const currentLevel = editor.getAttributes('heading').level || 0;
                if (currentLevel === 0) editor.chain().focus().toggleHeading({ level: 1 }).run();
                else if (currentLevel > 1) editor.chain().focus().toggleHeading({ level: currentLevel - 1 }).run();
                break;
            }
            case 'heading-decrease': {
                const level = editor.getAttributes('heading').level || 0;
                if (level > 0 && level < 6) editor.chain().focus().toggleHeading({ level: level + 1 }).run();
                else if (level === 6) editor.chain().focus().toggleHeading({ level: 6 }).run(); // Remove heading
                break;
            }
            case 'bold': editor.chain().focus().toggleBold().run(); break;
            case 'italic': editor.chain().focus().toggleItalic().run(); break;
            case 'strike': editor.chain().focus().toggleStrike().run(); break;
            case 'code': editor.chain().focus().toggleCode().run(); break;
            case 'bulletList': editor.chain().focus().toggleBulletList().run(); break;
            case 'orderedList': editor.chain().focus().toggleOrderedList().run(); break;
            case 'taskList': editor.chain().focus().toggleTaskList().run(); break;
            case 'blockquote': editor.chain().focus().toggleBlockquote().run(); break;
            case 'codeBlock': editor.chain().focus().toggleCodeBlock().run(); break;
            case 'horizontalRule': editor.chain().focus().setHorizontalRule().run(); break;
            case 'table':
                editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
                break;
            case 'link': {
                const url = prompt('输入链接地址:');
                if (url) editor.chain().focus().setLink({ href: url }).run();
                break;
            }
            case 'toggle-sidebar': toggleSidebar(); break;
            case 'toggle-outline':
                if (document.getElementById('sidebar').classList.contains('hidden')) {
                    document.getElementById('sidebar').classList.remove('hidden');
                }
                document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
                document.querySelector('[data-tab="outline"]').classList.add('active');
                document.getElementById('outline-panel').classList.add('active');
                break;
            case 'toggle-source': toggleSourceMode(); break;
            case 'toggle-theme': applyTheme(currentTheme === 'light' ? 'dark' : 'light'); break;
            case 'find': openSearchBar(); break;
        }
    });

} // end if (api)

// ===== Language Change Handler =====
let _currentUILang = 'zh'; // Track current UI language for AI features
if (api && api.onLanguageChanged) {
    api.onLanguageChanged((lang) => {
        _currentUILang = lang;
        // Update sidebar tab labels
        const filesTab = document.querySelector('[data-tab="files"]');
        const outlineTab = document.querySelector('[data-tab="outline"]');
        if (filesTab) filesTab.textContent = lang === 'zh' ? '文件' : 'Files';
        if (outlineTab) outlineTab.textContent = lang === 'zh' ? '大纲' : 'Outline';
        // Update status bar labels
        const wordsEl = document.getElementById('status-words');
        const charsEl = document.getElementById('status-chars');
        const linesEl = document.getElementById('status-lines');
        if (editor) updateStats(editor);
    });
}

// ===== Search & Replace =====
let searchMarks = [];   // Array of { from, to } in PM positions
let searchIndex = -1;
let currentSearchQuery = '';

// Helper: find all matches in PM doc, returns array of { from, to }
function findAllMatches(doc, query) {
    if (!query) return [];
    const results = [];
    const lowerQuery = query.toLowerCase();
    doc.descendants((node, pos) => {
        if (!node.isText) return;
        const text = node.text.toLowerCase();
        let idx = text.indexOf(lowerQuery);
        while (idx !== -1) {
            results.push({ from: pos + idx, to: pos + idx + query.length });
            idx = text.indexOf(lowerQuery, idx + 1);
        }
    });
    results.sort((a, b) => a.from - b.from);
    return results;
}

// Update search decorations in the editor
function updateSearchDecorations() {
    if (!editor) return;
    editor.view.dispatch(editor.view.state.tr.setMeta(searchPluginKey, {
        matches: searchMarks,
        activeIndex: searchIndex,
    }));
}

function openSearchBar() {
    const bar = document.getElementById('search-bar');
    bar.classList.remove('hidden');
    const input = document.getElementById('search-input');
    // If text is selected, use it as search term
    if (editor && !isSourceMode) {
        const { from, to } = editor.state.selection;
        if (from !== to) {
            const selected = editor.state.doc.textBetween(from, to);
            if (selected) input.value = selected;
        }
    }
    input.focus();
    input.select();
    doSearch();
}

function closeSearchBar() {
    document.getElementById('search-bar').classList.add('hidden');
    clearSearchHighlights();
    document.getElementById('search-input').value = '';
    document.getElementById('replace-input').value = '';
    document.getElementById('search-count').textContent = '';
    if (editor && !isSourceMode) editor.commands.focus();
}

function clearSearchHighlights() {
    searchMarks = [];
    searchIndex = -1;
    currentSearchQuery = '';
    updateSearchDecorations();
}


function doSearch() {
    const query = document.getElementById('search-input').value;
    const countEl = document.getElementById('search-count');
    currentSearchQuery = query;

    if (!query) {
        searchMarks = [];
        searchIndex = -1;
        updateSearchDecorations();
        countEl.textContent = '';
        return;
    }

    if (isSourceMode) {
        // Search in source textarea — no PM decorations needed
        searchMarks = [];
        searchIndex = -1;
        updateSearchDecorations();

        const sourceEl = document.getElementById('source-editor');
        const text = sourceEl.value;
        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const positions = [];
        let pos = lowerText.indexOf(lowerQuery);
        while (pos !== -1) {
            positions.push(pos);
            pos = lowerText.indexOf(lowerQuery, pos + 1);
        }
        // Store as simple text positions for source mode
        searchMarks = positions.map(p => ({ from: p, to: p + query.length }));
        countEl.textContent = positions.length > 0 ? `1/${positions.length}` : '0';
        if (positions.length > 0) {
            searchIndex = 0;
            sourceEl.selectionStart = positions[0];
            sourceEl.selectionEnd = positions[0] + query.length;
            sourceEl.focus();
        }
    } else if (editor) {
        // Search in WYSIWYG editor using PM positions directly
        searchMarks = findAllMatches(editor.state.doc, query);
        countEl.textContent = searchMarks.length > 0 ? `1/${searchMarks.length}` : '0';
        if (searchMarks.length > 0) {
            searchIndex = 0;
            updateSearchDecorations();
            navigateSearchResult(0);
        } else {
            searchIndex = -1;
            updateSearchDecorations();
        }
    }
}

function navigateSearchResult(index) {
    if (searchMarks.length === 0) return;
    searchIndex = ((index % searchMarks.length) + searchMarks.length) % searchMarks.length;
    const countEl = document.getElementById('search-count');
    countEl.textContent = `${searchIndex + 1}/${searchMarks.length}`;

    if (isSourceMode) {
        const sourceEl = document.getElementById('source-editor');
        const m = searchMarks[searchIndex];
        sourceEl.selectionStart = m.from;
        sourceEl.selectionEnd = m.to;
        sourceEl.focus();
        // Scroll into view
        const lineHeight = parseInt(getComputedStyle(sourceEl).lineHeight) || 28;
        const textBefore = sourceEl.value.substring(0, m.from);
        const lineNum = textBefore.split('\n').length;
        sourceEl.scrollTop = Math.max(0, (lineNum - 3) * lineHeight);
    } else if (editor) {
        const m = searchMarks[searchIndex];
        updateSearchDecorations();
        editor.commands.setTextSelection({ from: m.from, to: m.to });
        // Scroll to selection
        const domAtPos = editor.view.domAtPos(m.from);
        if (domAtPos && domAtPos.node) {
            const el = domAtPos.node.nodeType === 3 ? domAtPos.node.parentElement : domAtPos.node;
            if (el && el.scrollIntoView) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }
}

function doReplace() {
    const query = document.getElementById('search-input').value;
    const replacement = document.getElementById('replace-input').value;
    if (!query || searchMarks.length === 0 || searchIndex < 0) return;

    if (isSourceMode) {
        const sourceEl = document.getElementById('source-editor');
        const m = searchMarks[searchIndex];
        const text = sourceEl.value;
        sourceEl.value = text.substring(0, m.from) + replacement + text.substring(m.to);
        if (window.electronAPI) window.electronAPI.contentModified();
        doSearch();
    } else if (editor) {
        const m = searchMarks[searchIndex];
        // Select and replace the current match
        editor.chain()
            .focus()
            .setTextSelection({ from: m.from, to: m.to })
            .deleteSelection()
            .insertContent(replacement)
            .run();
        if (window.electronAPI) window.electronAPI.contentModified();
        // Re-search to update positions
        doSearch();
    }
}

function doReplaceAll() {
    const query = document.getElementById('search-input').value;
    const replacement = document.getElementById('replace-input').value;
    if (!query || searchMarks.length === 0) return;

    if (isSourceMode) {
        const sourceEl = document.getElementById('source-editor');
        const lowerQuery = query.toLowerCase();
        let text = sourceEl.value;
        let result = '';
        let lastEnd = 0;
        const lowerText = text.toLowerCase();
        let pos = lowerText.indexOf(lowerQuery);
        while (pos !== -1) {
            result += text.substring(lastEnd, pos) + replacement;
            lastEnd = pos + query.length;
            pos = lowerText.indexOf(lowerQuery, lastEnd);
        }
        result += text.substring(lastEnd);
        sourceEl.value = result;
        if (window.electronAPI) window.electronAPI.contentModified();
    } else if (editor) {
        // Replace all in PM: iterate matches from end to start to preserve positions
        const reversed = [...searchMarks].reverse();
        const chain = editor.chain().focus();
        for (const m of reversed) {
            chain.setTextSelection({ from: m.from, to: m.to }).deleteSelection().insertContent(replacement);
        }
        chain.run();
        if (window.electronAPI) window.electronAPI.contentModified();
    }
    doSearch();
}

// Search bar event listeners
document.getElementById('search-input').addEventListener('input', doSearch);
document.getElementById('btn-search-next').addEventListener('click', () => navigateSearchResult(searchIndex + 1));
document.getElementById('btn-search-prev').addEventListener('click', () => navigateSearchResult(searchIndex - 1));
document.getElementById('btn-replace').addEventListener('click', doReplace);
document.getElementById('btn-replace-all').addEventListener('click', doReplaceAll);
document.getElementById('btn-search-close').addEventListener('click', closeSearchBar);

// Cmd+F / Escape keyboard shortcuts
document.addEventListener('keydown', (e) => {
    _inlineRevealLastKeyEvent = { key: e.key, at: Date.now() };
    if (editor && !isSourceMode && handleInlineRevealKeyDown(editor, e)) {
        return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        openSearchBar();
    }
    if (e.key === 'Escape') {
        const bar = document.getElementById('search-bar');
        if (!bar.classList.contains('hidden')) {
            closeSearchBar();
        }
    }
    // Enter to go to next result in search
    if (e.key === 'Enter' && document.activeElement === document.getElementById('search-input')) {
        e.preventDefault();
        navigateSearchResult(searchIndex + (e.shiftKey ? -1 : 1));
    }
});

// ===== Init =====
applyTheme(currentTheme);
initEditor();
initSidebar();

// Update WYSIWYG cursor on scroll
document.getElementById('editor-wrap').addEventListener('scroll', () => {
    requestAnimationFrame(updateEditorCursor);
});

// =====================================================
// ===== AI Features =====
// =====================================================

// ===== AI i18n =====
const aiI18n = {
    en: {
        ai_settings: 'AI Settings', provider: 'Provider', api_key: 'API Key', model: 'Model',
        base_url: 'Base URL (optional)', test_conn: 'Test Connection', save: 'Save', cancel: 'Cancel',
        testing: 'Testing...', connected: '✓ Connected!', conn_failed: '✗ Failed: ',
        ai_continue: 'Continue writing', ai_rewrite: 'Rewrite', ai_translate: 'Translate',
        ai_summarize: 'Summarize', ai_custom: 'Custom prompt...', ai_apply: 'Apply', ai_discard: 'Discard',
        ai_chat: 'AI Chat', ai_chat_placeholder: 'Ask AI anything...', ai_chat_send: 'Send',
        ai_no_config: 'Please configure AI in Help → AI Settings first.',
        ai_custom_prompt: 'Enter your prompt:',
    },
    zh: {
        ai_settings: 'AI 设置', provider: '提供商', api_key: 'API 密钥', model: '模型',
        base_url: '自定义 URL（可选）', test_conn: '测试连接', save: '保存', cancel: '取消',
        testing: '测试中...', connected: '✓ 连接成功！', conn_failed: '✗ 失败：',
        ai_continue: '续写', ai_rewrite: '改写', ai_translate: '翻译',
        ai_summarize: '总结', ai_custom: '自定义指令...', ai_apply: '应用', ai_discard: '放弃',
        ai_chat: 'AI 对话', ai_chat_placeholder: '问 AI 任何问题...', ai_chat_send: '发送',
        ai_no_config: '请先在 帮助 → AI 设置 中配置 API 密钥。',
        ai_custom_prompt: '请输入指令：',
    },
};
function aiT(key) {
    const lang = typeof _currentUILang !== 'undefined' ? _currentUILang : 'zh';
    return aiI18n[lang]?.[key] || aiI18n.en[key] || key;
}

// ===== 1. AI Settings Modal =====
function createAISettingsModal() {
    let existing = document.getElementById('ai-settings-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ai-settings-modal';
    modal.className = 'ai-modal-overlay';
    modal.innerHTML = `
        <div class="ai-modal">
            <h2>${aiT('ai_settings')}</h2>
            <div class="ai-form-group">
                <label>${aiT('provider')}</label>
                <select id="ai-provider">
                    <option value="openai">OpenAI</option>
                    <option value="claude">Claude (Anthropic)</option>
                    <option value="ollama">Ollama (Local)</option>
                </select>
            </div>
            <div class="ai-form-group">
                <label>${aiT('api_key')}</label>
                <input type="password" id="ai-api-key" placeholder="sk-..." autocomplete="off">
            </div>
            <div class="ai-form-group">
                <label>${aiT('model')}</label>
                <input type="text" id="ai-model" placeholder="gpt-4o-mini">
            </div>
            <div class="ai-form-group">
                <label>${aiT('base_url')}</label>
                <input type="text" id="ai-base-url" placeholder="https://api.openai.com/v1/chat/completions">
            </div>
            <div class="ai-form-actions">
                <button id="ai-test-btn" class="ai-btn ai-btn-outline">${aiT('test_conn')}</button>
                <span id="ai-test-result"></span>
                <div style="flex:1"></div>
                <button id="ai-cancel-btn" class="ai-btn ai-btn-outline">${aiT('cancel')}</button>
                <button id="ai-save-btn" class="ai-btn ai-btn-primary">${aiT('save')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Load existing config
    window.electronAPI.getAIConfig().then(config => {
        document.getElementById('ai-provider').value = config.provider || 'openai';
        document.getElementById('ai-api-key').value = config.apiKey || '';
        document.getElementById('ai-model').value = config.model || '';
        document.getElementById('ai-base-url').value = config.baseUrl || '';
    });

    // Provider change → update placeholder
    document.getElementById('ai-provider').addEventListener('change', (e) => {
        const modelInput = document.getElementById('ai-model');
        const urlInput = document.getElementById('ai-base-url');
        const keyInput = document.getElementById('ai-api-key');
        if (e.target.value === 'openai') {
            modelInput.placeholder = 'gpt-4o-mini';
            urlInput.placeholder = 'https://api.openai.com/v1/chat/completions';
            keyInput.style.display = '';
        } else if (e.target.value === 'claude') {
            modelInput.placeholder = 'claude-3-5-sonnet-20241022';
            urlInput.placeholder = 'https://api.anthropic.com/v1/messages';
            keyInput.style.display = '';
        } else {
            modelInput.placeholder = 'llama3';
            urlInput.placeholder = 'http://localhost:11434/api/chat';
            keyInput.style.display = 'none';
        }
    });

    // Test connection
    document.getElementById('ai-test-btn').addEventListener('click', async () => {
        const resultEl = document.getElementById('ai-test-result');
        resultEl.textContent = aiT('testing');
        resultEl.className = '';
        const formConfig = {
            provider: document.getElementById('ai-provider').value,
            apiKey: document.getElementById('ai-api-key').value,
            model: document.getElementById('ai-model').value,
            baseUrl: document.getElementById('ai-base-url').value,
        };
        try {
            const res = await window.electronAPI.aiChat({
                ...formConfig,
                messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
            });
            if (res.error) throw new Error(res.error);
            // Auto-save on success
            await window.electronAPI.setAIConfig(formConfig);
            resultEl.textContent = aiT('connected');
            resultEl.className = 'ai-test-ok';
        } catch (e) {
            resultEl.textContent = aiT('conn_failed') + e.message;
            resultEl.className = 'ai-test-fail';
        }
    });

    // Save
    document.getElementById('ai-save-btn').addEventListener('click', async () => {
        await window.electronAPI.setAIConfig({
            provider: document.getElementById('ai-provider').value,
            apiKey: document.getElementById('ai-api-key').value,
            model: document.getElementById('ai-model').value,
            baseUrl: document.getElementById('ai-base-url').value,
        });
        modal.remove();
    });

    // Cancel
    document.getElementById('ai-cancel-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ===== 2. Inline AI Toolbar =====
let _aiToolbar = null;
let _aiResultContainer = null;

function showAIToolbar() {
    if (isSourceMode || !editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return; // No selection

    hideAIToolbar();

    const coords = editor.view.coordsAtPos(to);
    const editorWrap = document.getElementById('editor-wrap');
    const wrapRect = editorWrap.getBoundingClientRect();

    _aiToolbar = document.createElement('div');
    _aiToolbar.className = 'ai-toolbar';
    _aiToolbar.innerHTML = `
        <button data-action="continue">${aiT('ai_continue')}</button>
        <button data-action="rewrite">${aiT('ai_rewrite')}</button>
        <button data-action="translate">${aiT('ai_translate')}</button>
        <button data-action="summarize">${aiT('ai_summarize')}</button>
        <button data-action="custom">${aiT('ai_custom')}</button>
    `;

    // Position below selection
    _aiToolbar.style.top = (coords.bottom - wrapRect.top + editorWrap.scrollTop + 8) + 'px';
    _aiToolbar.style.left = (coords.left - wrapRect.left) + 'px';
    editorWrap.appendChild(_aiToolbar);

    _aiToolbar.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleAIAction(btn.dataset.action);
        });
    });
}

function hideAIToolbar() {
    if (_aiToolbar) { _aiToolbar.remove(); _aiToolbar = null; }
    if (_aiResultContainer) { _aiResultContainer.remove(); _aiResultContainer = null; }
}

async function handleAIAction(action) {
    if (!editor) return;
    const selectedText = editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
        '\n'
    );
    if (!selectedText) return;

    // Check config
    const config = await window.electronAPI.getAIConfig();
    if (!config.apiKey && config.provider !== 'ollama') {
        alert(aiT('ai_no_config'));
        return;
    }

    let systemPrompt = '';
    switch (action) {
        case 'continue':
            systemPrompt = 'Continue writing the following text naturally. Only output the continuation, do not repeat the original text.';
            break;
        case 'rewrite':
            systemPrompt = 'Rewrite the following text to improve clarity and style. Only output the rewritten text.';
            break;
        case 'translate':
            systemPrompt = 'Translate the following text. If it is in Chinese, translate to English. If it is in English, translate to Chinese. Only output the translation.';
            break;
        case 'summarize':
            systemPrompt = 'Summarize the following text concisely. Only output the summary.';
            break;
        case 'custom': {
            const prompt = window.prompt(aiT('ai_custom_prompt'));
            if (!prompt) return;
            systemPrompt = prompt;
            break;
        }
    }

    // Show result container below toolbar
    if (_aiToolbar) _aiToolbar.remove();
    _aiToolbar = null;

    const editorWrap = document.getElementById('editor-wrap');
    const coords = editor.view.coordsAtPos(editor.state.selection.to);
    const wrapRect = editorWrap.getBoundingClientRect();

    _aiResultContainer = document.createElement('div');
    _aiResultContainer.className = 'ai-result-container';
    _aiResultContainer.style.top = (coords.bottom - wrapRect.top + editorWrap.scrollTop + 8) + 'px';
    _aiResultContainer.style.left = Math.max(0, coords.left - wrapRect.left - 100) + 'px';
    _aiResultContainer.innerHTML = `
        <div class="ai-result-text"><span class="ai-typing-cursor">▊</span></div>
        <div class="ai-result-actions">
            <button class="ai-btn ai-btn-primary ai-apply-btn">${aiT('ai_apply')}</button>
            <button class="ai-btn ai-btn-outline ai-discard-btn">${aiT('ai_discard')}</button>
        </div>
    `;
    editorWrap.appendChild(_aiResultContainer);

    const textEl = _aiResultContainer.querySelector('.ai-result-text');
    let resultText = '';

    // Stream the response
    const chunkHandler = (text) => {
        resultText += text;
        textEl.textContent = resultText;
    };
    const doneHandler = () => { cleanup(); };
    const errorHandler = (err) => {
        textEl.textContent = '⚠ Error: ' + err;
        cleanup();
    };

    function cleanup() {
        window.electronAPI.onAIStreamChunk(() => { });
        window.electronAPI.onAIStreamDone(() => { });
        window.electronAPI.onAIStreamError(() => { });
    }

    window.electronAPI.onAIStreamChunk(chunkHandler);
    window.electronAPI.onAIStreamDone(doneHandler);
    window.electronAPI.onAIStreamError(errorHandler);

    window.electronAPI.aiStreamStart({
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: selectedText },
        ],
    });

    // Apply button
    _aiResultContainer.querySelector('.ai-apply-btn').addEventListener('click', () => {
        if (resultText && editor) {
            const { from, to } = editor.state.selection;
            if (action === 'continue') {
                editor.chain().focus().insertContentAt(to, resultText).run();
            } else {
                editor.chain().focus().insertContentAt({ from, to }, resultText).run();
            }
        }
        hideAIToolbar();
    });

    // Discard button
    _aiResultContainer.querySelector('.ai-discard-btn').addEventListener('click', () => {
        window.electronAPI.aiStreamStop();
        hideAIToolbar();
    });
}

// Show toolbar on selection change (mouseup)
document.getElementById('editor-wrap').addEventListener('mouseup', () => {
    setTimeout(() => {
        if (!editor || isSourceMode) return;
        const { from, to } = editor.state.selection;
        if (from !== to && to - from > 2) {
            showAIToolbar();
        } else {
            hideAIToolbar();
        }
    }, 100);
});

// ===== 3. AI Chat Sidebar =====
let _chatMessages = [];
let _chatOpen = false;

function createChatPanel() {
    if (document.getElementById('ai-chat-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ai-chat-panel';
    panel.className = 'ai-chat-panel';
    panel.innerHTML = `
        <div class="ai-chat-header">
            <span>${aiT('ai_chat')}</span>
            <button id="ai-chat-close" class="ai-chat-close-btn">✕</button>
        </div>
        <div class="ai-chat-messages" id="ai-chat-messages"></div>
        <div class="ai-chat-input-wrap">
            <textarea id="ai-chat-input" placeholder="${aiT('ai_chat_placeholder')}" rows="2"></textarea>
            <button id="ai-chat-send" class="ai-btn ai-btn-primary">${aiT('ai_chat_send')}</button>
        </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ai-chat-close').addEventListener('click', toggleChat);
    document.getElementById('ai-chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('ai-chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
}

function toggleChat() {
    _chatOpen = !_chatOpen;
    let panel = document.getElementById('ai-chat-panel');
    if (!panel) {
        createChatPanel();
        panel = document.getElementById('ai-chat-panel');
    }
    panel.classList.toggle('open', _chatOpen);
    if (_chatOpen) {
        document.getElementById('ai-chat-input').focus();
    }
}

function addChatBubble(role, text) {
    const messagesEl = document.getElementById('ai-chat-messages');
    if (!messagesEl) return null;
    const bubble = document.createElement('div');
    bubble.className = `ai-chat-bubble ai-chat-${role}`;
    bubble.textContent = text;
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}

async function sendChatMessage() {
    const input = document.getElementById('ai-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    // Check config
    const config = await window.electronAPI.getAIConfig();
    if (!config.apiKey && config.provider !== 'ollama') {
        addChatBubble('assistant', aiT('ai_no_config'));
        return;
    }

    _chatMessages.push({ role: 'user', content: text });
    addChatBubble('user', text);

    // Add context from current document
    let docContext = '';
    if (editor) {
        docContext = editor.state.doc.textContent.slice(0, 2000);
    }

    const systemMsg = {
        role: 'system',
        content: `You are a helpful writing assistant. The user is working on a Markdown document. Here is the current document context (first 2000 chars):\n\n${docContext}\n\nRespond helpfully and concisely.`
    };

    // Create assistant bubble for streaming
    const bubble = addChatBubble('assistant', '');
    let responseText = '';

    window.electronAPI.onAIStreamChunk((chunk) => {
        responseText += chunk;
        if (bubble) bubble.textContent = responseText;
        const messagesEl = document.getElementById('ai-chat-messages');
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    window.electronAPI.onAIStreamDone(() => {
        _chatMessages.push({ role: 'assistant', content: responseText });
    });

    window.electronAPI.onAIStreamError((err) => {
        if (bubble) bubble.textContent = '⚠ ' + err;
    });

    window.electronAPI.aiStreamStart({
        messages: [systemMsg, ..._chatMessages],
    });
}

// ===== 4. Autocomplete =====
let _autocompleteTimer = null;
let _ghostOverlay = null;

function scheduleAutocomplete() {
    clearAutocomplete();
    if (isSourceMode || !editor) return;

    _autocompleteTimer = setTimeout(async () => {
        if (!editor || isSourceMode) return;

        const config = await window.electronAPI.getAIConfig();
        if (!config.apiKey && config.provider !== 'ollama') return;

        const { from } = editor.state.selection;
        if (from < 10) return; // Don't autocomplete at very beginning

        // Get text before cursor (last 500 chars)
        const textBefore = editor.state.doc.textBetween(Math.max(0, from - 500), from, '\n');
        if (!textBefore.trim()) return;

        try {
            const res = await window.electronAPI.aiChat({
                messages: [
                    { role: 'system', content: 'You are an autocomplete engine. Given partial text, predict the next 1-2 sentences the user would write. Output ONLY the continuation, nothing else. Keep it short and natural. If you cannot predict, output nothing.' },
                    { role: 'user', content: textBefore },
                ],
            });
            if (res.error || !res.result) return;
            const suggestion = res.result.trim();
            if (!suggestion || suggestion.length < 3) return;

            // Check cursor hasn't moved
            if (editor.state.selection.from !== from) return;

            showGhostText(suggestion);
        } catch { }
    }, 2000);
}

function showGhostText(text) {
    clearGhostText();
    if (!editor) return;

    const pos = editor.state.selection.from;
    const coords = editor.view.coordsAtPos(pos);
    const editorWrap = document.getElementById('editor-wrap');
    const wrapRect = editorWrap.getBoundingClientRect();

    _ghostOverlay = document.createElement('span');
    _ghostOverlay.className = 'ai-ghost-text';
    _ghostOverlay.textContent = text;
    _ghostOverlay.dataset.suggestion = text;
    _ghostOverlay.style.position = 'absolute';
    _ghostOverlay.style.top = (coords.top - wrapRect.top + editorWrap.scrollTop) + 'px';
    _ghostOverlay.style.left = (coords.left - wrapRect.left) + 'px';
    editorWrap.appendChild(_ghostOverlay);
}

function clearGhostText() {
    if (_ghostOverlay) { _ghostOverlay.remove(); _ghostOverlay = null; }
}

function clearAutocomplete() {
    if (_autocompleteTimer) { clearTimeout(_autocompleteTimer); _autocompleteTimer = null; }
    clearGhostText();
}

function acceptGhostText() {
    if (!_ghostOverlay || !editor) return false;
    const text = _ghostOverlay.dataset.suggestion;
    clearGhostText();
    if (text) {
        editor.chain().focus().insertContent(text).run();
    }
    return true;
}

// ===== AI Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
    // Cmd+Shift+L — toggle chat
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'l') {
        e.preventDefault();
        toggleChat();
        return;
    }
    // Tab — accept ghost text
    if (e.key === 'Tab' && _ghostOverlay) {
        e.preventDefault();
        acceptGhostText();
        return;
    }
    // Escape — clear ghost text or close AI stuff
    if (e.key === 'Escape') {
        if (_ghostOverlay) { clearGhostText(); return; }
        if (_aiResultContainer) { hideAIToolbar(); return; }
        if (_chatOpen) { toggleChat(); return; }
    }
});

// ===== Menu Command for AI Settings =====
if (window.electronAPI?.onMenuCommand) {
    const _origOnMenuCommand = window.electronAPI.onMenuCommand;
    window.electronAPI.onMenuCommand((data) => {
        if (data.command === 'ai-settings') {
            createAISettingsModal();
            return;
        }
        // Let existing handler process other commands — it's already registered above
    });
}

// ===== Trigger autocomplete on typing =====
if (editor) {
    const origOnUpdate = editor.options.onUpdate;
    editor.on('update', ({ editor: ed }) => {
        // Schedule autocomplete after each edit
        if (!isSourceMode) scheduleAutocomplete();
    });
}

// ===== Create chat panel on load =====
createChatPanel();

// ===== Floating AI Chat Button =====
const _aiFab = document.createElement('button');
_aiFab.id = 'ai-fab';
_aiFab.className = 'ai-fab';
_aiFab.innerHTML = '💬';
_aiFab.title = 'AI Chat (⌘⇧L)';
_aiFab.addEventListener('click', () => toggleChat());
document.body.appendChild(_aiFab);

// Update FAB icon when chat opens/closes
const _origToggleChat = toggleChat;
// Override toggleChat to also update FAB
const _realToggle = toggleChat;
