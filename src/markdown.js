// ===== Markdown ↔ HTML 转换 =====
import { marked } from 'marked';
import TurndownService from 'turndown';

// ===== HTML → Markdown (TurndownService) =====
const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
});

// Task list support
turndown.addRule('taskListItem', {
    filter: (node) => {
        return node.nodeName === 'LI' && node.querySelector('input[type="checkbox"]');
    },
    replacement: (content, node) => {
        const checkbox = node.querySelector('input[type="checkbox"]');
        const checked = checkbox && checkbox.checked ? 'x' : ' ';
        const text = content.replace(/^\s*\[[ x]\]\s*/, '').trim();
        return `- [${checked}] ${text}\n`;
    },
});

// Table support
turndown.addRule('table', {
    filter: 'table',
    replacement: (content, node) => {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (rows.length === 0) return content;

        const result = [];
        rows.forEach((row, i) => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            const rowContent = cells.map(cell => cell.textContent.trim()).join(' | ');
            result.push(`| ${rowContent} |`);

            if (i === 0) {
                const separator = cells.map(() => '---').join(' | ');
                result.push(`| ${separator} |`);
            }
        });

        return '\n' + result.join('\n') + '\n\n';
    },
});

// Strikethrough
turndown.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => `~~${content}~~`,
});

// Highlight
turndown.addRule('highlight', {
    filter: 'mark',
    replacement: (content) => `==${content}==`,
});

export function htmlToMarkdown(html) {
    if (!html || html === '<p></p>') return '';
    return turndown.turndown(html);
}

// ===== Markdown → HTML (Marked) =====
marked.setOptions({
    breaks: true,
    gfm: true,
});

export function markdownToHtml(md) {
    if (!md || !md.trim()) return '<p></p>';
    return marked.parse(md);
}
