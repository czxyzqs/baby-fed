/* 备餐批次 + 记录面板（按笔）：首页专用。
   弹层复用 food-menu-actions.css 的 .fma-* 样式，步进器复用 index.css 的 .amount-control。
   一笔 = 同日同进食时间的一组条目：时间为主输入，餐次标签由时间落槽推导（MealConfig.slotForTime）；
   计划菜经「带入」托盘进列表，不自动带量，避免提前记水果时被计划污染。
   数据流：/api/prep/overview（横幅+面板共用）、/api/meals（按笔替换）、/api/prep/batches。 */
(() => {
    'use strict';

    const PRESETS = ['一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗'];
    const PORTIONS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const ORDINALS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    const ordinalBadge = index => ORDINALS[index - 1] || `第${index}笔`;

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

    function nowTime() {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(new Date());
    }

    function portionOf(amount) {
        return typeof amount === 'string' && amount.endsWith('份') ? Number(amount.slice(0, -1)) : null;
    }

    function gramOf(amount) {
        return typeof amount === 'string' && amount.endsWith('g') ? Number(amount.slice(0, -1)) : null;
    }

    // ---------- 弹层骨架（复用 .fma-* 样式） ----------

    let overlay = null;
    let overlayOnClose = null;

    function closePanel() {
        const onClose = overlayOnClose;
        overlay?.remove();
        overlay = null;
        overlayOnClose = null;
        document.body.style.overflow = '';
        onClose?.();
    }

    function openOverlay(title, onClose = null) {
        closePanel();
        overlayOnClose = onClose;
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
        const active = (overview.batches || []).filter(batch => !batch.exhausted);
        const done = (overview.batches || []).filter(batch => batch.exhausted);
        body.append(node('p', '进行中的批次', 'fma-label'));
        const list = node('div', '', 'fp-batches');
        if (!active.length) {
            list.append(node('p', done.length
                ? '进行中的批次都吃完了，点下方按钮备新的一批。'
                : '还没有批次。点下方按钮登记：记份数，顺手标定“生肉多少克×分几份”。', 'fma-hint'));
        }
        active.forEach(batch => list.append(batchRow(batch, body)));
        body.append(list);

        // 已用完的批次默认收起：不占余量列表，只留修正/删除的清理入口
        if (done.length) {
            const details = document.createElement('details');
            details.className = 'fp-batches-done';
            const summary = document.createElement('summary');
            summary.textContent = `已用完的批次（${done.length}）`;
            details.append(summary);
            const doneList = node('div', '', 'fp-batches');
            done.forEach(batch => doneList.append(batchRow(batch, body)));
            details.append(doneList);
            body.append(details);
        }

        const add = node('button', '＋ 登记新批次', 'fma-btn primary fp-add-batch');
        add.type = 'button';
        add.addEventListener('click', () => openBatchForm(context));
        body.append(add);
    }

    function openBatchForm(context) {
        const dialog = openOverlay('登记新批次', () => { window.FoodPrep?.open(); });
        const body = node('div', '', 'fp-body');
        dialog.append(body);

        const state = { food: null, raw: '', portions: 8 };
        const form = node('div', '', 'fp-form');

        // 食物选择：搜索框联想，点击联想项即完成选择（排除过敏）
        const candidates = context.foods.filter(food => food.status !== 'allergic');
        const searchHost = node('div', '', 'fp-food-search');
        const search = node('input', '', 'fma-search');
        search.type = 'search';
        search.placeholder = '搜索食材，如：牛肉';
        search.setAttribute('aria-label', '搜索食材');
        const suggest = node('div', '', 'fp-suggest');
        suggest.hidden = true;

        function pick(food) {
            state.food = food;
            search.value = food.name;
            suggest.hidden = true;
            refreshHint();
        }

        function renderSuggest() {
            const query = (search.value || '').trim().toLocaleLowerCase();
            suggest.replaceChildren();
            if (!query) {
                suggest.hidden = true;
                return;
            }
            const matched = candidates.filter(food =>
                food.name.toLocaleLowerCase().includes(query));
            if (!matched.length) {
                suggest.append(node('p', '没有匹配的食材，可先去辅食库添加。', 'fma-hint'));
            } else {
                const group = node('div', '', 'fma-chips');
                matched.forEach(food => {
                    const category = (context.categories || []).find(row => row.id === food.category_id);
                    const chip = node('button', `${category?.emoji ? `${category.emoji} ` : ''}${food.name}`, 'fma-chip');
                    chip.type = 'button';
                    chip.addEventListener('click', () => pick(food));
                    group.append(chip);
                });
                suggest.append(group);
            }
            suggest.hidden = false;
        }

        search.addEventListener('input', renderSuggest);
        search.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const query = (search.value || '').trim().toLocaleLowerCase();
            const matched = query ? candidates.filter(food =>
                food.name.toLocaleLowerCase().includes(query)) : [];
            if (matched[0]) pick(matched[0]);
        });
        searchHost.append(search, suggest);
        form.append(searchHost);

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
            if (!state.food) {
                hint.textContent = '输入食材名搜索并点选联想项；填了克数会自动算出每份含量。';
            } else if (!grams) {
                hint.textContent = `已选：${state.food.name}。填了克数会自动算出每份含量；不填则只记份数。`;
            } else {
                hint.textContent = `已选：${state.food.name} · 每份约含 ${Math.round(grams * 10 / state.portions) / 10}g`;
            }
        }
        refreshHint();
        form.append(hint);

        const save = node('button', '登记批次', 'fma-btn primary');
        save.type = 'button';
        save.addEventListener('click', async () => {
            if (!state.food) {
                toast('请先搜索并选择食材');
                search.focus();
                return;
            }
            try {
                await api('prep/batches', 'POST', {
                    food_id: state.food.id,
                    raw_grams: Number(state.raw) || undefined,
                    portions: state.portions
                });
                toast(`已登记：${state.food.name} ${state.portions}份`);
                closePanel(); // onClose 会重新打开批次列表
                window.FoodBanner?.refresh?.();
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
        const meta = batch.exhausted
            ? `已用完（共${batch.portions_total}份）`
            : batch.grams_per_portion
                ? `剩${batch.portions_left}/${batch.portions_total}份 · ${batch.grams_per_portion}g/份`
                : `剩${batch.portions_left}/${batch.portions_total}份`;
        const forecast = batch.exhausted
            ? ' · 该备新批次了'
            : batch.daily
                ? ` · 计划每天${batch.daily}份`
                    + (batch.days_left == null ? '' : ` · 够吃${batch.days_left}天`)
                : '';
        const warn = (batch.days_left != null && batch.days_left <= 1) || batch.low || batch.exhausted ? '⚠️ ' : '';
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
                    window.FoodBanner?.refresh?.();
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
                window.FoodBanner?.refresh?.();
            } catch (error) {
                toast(`删除失败：${error.message}`);
            }
        });
        row.append(fix, del);
        return row;
    }

    // ---------- 记录面板（按笔） ----------

    async function recordSheet(dateValue = today()) {
        const dialog = openOverlay('记一笔辅食');
        const body = node('div', '', 'fp-body');
        dialog.append(body);
        try {
            await renderSheetBody(body, dateValue);
        } catch (error) {
            body.append(node('p', `加载失败：${error.message}`, 'fma-hint'));
        }
    }

    async function renderSheetBody(body, dateValue) {
        const [context, overview, bannerData] = await Promise.all([
            api(`entries?date=${dateValue}`), api('prep/overview'),
            fetch('/api/screening/banner', { cache: 'no-store' }).then(response => response.json())
        ]);
        // 状态：time=这笔的进食时间（主输入）；editing=正在编辑的已有笔（null=新记一笔）
        const state = { time: nowTime(), editing: null };
        let addedRows = new Map();   // ＋加一个/计划带入的行：切换笔时清空
        // 批次按食物聚合：只要有批次（含已用完）就按份记；余量提示汇总全部批次，
        // 每份克数取还有余量的批次（多批不同含量给区间），不再误取最老的用完批次
        const batchByFood = {};
        (overview.batches || []).forEach(batch => {
            const info = batchByFood[batch.food_id]
                || (batchByFood[batch.food_id] = { left: 0, grams: [] });
            info.left += batch.portions_left || 0;
            if (batch.portions_left > 0 && batch.grams_per_portion
                && !info.grams.includes(batch.grams_per_portion)) {
                info.grams.push(batch.grams_per_portion);
            }
        });

        const occasions = context.occasions || [];
        const slotOf = () => window.MealConfig?.slotForTime(state.time) || 'lunch';
        const slotLabel = () => window.MealConfig?.labels?.[slotOf()] || '';

        // 计划托盘候选：时间所属槽内、计划里还没吃的菜（已带入/已在笔里的不算）
        function trayItems() {
            const slot = slotOf();
            const inRows = new Set(currentDishes().map(dish => dish.foodId));
            return (bannerData.items || []).filter(item => {
                if (['due', 'upcoming'].includes(item.kind)) return false;
                if ((item.eaten_meals || []).includes(slot)) return false;
                if (!(window.FoodMenu?.mealsOf(item.meal) || []).includes(slot)) return false;
                return !inRows.has(item.food_id);
            });
        }

        // 这笔的行 = 已有笔的条目 ∪ 带入/加进来的行
        function currentDishes() {
            const rows = [];
            const seen = new Set();
            (state.editing ? state.editing.entries : []).forEach(entry => {
                if (seen.has(entry.food_id)) return;
                seen.add(entry.food_id);
                rows.push({
                    foodId: entry.food_id, name: entry.food_name, tag: '', position: 0,
                    entryId: entry.id, amount: entry.amount,
                    rating: entry.rating || null, note: entry.note || '',
                    mode: 'keep', newItem: false
                });
            });
            addedRows.forEach(dish => {
                if (seen.has(dish.foodId)) return;
                seen.add(dish.foodId);
                rows.push(dish);
            });
            return rows;
        }

        function occasionChipLabel(occasion, index) {
            const names = occasion.entries.map(row => row.food_name);
            const summary = names.length <= 2 ? names.join('、') : `${names[0]}、${names[1]}等${names.length}样`;
            return `${ordinalBadge(index + 1)} ${occasion.time} · ${summary}`;
        }

        const mealHost = node('div', '', 'fp-meal-host');
        const trayHost = node('div', '', 'fp-plan-tray');
        const rowsHost = node('div', '', 'fp-rows');
        body.replaceChildren(mealHost, trayHost, rowsHost);

        let timeInput = null;

        function renderHead() {
            const timeLabel = node('label', '', 'fp-time');
            timeLabel.append(node('span', '这餐几点'));
            timeInput = document.createElement('input');
            timeInput.type = 'time';
            timeInput.className = 'form-input';
            timeInput.value = state.time;
            timeInput.addEventListener('change', () => {
                state.time = timeInput.value || nowTime();
                renderHead();
                renderTray();
            });
            timeLabel.append(timeInput);
            const slotTag = node('span', slotLabel(), 'fp-slot-tag');
            mealHost.replaceChildren(timeLabel, slotTag);

            const chips = node('div', '', 'fma-chips fp-occasion-chips');
            occasions.forEach((occasion, index) => {
                const chip = node('button', occasionChipLabel(occasion, index),
                    'fma-chip' + (state.editing === occasion ? ' active' : ''));
                chip.type = 'button';
                chip.addEventListener('click', () => {
                    if (state.editing === occasion) return;
                    state.editing = occasion;
                    state.time = occasion.time;
                    addedRows = new Map();
                    renderHead();
                    renderTray();
                    renderRows();
                });
                chips.append(chip);
            });
            const fresh = node('button', '＋ 新记一笔',
                'fma-chip' + (state.editing === null ? ' active' : ''));
            fresh.type = 'button';
            fresh.addEventListener('click', () => {
                if (state.editing === null) return;
                state.editing = null;
                state.time = nowTime();
                addedRows = new Map();
                renderHead();
                renderTray();
                renderRows();
            });
            chips.append(fresh);
            mealHost.append(chips);
        }

        function renderTray() {
            const items = trayItems();
            trayHost.replaceChildren();
            if (!items.length) {
                trayHost.hidden = true;
                return;
            }
            const names = items.map(item => item.food).join('、');
            const label = node('span',
                `今天的计划${slotLabel() ? `（${slotLabel()}）` : ''}：${names}`, 'fp-plan-tray-text');
            const bring = node('button', '带入', 'fma-btn');
            bring.type = 'button';
            bring.addEventListener('click', () => {
                items.forEach(item => {
                    addedRows.set(item.food_id, {
                        foodId: item.food_id, name: item.food,
                        tag: (item.kind === 'screening' || item.kind === 'planned') ? `🧪 ${item.text}` : '',
                        position: item.position, entryId: null, amount: null,
                        rating: null, note: '',
                        plannedPortions: item.portions ?? null,
                        gramDefault: item.gram_default ?? null,
                        mode: item.kind === 'planned' ? 'start' : 'keep',
                        newItem: item.kind === 'planned'
                    });
                });
                renderTray();
                renderRows();
            });
            trayHost.append(label, bring);
            trayHost.hidden = false;
        }

        function renderRows() {
            rowsHost.replaceChildren();
            const rows = currentDishes();
            rows.forEach(dish => rowsHost.append(dishRowEl(dish)));

            const add = node('button', '＋ 加一个', 'fp-add');
            add.type = 'button';
            add.addEventListener('click', () => {
                const picker = node('div', '', 'fp-picker');
                const candidates = context.foods.filter(food =>
                    food.status !== 'allergic' && !currentDishes().some(dish => dish.foodId === food.id));
                foodChips(picker, candidates, food => {
                    addedRows.set(food.id, {
                        foodId: food.id, name: food.name, tag: '', position: food.position || 0,
                        entryId: null, amount: null, rating: null, note: '',
                        mode: 'keep', newItem: false
                    });
                    closePicker();
                    renderTray();
                    renderRows();
                });
                function closePicker() {
                    picker.remove();
                    add.hidden = false;
                }
                add.hidden = true;
                rowsHost.append(picker);
            });
            rowsHost.append(add);

            function dishRowEl(dish) {
                const row = node('div', '', 'fp-row');
                const name = node('button', '', 'fp-row-name');
                name.type = 'button';
                name.append(node('span', dish.name));
                if (dish.tag) name.append(node('small', dish.tag));
                row.append(name);
                // 剩量提示并入名字列，控件区（步进器+⚠️）整组换行，避免⚠️被单独挤到下一行
                const controls = node('div', '', 'fp-row-controls');
                const batch = batchByFood[dish.foodId];
                if (batch) {
                    const gramText = !batch.grams.length ? ''
                        : batch.grams.length === 1 ? ` · ${batch.grams[0]}g/份`
                        : ` · ${Math.min(...batch.grams)}~${Math.max(...batch.grams)}g/份`;
                    name.append(node('small',
                        batch.left ? `剩${batch.left}份${gramText}` : `已吃完，备新批次按新含量折算`, 'fp-row-hint'));
                }
                const stateRow = { value: dish.amount };
                if (batch) {
                    let portion = portionOf(dish.amount);
                    if (portion === null) {
                        portion = window.FoodMenu?.portionsFor(dish.plannedPortions, slotOf()) ?? 1;
                    }
                    stateRow.value = `${portion}份`;
                    controls.append(stepper(
                        () => portion,
                        value => { portion = value; stateRow.value = `${value}份`; },
                        0, 4, 0.5, value => value ? `${value}份` : '不吃'
                    ));
                } else if (dish.gramDefault != null) {
                    // 干粉主食按克直记：默认 6g，克数直接入克数账本
                    let gram = gramOf(dish.amount)
                        ?? window.FoodMenu?.portionsFor(dish.plannedPortions, slotOf())
                        ?? dish.gramDefault;
                    stateRow.value = `${gram}g`;
                    controls.append(stepper(
                        () => gram,
                        value => { gram = value; stateRow.value = `${value}g`; },
                        2, 30, 1, value => `${value}g`
                    ));
                } else {
                    const select = node('select', '', 'fma-scope-date');
                    PRESETS.forEach(value => {
                        const option = node('option', value);
                        option.value = value;
                        select.append(option);
                    });
                    if (dish.amount && !PRESETS.includes(dish.amount)) {
                        const option = node('option', dish.amount);
                        option.value = dish.amount;
                        select.append(option);
                    }
                    select.value = dish.amount && (PRESETS.includes(dish.amount) || dish.amount)
                        ? dish.amount
                        : PRESETS[Math.min(Math.max(dish.position || 1, 1), 4) - 1];
                    stateRow.value = select.value;
                    select.addEventListener('change', () => { stateRow.value = select.value; });
                    controls.append(select);
                }
                row.append(controls);
                const react = node('button', '⚠️', 'fma-btn');
                react.type = 'button';
                react.setAttribute('aria-label', `记录${dish.name}的反应`);
                react.addEventListener('click', () => {
                    window.FoodBanner?.openFoodDialog({
                        food_id: dish.foodId, food: dish.name,
                        kind: dish.newItem ? 'planned' : 'normal',
                        position: dish.position || 1,
                        meal: slotOf(), amount: row._amount()
                    });
                });
                controls.append(react);
                row._dish = dish;
                row._amount = () => stateRow.value;
                return row;
            }
        }

        renderHead();
        renderTray();
        renderRows();

        const save = node('button', '保存这笔', 'fma-btn primary');
        save.type = 'button';
        save.addEventListener('click', async () => {
            const timeValue = state.time;
            if (!timeValue) {
                toast('请先填这餐几点吃的');
                return;
            }
            const rowEls = [...body.querySelectorAll('.fp-row')];
            // 0/不吃/空 = 没吃；份数与克数分别判（'7g' 不是份数，不能因 Number(null)===0 误判为零）
            function amountKept(amount) {
                if (amount === '不吃' || amount === '') return false;
                const portion = portionOf(amount);
                if (portion !== null) return portion > 0;
                const grams = gramOf(amount);
                if (grams !== null) return grams > 0;
                return true;
            }
            const selected = rowEls.filter(row => amountKept(row._amount()));
            // 已有笔的行全部在列：拨到 0/不吃 = 这笔里真的删掉它；整笔全 0 = 删除这笔
            if (!selected.length) {
                if (state.editing) {
                    if (!window.confirm('这笔全部拨 0，保存后整笔删除。确定吗？')) return;
                } else {
                    toast('先加个菜或从计划里带入，再保存');
                    return;
                }
            }
            const entries = [];
            for (const row of selected) {
                const dish = row._dish;
                if (dish.newItem && !(await window.FoodBanner?.confirmNoOtherScreening([dish.foodId], dish.name))) {
                    return;
                }
                entries.push({
                    id: dish.entryId || undefined,
                    food_id: dish.foodId, amount: row._amount(),
                    rating: dish.rating || null, note: dish.note || '',
                    mode: dish.mode || 'keep'
                });
            }
            try {
                await api('meals', 'POST', {
                    date: dateValue, time: timeValue,
                    revision: context.day_revision,
                    ids: state.editing ? state.editing.entries.map(row => row.id) : [],
                    entries
                });
                closePanel();
                toast(entries.length ? `已记录 ${timeValue} 这笔：${entries.length}样` : `已删除 ${timeValue} 这笔`);
                window.fetchRecords?.();
                window.FoodBanner?.refresh?.();
            } catch (error) {
                toast(`保存失败：${error.message}`);
            }
        });
        body.append(save);
        body.append(node('p', '备餐食物按份记、自动扣库存；其余按勺/碗。⚠️ 记反应。', 'fma-hint'));
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
