/* 餐次槽配置：后端经模板注入 window.APP_MEAL_SLOTS（启用的槽+各槽开始时间）。
   记录侧不存餐次，槽只活在计划侧；各食物模块从这里取槽与文案，
   「时间落槽」（slotForTime）是记录↔计划的唯一匹配方式。
   辅食中心的「餐次配置」弹窗也在这里：启停槽 + 改各槽开始时间。 */
(() => {
    'use strict';

    // 槽位全集（内部代号沿用四餐 key，用户只看到显示名）；start 为默认起点（当天分钟数）
    const PALETTE = [
        { key: 'breakfast', label: '早餐', emoji: '🥣', start: 390 },
        { key: 'lunch', label: '上午餐', emoji: '☀️', start: 660 },
        { key: 'snack', label: '下午茶', emoji: '🍎', start: 870 },
        { key: 'dinner', label: '下午餐', emoji: '🌙', start: 1050 },
    ];
    const byKey = Object.fromEntries(PALETTE.map(slot => [slot.key, slot]));

    function parseSlots(injected) {
        if (!Array.isArray(injected)) return null;
        const parsed = injected
            .filter(slot => slot && byKey[slot.key])
            .map(slot => ({
                key: slot.key, label: byKey[slot.key].label, emoji: byKey[slot.key].emoji,
                start: Number.isFinite(slot.start) ? Math.max(0, Math.floor(slot.start)) : byKey[slot.key].start,
            }));
        if (!parsed.length) return null;
        return parsed;
    }

    let slots = parseSlots(window.APP_MEAL_SLOTS) || PALETTE.slice();
    // 兜底：起点必须严格递增（首槽 0 点起），配置异常时顺延修正
    slots.forEach((slot, index) => {
        const previous = index === 0 ? 0 : slots[index - 1].start;
        if (index === 0) slot.start = 0;
        else if (slot.start <= previous) slot.start = previous + 1;
    });

    function minutesOf(hhmm) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
        if (!match) return null;
        const hour = Number(match[1]), minute = Number(match[2]);
        return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
    }

    function minutesToText(minutes) {
        return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    }

    // 时间落槽：槽全天无缝覆盖，任何时刻必有归属
    function slotForTime(hhmm) {
        const minutes = minutesOf(hhmm);
        if (minutes === null) return slots[slots.length - 1].key;
        let result = slots[0].key;
        for (const slot of slots.slice(1)) {
            if (minutes >= slot.start) result = slot.key;
            else break;
        }
        return result;
    }

    const keys = slots.map(slot => slot.key);
    const labels = Object.fromEntries(slots.map(slot => [slot.key, slot.label]));
    const emojiLabels = Object.fromEntries(slots.map(slot => [slot.key, `${slot.emoji} ${slot.label}`]));
    const startText = key => {
        const slot = slots.find(item => item.key === key);
        return slot ? minutesToText(slot.start) : '';
    };

    window.MealConfig = { slots, keys, labels, emojiLabels, slotForTime, minutesOf, minutesToText, startText };

    // ---------- 辅食中心：餐次配置弹窗（复用 .fma-* 样式） ----------

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    async function openMealSettings() {
        let saved;
        try {
            const response = await fetch('/api/screening/settings', { cache: 'no-store' });
            const data = await response.json();
            saved = parseSlots(data.meal_slots) || slots;
        } catch (error) {
            saved = slots;
        }
        const starts = Object.fromEntries(saved.filter(slot => slot.start > 0)
            .map(slot => [slot.key, minutesToText(slot.start)]));

        const overlay = node('div', '', 'fma-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) { overlay.remove(); document.body.style.overflow = ''; }
        });
        const dialog = node('div', '', 'fma-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'fma-head');
        head.append(node('h2', '餐次配置', 'fma-title'));
        const close = node('button', '✕', 'fma-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', () => { overlay.remove(); document.body.style.overflow = ''; });
        head.append(close);
        dialog.append(head);

        const body = node('div', '', 'fp-body');
        body.append(node('p',
            '勾选宝宝目前规律吃的餐次，并定每个餐次几点开始：一笔进食的时间落在哪个餐次，就算吃在哪个餐次（也决定兑现哪条计划）。第一个餐次从 0 点起。改配置不影响已记的数据。',
            'fma-hint'));

        const rows = node('div', '', 'fp-slot-rows');
        const timeInputs = new Map();
        const checks = new Map();
        PALETTE.forEach(slot => {
            const row = node('label', '', 'fp-slot-row');
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = saved.some(item => item.key === slot.key);
            const name = node('span', `${slot.emoji} ${slot.label}`, 'fp-slot-name');
            const timeLabel = node('span', '', 'fp-slot-time-label');
            timeLabel.textContent = '几点开始';
            const time = document.createElement('input');
            time.type = 'time';
            time.className = 'form-input';
            time.value = starts[slot.key] || minutesToText(slot.start);
            checks.set(slot.key, check);
            timeInputs.set(slot.key, time);
            check.addEventListener('change', renderState);
            time.addEventListener('change', renderState);
            row.append(check, name, timeLabel, time);
            rows.append(row);
        });
        body.append(rows);
        const stateHint = node('p', '', 'fma-hint');
        body.append(stateHint);

        function activeKeysOf() {
            return new Set(PALETTE.filter(slot => checks.get(slot.key)?.checked).map(slot => slot.key));
        }

        function renderState() {
            const keysNow = activeKeysOf();
            // 启用槽按天序排好后：首个槽 0 点起（时间输入禁用），其余可编辑
            const ordered = PALETTE.filter(slot => keysNow.has(slot.key));
            timeInputs.forEach((input, key) => {
                input.disabled = !keysNow.has(key) || (ordered.length > 0 && ordered[0].key === key);
            });
            let problem = '';
            if (!ordered.length) problem = '至少启用一个餐次';
            else {
                let previous = -1;
                for (const slot of ordered.slice(1)) {
                    const value = minutesOf(timeInputs.get(slot.key).value);
                    if (value === null) { problem = `${slot.label}的开始时间不完整`; break; }
                    if (value <= previous) { problem = '后一个餐次的开始时间要晚于前一个'; break; }
                    previous = value;
                }
            }
            stateHint.textContent = problem;
            stateHint.dataset.error = String(Boolean(problem));
            stateHint.hidden = !problem;
        }
        renderState();

        const save = node('button', '保存', 'fma-btn primary fp-add-batch');
        save.type = 'button';
        save.addEventListener('click', async () => {
            const keysNow = [...activeKeysOf()];
            if (!keysNow.length) { window.showToast?.('至少启用一个餐次'); return; }
            const ordered = PALETTE.filter(slot => keysNow.includes(slot.key));
            const startsPayload = {};
            let previous = -1;
            for (const slot of ordered.slice(1)) {
                const value = minutesOf(timeInputs.get(slot.key).value);
                if (value === null || value <= previous) {
                    window.showToast?.('请先修正开始时间的问题');
                    return;
                }
                startsPayload[slot.key] = minutesToText(value);
                previous = value;
            }
            try {
                const response = await fetch('/api/screening/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ meal_slots: { active: keysNow, starts: startsPayload } })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '保存失败');
                window.showToast?.(`已保存：每天${keysNow.length}餐`);
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
