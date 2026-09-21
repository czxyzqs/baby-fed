(() => {
    const element = name => document.getElementById(`screening-${name}`);
    const symptoms = ['口周红疹', '荨麻疹', '呕吐', '腹泻', '便秘', '湿疹加重', '其他'];
    const ratings = { 喜欢: '😋', 一般: '😐', 拒绝: '🥴' };
    let board = null;
    let stats = null;
    let tab = 'screening';
    let overlayAction = null;

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function button(text, handler, className = 'screening-btn') {
        const result = node('button', text, className);
        result.type = 'button';
        result.addEventListener('click', handler);
        return result;
    }

    function message(text = '', error = false) {
        element('message').textContent = text;
        element('message').hidden = !text;
        element('message').dataset.error = String(error);
    }

    function toast(text) {
        window.showToast?.(text);
    }

    async function api(path, method = 'GET', data) {
        const response = await fetch(`/api/screening/${path}`, {
            method, cache: 'no-store',
            headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
        return result;
    }

    function categoryLabel(food) {
        return `${food.category_emoji || '🍚'} ${food.category_name || '未分组'}${food.is_high_allergen ? ' ⚠️ 高致敏' : ''}`;
    }

    function renderDaysOptions() {
        const container = element('days-options');
        container.replaceChildren();
        for (let days = 1; days <= 7; days += 1) {
            const choice = button(`${days} 天`, async () => {
                try {
                    await api('settings', 'PUT', { observe_days_default: days });
                    board.settings.observe_days_default = days;
                    renderDaysOptions();
                    toast(`默认观察天数已设为 ${days} 天`);
                } catch (error) {
                    message(`保存失败：${error.message}`, true);
                }
            }, 'screening-option');
            choice.setAttribute('aria-pressed', String(board.settings.observe_days_default === days));
            container.append(choice);
        }
    }

    function dots(eaten, total) {
        return '●'.repeat(Math.min(eaten, total)) + '○'.repeat(Math.max(0, total - eaten));
    }

    function screeningCard(food) {
        const card = node('article', '', 'screening-card' + (food.reactions?.length ? ' screening-alert' : ''));
        const head = node('div', '', 'screening-card-head');
        head.append(node('strong', food.name, 'screening-card-name'));
        head.append(node('span', categoryLabel(food), 'screening-tag'));
        card.append(head);
        card.append(node('p', `${dots(food.eaten_days, food.observe_days)} 第${food.eaten_days}/${food.observe_days}天 · 首次 ${food.start_date}`, 'screening-line'));
        if (!food.eaten_today) {
            card.append(node('p', '今天还没吃', 'screening-line screening-warn'));
        }
        (food.reactions || []).forEach(reaction => {
            card.append(node('p', `⚠️ ${reaction.date} ${reaction.symptoms.join('、')}${reaction.note ? `（${reaction.note}）` : ''}`, 'screening-line screening-warn'));
        });
        const actions = node('div', '', 'screening-actions');
        actions.append(button('记录反应', () => reactionDialog(food), 'screening-btn primary'));
        actions.append(button('✅ 标记正常', () => verdictDialog(food, 'normal'), 'screening-btn green'));
        actions.append(button('⚠️ 标记过敏', () => verdictDialog(food, 'allergic'), 'screening-btn red'));
        card.append(actions);
        return card;
    }

    function allergicCard(food) {
        const card = node('article', '', 'screening-card screening-allergic');
        const head = node('div', '', 'screening-card-head');
        head.append(node('strong', food.name, 'screening-card-name'));
        head.append(node('span', categoryLabel(food), 'screening-tag'));
        card.append(head);
        card.append(node('p', '就诊档案（按时间线）', 'screening-line'));
        food.rounds.filter(round => round.status === 'allergic' || round.reactions.length).forEach(round => {
            const line = node('p', `${round.start_date} 起 · ${round.status === 'allergic' ? '标记过敏' : round.status === 'normal' ? '改判正常' : '观察中'} · 吃了 ${round.eaten_days} 天`, 'screening-line');
            card.append(line);
            round.reactions.forEach(reaction => {
                card.append(node('p', `　${reaction.date} ${reaction.symptoms.join('、')}${reaction.note ? `（${reaction.note}）` : ''}`, 'screening-line'));
            });
        });
        const actions = node('div', '', 'screening-actions');
        actions.append(button('重新尝试（新一轮排敏）', () => confirmAction(
            `将「${food.name}」从今天开始新一轮排敏？观察天数沿用 ${food.rounds.at(-1)?.observe_days || 3} 天。`,
            () => api('verdict', 'POST', { food_id: food.id, action: 'retry' })
        ), 'screening-btn primary'));
        actions.append(button('改判正常', () => confirmAction(
            `确认把「${food.name}」改判为正常？历史档案保留。`,
            () => api('verdict', 'POST', { food_id: food.id, action: 'normal' })
        ), 'screening-btn green'));
        card.append(actions);
        return card;
    }

    function poolTab(status) {
        const panel = node('div', '', 'screening-pool');
        const groups = new Map();
        board.foods.filter(food => food.status === status && !food.in_queue).forEach(food => {
            const key = food.category_name || '未分组';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(food);
        });
        if (!groups.size) {
            panel.append(node('p', status === 'untouched' ? '没有未排敏的食物。' : '还没有食物。', 'screening-line'));
            return panel;
        }
        groups.forEach((foods, groupName) => {
            panel.append(node('h3', groupName + (foods[0].is_high_allergen ? ' ⚠️' : ''), 'screening-group-title'));
            const group = node('div', '', 'screening-chip-group');
            foods.forEach(food => {
                const chip = button(food.name, () => {
                    if (status !== 'untouched') return;
                    confirmAction(`把「${food.name}」加入排敏队列？`, () => api('queue', 'POST', { food_id: food.id }));
                }, 'screening-chip' + (foods[0].is_high_allergen ? ' allergen' : ''));
                group.append(chip);
            });
            panel.append(group);
        });
        return panel;
    }

    function statsTab() {
        const panel = node('div', '', 'screening-stats');
        const summary = node('div', '', 'screening-stat-grid');
        [['已尝试', stats.tried], ['排敏中', stats.counts.screening], ['过敏', stats.counts.allergic], ['未排敏', stats.counts.untouched]]
            .forEach(([label, value]) => {
                const item = node('div', '', 'screening-stat');
                item.append(node('strong', String(value), 'screening-stat-value'));
                item.append(node('span', label, 'screening-stat-label'));
                summary.append(item);
            });
        panel.append(summary);
        panel.append(node('h3', '品类覆盖（已尝试 / 该类总数）'));
        stats.coverage.forEach(entry => {
            const row = node('div', '', 'screening-bar-row');
            row.append(node('span', `${entry.emoji} ${entry.name}${entry.high_allergen ? ' ⚠️' : ''}`, 'screening-bar-name'));
            const bar = node('div', '', 'screening-bar');
            const fill = node('i', '', '');
            fill.style.width = `${entry.total ? Math.round(entry.tried / entry.total * 100) : 0}%`;
            bar.append(fill);
            row.append(bar);
            row.append(node('span', `${entry.tried}/${entry.total}`, 'screening-bar-count'));
            panel.append(row);
        });
        if (stats.taste.like.length || stats.taste.reject.length) {
            panel.append(node('h3', '口味偏好'));
            if (stats.taste.like.length) panel.append(node('p', `😋 最爱：${stats.taste.like.map(item => `${item.food}（${item.count}次）`).join('、')}`, 'screening-line'));
            if (stats.taste.reject.length) panel.append(node('p', `🥴 拒绝：${stats.taste.reject.map(item => `${item.food}（${item.count}次）`).join('、')}`, 'screening-line'));
        }
        if (stats.monthly.length) {
            panel.append(node('h3', '本月新增'));
            panel.append(node('p', stats.monthly.map(item => `${item.date.slice(5)} ${item.food}`).join(' · '), 'screening-line'));
        }
        panel.append(node('p', '统计只呈现自家事实，不与别家宝宝对比。', 'screening-hint'));
        return panel;
    }

    function renderPanel() {
        const panel = element('panel');
        panel.replaceChildren();
        if (tab === 'screening') {
            const foods = board.foods.filter(food => food.status === 'screening');
            if (!foods.length) {
                panel.append(node('p', '当前没有排敏中的食物。可在首页记录新食物，或到排敏规划页排队列。', 'screening-line'));
            }
            foods.forEach(food => panel.append(screeningCard(food)));
        } else if (tab === 'allergic') {
            const foods = board.foods.filter(food => food.status === 'allergic');
            if (!foods.length) panel.append(node('p', '没有过敏食物 🎉', 'screening-line'));
            foods.forEach(food => panel.append(allergicCard(food)));
        } else if (tab === 'normal' || tab === 'untouched') {
            panel.append(poolTab(tab));
        } else if (tab === 'stats') {
            panel.append(statsTab());
        }
    }

    function render() {
        const counts = { screening: 0, allergic: 0, normal: 0, untouched: 0 };
        board.foods.forEach(food => { counts[food.status] += 1; });
        Object.entries(counts).forEach(([key, value]) => {
            element(`count-${key}`).textContent = value;
        });
        renderDaysOptions();
        renderPanel();
    }

    async function reload() {
        message('正在加载排敏数据…');
        try {
            const [boardResult, statsResult] = await Promise.all([api('board'), api('stats')]);
            board = boardResult;
            stats = statsResult;
            message();
            render();
        } catch (error) {
            message(`加载失败：${error.message}`, true);
            const retry = button('重试加载', reload, 'screening-btn primary');
            element('panel').replaceChildren(retry);
        }
    }

    function closeDialog() {
        element('overlay').hidden = true;
        overlayAction = null;
    }

    function openDialog(title, bodyNode, action) {
        element('dialog-title').textContent = title;
        element('dialog-body').replaceChildren(bodyNode);
        element('overlay').hidden = false;
        overlayAction = action;
    }

    function confirmAction(text, action) {
        const body = node('div', '', 'screening-dialog-body');
        body.append(node('p', text, 'screening-line'));
        const actions = node('div', '', 'screening-actions');
        actions.append(button('取消', closeDialog, 'screening-btn'));
        actions.append(button('确认', async () => {
            try {
                await action();
                closeDialog();
                await reload();
            } catch (error) {
                message(`操作失败：${error.message}`, true);
                closeDialog();
            }
        }, 'screening-btn primary'));
        body.append(actions);
        openDialog('请确认', body);
    }

    function reactionDialog(food) {
        const body = node('div', '', 'screening-dialog-body');
        body.append(node('p', `为「${food.name}」记录排敏反应（无反应不用记录）。`, 'screening-line'));
        const group = node('div', '', 'screening-chip-group');
        const chosen = new Set();
        symptoms.forEach(symptom => {
            const chip = button(symptom, () => {
                if (chosen.has(symptom)) {
                    chosen.delete(symptom);
                    chip.classList.remove('active');
                } else {
                    chosen.add(symptom);
                    chip.classList.add('active');
                }
            }, 'screening-chip');
            group.append(chip);
        });
        body.append(group);
        const label = node('label', '备注（选填）');
        const input = node('input', '', 'form-input');
        input.maxLength = 500;
        label.append(input);
        body.append(label);
        const actions = node('div', '', 'screening-actions');
        actions.append(button('取消', closeDialog));
        actions.append(button('保存反应', async () => {
            if (!chosen.size) {
                message('请至少选择一项症状；无反应则无需记录。', true);
                return;
            }
            try {
                await api('reactions', 'POST', {
                    food_id: food.id, date: board.today,
                    symptoms: [...chosen], note: input.value
                });
                closeDialog();
                await reload();
                toast('已记录反应');
            } catch (error) {
                message(`保存失败：${error.message}`, true);
                closeDialog();
            }
        }, 'screening-btn red'));
        body.append(actions);
        openDialog(`记录反应 · ${food.name}`, body);
    }

    function verdictDialog(food, action) {
        const body = node('div', '', 'screening-dialog-body');
        if (action === 'allergic') {
            body.append(node('p', `标记「${food.name}」为过敏。请勾选出现的症状：`, 'screening-line'));
            const group = node('div', '', 'screening-chip-group');
            const chosen = new Set();
            symptoms.forEach(symptom => {
                const chip = button(symptom, () => {
                    if (chosen.has(symptom)) {
                        chosen.delete(symptom);
                        chip.classList.remove('active');
                    } else {
                        chosen.add(symptom);
                        chip.classList.add('active');
                    }
                }, 'screening-chip');
                group.append(chip);
            });
            body.append(group);
            const pauseLabel = node('label', '后续排敏顺延几天（等症状消退）');
            const pauseGroup = node('div', '', 'screening-chip-group');
            const pauseChoice = { days: 3 };
            [0, 1, 3, 5, 7].forEach(days => {
                const chip = button(days === 0 ? '不顺延' : `${days} 天`, () => {
                    pauseChoice.days = days;
                    [...pauseGroup.children].forEach(child => child.classList.remove('active'));
                    chip.classList.add('active');
                }, 'screening-chip' + (days === 3 ? ' active' : ''));
                pauseGroup.append(chip);
            });
            pauseLabel.append(pauseGroup);
            body.append(pauseLabel);
            const noteLabel = node('label', '备注（选填，如处理方式）');
            const note = node('input', '', 'form-input');
            noteLabel.append(note);
            body.append(noteLabel);
            const actions = node('div', '', 'screening-actions');
            actions.append(button('取消', closeDialog));
            actions.append(button('确认标记过敏', async () => {
                if (!chosen.size) {
                    message('请至少选择一项症状', true);
                    return;
                }
                try {
                    await api('verdict', 'POST', {
                        food_id: food.id, action: 'allergic',
                        symptoms: [...chosen], note: note.value,
                        pause_days: pauseChoice.days
                    });
                    closeDialog();
                    await reload();
                    toast(`已标记过敏${pauseChoice.days ? `，后续排期顺延 ${pauseChoice.days} 天` : ''}`);
                } catch (error) {
                    message(`操作失败：${error.message}`, true);
                    closeDialog();
                }
            }, 'screening-btn red'));
            body.append(actions);
        } else {
            confirmAction(`确认把「${food.name}」标记为正常（已耐受）？`, () =>
                api('verdict', 'POST', { food_id: food.id, action: 'normal' }));
            return;
        }
        openDialog(action === 'allergic' ? `标记过敏 · ${food.name}` : '', body);
    }

    element('tabs').addEventListener('click', event => {
        const target = event.target.closest('.screening-tab');
        if (!target) return;
        tab = target.dataset.tab;
        [...element('tabs').children].forEach(item => item.classList.toggle('active', item === target));
        renderPanel();
    });
    element('overlay').addEventListener('click', event => {
        if (event.target === element('overlay')) closeDialog();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !element('overlay').hidden) closeDialog();
    });

    const elderButton = element('elder');
    function applyElder(on) {
        document.body.classList.toggle('elder', on);
        elderButton.textContent = on ? 'A- 标准' : 'A+ 大字';
    }
    elderButton.addEventListener('click', () => {
        const on = !document.body.classList.contains('elder');
        applyElder(on);
        try { localStorage.setItem('elder-mode', on ? '1' : '0'); } catch (error) {}
    });
    try { applyElder(localStorage.getItem('elder-mode') === '1'); } catch (error) { applyElder(false); }

    reload();
})();
