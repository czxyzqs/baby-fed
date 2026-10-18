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
            const response = await fetch('/api/screening/banner', { cache: 'no-store' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '加载失败');
            render(result.items || [], result.overrides || {});
        } catch (error) {
            banner.hidden = true;
        }
    }

    let lastItems = [];
    let lastOverrides = {};
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
        if (!foods.length) return wrap;
        // 今日餐单：固定四餐格（早/午/下午茶/晚），排敏只出现在午/晚，早/下午茶放常规计划
        const menu = node('div', '', 'food-banner-menu');
        [['breakfast', '🥣 早餐'], ['lunch', '☀️ 午餐'], ['snack', '🍎 下午茶'], ['dinner', '🌙 晚餐']].forEach(([meal, label]) => {
            const column = node('div', '', 'food-banner-menu-col');
            column.append(node('h4', label, 'food-banner-menu-title'));
            const columnFoods = foods.filter(item => mealsOf(item.meal).includes(meal));
            if (!columnFoods.length) {
                column.append(node('p', '没有计划', 'food-banner-menu-empty'));
            }
            columnFoods.forEach(item => {
                // ✓ 只反映「这一列的餐次」今天有没有记录；别餐已吃的提示放 title 里，避免药丸文字挤爆
                const eatenMeals = item.eaten_meals || [];
                const eaten = eatenMeals.includes(meal);
                const elsewhere = eatenMeals.filter(other => other !== meal);
                const pill = node('span', '', 'food-banner-pill' + (eaten ? ' eaten' : ''));
                const check = node('button', eaten ? '✓' : '', 'banner-check' + (eaten ? ' checked' : ''));
                check.type = 'button';
                check.setAttribute('aria-pressed', String(eaten));
                check.setAttribute('aria-label', `快速记录「${item.food}」${MEALS[meal]}${eaten ? '已吃（点按取消）' : '吃了'}`);
                check.addEventListener('click', event => {
                    event.stopPropagation();
                    toggleEaten(item, meal);
                });
                const name = node('button', '', 'food-banner-pill-name');
                name.type = 'button';
                name.append(node('span', item.food));
                if (item.text) name.append(node('small', item.text));
                if (elsewhere.length) {
                    name.title = `今天已在${elsewhere.map(other => MEALS[other]).join('、')}吃过`;
                }
                name.addEventListener('click', () => adjustMealDialog(item));
                pill.append(check, name);
                column.append(pill);
            });
            menu.append(column);
        });
        wrap.append(menu);
        wrap.append(node('p', '点食物名可临时调整今天的餐次；✓ 记入所在列的餐次。', 'food-banner-menu-hint'));
        return wrap;
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
        // 首页只留一条单行入口，样式对齐补剂横幅；点开看完整餐单
        const entry = node('button', '', 'food-plan-entry');
        entry.type = 'button';
        entry.append(node('span', '🥣', 'food-plan-entry-icon'));
        entry.append(node('div', '今日辅食计划', 'food-plan-entry-title'));
        entry.append(node('span', '›', 'food-plan-entry-arrow'));
        entry.addEventListener('click', openPlanDialog);
        body.append(entry);
        // ✓ 勾选等操作会触发重渲染；餐单弹层开着时就地刷新内容
        if (overlay?.classList.contains('food-plan-overlay')) {
            overlay.querySelector('.food-plan-content')?.replaceWith(buildPlanContent());
        }
    }

    // 临时调整某食物「今天」的餐次（不改长期计划）
    function adjustMealDialog(item) {
        closeDialog();
        const overridden = Object.prototype.hasOwnProperty.call(lastOverrides, String(item.food_id))
            || Object.prototype.hasOwnProperty.call(lastOverrides, item.food_id);
        overlay = node('div', '', 'banner-dialog-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = node('div', '', 'banner-dialog-head');
        head.append(node('h2', `${item.food} · 今天哪顿吃？`, 'banner-dialog-title'));
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(close);
        dialog.append(head);
        dialog.append(node('p', '只调整今天，不改长期计划。', 'banner-dialog-section'));
        const group = node('div', '', 'banner-chip-group');
        const options = [
            ['breakfast', '🥣 早餐'], ['lunch', '☀️ 午餐'], ['snack', '🍎 下午茶'],
            ['dinner', '🌙 晚餐'], ['both', '两餐都吃'], ['none', '今天不吃']
        ];
        if (overridden) options.push(['default', '恢复计划默认']);
        options.forEach(([value, label]) => {
            group.append(chip(label, async () => {
                try {
                    await api('screening/menu-override', 'POST', {
                        date: today(), food_id: item.food_id, meal: value
                    });
                    closeDialog();
                    toast(value === 'none' ? `今天不吃：${item.food}` : `已调整：${item.food}`);
                    await load();
                    openPlanDialog(); // 回到餐单弹层继续操作
                } catch (error) {
                    toast(`操作失败：${error.message}`);
                }
            }, value === item.meal));
        });
        dialog.append(group);
        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';
    }

    function suggestedAmount(item) {
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
        if (plannedFoods().length) {
            openBatchDialog();
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

    // ---------- 今日计划多选弹窗：勾选要摄入的部分食物，一次批量记录 ----------

    function openBatchDialog() {
        const foods = plannedFoods();
        if (!foods.length) return;
        // 只有一种计划食物时直接用单食物弹窗（含量化/反应的完整记录）
        if (foods.length === 1) {
            openFoodDialog(foods[0]);
            return;
        }
        closeDialog();
        // 计划绑定的餐次里取众数做默认（四餐通用，多选计划按所选餐次计票），没有明显多数时按当前时间猜
        const mealCounts = {};
        foods.forEach(item => {
            mealsOf(item.meal).forEach(meal => {
                mealCounts[meal] = (mealCounts[meal] || 0) + 1;
            });
        });
        const ranked = Object.entries(mealCounts).sort((a, b) => b[1] - a[1]);
        const state = {
            meal: ranked.length && ranked[0][1] > (ranked[1] ? ranked[1][1] : 0)
                ? ranked[0][0]
                : suggestedMeal()
        };

        overlay = node('div', '', 'banner-dialog-overlay');
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeDialog();
        });
        const dialog = node('div', '', 'banner-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const head = node('div', '', 'banner-dialog-head');
        head.append(node('h2', '今天吃了哪些？', 'banner-dialog-title'));
        const close = node('button', '✕', 'banner-dialog-close');
        close.type = 'button';
        close.setAttribute('aria-label', '关闭');
        close.addEventListener('click', closeDialog);
        head.append(close);
        dialog.append(head);

        const mealGroup = node('div', '', 'banner-chip-group');
        Object.entries(MEALS).forEach(([value, label]) => {
            mealGroup.append(chip(label, () => {
                state.meal = value;
                [...mealGroup.children].forEach(child => child.classList.remove('active'));
                [...mealGroup.children][Object.keys(MEALS).indexOf(value)].classList.add('active');
                refreshRows();
            }, value === state.meal));
        });
        dialog.append(mealGroup);

        const rows = node('div', '', 'banner-meal-rows');
        dialog.append(rows);

        const save = node('button', '保存已选进食', 'banner-dialog-primary');
        save.type = 'button';
        save.addEventListener('click', saveBatch);
        dialog.append(save);
        dialog.append(node('p', '勾选这餐吃了哪些计划食物；点 ⚠️ 可记录单个食物的反应。', 'banner-dialog-section'));

        overlay.append(dialog);
        document.body.append(overlay);
        document.body.style.overflow = 'hidden';

        async function refreshRows() {
            let entries = [];
            try {
                entries = (await api(`entries?date=${today()}`)).entries;
            } catch (error) {
                toast(`加载记录失败：${error.message}`);
            }
            rows.replaceChildren();
            foods.forEach(item => {
                const entry = entries.find(row => row.food_id === item.food_id && row.meal === state.meal);
                const chosen = { on: !!entry, amount: entry ? entry.amount : suggestedAmount(item) };
                const row = node('div', '', 'banner-meal-row');
                const check = node('button', chosen.on ? '✓' : '', 'banner-check' + (chosen.on ? ' checked' : ''));
                check.type = 'button';
                check.setAttribute('aria-pressed', String(chosen.on));
                check.setAttribute('aria-label', `选择「${item.food}」`);
                const name = node('button', '', 'banner-meal-name');
                name.type = 'button';
                name.append(node('span', item.food));
                if (item.text) name.append(node('small', item.text));
                function toggle() {
                    chosen.on = !chosen.on;
                    check.classList.toggle('checked', chosen.on);
                    check.textContent = chosen.on ? '✓' : '';
                    check.setAttribute('aria-pressed', String(chosen.on));
                }
                check.addEventListener('click', toggle);
                name.addEventListener('click', toggle);
                const amount = node('select', '', 'banner-amount-select');
                amount.setAttribute('aria-label', `${item.food} 的量`);
                AMOUNTS.forEach(value => {
                    const option = node('option', value);
                    option.value = value;
                    amount.append(option);
                });
                amount.value = chosen.amount;
                amount.addEventListener('change', () => { chosen.amount = amount.value; });
                const react = node('button', '⚠️ 反应', 'banner-react-btn');
                react.type = 'button';
                react.setAttribute('aria-label', `记录「${item.food}」的反应`);
                react.addEventListener('click', event => {
                    event.stopPropagation();
                    openFoodDialog(item);
                });
                row.append(check, name, amount, react);
                row._item = item;
                row._check = check;
                row._amount = () => amount.value;
                rows.append(row);
            });
            if (!rows.children.length) rows.append(node('p', '今天没有计划食物。', 'banner-dialog-section'));
        }

        async function saveBatch() {
            const selected = [...rows.children]
                .filter(row => row._check?.classList.contains('checked'))
                .map(row => ({ item: row._item, amount: row._amount() }));
            if (!selected.length) {
                toast('请先勾选这餐吃了哪些食物');
                return;
            }
            try {
                const dateValue = today();
                const result = await api(`entries?date=${dateValue}`);
                const selectedIds = selected.map(entry => entry.item.food_id);
                const plannedNames = selected
                    .filter(entry => entry.item.kind === 'planned')
                    .map(entry => entry.item.food);
                if (plannedNames.length
                    && !await confirmNoOtherScreening(selectedIds, plannedNames.join('、'))) {
                    return;
                }
                const others = result.entries
                    .filter(row => row.meal === state.meal && !selectedIds.includes(row.food_id))
                    .map(row => ({
                        id: row.id, food_id: row.food_id, amount: row.amount,
                        rating: row.rating, note: row.note, mode: 'keep'
                    }));
                const entries = [...others, ...selected.map(({ item, amount }) => ({
                    food_id: item.food_id,
                    amount,
                    rating: null, note: '',
                    mode: item.kind === 'planned' ? 'start' : 'keep'
                }))];
                await api('meals', 'POST', {
                    date: dateValue, meal: state.meal,
                    revision: result.revisions[state.meal], entries
                });
                todayContext = null;
                closeDialog();
                toast(`已记录${MEALS[state.meal]}：${selected.map(entry => entry.item.food).join('、')}`);
                window.fetchRecords?.();
                load();
            } catch (error) {
                toast(`保存失败：${error.message}`);
            }
        }

        refreshRows();
    }

    function openFoodDialog(item) {
        closeDialog();
        const state = {
            amount: AMOUNTS[Math.min(Math.max(item.position || 1, 1), 4) - 1],
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
        AMOUNTS.forEach(value => {
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
    window.addEventListener('pageshow', event => { if (event.persisted) load(); });
    load();
})();
