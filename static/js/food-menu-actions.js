/* 菜品级「按天编辑」的共用动作层：排期页当天详情与首页餐单弹层共用。
   面板/选菜器自建弹层，不依赖各页面自己的 dialog 体系；接口统一走 /api/screening/*。
   约定：一切改动默认是日级覆盖（不动长期计划）；「从此以后」仅对换餐次开放，
   直接改写常规计划段或排敏块的餐次。 */
(() => {
    'use strict';

    const MEALS = window.MealConfig?.emojiLabels || { breakfast: '🥣 早餐', lunch: '☀️ 午餐', snack: '🍎 下午茶', dinner: '🌙 晚餐' };
    const MEAL_KEYS = Object.keys(MEALS);
    const PORTION_KEYS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
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

    function mealsOf(value) {
        if (value === 'both' || value === 'all') return ['lunch', 'dinner'];
        return String(value || '').split(',').filter(Boolean);
    }

    // 份数取值：标量=各餐统一；对象（含JSON串）=按餐映射；null/缺键=不指定
    function portionsFor(value, meal) {
        if (value == null) return null;
        if (typeof value === 'string' && value.startsWith('{')) {
            try { value = JSON.parse(value); } catch (error) { return null; }
        }
        if (typeof value === 'object') return value[meal] ?? null;
        return value;
    }

    let toastTimer = null;
    function toast(text) {
        let box = document.querySelector('.fma-toast');
        if (!box) {
            box = node('div', '', 'fma-toast');
            document.body.append(box);
        }
        box.textContent = text;
        box.classList.add('show');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => box.classList.remove('show'), 2600);
    }

    // ---------- 弹层骨架 ----------

    let overlay = null;

    function closePanel() {
        overlay?.remove();
        overlay = null;
        document.body.style.overflow = '';
        document.removeEventListener('keydown', escHandler);
    }

    function openOverlay(title) {
        closePanel();
        overlay = node('div', '', 'fma-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closePanel();
        });
        document.addEventListener('keydown', escHandler);
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

    function escHandler(event) {
        if (event.key === 'Escape' && overlay) closePanel();
    }

    // ---------- 作用域：只这天 / 到几号（/ 从此以后） ----------

    function scopeSelector(config) {
        // config: { day, allowForever } → 返回 { el, days() }；days() 为 null 表示「从此以后」
        const state = { mode: 'day', endDate: null };
        const wrap = node('div', '', 'fma-scope');
        wrap.append(node('span', '作用范围', 'fma-scope-label'));
        const chips = node('div', '', 'fma-scope-chips');
        const dayChip = node('button', '只这天', 'fma-chip active');
        dayChip.type = 'button';
        dayChip.addEventListener('click', () => {
            state.mode = 'day';
            dayChip.classList.add('active');
            toChip.classList.remove('active');
            foreverChip?.classList.remove('active');
            endInput.hidden = true;
        });
        chips.append(dayChip);
        const toChip = node('button', '到几号', 'fma-chip');
        toChip.type = 'button';
        toChip.addEventListener('click', () => {
            state.mode = 'to';
            toChip.classList.add('active');
            dayChip.classList.remove('active');
            foreverChip?.classList.remove('active');
            endInput.hidden = false;
        });
        chips.append(toChip);
        let foreverChip = null;
        if (config.allowForever) {
            foreverChip = node('button', '从此以后', 'fma-chip');
            foreverChip.type = 'button';
            foreverChip.addEventListener('click', () => {
                state.mode = 'forever';
                foreverChip.classList.add('active');
                dayChip.classList.remove('active');
                toChip.classList.remove('active');
                endInput.hidden = true;
            });
            chips.append(foreverChip);
        }
        wrap.append(chips);
        const endInput = node('input', '', 'fma-scope-date');
        endInput.type = 'date';
        endInput.hidden = true;
        endInput.min = config.day;
        endInput.value = config.day;
        wrap.append(endInput);
        return {
            el: wrap,
            days() {
                if (state.mode === 'day') return 1;
                if (state.mode === 'forever') return null;
                const value = endInput.value;
                if (!value || value < config.day) throw new Error('请选择不早于当天的结束日期');
                const span = Math.round((new Date(value + 'T00:00:00') - new Date(config.day + 'T00:00:00')) / 86400000) + 1;
                if (span > 14) throw new Error('连续调整最多 14 天，更长的调整请改长期计划');
                return span;
            }
        };
    }

    // ---------- 餐次多选 ----------

    function mealPicker(selected) {
        const chosen = new Set(selected);
        const wrap = node('div', '', 'fma-chips');
        MEAL_KEYS.forEach(key => {
            const chip = node('button', MEALS[key], 'fma-chip' + (chosen.has(key) ? ' active' : ''));
            chip.type = 'button';
            chip.addEventListener('click', () => {
                if (chosen.has(key)) {
                    chosen.delete(key);
                    chip.classList.remove('active');
                } else {
                    chosen.add(key);
                    chip.classList.add('active');
                }
            });
            wrap.append(chip);
        });
        return { el: wrap, chosen };
    }

    // ---------- 食物选菜器（加菜/替换共用） ----------

    function openFoodPicker(config) {
        // config: { title, foods:[{id,name}], hint, confirmText, single, onPick(food) }
        const dialog = openOverlay(config.title);
        const search = node('input', '', 'fma-search');
        search.type = 'search';
        search.placeholder = '搜索食物';
        dialog.append(search);
        const list = node('div', '', 'fma-list');
        dialog.append(list);

        function renderList() {
            const query = (search.value || '').trim().toLocaleLowerCase();
            list.replaceChildren();
            const matched = config.foods.filter(food => !query || food.name.toLocaleLowerCase().includes(query));
            if (!matched.length) {
                list.append(node('p', '没有匹配的食物。', 'fma-hint'));
                return;
            }
            const chips = node('div', '', 'fma-chips');
            matched.forEach(food => {
                const chip = node('button', food.name, 'fma-chip');
                chip.type = 'button';
                chip.addEventListener('click', () => config.onPick(food));
                chips.append(chip);
            });
            list.append(chips);
        }

        search.addEventListener('input', renderList);
        renderList();
        if (config.hint) dialog.append(node('p', config.hint, 'fma-hint'));
        search.focus();
    }

    // ---------- 写入 ----------

    async function writeOverride(day, foodId, meal, days, portions, portionsExplicit = false, merge = null, anchorMeal = null) {
        // merge: add/remove/move 增量语义（后端以当天计划∪现有覆盖为基数），缺省=整组替换
        const payload = { date: day, food_id: foodId, meal };
        if (days > 1) payload.days = days;
        if (merge) {
            payload.merge = merge;
            if (anchorMeal) payload.anchor_meal = anchorMeal;
        }
        if (portionsExplicit) payload.portions = portions ?? null;
        else if (portions != null) payload.portions = portions;
        return api('menu-override', 'POST', payload);
    }

    // ---------- 菜品动作面板 ----------

    function openDishPanel(config) {
        // config: {
        //   day, meal(锚定餐次，可空), dish: { foodId, name, kind: 'normal'|'screening'|'extra',
        //     meals(当天实际餐次数组), hasOverride, planId, blockId, screeningReplaceable },
        //   days(整段锁定天数，>1 时隐藏作用域), extraActions: [{label, handler, danger}],
        //   replaceCandidates: [{id,name}], screeningSwapCandidates: [{id,name}],
        //   onChanged(result), segmentLabel }
        const dish = config.dish;
        const lockedDays = config.days && config.days > 1 ? config.days : null;
        const isScreening = dish.kind === 'screening';
        const dialog = openOverlay(`${dish.name} · ${config.meal ? MEALS[config.meal] : '全天'}`);

        if (lockedDays) {
            dialog.append(node('p', `以下调整作用于${config.segmentLabel}（共${lockedDays}天），长期计划不变。`, 'fma-hint'));
        }

        let scope = null;
        if (!lockedDays) {
            scope = scopeSelector({ day: config.day, allowForever: !isScreening && dish.kind !== 'extra' && !!mealHasLongTerm(dish) });
            dialog.append(scope.el);
            if (dish.hasOverride) {
                dialog.append(node('p', '这天存在临时调整，选「从此以后」会改长期计划，临时调整仍在。', 'fma-hint'));
            }
        }

        function mealHasLongTerm(target) {
            return !!target.planId || !!target.blockId;
        }

        const actions = node('div', '', 'fma-actions');

        function runWrite(job) {
            job().then(result => {
                closePanel();
                config.onChanged?.(result);
            }).catch(error => {
                toast(`操作失败：${error.message}`);
            });
        }

        function effectiveDays() {
            return lockedDays || scope.days();
        }

        // 换到别的餐
        const moveBtn = node('button', '换到别的餐', 'fma-btn');
        moveBtn.type = 'button';
        moveBtn.addEventListener('click', () => {
            const area = node('div', '', 'fma-sub');
            // 换=替换：不预选当前餐次，选中的餐次取代原餐，没选的餐不再吃
            const picker = mealPicker([]);
            area.append(picker.el);
            area.append(node('p', '选择要改到哪几餐；原来那餐会被替换掉。', 'fma-hint'));
            const save = node('button', '保存', 'fma-btn primary');
            save.type = 'button';
            save.addEventListener('click', () => {
                if (!picker.chosen.size) {
                    toast('请至少选择一个餐次');
                    return;
                }
                const meals = MEAL_KEYS.filter(key => picker.chosen.has(key));
                runWrite(async () => {
                    const days = effectiveDays();
                    if (days === null) {
                        // 从此以后：直接改长期计划/排敏块
                        const payload = { meal: meals.length === 1 ? meals[0] : meals };
                        return dish.planId
                            ? api(`normals/${dish.planId}`, 'PUT', payload)
                            : api(`blocks/${dish.blockId}`, 'PUT', payload);
                    }
                    return writeOverride(config.day, dish.foodId,
                        meals.length === 1 ? meals[0] : meals, days, undefined, false, 'move', config.meal);
                });
            });
            area.append(save);
            moveBtn.replaceWith(area);
        });
        actions.append(moveBtn);

        // 这餐不吃（锚定餐次且当天还有其他餐）
        if (config.meal && dish.meals.length > 1) {
            const skipBtn = node('button', `这餐不吃（${MEALS[config.meal]}）`, 'fma-btn');
            skipBtn.type = 'button';
            skipBtn.addEventListener('click', () => {
                runWrite(() => writeOverride(config.day, dish.foodId, config.meal, effectiveDays(),
                    undefined, false, 'remove'));
            });
            actions.append(skipBtn);
        }

        // 改每餐份数：从此以后直改计划段；这天/到几号写当日覆盖（排敏菜不规划份数）
        if (dish.kind !== 'screening') {
            const portionBtn = node('button', '改每餐份数', 'fma-btn');
            portionBtn.type = 'button';
            portionBtn.addEventListener('click', () => {
                const area = node('div', '', 'fma-sub');
                const base = config.meal ? portionsFor(dish.plannedPortions, config.meal) : dish.plannedPortions;
                const state = { value: base ?? null };
                const chips = node('div', '', 'fma-chips');
                const gram = !!dish.gramFood;
                const options = gram
                    ? [...[4, 5, 6, 8, 10, 12, 15, 20].map(value => [value, `${value}g`])]
                    : PORTION_KEYS.map(value => [value, `${value}份`]);
                const buildChips = () => {
                    chips.replaceChildren();
                    [[null, '不指定'], ...options].forEach(([value, label]) => {
                        const chip = node('button', label, 'fma-chip' + (state.value === value ? ' active' : ''));
                        chip.type = 'button';
                        chip.addEventListener('click', () => { state.value = value; buildChips(); });
                        chips.append(chip);
                    });
                };
                buildChips();
                area.append(node('p', gram ? '每餐克数：' : '每餐份数：', 'fma-label'));
                area.append(chips);
                let subScope = null;
                if (!lockedDays) {
                    subScope = scopeSelector({ day: config.day, allowForever: !!dish.planId });
                    area.append(subScope.el);
                }
                if (config.meal) {
                    area.append(node('p', `只改${MEALS[config.meal]}这一餐的量，其他餐次不变。`, 'fma-hint'));
                }
                const save = node('button', '保存', 'fma-btn primary');
                save.type = 'button';
                save.addEventListener('click', () => {
                    runWrite(async () => {
                        const days = effectiveDays();
                        if (days === null && dish.planId) {
                            return api(`normals/${dish.planId}`, 'PUT', { portions: state.value });
                        }
                        const mealValue = dish.meals.length === 1 ? dish.meals[0] : dish.meals;
                        // 按餐独立：保留其他餐次的现值，只覆盖锚定餐次
                        let payloadPortions = state.value;
                        if (config.meal && dish.meals.length > 1) {
                            const map = {};
                            dish.meals.forEach(meal => {
                                const value = meal === config.meal
                                    ? state.value : portionsFor(dish.plannedPortions, meal);
                                if (value != null) map[meal] = value;
                            });
                            const values = Object.values(map);
                            payloadPortions = !values.length ? null
                                : (new Set(values).size === 1 ? values[0] : map);
                        }
                        return writeOverride(config.day, dish.foodId, mealValue, days, payloadPortions, true);
                    });
                });
                area.append(save);
                portionBtn.replaceWith(area);
            });
            actions.append(portionBtn);
        }

        // 这天不吃
        const noneBtn = node('button', lockedDays ? '这段不吃' : '这天不吃', 'fma-btn');
        noneBtn.type = 'button';
        noneBtn.addEventListener('click', () => {
            runWrite(() => writeOverride(config.day, dish.foodId, 'none', effectiveDays()));
        });
        actions.append(noneBtn);

        // 替换：普通菜换普通菜；排敏第1天换排敏对象
        if (isScreening) {
            if (dish.screeningReplaceable && config.screeningSwapCandidates?.length) {
                const swapBtn = node('button', '替换排敏食物', 'fma-btn');
                swapBtn.type = 'button';
                swapBtn.addEventListener('click', () => {
                    openFoodPicker({
                        title: `换成什么排敏「${dish.name}」？`,
                        foods: config.screeningSwapCandidates,
                        hint: '只在还没开始吃时可用：整段排敏换成新食物，从头观察。',
                        onPick: food => {
                            runWrite(() => api(`blocks/${dish.blockId}`, 'PUT', { food_id: food.id }));
                        }
                    });
                });
                actions.append(swapBtn);
            }
        } else if (config.replaceCandidates?.length) {
            const swapBtn = node('button', '替换成…', 'fma-btn');
            swapBtn.type = 'button';
            swapBtn.addEventListener('click', () => {
                openFoodPicker({
                    title: `把${lockedDays ? config.segmentLabel : '这天'}的「${dish.name}」换成？`,
                    foods: config.replaceCandidates,
                    hint: '替换只调整所选日期，长期计划不变。',
                    onPick: food => {
                        // 只替换锚定餐次：旧食物移出这一餐（其他餐照吃），新食物补进这一餐
                        const meals = config.meal
                            ? [config.meal]
                            : (dish.meals.length ? dish.meals : ['lunch']);
                        runWrite(async () => {
                            const days = effectiveDays();
                            await writeOverride(config.day, dish.foodId, meals, days, undefined, false, 'remove');
                            return writeOverride(config.day, food.id,
                                meals.length === 1 ? meals[0] : meals, days, undefined, false, 'add');
                        });
                    }
                });
            });
            actions.append(swapBtn);
        }

        // 恢复计划默认（有日级覆盖时才有意义）
        if (dish.hasOverride) {
            const resetBtn = node('button', lockedDays ? '清除这段的临时调整' : '恢复计划默认', 'fma-btn');
            resetBtn.type = 'button';
            resetBtn.addEventListener('click', () => {
                runWrite(() => writeOverride(config.day, dish.foodId, 'default', effectiveDays()));
            });
            actions.append(resetBtn);
        }

        dialog.append(actions);

        // 页面注入的附加动作（移动/天数调整等）与危险区
        const extras = [...(config.extraActions || [])];
        if (dish.kind === 'normal' && dish.planId) {
            extras.push({
                label: '删除整个计划', danger: true,
                handler: () => {
                    if (!window.confirm(`删掉「${dish.name}」的整条常规计划？所有日期都不再安排。`)) return;
                    runWrite(() => api(`normals/${dish.planId}`, 'DELETE'));
                }
            });
        }
        if (extras.length) {
            const zone = node('div', '', 'fma-danger-zone');
            extras.forEach(action => {
                const el = node('button', action.label, 'fma-btn danger');
                el.type = 'button';
                el.addEventListener('click', action.handler);
                zone.append(el);
            });
            dialog.append(zone);
        }
    }

    // ---------- 加菜 ----------

    function openAddDialog(config) {
        // config: { day, meal(预选餐次), days(整段锁定天数), foods:[{id,name}], segmentLabel, onChanged }
        const lockedDays = config.days && config.days > 1 ? config.days : null;
        const dialog = openOverlay(`加一道菜 · ${config.meal ? MEALS[config.meal] : (config.segmentLabel || '')}`.trim());
        if (lockedDays) dialog.append(node('p', `会加到${config.segmentLabel}的每一天（共${lockedDays}天）。`, 'fma-hint'));

        dialog.append(node('p', '哪几餐吃：', 'fma-label'));
        const picker = mealPicker(config.meal ? [config.meal] : ['lunch']);
        dialog.append(picker.el);

        dialog.append(node('p', '每餐份数：', 'fma-label'));
        const portionsState = { value: 1 };
        const portionsWrap = node('div', '', 'fma-chips');
        const buildPortionsChips = () => {
            portionsWrap.replaceChildren();
            [['', '不指定'], ...PORTION_KEYS.map(value => [value, `${value}份`])].forEach(([value, label]) => {
                const active = (portionsState.value ?? '') === value;
                const chip = node('button', label, 'fma-chip' + (active ? ' active' : ''));
                chip.type = 'button';
                chip.addEventListener('click', () => {
                    portionsState.value = value === '' ? null : Number(value);
                    buildPortionsChips();
                });
                portionsWrap.append(chip);
            });
        };
        buildPortionsChips();
        dialog.append(portionsWrap);

        let scope = null;
        if (!lockedDays) {
            scope = scopeSelector({ day: config.day, allowForever: false });
            dialog.append(scope.el);
        }

        dialog.append(node('p', '选食物（可多选；仅已正常的食物，未排敏的请走排敏队列）：', 'fma-label'));
        const chosenFoods = new Map();
        const chosen = node('p', '未选择', 'fma-hint');
        openFoodPickerTo(dialog, config.foods, chosenFoods, chosen);

        const save = node('button', '加上', 'fma-btn primary');
        save.type = 'button';
        save.addEventListener('click', async () => {
            if (!chosenFoods.size) {
                toast('请先选择食物');
                return;
            }
            if (!picker.chosen.size) {
                toast('请至少选择一个餐次');
                return;
            }
            try {
                const meals = MEAL_KEYS.filter(key => picker.chosen.has(key));
                const mealValue = meals.length === 1 ? meals[0] : meals;
                const days = lockedDays || scope.days();
                save.disabled = true;
                for (const food of chosenFoods.values()) {
                    // 并入所选餐次：同食物当天其他餐次的计划不会被盖掉
                    await writeOverride(config.day, food.id, mealValue, days, portionsState.value, false, 'add');
                }
                closePanel();
                toast(`已加：${[...chosenFoods.values()].map(food => food.name).join('、')}`);
                config.onChanged?.();
            } catch (error) {
                save.disabled = false;
                toast(`操作失败：${error.message}`);
            }
        });
        dialog.append(save);
    }

    function openFoodPickerTo(dialog, foods, chosenFoods, label) {
        // 内嵌在加菜弹窗里的选菜区：搜索 + 多选，已选状态跨搜索保持
        const search = node('input', '', 'fma-search');
        search.type = 'search';
        search.placeholder = '搜索食物';
        dialog.append(search);
        const list = node('div', '', 'fma-list');
        dialog.append(list);

        function refreshLabel() {
            label.textContent = chosenFoods.size
                ? `已选：${[...chosenFoods.values()].map(food => food.name).join('、')}`
                : '未选择';
        }

        function render() {
            const query = (search.value || '').trim().toLocaleLowerCase();
            list.replaceChildren();
            const matched = foods.filter(food => !query || food.name.toLocaleLowerCase().includes(query));
            if (!matched.length) {
                list.append(node('p', '没有匹配的食物。', 'fma-hint'));
                return;
            }
            const group = node('div', '', 'fma-chips');
            matched.forEach(food => {
                const chip = node('button', food.name, 'fma-chip' + (chosenFoods.has(food.id) ? ' active' : ''));
                chip.type = 'button';
                chip.addEventListener('click', () => {
                    if (chosenFoods.has(food.id)) {
                        chosenFoods.delete(food.id);
                        chip.classList.remove('active');
                    } else {
                        chosenFoods.set(food.id, food);
                        chip.classList.add('active');
                    }
                    refreshLabel();
                });
                group.append(chip);
            });
            list.append(group);
        }

        search.addEventListener('input', render);
        render();
        dialog.append(label);
    }

    window.FoodMenu = { MEALS, mealsOf, portionsFor, openDishPanel, openAddDialog, closePanel };
})();
