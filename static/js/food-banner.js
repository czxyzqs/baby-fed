/* 首页排敏横幅：计划行、待标记提醒；点计划行弹出「记录进食/记录反应」弹窗 */
(() => {
    const banner = document.getElementById('food-screening-banner');
    const body = document.getElementById('food-screening-banner-body');
    if (!banner || !body) return;

    const AMOUNTS = ['一勺尖', '一勺', '两勺', '三勺', '半碗', '一碗'];
    const RATINGS = [['喜欢', '😋 喜欢'], ['一般', '😐 一般'], ['拒绝', '🥴 拒绝']];
    const SYMPTOMS = ['口周红疹', '荨麻疹', '呕吐', '腹泻', '便秘', '湿疹加重', '其他'];
    const MEALS = { breakfast: '早餐', lunch: '午餐', snack: '下午茶', dinner: '晚餐' };

    // 计划餐次可能是多选（逗号分隔）或旧值 both/all（午晚两餐），统一展开成数组
    function mealsOf(value) {
        if (value === 'both' || value === 'all') return ['lunch', 'dinner'];
        return String(value || '').split(',').filter(Boolean);
    }

    function node(tag, text, className = '') {
        const result = document.createElement(tag);
        if (text) result.textContent = text;
        if (className) result.className = className;
        return result;
    }

    function chip(text, handler, active = false) {
        const result = node('button', text, 'banner-chip' + (active ? ' active' : ''));
        result.type = 'button';
        result.addEventListener('click', handler);
        return result;
    }

    function today() {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    }

    function suggestedMeal() {
        const hour = Number(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'
        }).format(new Date()));
        return hour < 11 ? 'breakfast' : hour < 14 ? 'lunch' : hour < 17 ? 'snack' : 'dinner';
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

    function toast(text) {
        window.showToast?.(text);
    }

    async function load() {
        try {
            const [bannerFetch, prepFetch] = await Promise.all([
                fetch('/api/screening/banner', { cache: 'no-store' }),
                fetch('/api/prep/overview', { cache: 'no-store' }).catch(() => null)
            ]);
            const result = await bannerFetch.json();
            if (!bannerFetch.ok) throw new Error(result.error || '加载失败');
            lastItems = result.items || [];
            lastOverrides = result.overrides || {};
            lastHidden = result.hidden || [];
            if (prepFetch && prepFetch.ok) {
                const prep = await prepFetch.json().catch(() => null);
                batchByFood = {};
                (prep?.batches || []).forEach(batch => {
                    if (batch.portions_left > 0) batchByFood[batch.food_id] = batch;
                });
            }
            render(lastItems, lastOverrides);
        } catch (error) {
            banner.hidden = true;
        }
    }

    let lastItems = [];
    let lastOverrides = {};
    let lastHidden = [];
    let batchByFood = {};   // food_id -> 有余量的备餐批次（✓ 快捷记录对备餐食物默认记 1 份）
    let todayContext = null;

    async function getContext() {
        if (!todayContext) todayContext = await api(`entries?date=${today()}`);
        return todayContext;
    }

    // 完整餐单内容（待标记、明日预告、四餐格），渲染进底部弹层
    function buildPlanContent() {
        const wrap = node('div', '', 'food-plan-content');
        const foods = [];
        lastItems.forEach(item => {
            if (item.kind === 'due') {
                const card = node('div', '', 'food-banner-item food-banner-due');
                card.append(node('span', `🔔 ${item.food} ${item.text}`, 'food-banner-text'));
                const jump = node('a', '去标记 ›', 'food-banner-link');
                jump.href = '/screening';
                card.append(jump);
                wrap.append(card);
            } else if (item.kind === 'upcoming') {
                const card = node('div', '', 'food-banner-item food-banner-upcoming');
                card.append(node('span', `明天吃${item.food}`, 'food-banner-text'));
                const ack = node('button', '我知道了', 'banner-ack');
                ack.type = 'button';
                ack.addEventListener('click', async event => {
                    event.stopPropagation();
                    ack.disabled = true;
                    try {
                        await api('screening/banner/ack', 'POST', { block_id: item.block_id });
                        load();
                    } catch (error) {
                        ack.disabled = false;
                        toast(`操作失败：${error.message}`);
                    }
                });
                card.append(ack);
                wrap.append(card);
            } else {
                foods.push(item);
            }
        });
        if (!foods.length) {
            appendHiddenRow(wrap);
            return wrap;
        }
        // 今日餐单：固定四餐格（早/午/下午茶/晚）；点菜名打开菜品动作面板（换餐/替换/不吃/加菜）
        const menu = node('div', '', 'food-banner-menu');
        const labels = { breakfast: '🥣 早餐', lunch: '☀️ 午餐', snack: '🍎 下午茶', dinner: '🌙 晚餐' };
        Object.entries(labels).forEach(([meal, label]) => {
            const columnFoods = foods.filter(item => mealsOf(item.meal).includes(meal));
            // 纯预览：没有规划的餐次整列不展示
            if (!columnFoods.length) return;
            const column = node('div', '', 'food-banner-menu-col');
            column.append(node('h4', label, 'food-banner-menu-title'));
            columnFoods.forEach(item => {
                // ✓ 只展示「这一列的餐次」是否已记录，预览不可点
                const eatenMeals = item.eaten_meals || [];
                const eaten = eatenMeals.includes(meal);
                const elsewhere = eatenMeals.filter(other => other !== meal);
                const pill = node('span', '', 'food-banner-pill' + (eaten ? ' eaten' : ''));
                const name = node('span', '', 'food-banner-pill-name');
                name.append(node('span', item.food));
                if (item.kind === 'screening' || item.kind === 'planned') {
                    name.append(node('small', `🧪 ${item.text || ''}`.trim()));
                }
                if (elsewhere.length) {
                    name.title = `今天已在${elsewhere.map(other => MEALS[other]).join('、')}吃过`;
                }
                pill.append(name);
                column.append(pill);
            });
            menu.append(column);
        });
        if (!menu.children.length) return wrap;
        wrap.append(menu);
        wrap.append(node('p', '本弹层只做计划预览；点横幅右侧「记」记录这一餐，调整计划请到排期页。', 'food-banner-menu-hint'));
        appendHiddenRow(wrap);
        return wrap;
    }

    // 「今天不吃」的食物：底部只读展示（恢复入口在排期页）
    function appendHiddenRow(wrap) {
        if (!lastHidden.length) return;
        const row = node('div', '', 'food-banner-hidden-row');
        const names = [...new Set(lastHidden.map(item => item.food))];
        row.append(node('span', `今天不吃：${names.join('、')}`, 'food-banner-hidden-label'));
        wrap.append(row);
    }

    function panelChanged(result) {
        if (result && Array.isArray(result.items)) {
            lastItems = result.items;
            lastOverrides = result.overrides || {};
            lastHidden = result.hidden || [];
            render(lastItems, lastOverrides);
        } else {
            load();
        }
    }

    function dishFromItem(item) {
        const kind = item.kind === 'screening' || item.kind === 'planned'
            ? 'screening' : (item.kind === 'extra' ? 'extra' : 'normal');
        return {
            foodId: item.food_id, name: item.food, kind,
            meals: mealsOf(item.meal),
            hasOverride: Object.prototype.hasOwnProperty.call(lastOverrides, String(item.food_id))
                || Object.prototype.hasOwnProperty.call(lastOverrides, item.food_id),
            position: item.position, observeDays: item.observe_days,
            planId: item.plan_id, blockId: item.block_id,
            plannedPortions: item.portions ?? null,
            gramFood: item.gram_default != null && !batchByFood[item.food_id],
            screeningReplaceable: item.kind === 'planned' && item.position === 1
        };
    }

    async function openDishPanelForToday(item, meal, context) {
        const dish = dishFromItem(item);
        FoodMenu.openDishPanel({
            day: today(), meal, dish,
            replaceCandidates: context.foods.filter(food => food.status === 'normal' && food.id !== dish.foodId),
            screeningSwapCandidates: context.foods.filter(food => food.status === 'untouched' && food.id !== dish.foodId),
            onChanged: panelChanged
        });
    }

    function openAddForToday(meal, context) {
        FoodMenu.openAddDialog({
            day: today(), meal,
            foods: context.foods.filter(food => food.status === 'normal'),
            onChanged: panelChanged
        });
    }

    function openPlanDialog() {
        closeDialog();
        overlay = node('div', '', 'banner-dialog-overlay food-plan-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'banner-dialog-head');
        head.append(node('h2', '今日辅食计划', 'banner-dialog-title'));
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(close);
        dialog.append(head);
        dialog.append(buildPlanContent());
        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
    }

    function render(items, overrides = {}) {
        lastItems = items;
        lastOverrides = overrides;
        body.replaceChildren();
        if (!items.length) {
            banner.hidden = true;
            if (overlay?.classList.contains('food-plan-overlay')) closeDialog();
            return;
        }
        banner.hidden = false;
        // 单行入口双热区：主体打开计划预览，右侧「记」直达记录面板
        const entry = node('div', '', 'food-plan-entry');
        const preview = node('button', '', 'food-plan-entry-main');
        preview.type = 'button';
        preview.append(node('span', '🥣', 'food-plan-entry-icon'));
        preview.append(node('div', '今日辅食计划', 'food-plan-entry-title'));
        preview.append(node('span', '›', 'food-plan-entry-arrow'));
        preview.addEventListener('click', openPlanDialog);
        entry.append(preview);
        const record = node('button', '记', 'food-plan-entry-record');
        record.type = 'button';
        record.setAttribute('aria-label', '记一餐辅食');
        record.addEventListener('click', () => {
            if (window.FoodPrep) FoodPrep.recordSheet(today());
        });
        entry.append(record);
        body.append(entry);
        // ✓ 勾选等操作会触发重渲染；餐单弹层开着时就地刷新内容
        if (overlay?.classList.contains('food-plan-overlay')) {
            overlay.querySelector('.food-plan-content')?.replaceWith(buildPlanContent());
        }
    }

    // 临时调整餐次已并入 FoodMenu 动作面板（food-menu-actions.js）：换餐/替换/这餐不吃/加菜统一入口

    function suggestedAmount(item) {
        if (batchByFood[item.food_id]?.portions_left > 0) return '1份';
        if (item.gram_default != null && !batchByFood[item.food_id]) return `${item.gram_default}g`;
        return AMOUNTS[Math.min(Math.max(item.position || 1, 1), 4) - 1];
    }

    function plannedFoods() {
        return lastItems.filter(item => item.kind !== 'due' && item.kind !== 'upcoming');
    }

    // 引入新食物时的归因提醒：还有别的食物在排敏观察中需确认
    async function confirmNoOtherScreening(foodIds, name) {
        const board = await api('screening/board');
        const other = board.foods.find(food => food.status === 'screening' && !foodIds.includes(food.id));
        if (!other) return true;
        return window.confirm(
            `「${other.food}」正在排敏观察中。同时引入「${name}」会让过敏反应难以归因，建议等观察期结束。确定仍要记录吗？`);
    }

    // 横幅 ✓ 快捷勾选：只针对所在列的餐次——没吃 → 按建议量记一笔记食；已吃 → 撤销该餐记录
    async function toggleEaten(item, meal) {
        try {
            const dateValue = today();
            const result = await api(`entries?date=${dateValue}`);
            const entry = result.entries.find(row => row.food_id === item.food_id && row.meal === meal);
            const keepOthers = result.entries
                .filter(row => row.meal === meal && row.food_id !== item.food_id)
                .map(row => ({
                    id: row.id, food_id: row.food_id, amount: row.amount,
                    rating: row.rating, note: row.note, mode: 'keep'
                }));
            if (entry) {
                await api('meals', 'POST', {
                    date: dateValue, meal,
                    revision: result.revisions[meal], entries: keepOthers
                });
                toast(`已取消「${item.food}」${MEALS[meal]}的进食记录`);
                window.fetchRecords?.();
            } else {
                const mode = item.kind === 'planned' ? 'start' : 'keep';
                if (mode === 'start' && !await confirmNoOtherScreening([item.food_id], item.food)) return;
                const amount = suggestedAmount(item);
                await api('meals', 'POST', {
                    date: dateValue, meal,
                    revision: result.revisions[meal],
                    entries: [...keepOthers, {
                        food_id: item.food_id, amount, rating: null, note: '', mode
                    }]
                });
                toast(`已记录${MEALS[meal]}：${item.food} ${amount}`);
                window.fetchRecords?.();
            }
            todayContext = null;
            load();
        } catch (error) {
            toast(`操作失败：${error.message}`);
        }
    }

    // ---------- 记录弹窗：进食 + 反应 ----------

    let overlay = null;

    function closeDialog() {
        overlay?.remove();
        overlay = null;
        document.body.style.overflow = '';
    }

    // ---------- 快速添加：有规划直接进记录界面（预选规划食物），否则选食物 ----------

    const STATUS_LABELS = { untouched: '未排敏', screening: '排敏中', normal: '正常', allergic: '过敏' };

    async function openQuickAdd() {
        let context;
        try {
            context = await getContext();
        } catch (error) {
            toast(`加载食物失败：${error.message}`);
            return;
        }
        if (plannedFoods().length && window.FoodPrep) {
            FoodPrep.recordSheet(today());
            return;
        }
        openPickerDialog(context);
    }

    function openPickerDialog(context) {
        closeDialog();
        overlay = node('div', '', 'banner-dialog-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'banner-dialog-head');
        head.append(node('h2', '选择食物', 'banner-dialog-title'));
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(close);
        dialog.append(head);

        const search = node('input', '', 'banner-search');
        search.type = 'search';
        search.placeholder = '搜索食物';
        search.addEventListener('input', () => renderPickerList(list, search, context));
        dialog.append(search);
        const list = node('div', '', 'banner-picker-list');
        dialog.append(list);
        renderPickerList(list, search, context);

        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
        search.focus();
    }

    function renderPickerList(list, search, context) {
        const query = (search.value || '').trim().toLocaleLowerCase();
        list.replaceChildren();
        context.categories.forEach(category => {
            const foods = context.foods.filter(food =>
                food.category_id === category.id &&
                (!query || food.name.toLocaleLowerCase().includes(query)));
            if (!foods.length) return;
            const title = node('h3',
                `${category.emoji} ${category.name}${category.is_high_allergen ? ' ⚠️' : ''}`,
                'banner-dialog-section');
            list.append(title);
            const group = node('div', '', 'banner-chip-group');
            foods.forEach(food => {
                const eaten = context.entries.some(entry => entry.food_id === food.id);
                group.append(chip(
                    `${food.name} · ${STATUS_LABELS[food.status]}${eaten ? ' · 今天已吃' : ''}`,
                    () => openFoodDialogForFood(food)
                ));
            });
            list.append(group);
        });
        if (!list.children.length) list.append(node('p', '没有匹配的食物，可到辅食库添加。', 'banner-dialog-section'));
    }

    function openFoodDialogForFood(food) {
        const kindMap = { untouched: 'planned', screening: 'screening', normal: 'normal', allergic: 'allergic' };
        const item = {
            food_id: food.id,
            food: food.name,
            kind: kindMap[food.status] || 'normal',
            position: food.position || 1
        };
        item.text = food.status === 'screening'
            ? `第${food.position}/${food.observe_days}天`
            : STATUS_LABELS[food.status];
        openFoodDialog(item);
    }

    // 今日计划批量记录已由 FoodPrep.recordSheet（food-prep.js）取代：按餐拨份数，自动折算克数

    function openFoodDialog(item) {
        closeDialog();
        const state = {
            amount: item.amount
                || (() => {
                    const anchored = mealsOf(item.meal)[0];
                    const planned = window.FoodMenu?.portionsFor(item.portions, anchored);
                    return planned ? `${planned}份` : suggestedAmount(item);
                })(),
            rating: null,
            symptoms: new Set(),
            // 默认取计划绑定的餐次；两餐都吃/无计划时按当前时段，但界面显式可选，不静默落餐
            meal: mealsOf(item.meal).length === 1 ? mealsOf(item.meal)[0] : suggestedMeal()
        };
        overlay = node('div', '', 'banner-dialog-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const head = node('div', '', 'banner-dialog-head');
        const title = node('h2', `${item.food} · ${item.text || '今日计划'}`, 'banner-dialog-title');
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(title, close);
        dialog.append(head);

        // 换食物：回到选择器
        const switchRow = node('div', '', 'banner-switch-row');
        const switchBtn = node('button', '⟳ 换个食物', 'banner-switch');
        switchBtn.type = 'button';
        switchBtn.addEventListener('click', async () => {
            try {
                openPickerDialog(await getContext());
            } catch (error) {
                toast(`加载食物失败：${error.message}`);
            }
        });
        switchRow.append(switchBtn);
        dialog.append(switchRow);

        // 过敏食物需确认记录方式（服务端状态机要求）
        if (item.kind === 'allergic') {
            state.modeOverride = 'retry';
            dialog.append(node('h3', `⚠️ ${item.food} 已标记过敏，这次怎么记？`, 'banner-dialog-section'));
            const modeGroup = node('div', '', 'banner-chip-group');
            [['retry', '按新一轮排敏'], ['only', '仅记录（误食等）']].forEach(([value, label], index) => {
                const option = chip(label, () => {
                    state.modeOverride = value;
                    [...modeGroup.children].forEach(child => child.classList.remove('active'));
                    option.classList.add('active');
                }, index === 0);
                modeGroup.append(option);
            });
            dialog.append(modeGroup);
        }

        // 记入哪餐：显式可选，保存前看得见、改得了
        dialog.append(node('h3', '记入哪餐？', 'banner-dialog-section'));
        const mealGroup = node('div', '', 'banner-chip-group');
        Object.keys(MEALS).forEach(value => {
            mealGroup.append(chip(MEALS[value], () => {
                state.meal = value;
                [...mealGroup.children].forEach(child => child.classList.remove('active'));
                mealGroup.children[Object.keys(MEALS).indexOf(value)].classList.add('active');
                eatButton.textContent = '保存今日进食';
            }, value === state.meal));
        });
        dialog.append(mealGroup);

        // 记录进食
        dialog.append(node('h3', '今天吃了吗？', 'banner-dialog-section'));
        const amountGroup = node('div', '', 'banner-chip-group');
        const portionValues = ['0.5份','1份','1.5份','2份','2.5份','3份','3.5份','4份'];
        // 备餐过的按份（扣库存折算克数）、干粉主食按克，其余勺/碗档位
        const gramChips = item.gram_default != null && !batchByFood[item.food_id]
            ? [...new Set([4, 5, 6, 8, 10, 12, 15, 20, parseInt(state.amount) || item.gram_default])]
                .sort((a, b) => a - b).map(value => `${value}g`)
            : [];
        const amountOptions = batchByFood[item.food_id]?.portions_left > 0
            ? portionValues
            : (gramChips.length ? gramChips
                : [...AMOUNTS, ...portionValues.filter(value => value === state.amount)]);
        amountOptions.forEach(value => {
            const option = chip(value, () => {
                state.amount = value;
                [...amountGroup.children].forEach(child => child.classList.remove('active'));
                option.classList.add('active');
            }, value === state.amount);
            if (value === state.amount) option.classList.add('suggested');
            amountGroup.append(option);
        });
        dialog.append(amountGroup);
        const ratingGroup = node('div', '', 'banner-chip-group');
        RATINGS.forEach(([value, label]) => {
            ratingGroup.append(chip(label, () => {
                state.rating = state.rating === value ? null : value;
                [...ratingGroup.children].forEach(child => child.classList.remove('active'));
                if (state.rating) [...ratingGroup.children][RATINGS.findIndex(entry => entry[0] === state.rating)].classList.add('active');
            }));
        });
        dialog.append(ratingGroup);
        const eatButton = node('button', '保存今日进食', 'banner-dialog-primary');
        eatButton.type = 'button';
        eatButton.addEventListener('click', () => saveIntake(item, state));
        dialog.append(eatButton);

        // 记录反应
        dialog.append(node('h3', '出现过敏反应时记录（无反应不用记）', 'banner-dialog-section'));
        const symptomGroup = node('div', '', 'banner-chip-group');
        SYMPTOMS.forEach(value => {
            symptomGroup.append(chip(value, event => {
                if (state.symptoms.has(value)) {
                    state.symptoms.delete(value);
                    event.currentTarget.classList.remove('active');
                } else {
                    state.symptoms.add(value);
                    event.currentTarget.classList.add('active');
                }
            }));
        });
        dialog.append(symptomGroup);
        const reactButton = node('button', '记录反应', 'banner-dialog-danger');
        reactButton.type = 'button';
        reactButton.addEventListener('click', () => saveReaction(item, state));
        dialog.append(reactButton);

        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
        if (item.eaten_today) prefillIntake(item, state, mealGroup, amountGroup, ratingGroup, eatButton);
    }

    async function prefillIntake(item, state, mealGroup, amountGroup, ratingGroup, eatButton) {
        try {
            const result = await api(`entries?date=${today()}`);
            const entry = result.entries.find(row => row.food_id === item.food_id);
            if (!entry || !overlay) return;
            state.amount = entry.amount;
            state.rating = entry.rating || null;
            state.meal = entry.meal;
            Object.keys(MEALS).forEach((value, position) => {
                mealGroup.children[position].classList.toggle('active', value === entry.meal);
            });
            [...amountGroup.children].forEach(child => {
                child.classList.toggle('active', child.textContent === entry.amount);
                child.classList.remove('suggested');
            });
            if (state.rating) {
                const index = RATINGS.findIndex(row => row[0] === state.rating);
                [...ratingGroup.children].forEach((child, position) => child.classList.toggle('active', position === index));
            }
            eatButton.textContent = `更新今日进食（${MEALS[state.meal]}已记录）`;
        } catch (error) {
            // 预填失败不影响手动记录
        }
    }

    async function saveIntake(item, state) {
        try {
            const dateValue = today();
            const mode = state.modeOverride || (item.kind === 'planned' ? 'start' : 'keep');
            // 引入新食物（start/retry）时提醒：同时排敏多种食物会让反应难以归因
            if ((mode === 'start' || mode === 'retry')
                && !await confirmNoOtherScreening([item.food_id], item.food)) {
                return;
            }
            const result = await api(`entries?date=${dateValue}`);
            const others = result.entries.filter(row => row.meal === state.meal && row.food_id !== item.food_id);
            const entries = others.map(row => ({
                id: row.id, food_id: row.food_id, amount: row.amount,
                rating: row.rating, note: row.note, mode: 'keep'
            }));
            entries.push({
                food_id: item.food_id, amount: state.amount, rating: state.rating,
                note: '', mode
            });
            await api('meals', 'POST', {
                date: dateValue, meal: state.meal,
                revision: result.revisions[state.meal],
                entries
            });
            todayContext = null;
            closeDialog();
            toast(`已记录${MEALS[state.meal]}：${item.food} ${state.amount}`);
            window.fetchRecords?.();
            load();
        } catch (error) {
            toast(`保存失败：${error.message}`);
        }
    }

    async function saveReaction(item, state) {
        if (!state.symptoms.size) {
            toast('请先选择症状；无反应不用记录');
            return;
        }
        try {
            await api('screening/reactions', 'POST', {
                food_id: item.food_id, date: today(),
                symptoms: [...state.symptoms], note: ''
            });
            closeDialog();
            toast(`已记录「${item.food}」的反应`);
        } catch (error) {
            toast(`保存失败：${error.message}`);
        }
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && overlay) closeDialog();
    });

    window.foodQuickRecord = { open: openQuickAdd };
    // 供 food-prep.js 的按餐记录面板复用：单食物完整记录、归因确认、刷新餐单
    window.FoodBanner = { openFoodDialog, confirmNoOtherScreening, refresh: load };
    window.addEventListener('pageshow', event => { if (event.persisted) load(); });
    load();
})();
