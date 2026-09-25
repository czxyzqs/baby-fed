/* 首页排敏横幅：今日计划、观察进度与待标记提醒 */
(() => {
    const banner = document.getElementById('food-screening-banner');
    const body = document.getElementById('food-screening-banner-body');
    if (!banner || !body) return;

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function link(text, href) {
        const result = node('a', text, 'food-banner-link');
        result.href = href;
        return result;
    }

    async function load() {
        try {
            const response = await fetch('/api/screening/banner', { cache: 'no-store' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '加载失败');
            render(result.items || []);
        } catch (error) {
            banner.hidden = true;
        }
    }

    function render(items) {
        body.replaceChildren();
        if (!items.length) {
            banner.hidden = true;
            return;
        }
        banner.hidden = false;
        const planned = [];
        items.forEach(item => {
            if (item.kind === 'due') {
                const card = node('div', '', 'food-banner-item food-banner-due');
                card.append(node('span', `🔔 ${item.food} ${item.text}`, 'food-banner-text'));
                card.append(link('去标记 ›', '/screening'));
                body.append(card);
            } else {
                planned.push(item);
            }
        });
        if (planned.length) {
            const text = planned.map(item =>
                `${item.food}${item.text ? `（${item.text}）` : ''}`
            ).join('、');
            const card = node('div', '', 'food-banner-item');
            card.append(node('span', `今日计划：${text}`, 'food-banner-text'));
            body.append(card);
        }
    }

    window.addEventListener('pageshow', event => { if (event.persisted) load(); });
    load();
})();
