/* 备餐批次 + 按餐记录面板：首页专用。
   弹层复用 food-menu-actions.css 的 .fma-* 样式，步进器复用 index.css 的 .amount-control。
   数据流：/api/prep/overview（横幅+面板共用）、/api/meals（整餐替换）、/api/prep/batches。 */
(() => {
    'use strict';

    const MEALS = { breakfast: '🥣 早餐', lunch: '☀️ 午餐', snack: '🍎 下午茶', dinner: '🌙 晚餐' };
    const PRESETS = ['一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗'];
    const PORTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function toast(text) {
        window.showToast?.(text);
    }

    async function api(path, method = 'GET', data) {
        const response = await fetch(`/api/${path}`, {
            method, cache: 'no-store',
            headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
            body: data === undefined ? undefined : JSON.stringify(data)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '操作失败，请稍后重试');
        return result;
    }

    function today() {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());
    }

    function suggestedMeal() {
        const hour = Number(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'
        }).format(new Date()));
        return hour < 11 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';
    }

    function portionOf(amount) {
        return typeof amount === 'string' && amount.endsWith('份') ? Number(amount.slice(0, -1)) : null;
    }

    // ---------- 弹层骨架（复用 .fma-* 样式） ----------

    let overlay = null;

    function closePanel() {
        overlay?.remove();
        overlay = null;
        document.body.style.overflow = '';
    }

    function openOverlay(title) {
        closePanel();
        overlay = node('div', '', 'fma-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closePanel();
        });
        const dialog = node('div', '', 'fma-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'fma-head');
        head.append(node('h2', title, 'fma-title'));
        const close = node('button', '✕', 'fma-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closePanel);
        head.append(close);
        dialog.append(head);
        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
        return dialog;
    }

    function foodChips(container, foods, onPick, excludeIds = []) {
        const search = node('input', '', 'fma-search');
        search.type = 'search';
        search.placeholder = '搜索食物';
        container.append(search);
        const list = node('div', '', 'fma-list');
        container.append(list);

        function render() {
            const query = (search.value || '').trim().toLocaleLowerCase();
            list.replaceChildren();
            const matched = foods.filter(food =>
                !excludeIds.includes(food.id) && (!query || food.name.toLocaleLowerCase().includes(query)));
            if (!matched.length) {
                list.append(node('p', '没有匹配的食物。', 'fma-hint'));
                return;
            }
            const group = node('div', '', 'fma-chips');
            matched.forEach(food => {
                const chip = node('button', food.name, 'fma-chip');
                chip.type = 'button';
                chip.addEventListener('click', () => onPick(food));
                group.append(chip);
            });
            list.append(group);
        }

        search.addEventListener('input', render);
        render();
    }

    // ---------- 备餐弹窗 ----------

    async function open() {
        const dialog = openOverlay('备餐 · 分装与含量标定');
        const body = node('div', '', 'fp-body');
        dialog.append(body);
        try {
            await renderPrepBody(body);
        } catch (error) {
            body.append(node('p', `加载失败：${error.message}`, 'fma-hint'));
        }
    }

    async function renderPrepBody(body) {
        body.replaceChildren();
        const [overview, context] = await Promise.all([
            api('prep/overview'), api(`entries?date=${today()}`)
        ]);
        body.append(node('p', '进行中的批次', 'fma-label'));
        const list = node('div', '', 'fp-batches');
        if (!overview.batches.length) {
            list.append(node('p', '还没有批次。备餐后登记：记份数，顺手标定“生肉多少克×分几份”。', 'fma-hint'));
        }
        overview.batches.forEach(batch => {
            list.append(batchRow(batch, body));
        });
        body.append(list);

        body.append(node('p', '登记新批次', 'fma-label'));
        const form = node('div', '', 'fp-form');
        const state = { food: null, raw: '', portions: 8 };
        const picked = node('p', '未选择食物', 'fma-hint');
        form.append(picked);
        // 食物选择：弹内嵌选菜区（排除过敏）
        const candidates = context.foods.filter(food => food.status !== 'allergic');
        const pickerHost = node('div', '', 'fp-picker');
        foodChips(pickerHost, candidates, food => {
            state.food = food;
            picked.textContent = `已选：${food.name}`;
            refreshHint();
        });
        form.append(pickerHost);

        const rawLabel = node('label', '', 'fp-field');
        rawLabel.append(node('span', '生肉/生菜总克数（选填）', 'fma-label'));
        const rawInput = node('input', '', 'fma-scope-date');
        rawInput.type = 'number';
        rawInput.min = '0';
        rawInput.placeholder = '如 150';
        rawInput.addEventListener('input', () => {
            state.raw = rawInput.value;
            refreshHint();
        });
        rawLabel.append(rawInput);
        form.append(rawLabel);

        const portionLabel = node('label', '', 'fp-field');
        portionLabel.append(node('span', '分成几份', 'fma-label'));
        portionLabel.append(stepper(() => state.portions, value => {
            state.portions = value;
            refreshHint();
        }, 1, 50, 1, value => `${value}份`));
        form.append(portionLabel);

        const hint = node('p', '', 'fma-hint');
        function refreshHint() {
            const grams = Number(state.raw);
            hint.textContent = (!state.food || !grams)
                ? '填了克数会自动算出每份含量；不填则只记份数。'
                : `每份约含 ${Math.round(grams * 10 / state.portions) / 10}g`;
        }
        refreshHint();
        form.append(hint);

        const save = node('button', '登记批次', 'fma-btn primary');
        save.type = 'button';
        save.addEventListener('click', async () => {
            if (!state.food) {
                toast('请先选择食物');
                return;
            }
            try {
                await api('prep/batches', 'POST', {
                    food_id: state.food.id,
                    raw_grams: Number(state.raw) || undefined,
                    portions: state.portions
                });
                toast(`已登记：${state.food.name} ${state.portions}份`);
                await renderPrepBody(body);
                refreshBanner();
            } catch (error) {
                toast(`登记失败：${error.message}`);
            }
        });
        form.append(save);
        body.append(form);
    }

    function batchRow(batch, body) {
        const row = node('div', '', 'fp-batch-row' + (batch.low ? ' low' : ''));
        row.append(node('span', `${batch.emoji} ${batch.food_name}`, 'fp-batch-name'));
        const meta = batch.grams_per_portion
            ? `剩${batch.portions_left}/${batch.portions_total}份 · ${batch.grams_per_portion}g/份`
            : `剩${batch.portions_left}/${batch.portions_total}份`;
        const forecast = batch.daily
            ? ` · 计划每天${batch.daily}份`
                + (batch.days_left == null ? '' : ` · 够吃${batch.days_left}天`)
            : '';
        const warn = batch.days_left != null && batch.days_left <= 1 ? '⚠️ ' : (batch.low ? '⚠️ ' : '');
        row.append(node('span', warn + meta + forecast, 'fp-batch-meta'));
        const fix = node('button', '修正', 'fma-btn');
        fix.type = 'button';
        fix.addEventListener('click', () => {
            const input = node('input', '', 'fma-scope-date');
            input.type = 'number';
            input.min = '0';
            input.max = String(batch.portions_total);
            input.value = String(batch.portions_left);
            const ok = node('button', '确定', 'fma-btn primary');
            ok.type = 'button';
            ok.addEventListener('click', async () => {
                try {
                    await api(`prep/batches/${batch.id}`, 'PUT', { portions_left: Number(input.value) });
                    await renderPrepBody(body);
                    refreshBanner();
                } catch (error) {
                    toast(`修正失败：${error.message}`);
                }
            });
            row.replaceChildren(node('span', `${batch.food_name} 剩余份数`, 'fp-batch-name'), input, ok);
        });
        const del = node('button', '删除', 'fma-btn danger');
        del.type = 'button';
        del.addEventListener('click', async () => {
            if (!window.confirm(`删除「${batch.food_name}」这个批次？已记录的克数不受影响。`)) return;
            try {
                await api(`prep/batches/${batch.id}`, 'DELETE');
                toast('批次已删除');
                await renderPrepBody(body);
                refreshBanner();
            } catch (error) {
                toast(`删除失败：${error.message}`);
            }
        });
        row.append(fix, del);
        return row;
    }

    // ---------- 按餐记录面板 ----------

    async function recordSheet(dateValue = today(), mealValue) {
        const dialog = openOverlay('这餐吃了多少？');
        const body = node('div', '', 'fp-body');
        dialog.append(body);
        try {
            await renderSheetBody(body, dateValue, mealValue);
        } catch (error) {
            body.append(node('p', `加载失败：${error.message}`, 'fma-hint'));
        }
    }

    async function renderSheetBody(body, dateValue, mealValue) {
        const [context, overview, bannerData] = await Promise.all([
            api(`entries?date=${dateValue}`), api('prep/overview'),
            fetch('/api/screening/banner', { cache: 'no-store' }).then(response => response.json())
        ]);
        const state = { meal: mealValue || suggestedMeal() };
        const batchByFood = {};
        (overview.batches || []).forEach(batch => {
            batchByFood[batch.food_id] = batch; // 列表按新到旧，保留最新的展示（扣减仍由后端 FIFO）
        });

        function renderMealChips() {
            const chips = node('div', '', 'fma-chips');
            Object.entries(MEALS).forEach(([value, label]) => {
                const chip = node('button', label, 'fma-chip' + (value === state.meal ? ' active' : ''));
                chip.type = 'button';
                chip.addEventListener('click', () => {
                    state.meal = value;
                    renderMealChips();
                    renderRows();
                });
                chips.append(chip);
            });
            mealHost.replaceChildren(chips);
        }

        // 该餐的行 = 计划菜品 ∪ 已有记录，再加一个「＋加一个」入口
        function dishRows() {
            const rows = [];
            const seen = new Set();
            (bannerData.items || []).forEach(item => {
                if (['due', 'upcoming'].includes(item.kind)) return;
                if (!(item.eaten_meals || []).includes(state.meal)
                    && !(window.FoodMenu?.mealsOf(item.meal) || []).includes(state.meal)) return;
                if (seen.has(item.food_id)) return;
                seen.add(item.food_id);
                const entry = context.entries.find(row => row.food_id === item.food_id && row.meal === state.meal);
                rows.push({
                    foodId: item.food_id, name: item.food,
                    tag: (item.kind === 'screening' || item.kind === 'planned') ? `🧪 ${item.text}` : '',
                    position: item.position, entryId: entry?.id,
                    amount: entry ? entry.amount : null,
                    plannedPortions: item.portions ?? null,
                    mode: item.kind === 'planned' ? 'start' : 'keep',
                    newItem: item.kind === 'planned'
                });
            });
            context.entries.filter(row => row.meal === state.meal).forEach(entry => {
                if (seen.has(entry.food_id)) return;
                seen.add(entry.food_id);
                rows.push({
                    foodId: entry.food_id, name: entry.food_name, tag: '', position: 0,
                    entryId: entry.id, amount: entry.amount, mode: 'keep', newItem: false
                });
            });
            return rows;
        }

        const mealHost = node('div', '', 'fp-meal-host');
        body.replaceChildren(mealHost, node('div', '', 'fp-rows'));
        renderMealChips();
        renderRows();

        function renderRows() {
            const host = body.querySelector('.fp-rows');
            host.replaceChildren();
            const rows = dishRows();
            rows.forEach(dish => host.append(dishRowEl(dish)));

            const add = node('button', '＋ 加一个', 'fp-add');
            add.type = 'button';
            add.addEventListener('click', () => {
                const picker = node('div', '', 'fp-picker');
                const candidates = context.foods.filter(food =>
                    food.status !== 'allergic' && !rows.some(dish => dish.foodId === food.id));
                foodChips(picker, candidates, food => {
                    rows.push({
                        foodId: food.id, name: food.name, tag: '', position: food.position || 0,
                        entryId: null, amount: null, mode: 'keep', newItem: false, added: true
                    });
                    closePicker();
                    renderRows();
                });
                function closePicker() {
                    picker.remove();
                    add.hidden = false;
                }
                add.hidden = true;
                host.append(picker);
            });
            host.append(add);

            function dishRowEl(dish) {
                const row = node('div', '', 'fp-row');
                const name = node('button', '', 'fp-row-name');
                name.type = 'button';
                name.append(node('span', dish.name));
                if (dish.tag) name.append(node('small', dish.tag));
                row.append(name);
                const batch = batchByFood[dish.foodId];
                if (batch) {
                    row.append(node('span', `剩${batch.portions_left}份${batch.grams_per_portion ? ` · ${batch.grams_per_portion}g/份` : ''}`, 'fp-row-hint'));
                }
                const stateRow = { value: dish.amount };
                if (batch) {
                    let portion = portionOf(dish.amount);
                    if (portion === null) {
                        portion = window.FoodMenu?.portionsFor(dish.plannedPortions, state.meal) ?? 1;
                    }
                    stateRow.value = `${portion}份`;
                    row.append(stepper(
                        () => portion,
                        value => { portion = value; stateRow.value = `${value}份`; },
                        0, 4, 0.5, value => value ? `${value}份` : '不吃'
                    ));
                } else {
                    const select = node('select', '', 'fma-scope-date');
                    PRESETS.forEach(value => {
                        const option = node('option', value);
                        option.value = value;
                        select.append(option);
                    });
                    select.value = dish.amount && PRESETS.includes(dish.amount)
                        ? dish.amount
                        : PRESETS[Math.min(Math.max(dish.position || 1, 1), 4) - 1];
                    stateRow.value = select.value;
                    select.addEventListener('change', () => { stateRow.value = select.value; });
                    row.append(select);
                }
                const react = node('button', '⚠️', 'fma-btn');
                react.type = 'button';
                react.setAttribute('aria-label', `记录${dish.name}的反应`);
                react.addEventListener('click', () => {
                    window.FoodBanner?.openFoodDialog({
                        food_id: dish.foodId, food: dish.name,
                        kind: dish.newItem ? 'planned' : 'normal',
                        position: dish.position || 1,
                        meal: state.meal, amount: row._amount()
                    });
                });
                row.append(react);
                row._dish = dish;
                row._amount = () => stateRow.value;
                return row;
            }
        }

        const save = node('button', '保存这餐', 'fma-btn primary');
        save.type = 'button';
        save.addEventListener('click', async () => {
            const rowEls = [...body.querySelectorAll('.fp-row')];
            const selected = rowEls.filter(row => {
                const amount = row._amount();
                return amount !== '不吃' && amount !== '' && Number(portionOf(amount)) !== 0;
            });
            if (!selected.length) {
                toast('每样都拨到 0 就等于没吃，先加点份数或加个菜');
                return;
            }
            const selectedIds = selected.map(row => row._dish.foodId);
            const others = context.entries
                .filter(row => row.meal === state.meal && !selectedIds.includes(row.food_id))
                .map(row => ({
                    id: row.id, food_id: row.food_id, amount: row.amount, rating: row.rating,
                    note: row.note, mode: 'keep'
                }));
            const entries = [...others];
            for (const row of selected) {
                const dish = row._dish;
                if (dish.newItem && !(await window.FoodBanner?.confirmNoOtherScreening([dish.foodId], dish.name))) {
                    return;
                }
                entries.push({
                    id: dish.entryId || undefined,
                    food_id: dish.foodId, amount: row._amount(), rating: null, note: '',
                    mode: dish.mode || 'keep'
                });
            }
            try {
                await api('meals', 'POST', {
                    date: dateValue, meal: state.meal,
                    revision: context.revisions[state.meal], entries
                });
                closePanel();
                toast(`已记录${MEALS[state.meal].slice(2)}：${selected.length}样`);
                window.fetchRecords?.();
                window.FoodBanner?.refresh?.();
            } catch (error) {
                toast(`保存失败：${error.message}`);
            }
        });
        body.append(save);
        body.append(node('p', '备餐过的食物按份记（自动折算克数、扣库存）；其他按勺/碗。⚠️ 可记录反应。', 'fma-hint'));
    }

    // ---------- 通用步进器（复用 .amount-control 样式） ----------

    function stepper(get, set, min, max, step, format) {
        const control = node('div', '', 'amount-control fp-stepper');
        const minus = node('button', '−', 'amount-btn');
        minus.type = 'button';
        const value = node('span', format(get()), 'fp-stepper-value');
        const plus = node('button', '+', 'amount-btn');
        plus.type = 'button';
        minus.addEventListener('click', () => {
            if (get() - step < min) return;
            set(Math.round((get() - step) * 10) / 10);
            value.textContent = format(get());
        });
        plus.addEventListener('click', () => {
            if (get() + step > max) return;
            set(Math.round((get() + step) * 10) / 10);
            value.textContent = format(get());
        });
        control.append(minus, value, plus);
        return control;
    }

    // ---------- 启动 ----------

    document.querySelector('[data-prep-open]')?.addEventListener('click', open);

    window.FoodPrep = { open, recordSheet };
})();
