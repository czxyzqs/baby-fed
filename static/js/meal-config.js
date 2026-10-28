/* 餐次配置：后端经模板注入 window.APP_ACTIVE_MEALS（每天吃几餐）。
   各食物模块从这里取活跃餐次与文案；辅食中心的「餐次配置」弹窗也在这里。 */
(() => {
    'use strict';

    const ALL = { breakfast: '早餐', lunch: '午餐', snack: '下午茶', dinner: '晚餐' };
    const EMOJI = { breakfast: '🥣 早餐', lunch: '☀️ 午餐', snack: '🍎 下午茶', dinner: '🌙 晚餐' };

    const injected = window.APP_ACTIVE_MEALS;
    const keys = (Array.isArray(injected) && injected.filter(key => key in ALL).length)
        ? injected.filter(key => key in ALL)
        : Object.keys(ALL);

    const labels = {};
    const emojiLabels = {};
    keys.forEach(key => { labels[key] = ALL[key]; emojiLabels[key] = EMOJI[key]; });

    // 按时刻猜的餐次若不在活跃集合里，顺延到下一个活跃餐（越界则取最后一餐）
    function adjustSuggestion(meal) {
        if (keys.includes(meal)) return meal;
        const order = Object.keys(ALL);
        return keys.find(key => order.indexOf(key) >= order.indexOf(meal)) ?? keys[keys.length - 1];
    }

    window.MealConfig = { keys, labels, emojiLabels, adjustSuggestion };

    // ---------- 辅食中心：餐次配置弹窗（复用 .fma-* 样式） ----------

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    async function openMealSettings() {
        let active;
        try {
            const response = await fetch('/api/screening/settings', { cache: 'no-store' });
            const data = await response.json();
            active = new Set(data.active_meals || Object.keys(ALL));
        } catch (error) {
            active = new Set(window.MealConfig.keys);
        }
        const overlay = node('div', '', 'fma-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) { overlay.remove(); document.body.style.overflow = ''; }
        });
        const dialog = node('div', '', 'fma-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'fma-head');
        head.append(node('h2', '每天吃几餐', 'fma-title'));
        const close = node('button', '✕', 'fma-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', () => { overlay.remove(); document.body.style.overflow = ''; });
        head.append(close);
        dialog.append(head);

        const body = node('div', '', 'fp-body');
        body.append(node('p', '勾选宝宝目前规律吃的餐次；没勾的餐次在记录、规划、历史页都不再出现，之后加餐了再回来勾上。已记的数据不会丢。', 'fma-hint'));
        const chips = node('div', '', 'fma-chips');
        Object.entries(EMOJI).forEach(([key, label]) => {
            const chip = node('button', label, 'fma-chip' + (active.has(key) ? ' active' : ''));
            chip.type = 'button';
            chip.addEventListener('click', () => {
                if (active.has(key)) {
                    if (active.size === 1) { window.showToast?.('至少保留一餐'); return; }
                    active.delete(key);
                    chip.classList.remove('active');
                } else {
                    active.add(key);
                    chip.classList.add('active');
                }
            });
            chips.append(chip);
        });
        body.append(chips);

        const save = node('button', '保存', 'fma-btn primary fp-add-batch');
        save.type = 'button';
        save.addEventListener('click', async () => {
            const meals = Object.keys(ALL).filter(key => active.has(key));
            try {
                const response = await fetch('/api/screening/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active_meals: meals })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '保存失败');
                window.showToast?.(`已保存：每天${meals.length}餐`);
                overlay.remove();
                window.location.reload();
            } catch (error) {
                window.showToast?.(`保存失败：${error.message}`);
            }
        });
        body.append(save);
        dialog.append(body);
        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
    }

    const trigger = document.querySelector('[data-meal-settings]');
    if (trigger) trigger.addEventListener('click', openMealSettings);
})();
